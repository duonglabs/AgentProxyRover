'use strict';

// VPN/Proxy mode switch + Kaspersky-style VPN hero view.
// Self-contained: talks to window.vpnApi (tunnel) and window.api (proxies),
// reads nothing from app.js and mutates none of its DOM.

(function () {
  if (!window.vpnApi || !window.api) return;
  const $ = (id) => document.getElementById(id);

  // ── mode switch ────────────────────────────────────────────────────────
  const views = { vpn: $('viewVpn'), proxy: $('viewProxy') };
  const modeBtns = { vpn: $('modeVpn'), proxy: $('modeProxy') };

  function switchMode(mode) {
    for (const m of ['vpn', 'proxy']) {
      views[m]?.classList.toggle('hidden', m !== mode);
      modeBtns[m]?.classList.toggle('active', m === mode);
    }
    try {
      localStorage.setItem('ap-view', mode);
    } catch {
      /* private mode */
    }
    if (mode === 'proxy') ensureProxies(); // the proxy screen always has live rows
  }
  modeBtns.vpn?.addEventListener('click', () => switchMode('vpn'));
  modeBtns.proxy?.addEventListener('click', () => switchMode('proxy'));
  $('vpnLocCard')?.addEventListener('click', () => switchMode('proxy'));

  /** proxies are the tunnel's upstream — connect them quietly if not running */
  async function ensureProxies() {
    try {
      const st = await window.api.state();
      if (!st.running) await window.api.start(); // state events re-render the table
    } catch {
      /* app shutting down */
    }
  }

  // ── VPN hero toggle ────────────────────────────────────────────────────
  const toggle = $('vpnBigToggle');
  const hint = $('vpnHint');
  const statusEl = $('vpnStatus');
  const errEl = $('vpnError');
  const logEl = $('vpnLog');
  const locEl = $('vpnLoc');
  const locSub = $('vpnLocSub');
  let lastLog = null;

  const LABELS = {
    off: 'Nhấn vào đây để bật VPN',
    starting: 'Đang bật VPN — duyệt hộp thoại UAC…',
    on: 'VPN đang bảo vệ toàn bộ hệ thống',
    stopping: 'Đang tắt VPN — duyệt hộp thoại UAC…',
  };

  function render(st) {
    if (!st || !st.state) return; // ignore envelopes / partial payloads
    if (st.logTail !== undefined) lastLog = st.logTail;

    toggle.classList.toggle('on', st.state === 'on');
    toggle.classList.toggle('busy', st.state === 'starting' || st.state === 'stopping');
    toggle.setAttribute('aria-pressed', String(st.state === 'on'));
    // 'starting' stays clickable: it's the recovery path for a wedged start
    toggle.disabled = st.state === 'stopping';
    hint.textContent = LABELS[st.state] ?? st.state;

    let line = '';
    if (st.state === 'on') line = `pid ${st.pid} · toàn bộ traffic đi qua proxy #1 (${st.proxyPort})`;
    statusEl.textContent = line;
    errEl.textContent = st.lastError ?? '';
    if (lastLog) {
      logEl.textContent = lastLog;
      logEl.classList.remove('hidden');
    } else {
      logEl.classList.add('hidden');
    }
    updateLocation();
  }

  /** location card = first proxy in the allocation (the tunnel's exit) */
  async function updateLocation() {
    try {
      const st = await window.api.state();
      const p = st.proxies?.[0];
      if (!st.running || !p) {
        locEl.textContent = 'Chưa có proxy';
        locSub.textContent = '';
        return;
      }
      locEl.textContent = fmtCountry(p.country);
      const exit = String(p.exitHost ?? '').split(':').pop();
      locSub.textContent = exit ? ` · exit ${exit}` : '';
    } catch {
      /* app shutting down */
    }
  }

  function fmtCountry(c) {
    const t = String(c ?? '').trim();
    if (!t) return '—';
    if (/^[A-Za-z]{2}$/.test(t)) return t.toUpperCase();
    const [country, ...city] = t.toLowerCase().split('-');
    const cap = (s) => s.replace(/(^|\s|-)\w/g, (ch) => ch.toUpperCase());
    return city.length ? `${cap(country)} · ${cap(city.join('-'))}` : cap(country);
  }

  async function refresh() {
    try {
      const res = await window.vpnApi.status();
      render(res?.state);
    } catch {
      /* app shutting down */
    }
  }

  toggle.addEventListener('click', async () => {
    const st = (await window.vpnApi.status().catch(() => null))?.state;
    const mode = st?.state ?? 'off';
    if (mode === 'stopping') return;
    if (mode === 'on' || mode === 'starting') {
      const res = await window.vpnApi.stop().catch(() => null);
      render(res?.state);
    } else {
      // OFF → the tunnel exits through proxy #1: connect proxies FIRST
      // (the engine also refuses to elevate without a live listener), then UAC
      toggle.disabled = true;
      hint.textContent = 'Đang nạp proxy…';
      const ps = await window.api.start().catch((e) => ({ ok: false, error: e.message }));
      const psState = ps?.state;
      if (!ps?.ok || !psState?.proxies?.length) {
        errEl.textContent = ps?.error
          ? `Không nạp được proxy: ${ps.error}`
          : 'Không nạp được proxy — không có allocation nào, thử lại sau.';
        toggle.disabled = false;
        hint.textContent = LABELS.off;
        return;
      }
      const res = await window.vpnApi.start().catch(() => null);
      render(res?.state);
    }
    refresh();
  });

  window.vpnApi.onState(render);
  window.api.onState(updateLocation);

  // default view: last used, else VPN (the hero screen)
  let initial = 'vpn';
  try {
    initial = localStorage.getItem('ap-view') === 'proxy' ? 'proxy' : 'vpn';
  } catch {
    /* private mode */
  }
  switchMode(initial);
  refresh();
  setInterval(refresh, 5000); // probe clash API + fetch log tail
})();
