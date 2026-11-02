(() => {
  'use strict';
  const appRoot = document.getElementById('app');
  if (!appRoot) return;

  const addStyles = () => {
    if (document.getElementById('asistia-desktop-styles')) return;
    const style = document.createElement('style');
    style.id = 'asistia-desktop-styles';
    style.textContent = `
      .asistia-local-status{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;margin-left:8px;border-radius:999px;color:#eaf6fb;background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.17);font:700 11px/1.2 "Segoe UI",sans-serif;letter-spacing:.07em;white-space:nowrap;cursor:pointer;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
      .asistia-local-status i{width:7px;height:7px;border-radius:50%;background:#e2ad36;box-shadow:0 0 0 4px rgba(226,173,54,.12)}
      .asistia-local-status[data-state="ok"] i{background:#48d39a;box-shadow:0 0 0 4px rgba(72,211,154,.13)}
      .asistia-local-status[data-state="off"] i{background:#ef7777;box-shadow:0 0 0 4px rgba(239,119,119,.13)}
      @media(max-width:900px){.asistia-local-status{font-size:0;padding:8px}.asistia-local-status i{margin:0}}
    `;
    document.head.appendChild(style);
  };

  const ensureBadge = () => {
    const target = document.querySelector('.kiosk-top .kiosk-actions') || document.querySelector('.topbar .right');
    if (!target) return;
    let badge = document.getElementById('asistiaLocalStatus');
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.id = 'asistiaLocalStatus';
      badge.className = 'asistia-local-status';
      badge.innerHTML = '<i></i><span>SERVICIO LOCAL</span>';
      badge.title = 'Servicio local de ASISTIA. Pulsa para abrir la carpeta de datos de este equipo.';
      badge.addEventListener('click', async () => {
        try {
          const folder = await window.asistiaDesktop?.openDataFolder?.();
          if (folder) badge.title = 'Carpeta de datos: ' + folder;
        } catch {}
      });
      target.appendChild(badge);
    }
  };

  const checkHealth = async () => {
    const badge = document.getElementById('asistiaLocalStatus');
    if (!badge || !window.asistiaDesktop?.health) return;
    try {
      const data = await window.asistiaDesktop.health();
      const ok = data && data.status === 'ok' && data.database === 'ok';
      badge.dataset.state = ok ? 'ok' : 'off';
      badge.querySelector('span').textContent = ok ? 'SERVICIO LOCAL ACTIVO' : 'SERVICIO LOCAL SIN CONEXIÓN';
    } catch {
      badge.dataset.state = 'off';
      badge.querySelector('span').textContent = 'SERVICIO LOCAL SIN CONEXIÓN';
    }
  };

  addStyles();
  const sync = () => { ensureBadge(); checkHealth(); };
  const observer = new MutationObserver(sync);
  observer.observe(appRoot, { childList: true, subtree: false });
  sync();
  window.addEventListener('focus', checkHealth);
})();
