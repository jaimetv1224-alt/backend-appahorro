// CommonJS dependencies
const { google } = require('googleapis');
const { envolver: envolverHoja } = require('../hoja');
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
  'Miembros',
  'TipoGrupo',
  'ValorAccion',
  'PorcentajeInteresMensual'
];

function toColumnLetter(index) {
  let n = index;
  let output = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    output = String.fromCharCode(65 + remainder) + output;
    n = Math.floor((n - 1) / 26);
  }
  return output;
}

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
  sheetsClient = envolverHoja(google.sheets({ version: 'v4', auth: client }));
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
    const lastColumn = toColumnLetter(GROUPS_HEADERS.length);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `Groups!A1:${lastColumn}1`,
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

  // Red de seguridad: dos grupos con el mismo identificador significan que
  // quien creo el segundo queda como directivo del primero. Aunque el endpoint
  // ya genera el identificador, esto cierra la puerta desde cualquier otra via.
  if (group.GroupID) {
    const yaExiste = await getGroupById(group.GroupID.toString().trim());
    if (yaExiste) {
      const e = new Error('Ya existe un grupo con ese identificador.');
      e.codigo = 'GRUPO_DUPLICADO';
      throw e;
    }
  }
  const headers = await getGroupsHeaders();
  const activeHeaders = Array.isArray(headers) && headers.length > 0 ? headers : GROUPS_HEADERS;
  const row = activeHeaders.map((h) => {
    if (h === 'GroupID') return group.GroupID || uuidv4();
    if (h === 'Miembros') return Array.isArray(group.Miembros) ? group.Miembros.join(';') : (group.Miembros || '');
    if (h === 'CreatedDate') return group.CreatedDate || new Date().toISOString();
    if (h === 'Status') return group.Status || 'Activo';
    if (h === 'MonthlyContribution') return group.MonthlyContribution || group.MonthlyContrib || '';
    if (h === 'TipoGrupo') return group.TipoGrupo || group.type || '';
    if (h === 'ValorAccion') return group.ValorAccion || group.actionValue || '';
    if (h === 'PorcentajeInteresMensual') return group.PorcentajeInteresMensual || group.interestRate || '';
    return group[h] || '';
  });
  const lastColumn = toColumnLetter(activeHeaders.length);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `Groups!A2:${lastColumn}2`,
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
  // 1) Leer cabecera completa
  const { data: { values: [headers] = [[]] } } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Groups!1:1',
  });
  if (!Array.isArray(headers) || headers.length === 0) {
    throw new Error('No se pudo leer la cabecera de Groups');
  }

  const lastColumn = toColumnLetter(headers.length);

  // 2) Leer todas las filas de datos (A2:O)
  const { data: { values: rows = [] } } = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `Groups!A2:${lastColumn}`,
  });
  // 3) Encontrar índice de la fila por GroupID
  const idCol = headers.findIndex((h) => h === 'GroupID');
  const targetGroupId = group.GroupID || group.id;
  if (idCol === -1 || !targetGroupId) {
    throw new Error('GroupID no válido para actualizar');
  }
  const rowIndex = rows.findIndex((r) => r[idCol] === targetGroupId);
  if (rowIndex === -1) throw new Error('GroupID no encontrado');
  const existing = rows[rowIndex];

  const normalizedUpdate = {
    ...group,
    GroupID: targetGroupId,
    GroupName: group.GroupName ?? group.name,
    Description: group.Description ?? group.description,
    TargetAmount: group.TargetAmount ?? group.targetAmount,
    CurrentAmount: group.CurrentAmount ?? group.currentAmount,
    MonthlyContribution: group.MonthlyContribution ?? group.monthlyContribution,
    StartDate: group.StartDate ?? group.startDate,
    EndDate: group.EndDate ?? group.endDate,
    Status: group.Status ?? group.status,
    MaxMembers: group.MaxMembers ?? group.maxMembers,
    Presidente: group.Presidente ?? group.presidente,
    TipoGrupo: group.TipoGrupo ?? group.type,
    ValorAccion: group.ValorAccion ?? group.actionValue,
    PorcentajeInteresMensual: group.PorcentajeInteresMensual ?? group.interestRate,
  };

  // 4) Mezclar campos disponibles sin perder columnas existentes
  const updatedRow = headers.map((header, index) => {
    const newValue = normalizedUpdate[header];
    if (newValue === undefined || newValue === null) {
      return existing[index] ?? '';
    }
    if (header === 'Miembros' && Array.isArray(newValue)) {
      return newValue.join(';');
    }
    return newValue;
  });
  // 5) Escribir solo esa fila de vuelta (A{fila}:O{fila})
  const targetRow = rowIndex + 2; // +2 porque A2 es la fila 1 de datos
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `Groups!A${targetRow}:${lastColumn}${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [updatedRow] },
  });
  return { updatedRow };
}

function shouldIgnoreMissingSheet(error) {
  const message = (error?.message || '').toString();
  return message.includes('Unable to parse range');
}

async function rewriteSheetWithHeader(sheets, sheetName, headers, rows, valueInputOption = 'USER_ENTERED') {
  const safeHeaders = Array.isArray(headers) ? headers : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const totalColumns = Math.max(safeHeaders.length, 1);
  const lastColumn = toColumnLetter(totalColumns);
  const values = [safeHeaders, ...safeRows];

  await sheets.spreadsheets.values.clear({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:${lastColumn}`,
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A1:${lastColumn}${values.length}`,
    valueInputOption,
    requestBody: { values },
  });
}

async function deleteGroup(groupId) {
  const sheets = await getSheetsClient();
  const normalizedGroupId = (groupId || '').toString().trim();

  if (!normalizedGroupId) {
    throw new Error('GroupID es requerido para eliminar el grupo');
  }

  const headersResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'Groups!1:1',
  });
  const headers = headersResp.data.values?.[0] || [];
  const groupIdColumn = headers.findIndex((header) => header === 'GroupID');

  if (!headers.length || groupIdColumn === -1) {
    throw new Error('La hoja Groups no contiene la columna GroupID');
  }

  const groupsLastColumn = toColumnLetter(headers.length);
  const groupsResp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `Groups!A2:${groupsLastColumn}`,
  });
  const rows = groupsResp.data.values || [];

  const rowIndex = rows.findIndex((row) => ((row[groupIdColumn] || '').toString().trim() === normalizedGroupId));
  if (rowIndex === -1) {
    return {
      success: false,
      deleted: false,
      groupId: normalizedGroupId,
      message: 'Grupo no encontrado',
    };
  }

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const groupsSheet = (spreadsheet.data.sheets || []).find((sheet) => sheet.properties?.title === 'Groups');
  if (!groupsSheet) {
    throw new Error('No se encontró la hoja Groups');
  }

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: {
            sheetId: groupsSheet.properties.sheetId,
            dimension: 'ROWS',
            startIndex: rowIndex + 1,
            endIndex: rowIndex + 2,
          },
        },
      }],
    },
  });

  const cleanup = {
    userGroupLinksRemoved: 0,
    aportesRemoved: 0,
  };

  // Limpiar vínculos usuario-grupo del grupo eliminado.
  try {
    const linksHeaderResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'UserGroupLinks!1:1',
    });
    const linksHeaders = linksHeaderResp.data.values?.[0] || [];
    const linkGroupIdColumn = linksHeaders.findIndex((header) => header === 'GroupID');

    if (linkGroupIdColumn !== -1) {
      const linksLastColumn = toColumnLetter(Math.max(linksHeaders.length, 5));
      const linksResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `UserGroupLinks!A2:${linksLastColumn}`,
      });
      const linksRows = linksResp.data.values || [];
      const filteredLinks = linksRows.filter((row) => ((row[linkGroupIdColumn] || '').toString().trim() !== normalizedGroupId));
      cleanup.userGroupLinksRemoved = linksRows.length - filteredLinks.length;

      await rewriteSheetWithHeader(sheets, 'UserGroupLinks', linksHeaders, filteredLinks);
    }
  } catch (error) {
    if (!shouldIgnoreMissingSheet(error)) {
      throw error;
    }
  }

  // Limpiar aportes ligados al grupo eliminado.
  try {
    const aportesHeaderResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Aportes!1:1',
    });
    const aportesHeaders = aportesHeaderResp.data.values?.[0] || [];
    const aportesGroupIdColumn = aportesHeaders.findIndex((header) => header === 'GroupID');

    if (aportesGroupIdColumn !== -1) {
      const aportesLastColumn = toColumnLetter(Math.max(aportesHeaders.length, 5));
      const aportesResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `Aportes!A2:${aportesLastColumn}`,
      });
      const aportesRows = aportesResp.data.values || [];
      const filteredAportes = aportesRows.filter((row) => ((row[aportesGroupIdColumn] || '').toString().trim() !== normalizedGroupId));
      cleanup.aportesRemoved = aportesRows.length - filteredAportes.length;

      await rewriteSheetWithHeader(sheets, 'Aportes', aportesHeaders, filteredAportes);
    }
  } catch (error) {
    if (!shouldIgnoreMissingSheet(error)) {
      throw error;
    }
  }

  try {
    const auditLogService = require('./auditLogService');
    await auditLogService.log({
      UserEmail: 'system',
      Action: 'delete',
      Target: `Groups:${normalizedGroupId}`,
      Date: new Date().toISOString(),
    });
  } catch (error) {
    // No bloqueamos la eliminación si la bitácora falla.
  }

  return {
    success: true,
    deleted: true,
    groupId: normalizedGroupId,
    cleanup,
  };
}

module.exports = {
  getGroupsHeaders,
  listAllGroups,
  getGroupById,
  createGroup,
  updateGroup,
  deleteGroup,
};
