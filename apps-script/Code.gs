/**
 * ASISTIA — Registro del curso gratuito y solicitudes de demo.
 * Implementación para Google Apps Script como Web App.
 * Primera ejecución: crea automáticamente una hoja de cálculo y guarda su ID.
 */
const SHEET_NAME = "Registros";
const HEADERS = [
  "Fecha de registro", "Nombre", "Correo", "Empresa", "Puesto",
  "Aceptó aviso", "Aceptó marketing", "Token", "Fuente", "Campaña",
  "Página", "Curso completado", "Fecha de solicitud demo"
];

function doPost(e) {
  try {
    const data = JSON.parse((e && e.postData && e.postData.contents) || "{}");
    if (data.hp) return json_({ ok: true }); // honeypot anti-spam
    const action = String(data.action || "");
    if (action === "register") return register_(data);
    if (action === "complete_course") return completeCourse_(data);
    return json_({ ok: false, error: "Acción no válida" });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.action !== "check") return ContentService.createTextOutput("ASISTIA endpoint activo");
  const token = String(p.token || "");
  const result = checkToken_(token, p.demo === "1");
  const callback = String(p.callback || "");
  if (!/^[A-Za-z_$][0-9A-Za-z_$]*$/.test(callback)) return json_(result);
  return ContentService.createTextOutput(callback + "(" + JSON.stringify(result) + ");")
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function register_(d) {
  if (!d.privacy) return json_({ ok: false, error: "Se requiere aceptar el aviso de privacidad." });
  const token = String(d.token || "");
  const email = String(d.email || "").trim().toLowerCase();
  const name = String(d.name || "").trim();
  if (!token || !email || !name) return json_({ ok: false, error: "Faltan datos obligatorios." });
  const sheet = sheet_();
  const existing = findToken_(sheet, token);
  if (existing) return json_({ ok: true, duplicate: true });
  sheet.appendRow([
    new Date(), name, email, String(d.company || ""), String(d.role || ""),
    true, !!d.marketing, token, String(d.source || "directo"),
    String(d.campaign || ""), String(d.page || ""), false, ""
  ]);
  return json_({ ok: true });
}

function completeCourse_(d) {
  const token = String(d.token || "");
  if (!token) return json_({ ok: false, error: "Token faltante." });
  const sheet = sheet_();
  const row = findToken_(sheet, token);
  if (!row) return json_({ ok: false, error: "Registro no encontrado." });
  sheet.getRange(row, 12).setValue(true);
  sheet.getRange(row, 13).setValue(new Date());
  return json_({ ok: true, demoRequested: true });
}

function checkToken_(token, requireDemo) {
  if (!token) return { ok: false };
  const sheet = sheet_();
  const row = findToken_(sheet, token);
  if (!row) return { ok: false };
  const demo = sheet.getRange(row, 12).getValue() === true;
  return { ok: true, demoRequested: requireDemo ? demo : true };
}

function findToken_(sheet, token) {
  const last = sheet.getLastRow();
  if (last < 2) return 0;
  const found = sheet.getRange(2, 8, last - 1, 1)
    .createTextFinder(token).matchEntireCell(true).findNext();
  return found ? found.getRow() : 0;
}

function sheet_() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty("ASISTIA_SHEET_ID");
  let ss;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create("ASISTIA — Registros del curso gratuito");
    props.setProperty("ASISTIA_SHEET_ID", ss.getId());
  }
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
