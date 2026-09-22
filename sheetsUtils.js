const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// Siempre usa la ruta absoluta al credentials.json del backend
const CREDENTIALS_PATH = path.resolve(__dirname, 'credentials.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || 'TU_SPREADSHEET_ID_AQUI';

async function authorize() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`No se encontró el archivo de credenciales en: ${CREDENTIALS_PATH}`);
  }
  const rawCreds = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
  let credentials;
  try {
    credentials = JSON.parse(rawCreds);
  } catch (err) {
    throw new Error('El archivo credentials.json no es un JSON válido.');
  }
  let { client_email, private_key } = credentials;
  if (!client_email || !private_key) {
    throw new Error('El archivo credentials.json debe contener client_email y private_key.');
  }
  // Reemplazar \n por saltos de línea reales en la clave privada
  if (private_key.includes('\\n')) {
    private_key = private_key.replace(/\\n/g, '\n');
  }
  // Log para depuración
  console.log('[GOOGLE AUTH] client_email:', client_email ? 'OK' : 'FALTA', '| private_key:', private_key ? 'OK' : 'FALTA');
  const auth = new google.auth.JWT(
    client_email,
    null,
    private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return auth;
}

/**
 * Pestanas que ya se comprobaron, con su instante de caducidad.
 *
 * ensureSheetExists se llama antes de cada anexado, y cada llamada pedia la
 * estructura ENTERA del libro. Cinco anexados en una misma peticion eran cinco
 * lecturas de estructura para averiguar cinco veces lo mismo.
 *
 * Solo se memoriza lo POSITIVO (la pestana existe y tiene cabecera) y nunca lo
 * negativo: dar por hecho que algo no existe es lo que podria hacer que se
 * creara dos veces. Y se anota DESPUES de escribir la cabecera, nunca entre el
 * addSheet y la cabecera: si el proceso muriera en medio quedaria memorizada
 * una pestana sin cabecera, y una hoja sin cabecera deja su primera fila de
 * datos invisible para todo el backend, que lee siempre desde la fila 2.
 *
 * El plazo es corto (12 s, el mismo de la memoria de lecturas) a proposito: la
 * ganancia esta dentro de cada peticion, y a cambio la ventana en la que este
 * registro podria mentir (si alguien borra la pestana a mano) dura segundos y
 * no minutos.
 */
const vistas = new Map();
let TTL_MS = (() => {
  const n = Number(process.env.SHEETS_ENSURE_TTL_MS);
  if (Number.isFinite(n) && n >= 0) return n;
  return process.env.NODE_ENV === 'test' ? 0 : 12000;
})();

/** Cambia el plazo en caliente y devuelve el anterior. Lo usan las pruebas. */
function configurarEnsure(ms) {
  const antes = TTL_MS;
  const n = Number(ms);
  if (Number.isFinite(n) && n >= 0) TTL_MS = n;
  vistas.clear();
  return antes;
}

const claveDeHoja = (spreadsheetId, sheetTitle) => `${spreadsheetId}::${sheetTitle}`;

async function ensureSheetExists(sheetTitle, headers, sheetsApi, spreadsheetId) {
  // sheetsApi: instancia autenticada de google.sheets({ version: 'v4', auth })
  // spreadsheetId: string
  const clave = claveDeHoja(spreadsheetId, sheetTitle);
  if (TTL_MS > 0) {
    const caduca = vistas.get(clave);
    if (caduca && caduca > Date.now()) return;
  }

  const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId });
  const exists = spreadsheet.data.sheets.some(s => s.properties.title === sheetTitle);
  if (!exists) {
    // Crear la pestaña
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          { addSheet: { properties: { title: sheetTitle } } },
        ],
      },
    });
    // Escribir encabezados
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: `${sheetTitle}!A1:${String.fromCharCode(65 + headers.length - 1)}1`,
      valueInputOption: 'RAW',
      resource: { values: [headers] },
    });
  }
  // Solo aqui, con la pestana Y su cabecera puestas.
  if (TTL_MS > 0) vistas.set(clave, Date.now() + TTL_MS);
}

/** Para las pruebas y para cualquier caso en que haya que volver a mirar. */
function olvidarHojasVistas() {
  vistas.clear();
}

module.exports = { ensureSheetExists, olvidarHojasVistas, configurarEnsure };
