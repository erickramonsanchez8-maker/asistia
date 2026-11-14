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
      .asistia-trial-whatsapp{display:inline-flex;align-items:center;justify-content:center;gap:10px;margin-top:24px;padding:14px 22px;border:0;border-radius:12px;background:#25d366;color:#062b19;font:800 14px/1.2 "Segoe UI",sans-serif;text-decoration:none;cursor:pointer;box-shadow:0 10px 28px rgba(37,211,102,.2);transition:transform .18s ease,filter .18s ease}.asistia-trial-whatsapp:hover{filter:brightness(1.06);transform:translateY(-1px)}
      .asistia-trial-note{margin-top:24px!important;padding-top:18px;border-top:1px solid rgba(255,255,255,.13);font-size:13px!important;color:#8fa8c0!important}
      body.asistia-trial-locked{overflow:hidden}
      .asistia-mobile-access{margin:4px 3px!important;white-space:nowrap}
      .asistia-mobile-dialog{width:min(92vw,520px);border:1px solid #dce5ee;border-radius:20px;padding:26px;color:#172638;box-shadow:0 24px 80px rgba(5,22,40,.3)}
      .asistia-mobile-dialog::backdrop{background:rgba(5,18,32,.58);backdrop-filter:blur(5px)}
      .asistia-mobile-dialog h2{margin:0 0 8px;color:#0b1d33}
      .asistia-mobile-dialog p{color:#647589;font-size:13px;line-height:1.55}
      .asistia-mobile-credential{padding:12px 14px;margin:10px 0;border:1px solid #e1e8ef;border-radius:12px;background:#f6f9fc}
      .asistia-mobile-credential span{display:block;margin-bottom:5px;color:#718093;font-size:10px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}
      .asistia-mobile-credential strong{display:block;color:#0b1d33;font-size:16px;overflow-wrap:anywhere;user-select:all}
      .asistia-mobile-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:18px}
      .asistia-mobile-panel{margin:14px 0 18px;padding:18px}
      .asistia-mobile-list{display:grid;gap:8px;margin-top:12px}
      .asistia-mobile-item{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 12px;border:1px solid #e8edf2;border-radius:12px;background:#fbfcfe}
      .asistia-mobile-item strong{display:block;color:#142b43;font-size:13px}
      .asistia-mobile-item small{display:block;color:#748398;font-size:11px;margin-top:3px}
      .asistia-mobile-type{padding:6px 9px;border-radius:99px;background:#eaf2fb;color:#245b91;font-size:10px;font-weight:800;white-space:nowrap}
      .asistia-mobile-type.out{background:#edf1f5;color:#55677b}
      @media(max-width:600px){.asistia-trial-panel{padding:32px 22px}.asistia-trial-badge{font-size:0;padding:8px}.asistia-trial-badge span{font-size:10px}.asistia-mobile-item{align-items:flex-start;flex-direction:column}}
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
    overlay.innerHTML = '<div class="asistia-trial-panel"><div class="asistia-trial-lock" aria-hidden="true">🔒</div><div class="asistia-trial-brand">ASISTIA · CONTROL DE ASISTENCIA</div><h1 id="asistiaTrialTitle">Tu periodo de prueba terminó</h1><p>Los 15 días de demostración han concluido. El acceso a los registros y operaciones está bloqueado hasta activar una licencia.</p><button type="button" class="asistia-trial-whatsapp" id="asistiaTrialWhatsApp">Contactar por WhatsApp para activar</button><p class="asistia-trial-note">' + extra + '<br>Tu información permanece guardada en este equipo.</p></div>';
    overlay.querySelector('#asistiaTrialWhatsApp').addEventListener('click', async () => {
      try {
        await window.asistiaDesktop?.openActivationWhatsApp?.();
      } catch {
        window.location.href = 'https://wa.me/523123603551?text=Hola%2C%20quiero%20activar%20ASISTIA.%0ANombre%20del%20negocio%3A%0AN%C3%BAmero%20de%20sucursales%3A%0APlan%3A%20Mensual%20%2F%20Anual.';
      }
    });
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

  let lastEmployeeSyncFingerprint = '';
  let employeeSyncInFlight = false;
  let mobileActivityInFlight = false;

  const htmlText = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[char]));

  const syncExistingEmployees = async () => {
    if (employeeSyncInFlight || !window.asistiaDesktop?.syncEmployees) return;
    let employees;
    try {
      const data = JSON.parse(localStorage.getItem('control_asistencia_pro_v1') || 'null');
      if (!data || !Array.isArray(data.employees)) return;
      employees = data.employees.filter(person => person && person.id && person.fullName).map(person => ({
        id: String(person.id),
        fullName: String(person.fullName),
        employeeNumber: String(person.employeeNumber || ''),
        branch: String(person.branch || 'Principal'),
        active: person.active !== false
      }));
    } catch { return; }
    const fingerprint = JSON.stringify(employees);
    if (!employees.length || fingerprint === lastEmployeeSyncFingerprint) return;
    employeeSyncInFlight = true;
    try {
      const result = await window.asistiaDesktop.syncEmployees(employees);
      if (result?.ok && result.synced === employees.length) lastEmployeeSyncFingerprint = fingerprint;
    } catch {
      // A transient local-service failure is retried on the next cycle.
    } finally { employeeSyncInFlight = false; }
  };

  const showMobileCredentials = data => {
    const dialog = document.createElement('dialog');
    dialog.className = 'asistia-mobile-dialog';
    dialog.innerHTML = `
      <h2>Acceso móvil generado</h2>
      <p>Entrega estos datos al empleado. La contraseña temporal se muestra solamente en esta ocasión.</p>
      <div class="asistia-mobile-credential"><span>Número de empleado / usuario</span><strong id="asistiaMobileLogin"></strong></div>
      <div class="asistia-mobile-credential"><span>Contraseña temporal</span><strong id="asistiaMobilePassword"></strong></div>
      <p>Al volver a generar el acceso, la contraseña anterior dejará de funcionar.</p>
      <div class="asistia-mobile-actions">
        <button type="button" class="btn btn-ghost" id="asistiaMobileClose">Cerrar</button>
        <button type="button" class="btn btn-primary" id="asistiaMobileCopy">Copiar acceso</button>
      </div>`;
    dialog.querySelector('#asistiaMobileLogin').textContent = data.employee.employeeNumber;
    dialog.querySelector('#asistiaMobilePassword').textContent = data.access.password;
    dialog.querySelector('#asistiaMobileClose').addEventListener('click', () => dialog.close());
    dialog.querySelector('#asistiaMobileCopy').addEventListener('click', async () => {
      const text = 'ASISTIA Móvil\nNúmero de empleado: ' + data.employee.employeeNumber + '\nContraseña temporal: ' + data.access.password;
      try {
        await navigator.clipboard.writeText(text);
        dialog.querySelector('#asistiaMobileCopy').textContent = 'Copiado';
      } catch {
        dialog.querySelector('#asistiaMobileCopy').textContent = 'No se pudo copiar';
      }
    });
    dialog.addEventListener('close', () => dialog.remove(), { once: true });
    document.body.appendChild(dialog);
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else window.alert('Número: ' + data.employee.employeeNumber + '\nContraseña: ' + data.access.password);
  };

  const ensureEmployeeMobileActions = () => {
    appRoot.querySelectorAll('button[data-ed]').forEach(editButton => {
      const row = editButton.closest('tr');
      if (!row || row.querySelector('[data-asistia-mobile]')) return;
      const id = editButton.dataset.ed;
      const nameCell = row.cells?.[0];
      const numberCell = row.cells?.[1];
      const statusCell = row.cells?.[6];
      const actionCell = row.cells?.[7];
      if (!id || !nameCell || !numberCell || !actionCell) return;
      const fullName = [...nameCell.childNodes].filter(node => node.nodeType === Node.TEXT_NODE)
        .map(node => node.textContent).join('').trim() || nameCell.textContent.trim().split('\n')[0];
      const employeeNumber = numberCell.textContent.trim() === '—' ? '' : numberCell.textContent.trim();
      const active = !statusCell || statusCell.textContent.includes('Activo');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-ghost btn-sm asistia-mobile-access';
      button.dataset.asistiaMobile = id;
      button.textContent = 'Crear / restablecer móvil';
      button.title = 'Crea o restablece las credenciales móviles de esta misma ficha de empleado.';
      button.disabled = !active;
      button.addEventListener('click', async () => {
        if (!window.asistiaDesktop?.provisionMobileAccess) {
          window.alert('El servicio local de ASISTIA no está disponible.');
          return;
        }
        if (!window.confirm('Se generará una contraseña móvil nueva para ' + fullName + '. Si ya tenía acceso, la contraseña anterior dejará de funcionar. ¿Continuar?')) return;
        button.disabled = true;
        button.textContent = 'Generando…';
        try {
          const result = await window.asistiaDesktop.provisionMobileAccess({
            id, fullName, employeeNumber, branch: 'Principal', active: true
          });
          showMobileCredentials(result);
          button.textContent = 'Restablecer acceso móvil';
        } catch (error) {
          window.alert(error?.message || 'No se pudo generar el acceso móvil.');
          button.textContent = 'Crear / restablecer móvil';
        } finally { button.disabled = !active; }
      });
      actionCell.appendChild(button);
    });
  };

  const refreshMobileActivity = async () => {
    if (mobileActivityInFlight || !window.asistiaDesktop?.getMobileRecent) return;
    const heading = [...appRoot.querySelectorAll('h2')].find(node => node.textContent.trim() === 'Resumen general');
    const pageHead = heading?.closest('.page-head');
    if (!pageHead) return;
    let panel = appRoot.querySelector('#asistiaMobileActivity');
    if (!panel) {
      panel = document.createElement('section');
      panel.id = 'asistiaMobileActivity';
      panel.className = 'card asistia-mobile-panel';
      panel.innerHTML = '<div class="page-head"><div><h3>Registros móviles recientes</h3><p class="hint">Eventos recibidos en la base local de ASISTIA.</p></div><span class="badge badge-info">Wi-Fi local</span></div><div class="asistia-mobile-list" id="asistiaMobileList"><p class="hint">Consultando registros…</p></div>';
      pageHead.insertAdjacentElement('afterend', panel);
    }
    mobileActivityInFlight = true;
    try {
      const result = await window.asistiaDesktop.getMobileRecent();
      const list = panel.querySelector('#asistiaMobileList');
      if (!list || !panel.isConnected) return;
      list.replaceChildren();
      if (!result?.records?.length) {
        const empty = document.createElement('p');
        empty.className = 'hint';
        empty.textContent = 'Todavía no hay registros desde ASISTIA Móvil.';
        list.appendChild(empty);
      } else {
        result.records.slice(0,8).forEach(record => {
          const item = document.createElement('div');
          item.className = 'asistia-mobile-item';
          const info = document.createElement('div');
          const name = document.createElement('strong');
          name.textContent = record.fullName + (record.employeeNumber ? ' · ' + record.employeeNumber : '');
          const details = document.createElement('small');
          details.textContent = record.branch + ' · ' + new Date(record.occurredAt).toLocaleString('es-MX');
          info.append(name,details);
          const type = document.createElement('span');
          type.className = 'asistia-mobile-type' + (record.eventType === 'clock_out' ? ' out' : '');
          type.textContent = record.eventType === 'clock_in' ? 'ENTRADA' : 'SALIDA';
          item.append(info,type);
          list.appendChild(item);
        });
      }
    } catch {
      const list = panel.querySelector('#asistiaMobileList');
      if (list) list.textContent = 'No se pudo consultar el servicio local de asistencia móvil.';
    } finally { mobileActivityInFlight = false; }
  };

  addStyles();
  const sync = () => {
    ensureBadge();
    checkHealth();
    ensureEmployeeMobileActions();
    syncExistingEmployees();
    refreshMobileActivity();
  };
  const observer = new MutationObserver(sync);
  observer.observe(appRoot, { childList: true, subtree: true });
  sync();
  checkTrial();
  setInterval(checkTrial, 60000);
  setInterval(syncExistingEmployees, 8000);
  setInterval(refreshMobileActivity, 15000);
  window.addEventListener('focus', checkHealth);
  window.addEventListener('focus', checkTrial);
  window.addEventListener('focus', syncExistingEmployees);
})();
