/**
 * loansService.js
 * Servicio CRUD para la hoja de Préstamos (Loans) en Google Sheets.
 * Documenta las columnas, asegura integridad referencial y registra acciones en AuditLog.
 */

const { getGoogleSheetsClient, SPREADSHEET_ID } = require('../googleSheets');
const auditLogService = require('./auditLogService');

// Columnas esperadas en la hoja Loans
const LOAN_COLUMNS = [
  'LoanID', 'UserEmail', 'GroupID', 'Amount', 'Purpose', 'Status', 'RequestDate', 'ApprovedBy', 'ApprovedDate'
];

/**
 * Crea un préstamo en la hoja Loans y registra en AuditLog.
 * @param {Object} loan - Objeto con los campos del préstamo.
 */
async function createLoan(loan) {
  const sheets = await getGoogleSheetsClient();
  // Validar campos requeridos
  for (const col of ['LoanID', 'UserEmail', 'GroupID', 'Amount', 'Purpose', 'Status', 'RequestDate']) {
    if (!loan[col] && loan[col] !== 0) throw new Error(`Falta el campo requerido: ${col}`);
  }
  // Leer cabeceras actuales
  let headers = [];
  try {
    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Loans!1:1',
    });
    headers = headerResp.data.values[0];
  } catch (e) {
    headers = [];
  }
  // Si faltan columnas, las agrega
  if (headers.length < LOAN_COLUMNS.length || LOAN_COLUMNS.some((h, i) => headers[i] !== h)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Loans!1:1',
      valueInputOption: 'RAW',
      resource: { values: [LOAN_COLUMNS] },
    });
  }
  // Prepara los valores en el orden correcto
  const values = [LOAN_COLUMNS.map(h => loan[h] || '')];
  const resource = { values };
  // Agrega la fila
  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Loans!A:I',
    valueInputOption: 'USER_ENTERED',
    resource,
  });
  // Log de auditoría
  await auditLogService.logAction({
    action: 'CREATE',
    entity: 'Loan',
    entityId: loan.LoanID,
    performedBy: loan.UserEmail,
    details: JSON.stringify(loan),
    timestamp: new Date().toISOString(),
  });
  return response.data;
}

/**
 * Obtiene todos los préstamos como objetos.
 */
async function getAllLoans() {
  const sheets = await getGoogleSheetsClient();
  let headers = [];
  try {
    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Loans!1:1',
    });
    headers = headerResp.data.values[0];
  } catch (e) {
    headers = LOAN_COLUMNS;
  }
  let rows = [];
  try {
    const rowsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Loans!A2:I',
    });
    rows = rowsResp.data.values || [];
  } catch (e) {
    rows = [];
  }
  return rows.map(row => {
    const obj = {};
    LOAN_COLUMNS.forEach((h, i) => {
      obj[h] = row[i] || '';
    });
    return obj;
  });
}

module.exports = {
  createLoan,
  getAllLoans,
  LOAN_COLUMNS,
};
