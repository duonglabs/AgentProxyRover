'use strict';

/**
 * VPN mode POC (additive, doesn't touch the proxy engines).
 *
 * Data plane: sing-box TUN adapter captures the whole system's traffic and
 * forwards it to the app's local HTTP proxy (127.0.0.1:<proxyPort>), which
 * relays to the configured upstream as usual:
 *
 *   any app ──► TUN (sing-box) ──► http://127.0.0.1:<proxyPort> ──► upstream ──► internet
 *
 * Control plane: sing-box is started elevated (UAC, required for TUN +
 * auto_route) through two tiny PowerShell helpers in vpn/scripts/. State is
 * polled via sing-box's clash API (127.0.0.1:<clashPort>/version).
 *
 * Safety rails (see vpn/README.md):
 *  - the app's own processes are routed DIRECT so proxy upstream connections
 *    never loop back into the tunnel;
 *  - private/LAN ranges stay DIRECT;
 *  - strict_route stays OFF for the POC (no kill-switch lockout if sing-box dies).
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const EXCLUDED_PROCESSES = [
  'electron.exe', // dev-mode app itself (its upstream connections must stay direct)
  'agentproxy.exe', // packaged app binary
  'node.exe', // local tooling / agents driving this machine during POC
];

function log(...a) {
  console.log(`[${new Date().toISOString()}] [vpn]`, ...a);
}

class VpnEngine {
  /**
   * @param {{userDataDir:string, proxyPort?:number, clashPort?:number, binPath?:string,
   *          onEvent?:(type:string, payload?:object)=>void}} opts
   */
  constructor(opts) {
    this.userDataDir = opts.userDataDir;
    this.proxyPort = opts.proxyPort || 8801;
    this.clashPort = opts.clashPort || 9090;
    this.binPath = opts.binPath || path.resolve(__dirname, '..', 'vpn', 'bin', 'sing-box.exe');
    this.onEvent = opts.onEvent || (() => {});

    this.state = 'off'; // off | starting | on | stopping
    this.lastError = null;
    this.pid = null;
    this.startedAt = null;
    this._clashUp = false;
    this._startTimer = null;
  }

  get dir() {
    return path.join(this.userDataDir, 'vpn');
  }
  get configPath() {
    return path.join(this.dir, 'config.json');
  }
  get logPath() {
    return path.join(this.dir, 'sing-box.log');
  }
  get pidPath() {
    return path.join(this.dir, 'sing-box.pid');
  }
  get startScript() {
    return path.resolve(__dirname, '..', 'vpn', 'scripts', 'elevate-start.ps1');
  }
  get stopScript() {
    return path.resolve(__dirname, '..', 'vpn', 'scripts', 'elevate-stop.ps1');
  }

  /** sing-box config. Validated with `sing-box check` before use. */
  buildConfig() {
    const cfg = {
      log: { level: 'info', timestamp: true, output: this.logPath },
      dns: {
        servers: [
          // All A/AAAA answered with fake IPs — real resolution happens at the
          // upstream proxy (we send CONNECT with the hostname). No UDP leaves
          // the machine at all, which is exactly what an HTTP-proxy upstream needs.
          {
            type: 'fakeip',
            tag: 'dns-fake',
            inet4_range: '198.18.0.0/15',
            inet6_range: 'fc00::/18',
          },
          // Non-address types (HTTPS/SVCB, TXT, …) go out as DNS-over-TCP
          // THROUGH the proxy — the only DNS path an HTTP CONNECT upstream allows.
          { type: 'tcp', tag: 'dns-tcp', server: '1.1.1.1', detour: 'vpn-out' },
        ],
        rules: [{ query_type: ['A', 'AAAA'], server: 'dns-fake' }],
        final: 'dns-tcp',
      },
      inbounds: [
        {
          type: 'tun',
          tag: 'tun-in',
          address: ['172.19.0.1/30', 'fdfe:dcba:9876::1/126'],
          auto_route: true,
          strict_route: false, // POC: no kill-switch — if sing-box dies, traffic falls back
        },
      ],
      outbounds: [
        { type: 'http', tag: 'vpn-out', server: '127.0.0.1', server_port: this.proxyPort },
        { type: 'direct', tag: 'direct' },
      ],
      route: {
        rules: [
          { action: 'sniff' },
          { protocol: 'dns', action: 'hijack-dns' },
          { ip_is_private: true, outbound: 'direct' }, // LAN/printers/localhost-adjacent stay local
          {
            process_name: EXCLUDED_PROCESSES.slice(),
            outbound: 'direct', // the app's own upstream relays must NOT re-enter the tunnel
          },
        ],
        final: 'vpn-out',
        auto_detect_interface: true,
        // required by sing-box 1.12+ when a dial needs a domain resolved:
        // use the TCP-DNS-through-tunnel server, never the local system resolver
        default_domain_resolver: { server: 'dns-tcp' },
      },
      experimental: {
        clash_api: { external_controller: `127.0.0.1:${this.clashPort}` },
        cache_file: { enabled: true, store_fakeip: true },
      },
    };
    return cfg;
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.onEvent('state', this.snapshot());
    log('state →', state, JSON.stringify(extra));
  }

  snapshot() {
    return {
      state: this.state,
      pid: this.pid,
      clashPort: this.clashPort,
      proxyPort: this.proxyPort,
      startedAt: this.startedAt,
      lastError: this.lastError,
      binExists: fs.existsSync(this.binPath),
      configPath: this.configPath,
      logTail: this._tailLog(),
    };
  }

  _tailLog(n = 12) {
    try {
      const txt = fs.readFileSync(this.logPath, 'utf8');
      return txt.trimEnd().split(/\r?\n/).slice(-n).join('\n');
    } catch {
      return null;
    }
  }

  _runPs(script, args) {
    return new Promise((resolve, reject) => {
      const psArgs = [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', script,
        ...args.flatMap((kv) => [kv[0], kv[1]]),
      ];
      const child = spawn('powershell.exe', psArgs, { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(out.trim());
        else reject(new Error(`powershell exit ${code}: ${(err || out).trim().slice(0, 400)}`));
      });
    });
  }

  /** Non-elevated config validation. Needs sing-box.exe present. */
  async checkConfig() {
    if (!fs.existsSync(this.binPath)) {
      throw new Error('sing-box.exe not found — run: node vpn/fetch-singbox.js');
    }
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.buildConfig(), null, 2));
    return new Promise((resolve, reject) => {
      const child = spawn(this.binPath, ['check', '-c', this.configPath], { windowsHide: true });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(out.trim() || 'config OK');
        else reject(new Error(`sing-box check failed:\n${(err + out).trim().slice(0, 2000)}`));
      });
    });
  }

  /** UAC #1 → sing-box runs elevated → wait for clash API. */
  async start() {
    if (this.state === 'on' || this.state === 'starting') return this.snapshot();
    this.lastError = null;
    this._setState('starting');
    try {
      const checkMsg = await this.checkConfig(); // also (re)writes config.json
      log('config check:', checkMsg);
    } catch (e) {
      this.lastError = e.message;
      this._setState('off');
      throw e;
    }

    try {
      fs.rmSync(this.pidPath, { force: true });
      await this._runPs(this.startScript, [
        ['-SingBox', this.binPath],
        ['-Config', this.configPath],
        ['-PidFile', this.pidPath],
      ]);
    } catch (e) {
      this.lastError = /canceled by the user/i.test(e.message)
        ? 'UAC prompt declined'
        : `elevate failed: ${e.message}`;
      this._setState('off');
      throw new Error(this.lastError);
    }

    // wait for the pid file (UAC approved, script wrote it)
    const pidWaitMs = 30000;
    const t0 = Date.now();
    while (!fs.existsSync(this.pidPath) && Date.now() - t0 < pidWaitMs) {
      await new Promise((r) => setTimeout(r, 300));
    }
    const pid = Number(fs.readFileSync(this.pidPath, 'utf8').trim());
    if (!pid) {
      this.lastError = 'elevated start produced no pid';
      this._setState('off');
      throw new Error(this.lastError);
    }
    this.pid = pid;
    this.startedAt = Date.now();
    log('sing-box pid', pid);

    // wait for clash API — that's the reliable "tunnel is up" signal
    const upMs = 45000;
    const up = await this._waitClash(upMs);
    if (!up) {
      const tail = this._tailLog(6);
      this.lastError = `clash API not up in ${upMs / 1000}s. log: ${tail ?? '(no log yet)'}`;
      // don't flip to off — sing-box may still be initializing (or failed);
      // stop() from the UI can clean it up
      this.onEvent('state', this.snapshot());
      throw new Error(this.lastError);
    }
    this._clashUp = true;
    this._setState('on');
    this.onEvent('up', { pid });
    return this.snapshot();
  }

  /** UAC #2 → force-kill elevated sing-box (+ any stray of this exact binary). */
  async stop() {
    if (this.state === 'off' || this.state === 'stopping') return this.snapshot();
    this._setState('stopping');
    try {
      await this._runPs(this.stopScript, [
        ['-PidFile', this.pidPath],
        ['-ExePath', this.binPath],
      ]);
    } catch (e) {
      this.lastError = `stop failed: ${e.message}`;
    }
    this.pid = null;
    this.startedAt = null;
    this._clashUp = false;
    this._setState('off');
    this.onEvent('down', {});
    return this.snapshot();
  }

  _clashGet(pth) {
    return new Promise((resolve, reject) => {
      const req = http.get(
        { host: '127.0.0.1', port: this.clashPort, path: pth, timeout: 1500 },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve(body));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  }

  async _waitClash(ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await this._clashAlive()) return true;
      await new Promise((r) => setTimeout(r, 700));
    }
    return false;
  }

  async _clashAlive() {
    try {
      const body = await this._clashGet('/version');
      return /version/.test(body);
    } catch {
      return false;
    }
  }

  /** Pollable status probe for IPC (`vpn:status`) — never throws. */
  async probe() {
    const clash = await this._clashAlive();
    this._clashUp = clash;
    if (this.state === 'on' && !clash) {
      this.lastError = 'tunnel dropped (clash API unreachable)';
      this._setState('off');
      this.onEvent('down', { reason: 'clash-unreachable' });
    }
    return this.snapshot();
  }

  /** Best-effort cleanup on app quit (non-elevated taskkill; usually a no-op). */
  dispose() {
    if (this._startTimer) clearTimeout(this._startTimer);
    if (this.pid) {
      try {
        spawn('taskkill', ['/PID', String(this.pid), '/F'], { windowsHide: true });
      } catch {
        /* best effort */
      }
    }
  }
}

module.exports = { VpnEngine, EXCLUDED_PROCESSES };
