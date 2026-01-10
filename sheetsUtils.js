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

async function ensureSheetExists(sheetTitle, headers, sheetsApi, spreadsheetId) {
  // sheetsApi: instancia autenticada de google.sheets({ version: 'v4', auth })
  // spreadsheetId: string
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
}

module.exports = { ensureSheetExists };
