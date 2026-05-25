// Script utilitario para importar usuarios y grupos desde un archivo Excel
const xlsx = require('xlsx');
const path = require('path');
const { google } = require('googleapis');
require('dotenv').config();

const SERVICE_ACCOUNT_FILE = path.resolve(__dirname, 'credentials.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || 'TU_SPREADSHEET_ID_AQUI';

async function main() {
  const workbook = xlsx.readFile(path.resolve(__dirname, '../public/plantilla_importacion_usuarios_grupos.xlsx'));
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const users = xlsx.utils.sheet_to_json(sheet);

  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: 'https://www.googleapis.com/auth/spreadsheets',
  });
  const client = await auth.getClient();
  const sheetsApi = google.sheets({ version: 'v4', auth: client });

  // Asegura cabeceras en Users
  const headers = ['Username','Email','Group','GroupRole','Password'];
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A1:E1',
    valueInputOption: 'RAW',
    resource: { values: [headers] },
  });

  // Inserta usuarios
  const values = users.map(u => [u.Username, u.Email, u.Group, u.GroupRole, u.Password]);
  await sheetsApi.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A2:E',
    valueInputOption: 'RAW',
    resource: { values },
  });

  // Crea pestañas de grupos si no existen
  const groupNames = [...new Set(users.map(u => u.Group))];
  const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);
  for (const group of groupNames) {
    if (!existingSheets.includes(group)) {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { requests: [{ addSheet: { properties: { title: group } } }] },
      });
    }
  }
  console.log('Importación completada.');
}

main().catch(console.error);
