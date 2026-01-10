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
const { v4: uuidv4 } = require('uuid');
const SERVICE_ACCOUNT_FILE = path.resolve(__dirname, '../credentials.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA';

let sheets;
(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: 'https://www.googleapis.com/auth/spreadsheets',
  });
  const client = await auth.getClient();
  sheets = google.sheets({ version: 'v4', auth: client });
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
