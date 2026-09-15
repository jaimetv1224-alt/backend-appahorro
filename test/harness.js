/**
 * Arnes de pruebas del backend JuntaGO.
 *
 * Arranca server.js REAL (mismo middleware, mismas rutas, mismo gate de auth)
 * pero sustituyendo 'googleapis' por el emulador en memoria. Permite ejecutar
 * cientos de aserciones sin tocar la hoja real ni gastar cuota.
 */

const Module = require('module');
const path = require('path');

const FAKE_PATH = require.resolve('./fake-googleapis.js');

// --- Intercepta require('googleapis') en server.js y en services/* ---
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === 'googleapis') return FAKE_PATH;
  return originalResolve.call(this, request, ...args);
};

const fake = require('./fake-googleapis.js').__fake;

// --- Entorno de prueba ---
process.env.SPREADSHEET_ID = 'TEST_SPREADSHEET';
process.env.GOOGLE_CREDENTIALS = JSON.stringify({
  type: 'service_account',
  client_email: 'test@test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n',
});
process.env.JWT_SECRET = 'test-secret-para-pruebas-locales';
process.env.NODE_ENV = 'test';
process.env.PORT = process.env.TEST_PORT || '3987';

const BASE = `http://127.0.0.1:${process.env.PORT}`;

// --- Silencia el ruido de logs del servidor salvo que se pida verbose ---
const VERBOSE = process.argv.includes('--verbose');
const realLog = console.log;
const realWarn = console.warn;
const realError = console.error;
function quiet() {
  if (VERBOSE) return;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
}
function loud() {
  console.log = realLog;
  console.warn = realWarn;
  console.error = realError;
}

/** Siembra un libro de calculo con la estructura real de JuntaGO. */
function seedWorkbook() {
  fake.reset();
  fake.seedSheet('Users', [
    ['Username', 'Email', 'HashedPassword', 'Role', 'Balance', 'CreatedDate', 'Telefono', 'Cedula', 'Estado'],
  ]);
  fake.seedSheet('Groups', [[
    'GroupID', 'GroupName', 'Description', 'Presidente', 'CreatedBy', 'CreatedDate',
    'TargetAmount', 'CurrentAmount', 'MonthlyContribution', 'StartDate', 'EndDate',
    'Status', 'MaxMembers', 'Miembros', 'TipoGrupo', 'ValorAccion', 'PorcentajeInteresMensual',
  ]]);
  fake.seedSheet('UserGroupLinks', [['UserEmail', 'GroupID', 'JoinDate', 'GroupRole', 'Estado', 'InvitedBy']]);
  fake.seedSheet('Savings', [['UserEmail', 'GroupID', 'Amount', 'Date', 'Type', 'Description']]);
  fake.seedSheet('Acciones', [['UserEmail', 'GroupID', 'Date', 'Shares', 'ShareValue', 'InterestRate', 'CreatedAt']]);
  fake.seedSheet('Loans', [[
    'LoanID', 'UserEmail', 'GroupID', 'AmountApproved', 'StartDate', 'DueDate',
    'InterestRate', 'Status', 'Term', 'Total',
  ]]);
  // Mismo encabezado que escribe upload-payment (A..O)
  fake.seedSheet('LoanPayments', [[
    'PaymentID', 'UserEmail', 'LoanID', 'Amount', 'PaymentDate', 'Description', 'Status',
    'ImageFilename', 'OriginalImageName', 'ImagePath', 'ImageSize', 'CreatedAt',
    'ApprovedBy', 'ApprovalDate', 'ApprovalNotes',
  ]]);
  fake.seedSheet('Transactions', [[
    'TransactionID', 'UserEmail', 'Type', 'Amount', 'Description', 'Date', 'Category', 'Icon',
  ]]);
  fake.seedSheet('SolicitudesPrestamos', [[
    'ID', 'UserEmail', 'Group', 'GroupRole', 'Monto', 'Estado', 'Fecha', 'Detalles', 'AprobadoPor', 'TasaInteres',
  ]]);
  fake.seedSheet('SolicitudesAcciones', [[
    'ID', 'UserEmail', 'Group', 'GroupRole', 'Cantidad', 'Estado', 'Fecha', 'Detalles', 'AprobadoPor',
  ]]);
  fake.seedSheet('SolicitudesAdelantos', [[
    'ID', 'UserEmail', 'Group', 'GroupRole', 'Monto', 'Estado', 'Fecha', 'Detalles', 'AprobadoPor',
  ]]);
  // Mismo encabezado que crea createSavingsGoalsSheetIfNotExists (12 columnas)
  fake.seedSheet('MetasAhorro', [[
    'ID', 'Email', 'GroupID', 'Nombre', 'MontoObjetivo', 'MontoActual',
    'FechaObjetivo', 'Descripcion', 'Prioridad', 'Categoria', 'Estado', 'FechaCreacion',
  ]]);
  // Las cinco de verdad. services/auditLogService.js define
  // ['LogID','UserEmail','Action','Target','Date'] y reescribe A1:E1 en cuanto ve otra
  // cosa; con cuatro columnas sembradas, cualquier prueba que leyera Action y Target
  // miraba los indices 1 y 2 cuando estan en el 2 y el 3.
  fake.seedSheet('AuditLog', [['LogID', 'UserEmail', 'Action', 'Target', 'Date']]);
}

// Cobertura: se anota cada peticion para saber al final que endpoints no toco
// ninguna bateria. Lo que nadie prueba es justo donde se esconden los fallos.
const cobertura = new Set();
function anotar(method, url) {
  cobertura.add(`${method.toUpperCase()} ${url.split('?')[0]}`);
}

/** Cliente HTTP minimo contra el backend arrancado. */
async function api(method, url, { token, body, raw } = {}) {
  anotar(method, url);
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return raw ? { status: res.status, json, text } : { status: res.status, body: json, text };
}

/**
 * POST multipart (subida de archivos). Se usa un ayudante propio para que estas
 * llamadas tambien cuenten en el informe de cobertura: antes se hacian con fetch
 * directo y el contador las daba por no probadas.
 */
/**
 * Un PNG de 1x1 de VERDAD.
 *
 * El servidor comprueba los primeros bytes del archivo subido, porque el tipo
 * que declara el navegador se puede falsear (un shell.php enviado como
 * image/png pasaba el filtro). Las pruebas tienen que subir una imagen real,
 * como la subiria una socia con la camara del telefono.
 */
const PNG_PRUEBA = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');

async function postArchivo(url, campos, archivo, token) {
  anotar('POST', url);
  const form = new FormData();
  Object.entries(campos || {}).forEach(([k, v]) => form.append(k, String(v)));
  if (archivo) {
    form.append(archivo.campo, new Blob([archivo.contenido], { type: archivo.tipo || 'application/octet-stream' }), archivo.nombre);
  }
  const res = await fetch(BASE + url, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, body: json, text };
}

/**
 * El dia de hoy en el CALENDARIO DE QUIEN USA LA APP, no en UTC.
 *
 * `new Date().toISOString().split('T')[0]` devuelve manana a partir de las 19:00
 * en Ecuador (UTC-5). Las pruebas lo usaban como "hoy" y, como el servidor
 * rechaza las fechas futuras, la bateria se ponia roja todas las tardes: medido,
 * 20 fallas con el reloj a las 20:00 y 0 con el reloj a las 16:00.
 */
function hoyLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const get = (url, token) => api('GET', url, { token });
const post = (url, body, token) => api('POST', url, { body, token });
const put = (url, body, token) => api('PUT', url, { body, token });
const del = (url, token) => api('DELETE', url, { token });

let serverStarted = false;
async function startServer() {
  if (serverStarted) return;
  quiet(); // el servidor loguea cada request; se silencia salvo --verbose
  require(path.resolve(__dirname, '..', 'server.js'));
  // Espera a que el puerto responda
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(BASE + '/api/ping');
      if (r.ok || r.status === 200) { serverStarted = true; break; }
    } catch (e) { /* aun no escucha */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!serverStarted) { loud(); throw new Error('El servidor de pruebas no arranco'); }
}

module.exports = { PNG_PRUEBA, hoyLocal, fake, seedWorkbook, api, get, post, put, del, postArchivo, startServer, quiet, loud, BASE, VERBOSE, cobertura, anotar };
