/**
 * SERVICE: AuditLog
 * Pestaña "AuditLog" en Google Sheets:
 *   - LogID      : UUID único
 *   - UserEmail  : email del usuario
 *   - Action     : acción realizada (create, update, delete, etc)
 *   - Target     : entidad objetivo (Users, Groups, etc)
 *   - Date       : fecha ISO
 */
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA';

// Obtener credenciales desde variable de entorno o archivo
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (e) {
    console.error('[AUDIT LOG SERVICE] Error al parsear GOOGLE_CREDENTIALS:', e.message);
  }
} else {
  const SERVICE_ACCOUNT_FILE = path.resolve(__dirname, '../credentials.json');
  if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    try {
      googleCredentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf-8'));
    } catch (e) {
      console.error('[AUDIT LOG SERVICE] Error al leer credentials.json:', e.message);
    }
  }
}

let sheets;
(async () => {
  if (googleCredentials) {
    const auth = new google.auth.GoogleAuth({
      credentials: googleCredentials,
      scopes: 'https://www.googleapis.com/auth/spreadsheets',
    });
    const client = await auth.getClient();
    sheets = google.sheets({ version: 'v4', auth: client });
  }
})();

const AUDIT_HEADERS = ['LogID','UserEmail','Action','Target','Date'];

async function ensureAuditHeader() {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'AuditLog!1:1',
  });
  const headers = resp.data.values[0] || [];
  if (headers.length < AUDIT_HEADERS.length || AUDIT_HEADERS.some((h, i) => headers[i] !== h)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'AuditLog!A1:E1',
      valueInputOption: 'RAW',
      resource: { values: [AUDIT_HEADERS] },
    });
  }
}

async function log({ UserEmail, Action, Target, Date }) {
  await ensureAuditHeader();
  const row = [uuidv4(), UserEmail, Action, Target, Date];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'AuditLog!A2:E2',
    valueInputOption: 'RAW',
    resource: { values: [row] },
  });
}

module.exports = { log };
