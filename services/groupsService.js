// CommonJS dependencies
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
    console.error('[GROUPS SERVICE] Error al parsear GOOGLE_CREDENTIALS:', e.message);
  }
} else {
  const SERVICE_ACCOUNT_FILE = path.resolve(__dirname, '../credentials.json');
  if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    try {
      googleCredentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf-8'));
    } catch (e) {
      console.error('[GROUPS SERVICE] Error al leer credentials.json:', e.message);
    }
  }
}

// Orden exacto de columnas según la hoja Groups
const GROUPS_HEADERS = [
  'GroupID',
  'GroupName',
  'Description',
  'Presidente',
  'CreatedBy',
  'CreatedDate',
  'TargetAmount',
  'CurrentAmount',
  'MonthlyContribution',
  'StartDate',
  'EndDate',
  'Status',
  'MaxMembers',
  'Miembros'
];

let sheetsClient;
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

async function ensureGroupsHeader() {
  const sheets = await getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Groups!1:1',
  });
  const headers = resp.data.values[0] || [];
  if (headers.length < GROUPS_HEADERS.length || GROUPS_HEADERS.some((h, i) => headers[i] !== h)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Groups!A1:N1',
      valueInputOption: 'RAW',
      resource: { values: [GROUPS_HEADERS] },
    });
  }
}

async function getGroupsHeaders() {
  const sheets = await getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Groups!1:1',
  });
  return resp.data.values[0] || [];
}

async function listAllGroups() {
  const sheets = await getSheetsClient();
  const headersResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Groups!1:1',
  });
  const headers = headersResp.data.values[0] || [];
  function colLetter(n) {
    let s = '';
    while (n > 0) {
      let m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  const lastCol = colLetter(headers.length);
  const range = `Groups!A2:${lastCol}`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range,
  });
  return res.data.values || [];
}

async function getGroupById(groupId) {
  const all = await listAllGroups();
  return all.find(row => row[0] === groupId);
}

async function createGroup(group) {
  const sheets = await getSheetsClient();
  await ensureGroupsHeader();
  if (!group.GroupName || !group.CreatedBy) throw new Error('Faltan datos obligatorios');
  const row = GROUPS_HEADERS.map(h => {
    if (h === 'GroupID') return group.GroupID || uuidv4();
    if (h === 'Miembros') return Array.isArray(group.Miembros) ? group.Miembros.join(';') : (group.Miembros || '');
    if (h === 'CreatedDate') return group.CreatedDate || new Date().toISOString();
    if (h === 'Status') return group.Status || 'Activo';
    if (h === 'MonthlyContribution') return group.MonthlyContribution || group.MonthlyContrib || '';
    return group[h] || '';
  });
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `Groups!A2:N2`,
    valueInputOption: 'RAW',
    resource: { values: [row] },
  });
  const auditLogService = require('./auditLogService');
  await auditLogService.log({
    UserEmail: group.CreatedBy,
    Action: 'create',
    Target: 'Groups',
    Date: new Date().toISOString(),
  });
  return row;
}

async function updateGroup(group) {
  const sheets = await getSheetsClient();
  // 1) Leer cabecera completa (A1:O1)
  const { data: { values: [headers] } } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Groups!A1:O1',
  });
  // 2) Leer todas las filas de datos (A2:O)
  const { data: { values: rows = [] } } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Groups!A2:O',
  });
  // 3) Encontrar índice de la fila por GroupID
  const idCol   = headers.findIndex(h => h === 'GroupID');
  const rowIndex= rows.findIndex(r => r[idCol] === group.GroupID);
  if (rowIndex === -1) throw new Error('GroupID no encontrado');
  const existing = rows[rowIndex];
  // 4) Solo mezclar las 3 columnas nuevas, conservar el resto intacto
  const updatedRow = headers.map((h, i) => {
    switch (h) {
      case 'TipoGrupo':
        return group.type          ?? existing[i];
      case 'ValorAccion':
        return group.actionValue   ?? existing[i];
      case 'PorcentajeInteresMensual':
        return group.interestRate  ?? existing[i];
      default:
        return existing[i];
    }
  });
  // 5) Escribir solo esa fila de vuelta (A{fila}:O{fila})
  const targetRow = rowIndex + 2;  // +2 porque A2 es la fila 1 de datos
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Groups!A${targetRow}:O${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [updatedRow] },
  });
  return { updatedRow };
}

module.exports = {
  getGroupsHeaders,
  listAllGroups,
  getGroupById,
  createGroup,
  updateGroup,
};
