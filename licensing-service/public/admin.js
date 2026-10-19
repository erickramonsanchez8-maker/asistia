(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  let adminToken = '';
  let lastIssuedCode = '';
  const workspace = $('workspace');
  const setStatus = (node, message, type = '') => {
    node.textContent = message;
    node.className = 'status' + (type ? ' ' + type : '');
  };
  async function api(path, options = {}) {
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + adminToken,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      cache: 'no-store', credentials: 'same-origin', redirect: 'error'
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'La solicitud falló (HTTP ' + response.status + ').');
    return data;
  }
  function makeCell(text, className = '') {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text == null ? '' : String(text);
    return td;
  }
  function actionButton(label, action, id, className = 'secondary') {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = label; button.dataset.action = action; button.dataset.id = id;
    button.className = className;
    return button;
  }
  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? 'Fecha no disponible' : new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' }).format(date);
  }
  async function loadLicenses() {
    setStatus($('listStatus'), 'Consultando registro…');
    try {
      const result = await api('/v1/admin/licenses?limit=100&offset=0');
      const tbody = $('licenseRows'); tbody.replaceChildren();
      if (!result.licenses.length) {
        const row = document.createElement('tr'), cell = makeCell('Aún no se han emitido licencias.', 'empty');
        cell.colSpan = 5; row.append(cell); tbody.append(row);
      }
      for (const license of result.licenses) {
        const row = document.createElement('tr');
        const identity = document.createElement('td');
        const company = document.createElement('strong'); company.textContent = license.companyId;
        const plan = document.createElement('small'); plan.textContent = license.planCode + ' · ' + license.licenseId;
        identity.append(company, plan); row.append(identity);
        const statusCell = document.createElement('td');
        const badge = document.createElement('span'); badge.className = 'state' + (license.status === 'suspended' ? ' suspended' : license.status === 'revoked' ? ' revoked' : license.status === 'scheduled' ? ' suspended' : '');
        badge.textContent = license.status === 'active' ? 'ACTIVA' : license.status === 'scheduled' ? 'PROGRAMADA' : license.status === 'suspended' ? 'SUSPENDIDA' : 'REVOCADA';
        statusCell.append(badge); row.append(statusCell);
        row.append(makeCell(formatDate(license.startsAt) + ' — ' + formatDate(license.expiresAt)));
        row.append(makeCell(String(license.activeDevices) + ' / ' + 'máx. ' + license.maxDevices));
        const actions = document.createElement('td'), group = document.createElement('div'); group.className = 'actions';
        if (license.status === 'active' || license.status === 'scheduled') {
          group.append(actionButton('Renovar', 'renew', license.licenseId));
          group.append(actionButton('Nuevo código', 'code', license.licenseId));
          group.append(actionButton('Suspender', 'suspend', license.licenseId, 'secondary'));
          group.append(actionButton('Revocar', 'revoke', license.licenseId, 'danger'));
        } else if (license.status === 'suspended') {
          group.append(actionButton('Reactivar', 'resume', license.licenseId));
          group.append(actionButton('Revocar', 'revoke', license.licenseId, 'danger'));
        }
        actions.append(group); row.append(actions); tbody.append(row);
      }
      const suffix = result.pagination.total > result.licenses.length ? ' · mostrando las primeras ' + result.licenses.length + ' de ' + result.pagination.total : '';
      setStatus($('listStatus'), 'Registro actualizado: ' + result.pagination.total + ' licencia(s).' + suffix, 'success');
    } catch (error) { setStatus($('listStatus'), error.message, 'error'); }
  }
  $('authForm').addEventListener('submit', async event => {
    event.preventDefault();
    adminToken = $('adminToken').value.trim();
    if (adminToken.length < 32) { setStatus($('authStatus'), 'El token debe tener al menos 32 caracteres.', 'error'); return; }
    try {
      await api('/v1/admin/licenses?limit=1');
      workspace.hidden = false;
      $('adminToken').value = '';
      setStatus($('authStatus'), 'Conexión administrativa verificada.', 'success');
      await loadLicenses();
    } catch (error) {
      adminToken = '';
      setStatus($('authStatus'), error.message, 'error');
    }
  });
  $('issueForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (!adminToken) return;
    const form = new FormData(event.currentTarget);
    const body = {
      companyId: String(form.get('companyId')).trim(),
      planCode: String(form.get('planCode')).trim(),
      maxEmployees: Number(form.get('maxEmployees')),
      maxDevices: Number(form.get('maxDevices')),
      startsAt: new Date(String(form.get('startsAt')) + 'T00:00:00.000Z').toISOString(),
      expiresAt: new Date(String(form.get('expiresAt')) + 'T23:59:59.999Z').toISOString()
    };
    if (String(form.get('expiresAt')) <= String(form.get('startsAt'))) {
      setStatus($('listStatus'), 'El vencimiento debe ser posterior a la fecha de inicio.', 'error');
      return;
    }
    try {
      const result = await api('/v1/admin/licenses', { method: 'POST', body });
      lastIssuedCode = result.activationCode;
      $('issuedCodeValue').textContent = lastIssuedCode;
      $('issuedCode').hidden = false;
      setStatus($('listStatus'), 'Licencia emitida. Copia y entrega el código de activación ahora.', 'success');
      await loadLicenses();
    } catch (error) { setStatus($('listStatus'), error.message, 'error'); }
  });
  $('copyCode').addEventListener('click', async () => {
    if (!lastIssuedCode) return;
    try { await navigator.clipboard.writeText(lastIssuedCode); $('copyCode').textContent = 'Copiado'; }
    catch { setStatus($('listStatus'), 'No se pudo copiar automáticamente. Selecciona y copia el código manualmente.', 'error'); }
  });
  $('refreshList').addEventListener('click', loadLicenses);
  $('licenseRows').addEventListener('click', async event => {
    const button = event.target.closest('button[data-action]');
    if (!button || !adminToken) return;
    const { action, id } = button.dataset;
    try {
      if (action === 'renew') {
        const date = prompt('Nueva fecha de vencimiento (AAAA-MM-DD). Debe ser posterior al vencimiento actual.', '');
        if (!date || !/^\\d{4}-\\d{2}-\\d{2}$/.test(date)) return;
        if (!confirm('¿Extender la licencia hasta el final del día ' + date + ' UTC?')) return;
        await api('/v1/admin/licenses/' + encodeURIComponent(id) + '/renew', { method: 'POST', body: { expiresAt: new Date(date + 'T23:59:59.999Z').toISOString() } });
      } else if (action === 'code') {
        if (!confirm('El código nuevo invalida cualquier código de activación pendiente. ¿Continuar?')) return;
        const result = await api('/v1/admin/licenses/' + encodeURIComponent(id) + '/activation-code', { method: 'POST', body: {} });
        lastIssuedCode = result.activationCode;
        $('issuedCodeValue').textContent = lastIssuedCode;
        $('issuedCode').hidden = false;
        window.scrollTo({ top: $('issuedCode').getBoundingClientRect().top + window.scrollY - 20, behavior: 'smooth' });
      } else if (action === 'suspend') {
        if (!confirm('¿Suspender esta licencia? Los equipos conectados que validen con el servidor serán rechazados; un equipo desconectado puede conservar acceso temporal hasta su validación local.')) return;
        await api('/v1/admin/licenses/' + encodeURIComponent(id) + '/suspend', { method: 'POST', body: {} });
      } else if (action === 'resume') {
        if (!confirm('¿Reactivar esta licencia?')) return;
        await api('/v1/admin/licenses/' + encodeURIComponent(id) + '/resume', { method: 'POST', body: {} });
      } else if (action === 'revoke') {
        if (!confirm('La revocación es permanente desde este panel. ¿Revocar esta licencia?')) return;
        await api('/v1/admin/licenses/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: {} });
      }
      await loadLicenses();
    } catch (error) { setStatus($('listStatus'), error.message, 'error'); }
  });
})();