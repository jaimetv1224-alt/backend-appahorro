/**
 * loansService.js
 * Servicio CRUD para la hoja de Préstamos (Loans) en Google Sheets.
 * Esquema REAL posicional (consistente con approve-loan-request / obtener-prestamos):
 *   A=LoanID, B=UserEmail, C=GroupID, D=AmountApproved, E=StartDate, F=DueDate,
 *   G=InterestRate(mensual), H=Status, I=Term, J=Total
 */

const { getGoogleSheetsClient, SPREADSHEET_ID } = require('../googleSheets');
const auditLogService = require('./auditLogService');

const LOAN_COLUMNS = [
  'LoanID', 'UserEmail', 'GroupID', 'AmountApproved', 'StartDate', 'DueDate', 'InterestRate', 'Status', 'Term', 'Total'
];

const toMoney = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = (v == null ? '' : v).toString().trim().replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Crea un préstamo en la hoja Loans (esquema real, sin reescribir el header) y audita.
 */
async function createLoan(loan) {
  const sheets = await getGoogleSheetsClient();
  for (const col of ['LoanID', 'UserEmail', 'GroupID']) {
    if (!loan[col]) throw new Error(`Falta el campo requerido: ${col}`);
  }
  const principal = toMoney(loan.AmountApproved != null ? loan.AmountApproved : loan.Amount);
  if (!(principal > 0)) throw new Error('El monto del préstamo debe ser un número positivo.');
  const term = Number(loan.Term) > 0 ? Number(loan.Term) : 0;
  const rate = toMoney(loan.InterestRate);
  const total = toMoney(loan.Total) > 0 ? toMoney(loan.Total) : Math.round(principal * (1 + (rate / 100) * term) * 100) / 100;
  const startDate = loan.StartDate || loan.RequestDate || new Date().toISOString();
  // Estado lo decide el servidor: por defecto 'pendiente' salvo que se indique explícitamente
  const status = (loan.Status || 'pendiente').toString();

  const row = [
    loan.LoanID, loan.UserEmail, loan.GroupID, principal,
    startDate, loan.DueDate || '', rate, status, term, total,
  ];

  const response = await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Loans!A:J',
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] },
  });

  try {
    await auditLogService.logAction({
      action: 'CREATE', entity: 'Loan', entityId: loan.LoanID,
      performedBy: loan.UserEmail, details: JSON.stringify({ principal, term, rate, total, status }),
      timestamp: new Date().toISOString(),
    });
  } catch (e) { /* auditoría best-effort */ }
  return response.data;
}

/**
 * Obtiene todos los préstamos como objetos (esquema real posicional).
 */
async function getAllLoans() {
  const sheets = await getGoogleSheetsClient();
  let rows = [];
  try {
    const rowsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Loans!A2:J',
    });
    rows = rowsResp.data.values || [];
  } catch (e) {
    rows = [];
  }
  return rows.map(row => {
    const obj = {};
    LOAN_COLUMNS.forEach((h, i) => { obj[h] = row[i] || ''; });
    return obj;
  });
}

module.exports = {
  createLoan,
  getAllLoans,
  LOAN_COLUMNS,
};
