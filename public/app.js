// Small progressive enhancements: every page also works without JS.
(() => {
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-print]')) window.print();
  });

  document.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-confirm]');
    if (f && !window.confirm(f.dataset.confirm)) { e.preventDefault(); return; }
    if (e.target.closest('form[data-logout]') && navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage('logout'); // forget cached waybills on this phone
    }
  });

  document.addEventListener('change', (e) => {
    const f = e.target.closest('form.autosubmit');
    if (f) f.submit();
    // bank statement: read the file in the browser; 1C files are usually in Windows-1251
    const inp = e.target.closest('input[type=file][data-load-into]');
    if (inp && inp.files[0]) {
      inp.files[0].arrayBuffer().then((buf) => {
        let text;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1251').decode(buf); }
        document.getElementById(inp.dataset.loadInto).value = text;
      });
    }
  });

  // "select all" in signing tables
  document.addEventListener('change', (e) => {
    if (!e.target.matches('[data-check-all]')) return;
    e.target.closest('form').querySelectorAll('input[name=pick]').forEach((c) => { c.checked = e.target.checked; });
  });

  // typing a custom amount selects the "other amount" option
  document.addEventListener('input', (e) => {
    if (e.target.name === 'amount_other') {
      const r = e.target.closest('.amt')?.querySelector('input[type=radio]');
      if (r) r.checked = true;
    }
  });

  // Offline support and "install to home screen".
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  const bar = document.getElementById('install');
  if (bar) {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    let dismissed = false;
    try { dismissed = localStorage.getItem('pv-install-hide') === '1'; } catch { /* ignore */ }
    const hide = () => { bar.hidden = true; try { localStorage.setItem('pv-install-hide', '1'); } catch { /* ignore */ } };
    document.getElementById('install-close')?.addEventListener('click', hide);
    let deferred = null;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); deferred = e;
      if (!standalone && !dismissed) bar.hidden = false;
    });
    const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
    if (isIos && !standalone && !dismissed) {
      bar.hidden = false;
      document.getElementById('install-text').textContent = 'Нажмите «Поделиться», затем «На экран Домой».';
      document.getElementById('install-btn').hidden = true;
    }
    document.getElementById('install-btn')?.addEventListener('click', async () => {
      if (!deferred) return;
      deferred.prompt();
      await deferred.userChoice.catch(() => null);
      deferred = null; hide();
    });
  }

  // Live refresh: reload when the park's data changed (a stamp, a block, a new sheet),
  // but never while someone is typing or has a small form open.
  const rev = document.body.dataset.rev;
  if (!rev) return;
  const busy = () => {
    const a = document.activeElement;
    return (a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName)) || document.querySelector('details[open]') ||
      [...document.querySelectorAll('input[type=checkbox]')].some((c) => c.checked && c.closest('.week'));
  };
  setInterval(async () => {
    if (document.hidden || busy() || !navigator.onLine) return;
    try {
      const r = await fetch('/api/rev', { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;
      const j = await r.json();
      if (j.rev && j.rev !== rev) location.reload();
    } catch { /* offline: try later */ }
  }, 7000);
})();
