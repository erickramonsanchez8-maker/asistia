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
      .asistia-trial-badge{display:inline-flex;align-items:center;gap:7px;margin-left:8px;padding:7px 11px;border-radius:999px;background:rgba(26,166,183,.14);border:1px solid rgba(26,166,183,.28);color:#dffaff;font:700 11px/1.2 "Segoe UI",sans-serif;letter-spacing:.045em;white-space:nowrap}
      .asistia-trial-overlay{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px;background:radial-gradient(circle at 15% 10%,rgba(26,166,183,.18),transparent 34%),linear-gradient(145deg,#071a30,#0b1f3a 55%,#102b49);color:#eef7ff;font-family:"Segoe UI",sans-serif}
      .asistia-trial-panel{width:min(100%,520px);padding:42px 38px;border:1px solid rgba(255,255,255,.15);border-radius:24px;background:rgba(255,255,255,.075);box-shadow:0 28px 90px rgba(0,0,0,.34);text-align:center;backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px)}
      .asistia-trial-lock{width:64px;height:64px;display:grid;place-items:center;margin:0 auto 22px;border-radius:20px;background:rgba(26,166,183,.16);border:1px solid rgba(26,166,183,.34);font-size:28px}
      .asistia-trial-brand{margin:0 0 10px;color:#72d9e5;font-size:11px;font-weight:800;letter-spacing:.2em}
      .asistia-trial-panel h1{margin:0 0 12px;color:#fff;font-size:clamp(25px,5vw,34px);letter-spacing:-.04em}
      .asistia-trial-panel p{margin:0;color:#c6d4e3;font-size:15px;line-height:1.7}
      .asistia-trial-note{margin-top:24px!important;padding-top:18px;border-top:1px solid rgba(255,255,255,.13);font-size:13px!important;color:#8fa8c0!important}
      body.asistia-trial-locked{overflow:hidden}
      @media(max-width:600px){.asistia-trial-panel{padding:32px 22px}.asistia-trial-badge{font-size:0;padding:8px}.asistia-trial-badge span{font-size:10px}}
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

  const ensureTrialBadge = status => {
    const target = document.querySelector('.kiosk-top .kiosk-actions') || document.querySelector('.topbar .right');
    if (!target || status.expired) return;
    let badge = document.getElementById('asistiaTrialBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'asistiaTrialBadge';
      badge.className = 'asistia-trial-badge';
      target.appendChild(badge);
    }
    badge.textContent = 'DEMO · ' + status.daysRemaining + (status.daysRemaining === 1 ? ' DÍA RESTANTE' : ' DÍAS RESTANTES');
  };

  const lockExpiredTrial = status => {
    if (document.getElementById('asistiaTrialLock')) return;
    appRoot.inert = true;
    appRoot.setAttribute('aria-hidden', 'true');
    document.body.classList.add('asistia-trial-locked');
    const badge = document.getElementById('asistiaTrialBadge');
    if (badge) badge.remove();
    const overlay = document.createElement('section');
    overlay.id = 'asistiaTrialLock';
    overlay.className = 'asistia-trial-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'asistiaTrialTitle');
    const extra = status.clockRollback
      ? 'Se detectó un cambio hacia atrás en la fecha del equipo. La prueba quedó cerrada por seguridad.'
      : 'Para continuar utilizando ASISTIA, solicita una licencia a la persona que te proporcionó esta demostración.';
    overlay.innerHTML = '<div class="asistia-trial-panel"><div class="asistia-trial-lock" aria-hidden="true">🔒</div><div class="asistia-trial-brand">ASISTIA · CONTROL DE ASISTENCIA</div><h1 id="asistiaTrialTitle">Tu periodo de prueba terminó</h1><p>Los 15 días de demostración han concluido. El acceso a los registros y operaciones está bloqueado hasta activar una licencia.</p><p class="asistia-trial-note">' + extra + '<br>Tu información permanece guardada en este equipo.</p></div>';
    document.body.appendChild(overlay);
  };

  const checkTrial = async () => {
    if (!window.asistiaDesktop?.trialStatus) return;
    try {
      const status = await window.asistiaDesktop.trialStatus();
      if (status?.expired) lockExpiredTrial(status);
      else if (status) ensureTrialBadge(status);
    } catch {}
  };

  addStyles();
  const sync = () => { ensureBadge(); checkHealth(); };
  const observer = new MutationObserver(sync);
  observer.observe(appRoot, { childList: true, subtree: false });
  sync();
  checkTrial();
  setInterval(checkTrial, 60000);
  window.addEventListener('focus', checkHealth);
  window.addEventListener('focus', checkTrial);
})();
