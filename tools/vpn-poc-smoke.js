'use strict';

/**
 * VPN mode POC — standalone e2e smoke (no Electron UI needed).
 *
 * Boots ONE local proxy engine on 127.0.0.1:<port> backed by a static upstream,
 * then runs the full VPN cycle with real curl verification:
 *
 *   1. baseline curl (no proxy)            → your real IP
 *   2. curl through the local proxy        → upstream exit IP
 *   3. VpnEngine.start()                   → APPROVE THE FIRST UAC PROMPT
 *   4. curl, still no proxy settings       → must now ALSO show the upstream exit IP
 *   5. VpnEngine.stop()                    → APPROVE THE SECOND UAC PROMPT
 *   6. curl, no proxy                      → back to your real IP
 *
 * The node.exe process itself is excluded from the tunnel (vpn-engine route
 * rules), so the smoke script and any agent driving it keep a clean connection
 * while the tunnel is on — curl.exe deliberately IS captured, which is the
 * whole point of the test.
 *
 * Usage:
 *   node tools/vpn-poc-smoke.js --upstream host:port:user:pass [options]
 * Options:
 *   --scheme http|https   upstream proxy scheme (default http)
 *   --port 8801           local proxy port the tunnel points at (default 8801)
 *   --keep                leave the local proxy running after the test
 */

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const { ProxyServer } = require('../lib/proxy-engine');
const { VpnEngine } = require('../lib/vpn-engine');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const flag = (name) => process.argv.includes(`--${name}`);

const UPSTREAMS = (process.argv.find((a) => a.startsWith('--upstream='))?.split('=')[1] ||
  (process.argv.includes('--upstream') ? process.argv[process.argv.indexOf('--upstream') + 1] : ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    // password may contain ':' — host:port:user:<rest joined back>
    const [host, port, user, ...passParts] = s.split(':');
    return {
      host,
      port: Number(port),
      scheme: arg('scheme', 'http'),
      username: user ?? '',
      password: passParts.join(':'),
    };
  });

const PORT = Number(arg('port', '8801'));
const IP_ECHO = 'https://api.ipify.org';

function log(tag, ...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}]`, ...a);
}

function curl(args) {
  return new Promise((resolve) => {
    const child = spawn('curl.exe', [' -s'.trim(), '--max-time', '20', ...args], { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}
const curlDirect = () => curl([IP_ECHO]);
const curlViaProxy = (port) => curl(['-x', `http://127.0.0.1:${port}`, IP_ECHO]);

async function findWorkingUpstream() {
  for (const up of UPSTREAMS) {
    log('probe', `testing upstream ${up.host}:${up.port} ...`);
    const probe = new ProxyServer({
      name: 'probe',
      listen: '127.0.0.1:0',
      provider: {
        acquireUpstream: async () => up,
        reportFailure: () => {},
      },
    });
    try {
      await probe.start();
      const r = await curl(['-x', `http://127.0.0.1:${probe.server.address().port}`, IP_ECHO]);
      await probe.stop();
      if (r.code === 0 && /^\d+\.\d+\.\d+\.\d+$/.test(r.out)) {
        log('probe', `OK — exit IP ${r.out}`);
        return { up, exitIp: r.out };
      }
      log('probe', `dead (${r.err || r.out || 'exit ' + r.code})`);
    } catch (e) {
      log('probe', 'dead:', e.message);
    }
  }
  return null;
}

async function main() {
  if (!UPSTREAMS.length) {
    console.error('usage: node tools/vpn-poc-smoke.js --upstream host:port:user:pass');
    process.exit(2);
  }

  console.log('=== VPN mode POC smoke ===');
  const found = await findWorkingUpstream();
  if (!found) {
    console.error('FAIL: no working upstream given');
    process.exit(1);
  }
  const { up, exitIp } = found;

  // 1. the real local proxy the tunnel will point at
  const engine = new ProxyServer({
    name: `poc-8801`,
    listen: `127.0.0.1:${PORT}`,
    provider: { acquireUpstream: async () => up, reportFailure: () => {} },
  });
  await engine.start();

  const realIp = (await curlDirect()).out;
  log('step1', `baseline (no proxy): ${realIp}`);
  const viaProxy = await curlViaProxy(PORT);
  log('step2', `via local proxy    : ${viaProxy.out || '(fail: ' + viaProxy.err + ')'}`);
  const ok2 = viaProxy.out === exitIp;
  if (!ok2) {
    console.error('FAIL: local proxy does not reach the upstream exit — fix that first');
    await engine.stop();
    process.exit(1);
  }

  // 2. the VPN cycle
  const vpn = new VpnEngine({
    userDataDir: path.join(__dirname, '..', 'state-vpn-poc'),
    proxyPort: PORT,
    onEvent: (t, p) => t === 'state' && log('vpn', 'state =', p.state),
  });

  let pass = true;
  try {
    console.log('\n>>> APPROVE THE UAC PROMPT NOW (starting sing-box) <<<\n');
    await vpn.start();
    log('step3', `VPN ON — pid ${vpn.pid}`);

    await new Promise((r) => setTimeout(r, 2000)); // let the browser stack settle
    const direct1 = await curlDirect();
    log('step4', `curl (no proxy, tunneled): ${direct1.out || '(fail: ' + direct1.err + ')'}`);
    const ok4 = direct1.out === exitIp;
    const again = await curlDirect(); // stability: second request, fresh DNS
    log('step4b', `curl again               : ${again.out || '(fail: ' + again.err + ')'}`);
    const ok4b = again.out === exitIp;

    console.log('\n>>> APPROVE THE SECOND UAC PROMPT NOW (stopping sing-box) <<<\n');
    await vpn.stop();
    const restored = (await curlDirect()).out;
    log('step6', `after stop (no proxy): ${restored}`);
    const ok6 = restored === realIp;

    pass = ok2 && ok4 && ok4b && ok6;
    console.log('\n=== RESULT ===');
    console.log(`local proxy reaches upstream exit : ${ok2 ? 'PASS' : 'FAIL'}`);
    console.log(`system traffic captured (VPN on)  : ${ok4 ? 'PASS' : 'FAIL'}`);
    console.log(`capture stable (2nd request)      : ${ok4b ? 'PASS' : 'FAIL'}`);
    console.log(`system restored (VPN off)         : ${ok6 ? 'PASS' : 'FAIL'}`);
    console.log(`exit IP seen through the tunnel   : ${exitIp}`);
    console.log(`your real IP                      : ${realIp}`);
  } catch (e) {
    pass = false;
    console.error('\nFAIL:', e.message);
    if (vpn.state !== 'off') {
      console.error('attempting cleanup (approve the UAC prompt if it appears)...');
      await vpn.stop().catch(() => {});
    }
  } finally {
    if (!flag('keep')) await engine.stop();
    else log('keep', `local proxy still on 127.0.0.1:${PORT}`);
  }
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
