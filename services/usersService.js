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
const { envolver: envolverHoja } = require('../hoja');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA';
const USERS_HEADERS = ['Username', 'Email', 'HashedPassword', 'Role', 'Balance', 'CreatedDate', 'Telefono', 'Cedula', 'Estado'];
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
  sheetsClient = envolverHoja(google.sheets({ version: 'v4', auth: client }));
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
      range: 'Users!A1:I1',
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
    range: 'Users!A2:I',
  });

  return res.data.values || [];
}

async function getUserByEmail(email) {
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return null;

  const all = await listAllUsers();
  return all.find((row) => normalizeEmail(row?.[1]) === targetEmail) || null;
}

/**
 * Comprueba y normaliza los datos de una persona SIN tocar la hoja.
 *
 * Esta parte estaba metida dentro de createUser, y por eso dar de alta a 52
 * socias costaba 52 lecturas de la hoja entera: no habia forma de preparar las
 * filas primero y escribirlas todas juntas despues.
 */
function normalizarUsuario(user) {
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

  return {
    username,
    email,
    password,
    importedHash,
    role,
    balance,
    hasPassword,
    hasImportedHash,
    telefono: (user?.Telefono || '').toString().trim(),
    cedula: (user?.Cedula || '').toString().trim(),
    estado: (user?.Estado || 'activo').toString().trim().toLowerCase(),
  };
}

/**
 * Las nueve celdas de la fila de Users, ya con la clave cifrada.
 *
 * El cifrado va por la version asincrona a proposito: bcrypt.hashSync con 52
 * personas seguidas deja el servidor congelado varios segundos y nadie mas
 * puede entrar mientras tanto.
 */
async function filaDeUsuario(norm) {
  let hashedPassword = '';
  if (norm.hasImportedHash && isLikelyBcryptHash(norm.importedHash)) {
    hashedPassword = norm.importedHash;
  } else if (norm.hasPassword) {
    hashedPassword = await bcrypt.hash(norm.password, 10);
  } else {
    throw new Error('La contraseña importada no tiene un formato válido.');
  }

  return [
    norm.username,
    norm.email,
    hashedPassword,
    norm.role,
    norm.balance,
    new Date().toISOString(),
    norm.telefono,
    norm.cedula,
    norm.estado,
  ];
}

/** Prepara la fila de una persona sin escribir nada. Para altas en lote. */
async function prepararFilaUsuario(user) {
  return filaDeUsuario(normalizarUsuario(user));
}

/**
 * Escribe MUCHAS personas de una sola vez: un append y un registro de
 * auditoria, en lugar de dos por cabeza.
 */
async function crearUsuariosEnLote(filas) {
  const lote = (filas || []).filter((f) => Array.isArray(f) && f.length);
  if (!lote.length) return 0;

  await ensureUsersHeader();
  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A2:I2',
    valueInputOption: 'RAW',
    resource: { values: lote },
  });

  const auditLogService = require('./auditLogService');
  await auditLogService.log({
    UserEmail: lote[0][1],
    Action: `create_lote_${lote.length}`,
    Target: 'Users',
    Date: new Date().toISOString(),
  });

  return lote.length;
}

async function createUser(user) {
  await ensureUsersHeader();

  const norm = normalizarUsuario(user);

  const existing = await getUserByEmail(norm.email);
  if (existing) {
    const err = new Error('El usuario ya existe');
    err.code = 'USER_EXISTS';
    throw err;
  }

  const row = await filaDeUsuario(norm);

  const sheets = await getSheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Users!A2:I2',
    valueInputOption: 'RAW',
    resource: { values: [row] },
  });

  const auditLogService = require('./auditLogService');
  await auditLogService.log({
    UserEmail: norm.email,
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
  prepararFilaUsuario,
  crearUsuariosEnLote,
};
