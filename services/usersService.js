/**
 * SERVICE: Users
 * Pestaña "Users" en Google Sheets:
 *   - Username       : nombre de usuario único
 *   - Email          : email (clave primaria)
 *   - HashedPassword : contraseña en hash
 *   - Role           : rol global (admin, miembro)
 *   - Balance        : saldo total disponible
 *   - CreatedDate    : ISO timestamp de creación
 */
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
const SERVICE_ACCOUNT_FILE = path.resolve(__dirname, '../credentials.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA';

// Google Sheets Auth
let sheets;
(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_FILE,
    scopes: 'https://www.googleapis.com/auth/spreadsheets',
  });
  const client = await auth.getClient();
  sheets = google.sheets({ version: 'v4', auth: client });
})();

const USERS_HEADERS = ['Username','Email','HashedPassword','Role','Balance','CreatedDate'];

async function ensureUsersHeader() {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!1:1',
  });
  const headers = resp.data.values[0] || [];
  if (headers.length < USERS_HEADERS.length || USERS_HEADERS.some((h, i) => headers[i] !== h)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Users!A1:F1',
      valueInputOption: 'RAW',
      resource: { values: [USERS_HEADERS] },
    });
  }
}

/**
 * Listar todos los usuarios
 */
async function listAllUsers() {
  await ensureUsersHeader();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A2:F',
  });
  return res.data.values || [];
}

/**
 * Buscar usuario por email
 */
async function getUserByEmail(email) {
  const all = await listAllUsers();
  return all.find(row => row[1] === email);
}

/**
 * Crear usuario
 */
async function createUser(user) {
  await ensureUsersHeader();
  // Validaciones básicas
  if (!user.Username || !user.Email || !user.Password || user.Role === undefined || user.Balance === undefined) {
    throw new Error('Faltan datos obligatorios');
  }
  // Hash de contraseña
  const saltRounds = 10;
  const hashedPassword = bcrypt.hashSync(user.Password, saltRounds);
  const row = [
    user.Username,
    user.Email,
    hashedPassword,
    user.Role,
    user.Balance,
    new Date().toISOString(),
  ];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A2:F2',
    valueInputOption: 'RAW',
    resource: { values: [row] },
  });
  // Audit log
  const auditLogService = require('./auditLogService');
  await auditLogService.log({
    UserEmail: user.Email,
    Action: 'create',
    Target: 'Users',
    Date: new Date().toISOString(),
  });
  return row;
}

module.exports = {
  listAllUsers,
  getUserByEmail,
  createUser,
};
