const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const SPREADSHEET_ID = 'TU_SPREADSHEET_ID_AQUI'; // <-- Cambia esto por tu ID real
const SHEET_NAME = 'usuarios'; // <-- Cambia esto por el nombre de tu hoja

async function authorize() {
  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_email, private_key } = credentials;
  const auth = new google.auth.JWT(
    client_email,
    null,
    private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  await auth.authorize();
  return auth;
}

async function findUser(email, password) {
  const auth = await authorize();
  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: SHEET_NAME,
  });
  const rows = res.data.values;
  if (!rows || rows.length === 0) return null;
  // Suponiendo que la primera fila es encabezado
  const headers = rows[0];
  const emailIdx = headers.indexOf('email');
  const passIdx = headers.indexOf('password');
  for (let i = 1; i < rows.length; i++) {
    if (
      rows[i][emailIdx] === email &&
      rows[i][passIdx] === password
    ) {
      // Devuelve el usuario completo (puedes ajustar esto)
      return Object.fromEntries(headers.map((h, idx) => [h, rows[i][idx]]));
    }
  }
  return null;
}

module.exports = { findUser };
