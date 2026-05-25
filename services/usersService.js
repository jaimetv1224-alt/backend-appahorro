/**
 * SERVICE: Users
 * Pestaña "Users" en Google Sheets:
 *   - Username
 *   - Email
 *   - HashedPassword
 *   - Role
 *   - Balance
 *   - CreatedDate
 */
const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA';
const USERS_HEADERS = ['Username', 'Email', 'HashedPassword', 'Role', 'Balance', 'CreatedDate'];
const VALID_GLOBAL_ROLES = new Set(['admin', 'member']);

let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (e) {
    console.error('[USERS SERVICE] Error al parsear GOOGLE_CREDENTIALS:', e.message);
  }
} else {
  const SERVICE_ACCOUNT_FILE = path.resolve(__dirname, '../credentials.json');
  if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    try {
      googleCredentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf-8'));
    } catch (e) {
      console.error('[USERS SERVICE] Error al leer credentials.json:', e.message);
    }
  }
}

let sheetsClient = null;
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!googleCredentials) {
    throw new Error('Google credentials not available');
  }

  const auth = new google.auth.GoogleAuth({
    credentials: googleCredentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });

  const client = await auth.getClient();
  sheetsClient = google.sheets({ version: 'v4', auth: client });
  return sheetsClient;
}

const normalizeEmail = (value) => (value || '').toString().trim().toLowerCase();
const normalizeRole = (value) => {
  const role = (value || '').toString().trim().toLowerCase();
  return VALID_GLOBAL_ROLES.has(role) ? role : 'member';
};
const isLikelyBcryptHash = (value) => /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test((value || '').toString().trim());

async function ensureUsersHeader() {
  const sheets = await getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!1:1',
  });

  const headers = resp.data.values?.[0] || [];
  if (headers.length < USERS_HEADERS.length || USERS_HEADERS.some((h, i) => headers[i] !== h)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Users!A1:F1',
      valueInputOption: 'RAW',
      resource: { values: [USERS_HEADERS] },
    });
  }
}

async function listAllUsers() {
  const sheets = await getSheetsClient();
  await ensureUsersHeader();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A2:F',
  });

  return res.data.values || [];
}

async function getUserByEmail(email) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return null;

  const all = await listAllUsers();
  return all.find((row) => normalizeEmail(row?.[1]) === targetEmail) || null;
}

async function createUser(user) {
  await ensureUsersHeader();

  const username = (user?.Username || '').toString().trim();
  const email = normalizeEmail(user?.Email);
  const password = (user?.Password || '').toString();
  const importedHash = (user?.HashedPassword || '').toString().trim();
  const role = normalizeRole(user?.Role);
  const balance = Number(user?.Balance);
  const hasPassword = password.length > 0;
  const hasImportedHash = importedHash.length > 0;

  if (!username || !email || (!hasPassword && !hasImportedHash) || Number.isNaN(balance)) {
    throw new Error('Faltan datos obligatorios');
  }

  const existing = await getUserByEmail(email);
  if (existing) {
    const err = new Error('El usuario ya existe');
    err.code = 'USER_EXISTS';
    throw err;
  }

  let hashedPassword = '';
  if (hasImportedHash && isLikelyBcryptHash(importedHash)) {
    hashedPassword = importedHash;
  } else if (hasPassword) {
    hashedPassword = bcrypt.hashSync(password, 10);
  } else {
    throw new Error('La contraseña importada no tiene un formato válido.');
  }
  const row = [
    username,
    email,
    hashedPassword,
    role,
    balance,
    new Date().toISOString(),
  ];

  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A2:F2',
    valueInputOption: 'RAW',
    resource: { values: [row] },
  });

  const auditLogService = require('./auditLogService');
  await auditLogService.log({
    UserEmail: email,
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
