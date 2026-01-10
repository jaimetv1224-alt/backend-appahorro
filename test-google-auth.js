const { google } = require('googleapis');
const path = require('path');

async function test() {
  const auth = new google.auth.GoogleAuth({
    keyFile: path.resolve(__dirname, 'credentials.json'),
    scopes: 'https://www.googleapis.com/auth/spreadsheets',
  });
  const sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  const spreadsheetId = '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA'; // <-- pon aquí el ID de tu hoja
  try {
    const res = await sheets.spreadsheets.get({ spreadsheetId });
    console.log('¡Acceso exitoso!', res.data.properties.title);
  } catch (e) {
    console.error('Error de acceso:', e);
  }
}

test();
