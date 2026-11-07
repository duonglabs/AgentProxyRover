'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const { ProxyManager } = require('./lib/proxy-manager');
const { McpServer } = require('./lib/mcp-server');
const { buildMcpTools } = require('./lib/mcp-tools');
const { VpnEngine } = require('./lib/vpn-engine');

let win = null;
let manager = null;
let mcp = null;
let vpn = null;

function createWindow() {
  win = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 700,
    backgroundColor: '#101418',
    icon: path.join(__dirname, 'assets', 'favicon.png'), // taskbar reads best at 16-32px
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // Renderer console -> stdout: nhìn thấy lỗi UI (render throw, IPC fail...) mà
  // không cần mở DevTools. Đặc biệt hữu ích khi chẩn đoán "UI không cập nhật".
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    console.log(`[renderer:${level}] ${message} (${path.basename(String(source))}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.log(`[renderer:GONE] ${details.reason}`);
  });
  // DEBUG UI: poll CHỈ-ĐỌC 5s/lần (không đụng handler) — quan sát khi cần debug.
  setInterval(() => {
    if (!win || win.isDestroyed()) return;
    win.webContents
      .executeJavaScript(
        `(() => {
          const rows = [...document.querySelectorAll('#rows tr')];
          const r1 = rows[1] ? [...rows[1].querySelectorAll('td')].map(td => td.textContent.trim().slice(0, 30)) : null;
          return JSON.stringify({
            domRows: rows.length,
            row8802: r1,
            quota: document.getElementById('quotaLine')?.textContent?.slice(0, 48) ?? null,
          });
        })()`,
      )
      .then((s) => console.log('[dom] ' + s))
      .catch((e) => console.log('[dom ERR] ' + e.message));
  }, 5000);
}

/** App state + MCP server info + VPN POC state, for the renderer. */
function fullState() {
  return {
    ...manager.state(),
    mcp: mcp?.info() ?? { running: false, url: null, tools: [] },
    vpn: vpn?.snapshot() ?? null,
  };
}

async function startMcp() {
  mcp = new McpServer({
    name: 'agentproxy',
    version: app.getVersion(),
    host: '127.0.0.1',
    port: manager.settings.get().mcpPort,
    tools: buildMcpTools(manager),
    instructions:
      'Control surface of the AgentProxy desktop app on this machine. list_proxies shows the ' +
      'live local HTTP proxy endpoints; get_allocation lists the proxies assigned to this public IP; ' +
      'connect/disconnect start/stop them.',
    log: (m) => console.log(m),
  });
  await mcp.start();
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.agentproxy.app'); // Windows taskbar identity
  manager = new ProxyManager(app.getPath('userData'), () => {
    win?.webContents.send('state', fullState());
  }, { appVersion: app.getVersion() });

  // VPN mode POC — fully additive, managed by lib/vpn-engine.js. Tunnels all
  // system traffic through the FIRST local proxy port (settings.portStart).
  vpn = new VpnEngine({
    userDataDir: app.getPath('userData'),
    proxyPort: manager.settings.get().portStart,
    bindIp: manager.settings.get().bindIp,
    onEvent: (_type, payload) => {
      win?.webContents.send('vpn-state', payload ?? vpn.snapshot());
    },
  });

  ipcMain.handle('state', () => fullState());
  ipcMain.handle('start', async () => {
    try {
      await manager.start();
      return { ok: true, state: fullState() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('stop', async () => {
    try {
      // engine teardown resolves in ≤3s, but never leave the UI hanging
      await Promise.race([manager.stop(), new Promise((r) => setTimeout(r, 10000))]);
      return { ok: true, state: fullState() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('rotate', async (_e, itemId) => {
    try {
      const result = await manager.rotate(itemId);
      return { ok: true, result, state: fullState() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('vpn:start', async () => {
    try {
      const settings = manager.settings.get();
      vpn.proxyPort = settings.portStart; // tunnel → first local proxy port
      vpn.bindIp = settings.bindIp; // same IP the proxies actually listen on
      const state = await vpn.start();
      return { ok: true, state };
    } catch (e) {
      return { ok: false, error: e.message, state: vpn.snapshot() };
    }
  });
  ipcMain.handle('vpn:stop', async () => {
    try {
      const state = await vpn.stop();
      return { ok: true, state };
    } catch (e) {
      return { ok: false, error: e.message, state: vpn.snapshot() };
    }
  });
  ipcMain.handle('vpn:status', async () => ({ ok: true, state: await vpn.probe() }));

  ipcMain.handle('save-settings', async (_e, patch) => {
    try {
      const settings = manager.saveSettings(patch);
      if (mcp && patch.mcpPort !== undefined && mcp.port !== settings.mcpPort) {
        await mcp.stop();
        mcp.port = settings.mcpPort;
        await mcp.start();
      }
      return { ok: true, settings, state: fullState() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  await startMcp();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  manager?.stop().catch(() => {});
  mcp?.stop().catch(() => {});
  vpn?.dispose(); // best-effort kill of an elevated sing-box (real cleanup = UAC stop)
});
