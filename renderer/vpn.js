'use strict';

// VPN mode POC card — self-contained, only talks to window.vpnApi.
// Reads nothing from app.js and mutates none of its DOM.

(function () {
  const $ = (id) => document.getElementById(id);
  const dot = $('vpnDot');
  const btn = $('btnVpn');
  const info = $('vpnInfo');
  const logEl = $('vpnLog');
  if (!window.vpnApi) return;

  const COLORS = { off: '#8a94a6', starting: '#e6b35a', on: '#39c26d', stopping: '#e6b35a' };
  const LABELS = {
    off: 'OFF',
    starting: 'starting — approve the UAC prompt…',
    on: 'ON — system traffic goes through proxy #1',
    stopping: 'stopping — approve the UAC prompt…',
  };

  function render(st) {
    if (!st) return;
    dot.style.background = COLORS[st.state] ?? COLORS.off;
    btn.textContent = st.state === 'on' || st.state === 'starting' ? 'Stop VPN' : 'Start VPN';
    btn.disabled = st.state === 'starting' || st.state === 'stopping';
    let line = LABELS[st.state] ?? st.state;
    if (st.state === 'on') line += ` · pid ${st.pid} · clash :${st.clashPort} → proxy :${st.proxyPort}`;
    if (st.lastError) line += ` · ⚠ ${st.lastError}`;
    if (!st.binExists) line = 'sing-box.exe missing — run: node vpn/fetch-singbox.js';
    info.textContent = line;
    if (st.logTail) {
      logEl.textContent = st.logTail;
      logEl.classList.remove('hidden');
    } else {
      logEl.classList.add('hidden');
    }
  }

  async function refresh() {
    try {
      const res = await window.vpnApi.status();
      render(res?.state);
    } catch {
      /* app shutting down */
    }
  }

  btn.addEventListener('click', async () => {
    const st = (await window.vpnApi.status().catch(() => null))?.state;
    if (st && (st.state === 'on' || st.state === 'starting')) {
      render(await window.vpnApi.stop().catch(() => null));
    } else {
      render(await window.vpnApi.start().catch(() => null));
    }
    refresh();
  });

  window.vpnApi.onState(render);
  refresh();
  setInterval(refresh, 5000); // drift/crash detection: probe clash API
})();
