const { google } = require('googleapis');
const path = require('path');
require('dotenv').config();

const SERVICE_ACCOUNT_FILE = path.resolve(__dirname, 'credentials.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA';

async function createLoansSheet() {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: 'https://www.googleapis.com/auth/spreadsheets',
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sheetTitle = 'Loans';
  // Verifica si ya existe
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = spreadsheet.data.sheets.some(s => s.properties.title === sheetTitle);
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetTitle } } }],
      },
    });
    // Escribe cabeceras
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetTitle}!A1:L1`,
      valueInputOption: 'RAW',
      resource: {
        values: [[
          'LoanID', 'Borrower', 'Amount', 'Purpose', 'InterestRate', 'Term', 'MonthlyPayment', 'RemainingBalance', 'Status', 'ApprovalDate', 'NextPaymentDate', 'Guarantor', 'Collateral'
        ]],
      },
    });
    console.log('Pestaña Loans creada con cabeceras.');
  } else {
    console.log('La pestaña Loans ya existe.');
  }
}

createLoansSheet().catch(console.error);
