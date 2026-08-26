const express = require('express');
const { google } = require('googleapis');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcrypt');
const groupsService = require('./services/groupsService');
const multer = require('multer');
const xlsx = require('xlsx');
const fs = require('fs');
require('dotenv').config();

const jwt = require('jsonwebtoken');

const app = express();

// --- CORS ---
// Por defecto se permite cualquier origen (la seguridad real la da el token Bearer, no cookies).
// Para restringir, definir FRONTEND_ORIGINS="https://juntago.com,https://www.juntago.com" en el entorno.
const allowedOrigins = (process.env.FRONTEND_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (allowedOrigins.length > 0) {
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // apps nativas / curl
      return cb(null, allowedOrigins.includes(origin));
    },
  }));
} else {
  app.use(cors());
}
app.use(express.json({ limit: '5mb' }));
const upload = multer({ dest: 'uploads/' });

// --- AUTENTICACION (JWT) ---
if (!process.env.JWT_SECRET && process.env.NODE_ENV === 'production') {
  console.error('[AUTH] FATAL: JWT_SECRET no esta definido en produccion. Defínelo en las variables de entorno (Render) y reinicia.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET || 'juntago-dev-secret-CAMBIAR-EN-PRODUCCION';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';
if (!process.env.JWT_SECRET) {
  console.warn('[AUTH] ADVERTENCIA: JWT_SECRET no definido. Usando secreto de desarrollo (solo dev). Define JWT_SECRET en produccion.');
}

function signUserToken(payload) {
  return jwt.sign(
    { email: (payload.email || '').toString().trim().toLowerCase(), role: payload.role || 'member' },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );
}

function readToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7).trim();
  }
  return null;
}

function decodeToken(req) {
  const token = readToken(req);
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function requireAuth(req, res, next) {
  const payload = decodeToken(req);
  if (!payload || !payload.email) {
    return res.status(401).json({ message: 'No autorizado. Inicia sesion nuevamente.' });
  }
  req.user = { email: payload.email.toString().trim().toLowerCase(), role: (payload.role || 'member') };
  next();
}

function optionalAuth(req, res, next) {
  const payload = decodeToken(req);
  if (payload && payload.email) {
    req.user = { email: payload.email.toString().trim().toLowerCase(), role: (payload.role || 'member') };
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ message: 'Acceso restringido a administradores.' });
  }
  next();
}

// Rutas accesibles sin token
const PUBLIC_EXACT_PATHS = new Set([
  '/api/login',
  '/api/ping',
  '/api/test-endpoint',
]);
// Prefijos publicos (imagenes de comprobantes se cargan via <img>, no pueden enviar header)
const PUBLIC_PREFIXES = ['/api/payment-image/'];
// Registro: autenticacion opcional (un admin con token puede crear con rol; el publico crea 'member')
const OPTIONAL_AUTH_PATHS = new Set(['/api/registrar-usuario-en-sheet']);

// Gate global: por defecto todo exige token (default-deny)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const p = req.path;
  if (PUBLIC_EXACT_PATHS.has(p)) return next();
  if (PUBLIC_PREFIXES.some((prefix) => p.startsWith(prefix))) return next();
  if (OPTIONAL_AUTH_PATHS.has(p)) return optionalAuth(req, res, next);
  return requireAuth(req, res, next);
});

const normalizeEmailKey = (value) => (value || '').toString().trim().toLowerCase();
const normalizeGroupKey = (value) => (value || '').toString().trim();
// Sanea texto que se escribe a Google Sheets para evitar inyección de fórmulas
// (CSV/formula injection): un valor que empieza con = + - @ se prefija con apostrofe
// para que Sheets lo trate como texto literal, no como fórmula ejecutable.
const sanitizeCell = (value, maxLen = 500) => {
  let s = (value == null ? '' : value).toString();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
};
// Parser de dinero tolerante a locale es-EC: "137,37" -> 137.37, "1.234,56" -> 1234.56
const parseMoney = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  let s = (value == null ? '' : value).toString().trim().replace(/\s/g, '').replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes('.') && s.includes(',')) {
    s = s.replace(/\./g, '').replace(',', '.'); // . = miles, , = decimal
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
// Puente al modulo de control interno (se inicializa al final del archivo).
// Se declara aqui para que los endpoints definidos mas arriba puedan usarlo en
// tiempo de peticion (para entonces el modulo ya esta registrado).
// Marca de version del backend. Sirve para comprobar DESDE FUERA y sin sesion,
// en /api/ping, que el servidor esta corriendo el codigo que se acaba de subir.
// El porton de seguridad responde 401 a cualquier ruta desconocida, asi que
// preguntar por un endpoint nuevo no distingue "existe" de "no existe": lo unico
// que lo prueba es que el propio servidor declare su version.
const BACKEND_VERSION = '2026.08.26-control-interno';

let gobApi = null;

/**
 * Decide con que estado nace un aporte (ahorro o compra de acciones).
 * Regla: si el grupo exige aprobacion, el aporte que registra el propio socio
 * nace PENDIENTE y solo la tesoreria (u otro lider) lo confirma. Asi nadie se
 * atribuye un patrimonio que no entrego.
 */
async function estadoInicialAporte(groupId) {
    try {
        if (!gobApi) return 'confirmado';
        const reglas = await gobApi.getReglas(groupId);
        return reglas.requiereAprobacionAportes ? 'pendiente' : 'confirmado';
    } catch (e) {
        // Ante cualquier fallo se elige el lado seguro: queda pendiente de revision.
        console.error('[GOB] no se pudo leer el reglamento, el aporte queda pendiente:', e.message);
        return 'pendiente';
    }
}

const nuevoMovId = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Tope superior para cualquier cifra de dinero que entre al sistema. No existe un
// banco comunal con aportes de cien millones: una cifra asi es un error de tecleo
// o un intento de inflar el patrimonio, y en ambos casos hay que frenarla.
const MONTO_MAXIMO = 100000000;

// --- EXCLUSION MUTUA POR RECURSO ---------------------------------------------
// Sheets no tiene transacciones: dos peticiones simultaneas leen el mismo estado
// viejo y las dos escriben (prestamos duplicados, saldos cargados dos veces, un
// mismo directivo alcanzando el quorum solo). Este middleware toma un bloqueo por
// recurso ANTES del handler y lo suelta cuando la respuesta termina, de modo que
// la segunda peticion ya lee el estado nuevo y sus controles de idempotencia la
// rechazan con 409.
const { conBloqueo } = require('./lock');

function bloquear(claveDe) {
    return async (req, res, next) => {
        let clave = 'global';
        try {
            clave = (await claveDe(req)) || 'global';
        } catch (e) {
            console.error('[LOCK] no se pudo calcular la clave, se usa global:', e.message);
        }
        let liberar = () => {};
        const hastaResponder = new Promise((resolve) => { liberar = resolve; });
        res.on('finish', liberar);
        res.on('close', liberar);
        conBloqueo(clave, () => {
            next();
            return hastaResponder;
        }).catch((error) => {
            console.error('[LOCK]', clave, error.message);
            if (!res.headersSent) {
                res.status(503).json({ message: 'El sistema esta procesando otra operacion sobre estos datos. Intenta de nuevo.' });
            }
        });
    };
}

// Estado efectivo de un aporte (Savings col G idx 6 / Acciones col H idx 7).
// Celda vacia = fila historica anterior al control interno => cuenta como confirmada.
const estadoAporteCell = (valor) => {
    const v = (valor == null ? '' : valor).toString().trim().toLowerCase();
    if (!v) return 'confirmado';
    return ['pendiente', 'confirmado', 'rechazado'].includes(v) ? v : 'confirmado';
};
// Un aporte solo suma al patrimonio del socio si esta confirmado por la tesoreria.
const aporteConfirmado = (valor) => estadoAporteCell(valor) === 'confirmado';
const SAVINGS_ESTADO_IDX = 6;
const ACCIONES_ESTADO_IDX = 7;

const isQuotaExceededError = (error) => {
  const statusCandidates = [
    error?.status,
    error?.code,
    error?.response?.status,
    error?.response?.statusCode,
    error?.response?.data?.error?.code,
    error?.cause?.code,
  ];
  const status = statusCandidates
    .map((candidate) => Number(candidate))
    .find((candidate) => Number.isFinite(candidate));
  const message = `${error?.message || ''} ${error?.cause?.message || ''}`.toLowerCase();
  return status === 429 || message.includes('quota exceeded') || message.includes('resource_exhausted');
};

async function userBelongsToGroupSafe(sheetsClient, userEmail, groupId) {
  const normalizedEmail = normalizeEmailKey(userEmail);
  const normalizedGroupId = normalizeGroupKey(groupId);

  if (!normalizedEmail || !normalizedGroupId) return false;

  const linksResp = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'UserGroupLinks!A2:E',
  });

  const links = linksResp.data.values || [];
  return links.some((row) => (
    normalizeEmailKey(row?.[0]) === normalizedEmail
    && normalizeGroupKey(row?.[1]) === normalizedGroupId
  ));
}

// GET /api/grupos-del-usuario?userEmail=...
app.get('/api/grupos-del-usuario', async (req, res) => {
  const normalizedUserEmail = normalizeEmailKey(selfEmail(req, req.query.userEmail));
  if (!normalizedUserEmail) {
    return res.status(400).json({ error: 'Falta parámetro userEmail' });
  }
  try {
    const sheets = await getSheetsClient();
    // Leer todos los links usuario-grupo
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'UserGroupLinks!A2:E',
    });
    const rows = resp.data.values || [];
    // Filtrar solo los grupos del usuario
    const userGroups = rows.filter(row =>
      normalizeEmailKey(row?.[0]) === normalizedUserEmail
    ).map(row => ({
      groupId: row[1] || '',
      groupRole: row[3] || '',
      joinDate: row[2] || '',
      estado: row[4] || ''
    }));
    // Leer info de los grupos para mostrar nombre
    let allGroups = [];
    try {
      const groupsResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Groups!A2:Q',
      });
      allGroups = groupsResp.data.values || [];
    } catch (e) {}
    // Mapear nombre y configuracion financiera del grupo.
    // Indices segun GROUPS_HEADERS: 1=GroupName, 14=TipoGrupo, 15=ValorAccion, 16=PorcentajeInteresMensual
    const result = userGroups.map(g => {
      const found = allGroups.find(row => row[0] === g.groupId);
      const groupName = found ? (found[1] || '') : '';
      return {
        groupId: g.groupId,
        groupRole: g.groupRole,
        joinDate: g.joinDate,
        estado: g.estado,
        groupName,
        GroupName: groupName,
        name: groupName,
        TipoGrupo: found ? (found[14] || '') : '',
        ValorAccion: found ? (found[15] || '') : '',
        PorcentajeInteresMensual: found ? (found[16] || '') : ''
      };
    });
    return res.json({ grupos: result });
  } catch (err) {
    console.error('Error en /api/grupos-del-usuario:', err);
    if (isQuotaExceededError(err)) {
      return res.status(200).json({
        grupos: [],
        warning: 'Límite temporal de lecturas alcanzado. Intenta nuevamente en unos segundos.'
      });
    }
    return res.status(500).json({ error: 'Error interno al obtener grupos del usuario' });
  }
});

// GET /api/obtener-acciones
// GET /api/obtener-acciones?groupId=...&userEmail=...
app.get('/api/obtener-acciones', async (req, res) => {
  try {
    const normalizedGroupId = normalizeGroupKey(req.query.groupId);
    const normalizedUserEmail = normalizeEmailKey(selfEmail(req, req.query.userEmail));

    if (!normalizedGroupId || !normalizedUserEmail) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }
    const sheets = await getSheetsClient();

    const pertenece = await userBelongsToGroupSafe(sheets, normalizedUserEmail, normalizedGroupId);
    if (!pertenece) {
      return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
    }
    const range = 'Acciones!A:M';
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });
    const rows = resp.data.values || [];
    // Filtra SIEMPRE por usuario y grupo, ignorando mayusculas y espacios
    const propias = rows.filter(row =>
      normalizeEmailKey(row?.[0]) === normalizedUserEmail &&
      normalizeGroupKey(row?.[1]) === normalizedGroupId
    );
    // Solo las compras de acciones CONFIRMADAS cuentan como capital del socio.
    const filtered = propias.filter(row => aporteConfirmado(row?.[ACCIONES_ESTADO_IDX]));
    return res.json({
      shares: filtered.map(row => ({
        date:        row[2],
        shares:      parseMoney(row[3]),
        shareValue:  parseMoney(row[4]),
        interestRate:parseMoney(row[5])
      })),
      pendientes: propias
        .filter(row => estadoAporteCell(row?.[ACCIONES_ESTADO_IDX]) === 'pendiente')
        .map(row => ({ date: row[2], shares: parseMoney(row[3]), shareValue: parseMoney(row[4]), movId: row[11] || '' }))
    });
  } catch (err) {
    console.error('Error en /api/obtener-acciones:', err);
    return res.status(500).json({ error: 'Error interno al obtener acciones' });
  }
});

// POST /api/registrar-acciones
app.post('/api/registrar-acciones', async (req, res) => {
  try {
    const { groupId, date, shares, shareValue, interestRate } = req.body;
    const userEmail = selfEmail(req, req.body.userEmail); // se registra a nombre del usuario autenticado
    if (!groupId || !userEmail || !date || typeof shares !== 'number'
        || typeof shareValue !== 'number' || typeof interestRate !== 'number') {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    if (!Number.isFinite(shares) || shares <= 0 || !Number.isFinite(shareValue) || shareValue <= 0 || !Number.isFinite(interestRate) || interestRate < 0) {
      return res.status(400).json({ error: 'Cantidad de acciones y valor deben ser numeros positivos; la tasa no puede ser negativa.' });
    }
    if (shares * shareValue > MONTO_MAXIMO || shares > 1000000 || interestRate > 100) {
      return res.status(400).json({ error: 'Los valores de la compra estan fuera de rango. Revisa la cifra.' });
    }
    const sheets = await getSheetsClient();
    if (req.user.role !== 'admin' && !(await userBelongsToGroupSafe(sheets, userEmail, groupId))) {
      return res.status(403).json({ error: 'No perteneces a este grupo.' });
    }
    const estadoNuevo = await estadoInicialAporte(groupId);
    const movId = nuevoMovId('acc');
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Acciones!A:M',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[ userEmail, groupId, date, shares, shareValue, interestRate, new Date().toISOString(),
                   estadoNuevo, req.user.email, '', '', movId, '' ]]
      }
    });
    res.status(201).json({ success: true, estado: estadoNuevo, movId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error interno' });
  }
});

// Obtener miembros de un grupo por GroupID

// Helper para obtener miembros desde Google Sheets
async function fetchMembersFromSheets(groupId) {
  const range = 'UserGroupLinks!A2:E';
  console.log('[fetchMembersFromSheets] usando rango =', range, 'para groupId=', groupId);
  try {
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });
    const rows = resp.data.values || [];
    return rows
      .filter(row => row[1] && row[1] === groupId)
      .map(row => ({
        email:    row[0] || '',  // UserEmail
        groupId:  row[1] || '',  // GroupID
        joinDate: row[2] || '',  // JoinDate
        role:     row[3] || '',  // GroupRole
        estado:   row[4] || '',  // Estado (si existe)
      }));
  } catch (err) {
    console.error('[fetchMembersFromSheets] error al leer rangos:', err);
    return [];
  }
}

app.get('/api/obtener-miembros', async (req, res) => {
  try {
    const normalizedGroupId = normalizeGroupKey(req.query.groupId);
    if (!normalizedGroupId) {
      return res.status(400).json({ error: 'Falta parámetro groupId' });
    }
    // Admin o gestor del grupo ven la lista completa; un miembro normal solo su propia ficha
    const isPrivileged = req.user.role === 'admin' || await canManageGroup(req.user.email, normalizedGroupId);
    const normalizedUserEmail = isPrivileged
      ? normalizeEmailKey(req.query.userEmail)
      : req.user.email;
    console.log('obtener-miembros groupId=', normalizedGroupId);

    if (normalizedUserEmail) {
      const sheets = await getSheetsClient();
      const belongs = await userBelongsToGroupSafe(sheets, normalizedUserEmail, normalizedGroupId);
      if (!belongs) {
        return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
      }
    }
    const members = await fetchMembersFromSheets(normalizedGroupId);
    const scopedMembers = normalizedUserEmail
      ? members.filter((member) => normalizeEmailKey(member?.email || member?.UserEmail) === normalizedUserEmail)
      : members;

    return res.status(200).json({ members: scopedMembers });
  } catch (err) {
    console.error('Error en /api/obtener-miembros:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Error interno al obtener miembros' });
  }
});

// --- MIDDLEWARE ---

// Middleware para loggear absolutamente todas las peticiones, incluso si la ruta no existe o el body es inválido
app.use((req, res, next) => {
    console.log('[GLOBAL LOGGER] Método:', req.method, 'URL:', req.url, 'IP:', req.ip, 'Origin:', req.headers.origin, 'User-Agent:', req.headers['user-agent']);
    next();
});

// Middleware para loggear todas las peticiones entrantes (después de cors y express.json)
app.use((req, res, next) => {
  const safeBody = { ...(req.body || {}) };
  for (const k of Object.keys(safeBody)) {
    if (/pass|contrase|password|hashed|token/i.test(k)) safeBody[k] = '***';
  }
  console.log(`[BACKEND REQUEST LOGGER] Method: ${req.method}, URL: ${req.url}, Body: ${JSON.stringify(safeBody)}`);
  next();
});

// --- CONFIGURACI?N ---
const PORT = process.env.PORT || 3001; // Puerto para el backend
const SERVICE_ACCOUNT_FILE = path.resolve(__dirname, 'credentials.json');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA'; // ID de tu hoja de cálculo

// Obtener credenciales de Google desde variable de entorno o archivo
let googleCredentials = null;
if (process.env.GOOGLE_CREDENTIALS) {
  try {
    googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  } catch (e) {
    console.error('[ERROR] No se pudo parsear GOOGLE_CREDENTIALS:', e.message);
  }
} else if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
  try {
    googleCredentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf-8'));
  } catch (e) {
    console.error('[ERROR] No se pudo leer credentials.json:', e.message);
  }
}

// --- NUEVOS ENDPOINTS: AHORROS Y ACCIONES ---
// Helper para inicializar Google Sheets API
let sheets;
async function getSheetsClient() {
  if (!googleSheetsAvailable) {
    throw new Error('Google Sheets no está disponible - funcionando en modo de prueba');
  }
  if (sheets) return sheets;
  const auth = new google.auth.GoogleAuth({
    credentials: googleCredentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return sheets;
}

// POST /api/registrar-ahorros
app.post('/api/registrar-ahorros', async (req, res) => {
  try {
    const { groupId, date, amount } = req.body;
    const userEmail = selfEmail(req, req.body.userEmail); // se registra a nombre del usuario autenticado
    if (!groupId || !userEmail || !date || typeof amount !== 'number') {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }
    if (typeof amount === 'number' && amount <= 0) {
      return res.status(400).json({ error: 'El monto debe ser mayor a 0' });
    }
    if (!Number.isFinite(amount) || amount > MONTO_MAXIMO) {
      return res.status(400).json({ error: `El monto no puede superar ${MONTO_MAXIMO.toLocaleString('es-EC')}.` });
    }
    const sheets = await getSheetsClient();
    if (req.user.role !== 'admin' && !(await userBelongsToGroupSafe(sheets, userEmail, groupId))) {
      return res.status(403).json({ error: 'No perteneces a este grupo.' });
    }
    // Convencion canonica de Savings: A=email, B=group, C=amount, D=date, E=type, F=desc
    // y columnas de control interno G..L (estado, quien lo registro, quien lo resolvio...)
    const estadoNuevo = await estadoInicialAporte(groupId);
    const movId = nuevoMovId('sav');
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Savings!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[userEmail, groupId, amount, date, 'mensual', '', estadoNuevo, req.user.email, '', '', movId, '']],
      },
    });
    return res.status(200).json({ success: true, estado: estadoNuevo, movId });
  } catch (err) {
    console.error('Error en /api/registrar-ahorros:', err);
    return res.status(500).json({ error: 'Error interno al registrar ahorros' });
  }
});

// GET /api/obtener-ahorros?groupId=...&userEmail=...
app.get('/api/obtener-ahorros', async (req, res) => {
  try {
    const normalizedGroupId = normalizeGroupKey(req.query.groupId);
    const normalizedUserEmail = normalizeEmailKey(selfEmail(req, req.query.userEmail));

    if (!normalizedGroupId || !normalizedUserEmail) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }
    const sheets = await getSheetsClient();
    const pertenece = await userBelongsToGroupSafe(sheets, normalizedUserEmail, normalizedGroupId);
    if (!pertenece) {
      return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
    }
    const range = 'Savings!A:L';
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });
    const rows = resp.data.values || [];
    const propias = rows.filter(row =>
      normalizeEmailKey(row?.[0]) === normalizedUserEmail &&
      normalizeGroupKey(row?.[1]) === normalizedGroupId
    );
    // Solo los aportes CONFIRMADOS cuentan como ahorro del socio.
    const savings = propias
      .filter(row => aporteConfirmado(row?.[SAVINGS_ESTADO_IDX]))
      .map(row => ({ date: row[3], amount: parseMoney(row[2]), estado: 'confirmado' }));
    const pendientes = propias
      .filter(row => estadoAporteCell(row?.[SAVINGS_ESTADO_IDX]) === 'pendiente')
      .map(row => ({ date: row[3], amount: parseMoney(row[2]), movId: row[10] || '', estado: 'pendiente' }));
    return res.status(200).json({ savings, pendientes });
  } catch (err) {
    console.error('Error en /api/obtener-ahorros:', err);
    return res.status(500).json({ error: 'Error interno al obtener ahorros' });
  }
});

// GET /api/obtener-prestamos?groupId=...&userEmail=...
app.get('/api/obtener-prestamos', async (req, res) => {
  try {
    const normalizedGroupId = normalizeGroupKey(req.query.groupId);
    // Admin sin userEmail => todos los prestamos del grupo; miembro => siempre solo los suyos
    const normalizedUserEmail = req.user.role === 'admin'
      ? normalizeEmailKey(req.query.userEmail || '')
      : req.user.email;

    if (!normalizedGroupId) {
      return res.status(400).json({ error: 'Falta parámetro groupId' });
    }
    const sheets = await getSheetsClient();
    // Validar que el usuario pertenece al grupo (solo si userEmail está presente)
    if (normalizedUserEmail) {
      const pertenece = await userBelongsToGroupSafe(sheets, normalizedUserEmail, normalizedGroupId);
      if (!pertenece) {
        return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
      }
    }
    // Loans real: [A=LoanID, B=UserEmail, C=GroupID, D=AmountApproved, E=StartDate, F=DueDate, G=InterestRate(mensual), H=Status, I=Term, J=Total]
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Loans!A2:J',
    });
    const rows = resp.data.values || [];
    let filtered;
    if (normalizedUserEmail) {
      filtered = rows.filter(row =>
        normalizeEmailKey(row?.[1]) === normalizedUserEmail &&
        normalizeGroupKey(row?.[2]) === normalizedGroupId
      );
    } else {
      filtered = rows.filter(row => normalizeGroupKey(row?.[2]) === normalizedGroupId);
    }

    // Leer pagos una sola vez y agregar por loanId (solo pagos aprobados reducen el saldo)
    let paidByLoan = {};
    try {
      const payResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O' });
      (payResp.data.values || []).forEach((r) => {
        const lid = (r[2] || '').toString().trim();
        const estado = (r[6] || '').toString().trim().toLowerCase();
        if (lid && ['approved', 'aprobado'].includes(estado)) {
          paidByLoan[lid] = (paidByLoan[lid] || 0) + parseMoney(r[3]);
        }
      });
    } catch (e) { paidByLoan = {}; }

    const loans = filtered.map(row => {
      const principal = parseMoney(row[3]);
      const interestRate = parseMoney(row[6]);
      const term = Number(row[8] || 0);
      const total = parseMoney(row[9]) || principal;
      const paid = paidByLoan[(row[0] || '').toString().trim()] || 0;
      return {
        loanId: row[0] || '',
        userEmail: row[1] || '',
        groupId: row[2] || '',
        amount: principal,
        startDate: row[4] || '',
        dueDate: row[5] || '',
        interestRate,
        status: row[7] || '',
        term,
        totalAPagar: total,
        paid: Math.round(paid * 100) / 100,
        remainingBalance: Math.max(0, Math.round((total - paid) * 100) / 100)
      };
    });
    return res.status(200).json({ loans });
  } catch (err) {
    console.error('Error en /api/obtener-prestamos:', err);
    return res.status(500).json({ error: 'Error interno al obtener préstamos' });
  }
});

// GET /api/obtener-utilidades?groupId=...&userEmail=...
// GET /api/obtener-utilidades?groupId=...&userEmail=...
app.get('/api/obtener-utilidades', async (req, res) => {
  const normalizedGroupId = normalizeGroupKey(req.query.groupId);
  const normalizedUserEmail = normalizeEmailKey(selfEmail(req, req.query.userEmail));

  if (!normalizedGroupId) {
    return res.status(400).json({ error: 'Falta parámetro groupId' });
  }

  try {
    const sheets = await getSheetsClient();
    // Validar que el usuario pertenece al grupo (solo si userEmail está presente)
    if (normalizedUserEmail) {
      const pertenece = await userBelongsToGroupSafe(sheets, normalizedUserEmail, normalizedGroupId);
      if (!pertenece) {
        return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
      }
    }
    // Leemos todas las compras de acciones
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Acciones!A2:M',        // A: UserEmail, B: GroupID, C: Date, D: Shares, E: ShareValue, F: InterestRate, G: Timestamp, H: Estado
    });
    const rowsTodas = resp.data.values || [];
    // Las acciones pendientes de confirmacion no generan utilidades.
    const rows = rowsTodas.filter(r => aporteConfirmado(r?.[ACCIONES_ESTADO_IDX]));

    let filtered;
    if (normalizedUserEmail) {
      filtered = rows.filter(r =>
        normalizeEmailKey(r?.[0]) === normalizedUserEmail &&
        normalizeGroupKey(r?.[1]) === normalizedGroupId
      );
    } else {
      filtered = rows.filter(r => normalizeGroupKey(r?.[1]) === normalizedGroupId);
    }
    const utilities = filtered.map(r => {
      const date         = r[2];
      const shares       = parseMoney(r[3]);
      const shareValue   = parseMoney(r[4]);
      const interestRate = parseMoney(r[5]) / 100; // convierto % en decimal
      // utilidad = cantidad ? valor ? tasa
      const amount = +(shares * shareValue * interestRate).toFixed(2);
      return { userEmail: r[0], date, amount };
    });

    return res.json({ utilities });
  } catch (err) {
    console.error('Error en /api/obtener-utilidades:', err);
    return res.status(500).json({ error: 'Error interno al obtener utilidades' });
  }
});

// Variable para saber si Google Sheets está disponible
let googleSheetsAvailable = false;

// Autenticación con Google Sheets usando la cuenta de servicio
let auth;

if (!googleCredentials) {
    console.warn("[ADVERTENCIA] No se encontraron credenciales de Google. El servidor funcionará con datos de prueba.");
    googleSheetsAvailable = false;
} else {
    // sheets variable already declared above, do not redeclare
    (async () => {
        try {
            auth = new google.auth.GoogleAuth({
                credentials: googleCredentials,
                scopes: 'https://www.googleapis.com/auth/spreadsheets',
            });
            const client = await auth.getClient();
            sheets = google.sheets({ version: 'v4', auth: client });
            googleSheetsAvailable = true;
            console.log('[BACKEND] Google Sheets API autenticado correctamente.');
        } catch (e) {
            console.error("[ADVERTENCIA] Error al inicializar Google Auth. El servidor funcionará con datos de prueba.", e);
            googleSheetsAvailable = false;
        }
    })();
}

// --- ENDPOINTS DE LA API ---

// Endpoint para registrar un nuevo usuario
// Refactor: Usar usersService y auditLogService
const usersService = require('./services/usersService');
app.post('/api/registrar-usuario-en-sheet', async (req, res) => {
    try {
        const { Username, Email, password, Role, Balance } = req.body || {};
        const normalizedEmail = normalize(Email);
        // Solo un admin autenticado puede asignar rol; el registro publico siempre crea 'member'
        const normalizedRole = (req.user && req.user.role === 'admin') ? normalizeGlobalRole(Role) : 'member';
        const numericBalance = Number(Balance ?? 0);
        if (!Username || !normalizedEmail || !password || Number.isNaN(numericBalance)) {
            return res.status(400).json({ message: 'Faltan datos del usuario. Se requieren: Username, Email y password válidos.' });
        }
        // Usar usersService para crear usuario (ya hace hash y log)
        const user = {
            Username: Username.toString().trim(),
            Email: normalizedEmail,
            Password: password,
            Role: normalizedRole,
            Balance: numericBalance
        };
        const created = await usersService.createUser(user);
        res.status(201).json({ message: 'Usuario registrado en Google Sheet con éxito.', data: created });
    } catch (error) {
        if (error?.code === 'USER_EXISTS') {
            return res.status(409).json({ message: 'Ya existe un usuario con ese email.' });
        }
        res.status(500).json({ message: 'Error al registrar usuario en Sheet.', error: error.message });
    }
});

// Endpoint para crear un grupo (mejorado)
// Refactor: Usar groupsService y auditLogService
// const groupsService = require('./services/groupsService');
// ===================== AUTOGESTION DE GRUPOS (helpers) =====================
const GROUP_LEADER_ROLES = new Set(['presidente', 'tesorero', 'secretario']);
const MAX_GROUPS_PER_USER = 2;
const INVITATIONS_HEADERS = ['InvitationID', 'GroupID', 'InvitedEmail', 'InvitedBy', 'ProposedRole', 'Tipo', 'Status', 'CreatedAt', 'RespondedAt', 'ExpiresAt'];

async function readUserGroupLinks() {
    const sheetsClient = await getSheetsClient();
    const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'UserGroupLinks!A2:F' });
    return resp.data.values || [];
}
// Un vínculo cuenta como activo salvo que su Estado (col E) sea 'inactivo'. Filas viejas sin col E = activas.
const linkIsActive = (row) => (row[4] || 'activo').toString().trim().toLowerCase() !== 'inactivo';

async function countActivePresidencies(email) {
    const e = normalizeEmailKey(email);
    return (await readUserGroupLinks()).filter(r => normalizeEmailKey(r[0]) === e && normalizeGroupRole(r[3]) === 'presidente' && linkIsActive(r)).length;
}
async function getActiveLeaderCount(groupId) {
    const g = normalizeGroupKey(groupId);
    return (await readUserGroupLinks()).filter(r => normalizeGroupKey(r[1]) === g && GROUP_LEADER_ROLES.has(normalizeGroupRole(r[3])) && linkIsActive(r)).length;
}
async function roleHolderEmail(groupId, role) {
    const g = normalizeGroupKey(groupId), rr = normalizeGroupRole(role);
    const found = (await readUserGroupLinks()).find(r => normalizeGroupKey(r[1]) === g && normalizeGroupRole(r[3]) === rr && linkIsActive(r));
    return found ? normalizeEmailKey(found[0]) : '';
}
async function ensureInvitationsSheet() {
    await ensureSheetExists('Invitations', INVITATIONS_HEADERS, await getSheetsClient(), SPREADSHEET_ID);
}
async function readInvitations() {
    await ensureInvitationsSheet();
    const sheetsClient = await getSheetsClient();
    const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Invitations!A2:J' });
    return resp.data.values || [];
}
const newId = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Cualquier usuario autenticado crea grupos (máx 2 presidencias activas). El creador queda como presidente activo.
app.post('/api/crear-grupo-en-sheet', bloquear((r) => `presidencias:${r.user && r.user.email}`), async (req, res) => {
    try {
        const group = req.body || {};
        if (!group.GroupName) {
            return res.status(400).json({ message: 'Falta el nombre del grupo (GroupName).' });
        }
        const creador = req.user.email;
        if (req.user.role !== 'admin') {
            const n = await countActivePresidencies(creador);
            if (n >= MAX_GROUPS_PER_USER) {
                return res.status(409).json({ message: `Límite alcanzado: solo puedes crear ${MAX_GROUPS_PER_USER} grupos.` });
            }
        }
        // El servidor fuerza creador y presidente (no se confía en el body)
        group.CreatedBy = creador;
        group.Presidente = creador;
        const created = await groupsService.createGroup(group);
        const newGroupId = Array.isArray(created) ? (created[0] || '') : (created.GroupID || group.GroupID || '');
        // Vincular al creador como presidente activo (atómico a nivel de flujo)
        if (newGroupId) {
            await createUserGroupLink({ UserEmail: creador, GroupID: newGroupId, JoinDate: new Date().toISOString(), GroupRole: 'presidente', InvitedBy: 'self' });
        }
        res.status(201).json({ message: 'Grupo creado correctamente.', data: created, groupId: newGroupId });
    } catch (error) {
        console.error('[CREAR-GRUPO] Error:', error.message);
        res.status(500).json({ message: 'Error al crear grupo.', error: error.message });
    }
});

// Invitar a un usuario YA registrado al grupo (solo gestor: presidente/tesorero). Crea invitación PENDIENTE (no vincula aún).
app.post('/api/invitar-miembro', bloquear((r) => `grupo:${normalizeGroupKey(r.body && (r.body.groupId || r.body.GroupID))}`), async (req, res) => {
    try {
        const groupId = (req.body?.groupId || req.body?.GroupID || '').toString().trim();
        const invitedEmail = normalizeEmailKey(req.body?.email || req.body?.InvitedEmail);
        // Se acepta role/rol/ProposedRole; un rol mal escrito NO se degrada en silencio a
        // 'member' (eso hacia que invitar a alguien como tesorero lo dejara como socio raso).
        const rolPedido = (req.body?.role ?? req.body?.rol ?? req.body?.ProposedRole ?? 'member').toString().trim();
        const proposedRole = normalizeGroupRole(rolPedido);
        if (!groupId || !invitedEmail) return res.status(400).json({ message: 'Faltan groupId o email.' });
        if (!esRolDeGrupoConocido(rolPedido)) {
            return res.status(400).json({
                message: `Rol propuesto invalido ("${rolPedido}"). Usa member, presidente, tesorero o secretario.`,
            });
        }
        if (!(await assertGroupManager(req, res, groupId))) return;
        if (invitedEmail === req.user.email) return res.status(400).json({ message: 'No puedes invitarte a ti mismo.' });

        // El invitado debe existir y estar activo
        const sheetsClient = await getSheetsClient();
        const usersResp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:I' });
        const uRows = usersResp.data.values || []; const uHead = uRows[0] || [];
        const uEmailCol = uHead.findIndex(h => normalize(h) === 'email');
        const uEstadoCol = uHead.findIndex(h => normalize(h) === 'estado');
        const uRow = uRows.find((r, i) => i > 0 && normalizeEmailKey(r[uEmailCol]) === invitedEmail);
        if (!uRow) return res.status(404).json({ message: 'No existe un usuario registrado con ese correo.' });
        if (uEstadoCol !== -1 && (uRow[uEstadoCol] || 'activo').toString().trim().toLowerCase() === 'inactivo') {
            return res.status(409).json({ message: 'Ese usuario está desactivado.' });
        }
        // No debe ser ya miembro activo
        const links = await readUserGroupLinks();
        if (links.some(r => normalizeEmailKey(r[0]) === invitedEmail && normalizeGroupKey(r[1]) === groupId && linkIsActive(r))) {
            return res.status(409).json({ message: 'Ese usuario ya es miembro del grupo.' });
        }
        // Rol de liderazgo único (presidente/tesorero/secretario): que esté libre
        if (GROUP_LEADER_ROLES.has(proposedRole)) {
            const holder = await roleHolderEmail(groupId, proposedRole);
            if (holder) return res.status(409).json({ message: `El rol ${proposedRole} ya está ocupado en este grupo.` });
        }
        // No duplicar invitación pendiente
        const invs = await readInvitations();
        const dup = invs.some(r => normalizeGroupKey(r[1]) === groupId && normalizeEmailKey(r[2]) === invitedEmail && (r[6] || '').toString().trim().toLowerCase() === 'pendiente');
        if (dup) return res.status(409).json({ message: 'Ya hay una invitación pendiente para ese usuario.' });

        const now = new Date();
        const exp = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID, range: 'Invitations!A:J', valueInputOption: 'RAW',
            resource: { values: [[newId('inv'), groupId, invitedEmail, req.user.email, proposedRole, 'invitacion', 'pendiente', now.toISOString(), '', exp.toISOString()]] },
        });
        return res.status(201).json({ message: 'Invitación enviada. El usuario debe aceptarla.' });
    } catch (error) {
        console.error('[INVITAR-MIEMBRO] Error:', error.message);
        return res.status(500).json({ message: 'Error al invitar miembro.', error: error.message });
    }
});

// Invitaciones pendientes del usuario autenticado (para aceptar/rechazar)
app.get('/api/mis-invitaciones', async (req, res) => {
    try {
        const me = req.user.email;
        const invs = await readInvitations();
        const hoy = new Date();
        // Nombres de grupos
        let groupName = {};
        try {
            const grupos = await groupsService.listAllGroups();
            const headers = await groupsService.getGroupsHeaders();
            const idCol = headers.findIndex(h => normalize(h) === 'groupid');
            const nameCol = headers.findIndex(h => normalize(h) === 'groupname');
            grupos.forEach(r => { if (r[idCol]) groupName[(r[idCol] || '').toString().trim()] = r[nameCol] || ''; });
        } catch (e) { groupName = {}; }
        const pendientes = invs
            .filter(r => normalizeEmailKey(r[2]) === me && (r[5] || '').toString().toLowerCase() === 'invitacion' && (r[6] || '').toString().toLowerCase() === 'pendiente')
            .filter(r => { const exp = r[9] ? new Date(r[9]) : null; return !exp || exp >= hoy; })
            .map(r => ({ invitationId: r[0], groupId: r[1], groupName: groupName[(r[1] || '').toString().trim()] || r[1], invitedBy: r[3], role: r[4], createdAt: r[7], expiresAt: r[9] }));
        return res.json({ invitaciones: pendientes });
    } catch (error) {
        console.error('[MIS-INVITACIONES] Error:', error.message);
        return res.status(500).json({ message: 'Error al obtener invitaciones.', invitaciones: [] });
    }
});

// Aceptar o rechazar una invitación (solo el propio invitado)
app.post('/api/responder-invitacion', bloquear(async (r) => {
    // Se resuelve el grupo de la invitacion para serializar por grupo: asi dos
    // personas aceptando a la vez no pueden quedar ambas como tesorero.
    const id = ((r.body && r.body.invitationId) || '').toString().trim();
    try {
        const inv = (await readInvitations()).find((fila) => (fila[0] || '').toString().trim() === id);
        return inv ? `grupo:${normalizeGroupKey(inv[1])}` : `invitacion:${id}`;
    } catch (e) {
        return `invitacion:${id}`;
    }
}), async (req, res) => {
    try {
        const { invitationId, accion } = req.body || {};
        if (!invitationId || !['aceptar', 'rechazar'].includes(accion)) {
            return res.status(400).json({ message: 'Faltan invitationId o acción (aceptar|rechazar).' });
        }
        const sheetsClient = await getSheetsClient();
        const invs = await readInvitations();
        const idx = invs.findIndex(r => (r[0] || '').toString().trim() === invitationId.toString().trim());
        if (idx === -1) return res.status(404).json({ message: 'Invitación no encontrada.' });
        const inv = invs[idx];
        if (normalizeEmailKey(inv[2]) !== req.user.email) return res.status(403).json({ message: 'Esta invitación no es para ti.' });
        if ((inv[6] || '').toString().toLowerCase() !== 'pendiente') return res.status(409).json({ message: 'Esta invitación ya fue respondida.' });
        const exp = inv[9] ? new Date(inv[9]) : null;
        if (exp && exp < new Date()) return res.status(409).json({ message: 'La invitación expiró.' });

        const rowNum = idx + 2; // +2: fila 1 = cabecera
        if (accion === 'aceptar') {
            const groupId = (inv[1] || '').toString().trim();
            const role = normalizeGroupRole(inv[4]);
            // Re-validar rol único libre
            if (GROUP_LEADER_ROLES.has(role) && await roleHolderEmail(groupId, role)) {
                return res.status(409).json({ message: `El rol ${role} ya fue ocupado; pide otra invitación.` });
            }
            const link = await createUserGroupLink({ UserEmail: req.user.email, GroupID: groupId, JoinDate: new Date().toISOString(), GroupRole: role, InvitedBy: inv[3] });
            if (!link.ok && link.status !== 409) return res.status(link.status).json(link.body);
        }
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID, range: `Invitations!G${rowNum}:I${rowNum}`, valueInputOption: 'RAW',
            resource: { values: [[accion === 'aceptar' ? 'aceptada' : 'rechazada', inv[7] || '', new Date().toISOString()]] },
        });
        return res.json({ success: true, message: accion === 'aceptar' ? 'Te uniste al grupo.' : 'Invitación rechazada.' });
    } catch (error) {
        console.error('[RESPONDER-INVITACION] Error:', error.message);
        return res.status(500).json({ message: 'Error al responder la invitación.', error: error.message });
    }
});

app.delete('/api/eliminar-grupo/:groupId', requireAdmin, async (req, res) => {
    const groupId = (req.params.groupId || '').toString().trim();
    if (!groupId) {
        return res.status(400).json({ message: 'Se requiere groupId.' });
    }

    try {
        const result = await groupsService.deleteGroup(groupId);
        if (!result?.deleted) {
            return res.status(404).json({
                message: result?.message || 'Grupo no encontrado.',
                groupId,
            });
        }

        return res.json({
            message: 'Grupo eliminado correctamente.',
            groupId: result.groupId,
            cleanup: result.cleanup,
        });
    } catch (error) {
        console.error('[ELIMINAR GRUPO] Error:', error.message, error.stack);
        return res.status(500).json({ message: 'Error al eliminar grupo.', error: error.message });
    }
});

// --- Endpoint para Login ---
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log(`[LOGIN ENDPOINT] Intento de login para email: ${email}`); // Log del intento

    if (!email || !password) {
        console.log('[LOGIN ENDPOINT] Email o contraseña faltantes.');
        return res.status(400).json({ message: 'Email y contraseña son requeridos.' });
    }

    try {
        console.log('[LOGIN ENDPOINT] Leyendo datos de Google Sheets...');
        // 1. Leer todos los usuarios de la hoja 'Users'
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Users!A:I', // Cubre Estado (col I) para bloquear cuentas inactivas
        });

        const rows = response.data.values;
        if (!rows || rows.length < 2) { // Necesitamos al menos una cabecera y una fila de datos
            console.log('[LOGIN ENDPOINT] No se encontraron filas o no hay suficientes filas en la hoja "Users".');
            return res.status(404).json({ message: 'No hay usuarios registrados o la hoja está mal configurada.' });
        }
        console.log('[LOGIN ENDPOINT] Filas obtenidas de Sheets:', rows.length);

        const headerRow = rows[0];
        console.log('[LOGIN ENDPOINT] Fila de cabecera:', headerRow);
        // Búsqueda de columnas sin distinción de mayúsculas/minúsculas y quitando espacios extra
        const emailColumnIndex = headerRow.findIndex(header => header && header.trim().toLowerCase() === 'email');
        const hashedPasswordColumnIndex = headerRow.findIndex(header => header && header.trim().toLowerCase() === 'hashedpassword');
        const roleColumnIndex = headerRow.findIndex(header => header && header.trim().toLowerCase() === 'role');
        const usernameColumnIndex = headerRow.findIndex(header => header && header.trim().toLowerCase() === 'username');

        console.log(`[LOGIN ENDPOINT] Índices de columnas: Email=${emailColumnIndex}, HashedPassword=${hashedPasswordColumnIndex}, Role=${roleColumnIndex}, Username=${usernameColumnIndex}`);

        if (emailColumnIndex === -1 || hashedPasswordColumnIndex === -1 || roleColumnIndex === -1 || usernameColumnIndex === -1) {
            console.error('[LOGIN ENDPOINT] Una o más columnas requeridas (Email, HashedPassword, Role, Username) no se encontraron en la cabecera de la hoja "Users". Cabeceras encontradas:', headerRow);
            return res.status(500).json({ message: 'Error de configuración del servidor: columnas de usuario no encontradas.' });
        }

        // Buscar usuario (email sin distinción de mayúsculas/minúsculas y quitando espacios)
        const userRow = rows.slice(1).find(row =>
            row[emailColumnIndex] && row[emailColumnIndex].trim().toLowerCase() === email.trim().toLowerCase()
        );

        if (!userRow) {
            console.log(`[LOGIN ENDPOINT] Usuario con email '${email}' no encontrado en la hoja.`);
            return res.status(401).json({ message: 'Usuario no encontrado.' }); // Mensaje de error
        }
        console.log(`[LOGIN ENDPOINT] Usuario encontrado:`, userRow);

        // 2. Comparar la contraseña hasheada
        const hashedPasswordFromSheet = userRow[hashedPasswordColumnIndex];
        // Ahora usamos bcrypt.compareSync para comparar la contraseña en texto plano (password)
        // con el hash almacenado en la hoja (hashedPasswordFromSheet)
        console.log(`[LOGIN ENDPOINT] Comparando contraseña para ${email}. Hash disponible: ${Boolean(hashedPasswordFromSheet)}`);

        if (bcrypt.compareSync(password, hashedPasswordFromSheet)) {
            // Bloquear cuentas desactivadas (baja logica)
            const estadoColumnIndex = headerRow.findIndex(header => header && header.trim().toLowerCase() === 'estado');
            const estado = estadoColumnIndex !== -1 ? (userRow[estadoColumnIndex] || '').toString().trim().toLowerCase() : '';
            if (estado === 'inactivo') {
                console.log(`[LOGIN ENDPOINT] Cuenta inactiva: ${email}`);
                return res.status(403).json({ message: 'Tu cuenta esta desactivada. Contacta al administrador.' });
            }
            // Contraseña correcta
            console.log(`[LOGIN ENDPOINT] Login exitoso para ${email}`);
            const normalizedRole = normalizeGlobalRole(userRow[roleColumnIndex]);
            const loginEmail = (userRow[emailColumnIndex] || '').toString().trim().toLowerCase();
            const token = signUserToken({ email: loginEmail, role: normalizedRole });
            res.status(200).json({
                message: 'Login exitoso.',
                token,
                user: {
                    username: userRow[usernameColumnIndex],
                    email: userRow[emailColumnIndex],
                    role: userRow[roleColumnIndex],
                }
            });
        } else {
            // Contraseña incorrecta
            console.log(`[LOGIN ENDPOINT] Contraseña incorrecta para ${email}.`);
            res.status(401).json({ message: 'Contraseña incorrecta.' });
        }

    } catch (error) {
        console.error('[LOGIN ENDPOINT] Error durante el login:', error.response ? error.response.data : error.message, error.stack);
        res.status(500).json({ message: 'Error en el servidor durante el login.', error: error.message });
    }
});


// Endpoint para UserGroupLinks
const normalize = (value) => (value || '').toString().trim().toLowerCase();
const normalizeLooseToken = (value) => normalize(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const VALID_GLOBAL_ROLES = new Set(['admin', 'member']);
const VALID_GROUP_ROLES = new Set(['member', 'presidente', 'tesorero', 'secretario']);
const GROUP_ADMIN_ROLES = new Set(['presidente', 'tesorero']);

const normalizeGlobalRole = (value) => {
    const role = normalizeLooseToken(value);
    if (role === 'admin' || role === 'administrador' || role === 'administrator') return 'admin';
    return 'member';
};

const normalizeGroupRole = (value) => {
    const role = normalizeLooseToken(value);
    if (['presidente', 'lider', 'leader', 'groupleader'].includes(role)) return 'presidente';
    if (['tesorero', 'tesorera', 'treasurer'].includes(role)) return 'tesorero';
    if (['secretario', 'secretaria', 'secretary'].includes(role)) return 'secretario';
    if (['member', 'miembro', 'miembros', 'socio', 'socios'].includes(role)) return 'member';
    return VALID_GROUP_ROLES.has(role) ? role : 'member';
};

// Sinonimos aceptados para un rol de grupo. Sirve para RECHAZAR un rol mal escrito
// en vez de degradarlo en silencio a 'member' (bug real: invitar como tesorero y que
// la persona terminara entrando como socio raso).
const SINONIMOS_ROL_GRUPO = new Set([
    'member', 'miembro', 'miembros', 'socio', 'socios',
    'presidente', 'presidenta', 'lider', 'leader', 'groupleader',
    'tesorero', 'tesorera', 'treasurer',
    'secretario', 'secretaria', 'secretary',
]);
const esRolDeGrupoConocido = (valor) => SINONIMOS_ROL_GRUPO.has(normalizeLooseToken(valor));

const toColumnLetter = (index) => {
    let n = index;
    let output = '';
    while (n > 0) {
        const remainder = (n - 1) % 26;
        output = String.fromCharCode(65 + remainder) + output;
        n = Math.floor((n - 1) / 26);
    }
    return output || 'A';
};

async function getUsersHeadersAndRows() {
    const sheetsClient = await getSheetsClient();
    const usersResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Users!A:F',
    });
    const allRows = usersResp.data.values || [];
    const headers = allRows[0] || [];
    const rows = allRows.slice(1);
    return { headers, rows };
}

async function getUserRoleByEmail(userEmail) {
    const email = normalize(userEmail);
    if (!email) return 'member';

    const { headers, rows } = await getUsersHeadersAndRows();
    const emailCol = headers.findIndex((h) => normalize(h) === 'email');
    const roleCol = headers.findIndex((h) => normalize(h) === 'role');
    if (emailCol === -1 || roleCol === -1) return 'member';

    const userRow = rows.find((row) => normalize(row[emailCol]) === email);
    return normalizeGlobalRole(userRow?.[roleCol]);
}

async function isGlobalAdmin(userEmail) {
    const role = await getUserRoleByEmail(userEmail);
    return role === 'admin';
}

async function getUserManagedGroupIds(userEmail) {
    const email = normalize(userEmail);
    if (!email) return new Set();

    const sheetsClient = await getSheetsClient();
    const isAdmin = await isGlobalAdmin(email);
    if (isAdmin) return null; // null representa acceso total

    const linksResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'UserGroupLinks!A2:E',
    });
    const links = linksResp.data.values || [];

    return new Set(
        links
            .filter((row) => normalize(row[0]) === email && GROUP_ADMIN_ROLES.has(normalize(row[3])))
            .map((row) => (row[1] || '').toString().trim())
            .filter(Boolean)
    );
}

async function getUserGroupIds(userEmail) {
    const email = normalize(userEmail);
    if (!email) return new Set();

    const sheetsClient = await getSheetsClient();
    const linksResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'UserGroupLinks!A2:E',
    });

    const links = linksResp.data.values || [];
    return new Set(
        links
            .filter((row) => normalize(row[0]) === email)
            .map((row) => (row[1] || '').toString().trim())
            .filter(Boolean)
    );
}

async function canManageGroup(userEmail, groupId) {
    const normalizedGroupId = (groupId || '').toString().trim();
    if (!normalizedGroupId) return false;
    const managedGroupIds = await getUserManagedGroupIds(userEmail);
    if (managedGroupIds === null) return true;
    return managedGroupIds.has(normalizedGroupId);
}

// Verifica que el solicitante sea admin global o gestor (presidente/tesorero) del grupo.
// Responde 403 y devuelve false si no tiene permiso. canManageGroup ya cubre el caso admin.
async function assertGroupManager(req, res, groupId) {
    const gid = (groupId || '').toString().trim();
    if (!gid) {
        res.status(400).json({ success: false, message: 'Falta el identificador del grupo.' });
        return false;
    }
    if (await canManageGroup(req.user.email, gid)) return true;
    res.status(403).json({ success: false, message: 'No tienes permisos para gestionar este grupo.' });
    return false;
}

// Verifica que el solicitante sea admin global o miembro del grupo (para lecturas de datos de grupo).
async function assertGroupMember(req, res, groupId) {
    const gid = (groupId || '').toString().trim();
    if (!gid) {
        res.status(400).json({ success: false, message: 'Falta el identificador del grupo.' });
        return false;
    }
    if (req.user.role === 'admin') return true;
    const sheetsClient = await getSheetsClient();
    if (await userBelongsToGroupSafe(sheetsClient, req.user.email, gid)) return true;
    res.status(403).json({ success: false, message: 'No perteneces a este grupo.' });
    return false;
}

// Devuelve el email cuyo dato puede consultarse: el propio salvo que sea admin (que puede consultar otros).
function selfEmail(req, paramEmail) {
    if (req.user && req.user.role === 'admin') {
        return (paramEmail || req.user.email);
    }
    return req.user ? req.user.email : '';
}

// Verifica que la meta (MetasAhorro: A=goalId, B=email) pertenezca al solicitante (o sea admin).
async function assertGoalOwner(req, res, goalId) {
    const id = (goalId || '').toString().trim();
    if (!id) { res.status(400).json({ success: false, message: 'Falta goalId.' }); return false; }
    if (req.user && req.user.role === 'admin') return true;
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'MetasAhorro!A:B' });
        const rows = resp.data.values || [];
        const row = rows.find((r) => (r[0] || '').toString().trim() === id);
        if (!row) { res.status(404).json({ success: false, message: 'Meta no encontrada.' }); return false; }
        if (normalizeEmailKey(row[1]) === req.user.email) return true;
        res.status(403).json({ success: false, message: 'No puedes modificar metas de otro usuario.' });
        return false;
    } catch (e) {
        res.status(500).json({ success: false, message: 'Error verificando la meta.' });
        return false;
    }
}

// Devuelve el rol de grupo (presidente/tesorero/secretario/member) del usuario en un grupo, leido del servidor.
async function getUserGroupRole(userEmail, groupId) {
    const email = normalizeEmailKey(userEmail);
    const gid = (groupId || '').toString().trim();
    if (!email || !gid) return '';
    const sheetsClient = await getSheetsClient();
    const resp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'UserGroupLinks!A2:E',
    });
    const links = resp.data.values || [];
    const found = links.find((row) => (
        normalizeEmailKey(row?.[0]) === email && (row?.[1] || '').toString().trim() === gid
    ));
    return found ? normalizeGroupRole(found[3]) : '';
}

// Tasa de interes MENSUAL configurada del grupo (Groups col Q = PorcentajeInteresMensual, indice 16)
async function getGroupMonthlyRate(groupId) {
    const gid = (groupId || '').toString().trim();
    if (!gid) return 0;
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Groups!A2:Q',
        });
        const rows = resp.data.values || [];
        const row = rows.find((r) => (r[0] || '').toString().trim() === gid);
        return row ? parseMoney(row[16]) : 0;
    } catch (e) {
        return 0;
    }
}

// Extrae el plazo (meses) del texto de Detalles, ej. "Plazo: 12"
function parsePlazo(detalles) {
    const m = (detalles || '').toString().match(/plazo\s*:?\s*(\d+)/i);
    const n = m ? parseInt(m[1], 10) : 0;
    return n > 0 ? n : 1;
}

// Suma de pagos APROBADOS de un prestamo (LoanPayments: C=loanId idx2, D=amount idx3, G=status idx6)
async function getApprovedPaymentsTotal(loanId) {
    const id = (loanId || '').toString().trim();
    if (!id) return 0;
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'LoanPayments!A2:O',
        });
        const rows = resp.data.values || [];
        return rows
            .filter((r) => (r[2] || '').toString().trim() === id && ['approved', 'aprobado'].includes((r[6] || '').toString().trim().toLowerCase()))
            .reduce((s, r) => s + parseMoney(r[3]), 0);
    } catch (e) {
        return 0;
    }
}

// Prestamos ACTIVOS (aprobados y con saldo pendiente) de un socio en un grupo.
// Lee LoanPayments una sola vez para no disparar la cuota de Sheets.
async function contarPrestamosActivos(userEmail, groupId) {
    const email = normalizeEmailKey(userEmail);
    const gid = normalizeGroupKey(groupId);
    if (!email || !gid) return { cantidad: 0, saldoTotal: 0, prestamos: [] };
    try {
        const sheetsClient = await getSheetsClient();
        const [loansResp, paysResp] = [
            await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Loans!A2:J' }),
            await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O' }),
        ];
        const loans = loansResp.data.values || [];
        const pagos = paysResp.data.values || [];
        const pagadoPorPrestamo = new Map();
        for (const p of pagos) {
            const estadoPago = (p[6] || '').toString().trim().toLowerCase();
            if (!['approved', 'aprobado'].includes(estadoPago)) continue;
            const lid = (p[2] || '').toString().trim();
            pagadoPorPrestamo.set(lid, (pagadoPorPrestamo.get(lid) || 0) + parseMoney(p[3]));
        }
        const activos = loans
            .filter((r) => normalizeEmailKey(r[1]) === email
                && normalizeGroupKey(r[2]) === gid
                && ['aprobado', 'approved', 'activo'].includes((r[7] || '').toString().trim().toLowerCase()))
            .map((r) => {
                const id = (r[0] || '').toString().trim();
                const total = parseMoney(r[9]) || parseMoney(r[3]);
                const saldo = Math.round((total - (pagadoPorPrestamo.get(id) || 0)) * 100) / 100;
                return { loanId: id, total, saldo };
            })
            .filter((l) => l.saldo > 0.009);
        return {
            cantidad: activos.length,
            saldoTotal: Math.round(activos.reduce((s, l) => s + l.saldo, 0) * 100) / 100,
            prestamos: activos,
        };
    } catch (e) {
        console.error('[contarPrestamosActivos]', e.message);
        return { cantidad: 0, saldoTotal: 0, prestamos: [] };
    }
}

// Suma de pagos COMPROMETIDOS de un prestamo: los aprobados MAS los que estan
// esperando revision. El tope de pago tiene que mirar los dos: si solo mira los
// aprobados, un socio puede subir cinco comprobantes de $80 sobre una deuda de
// $104 y la tesoreria acabar aprobando de mas.
async function getCommittedPaymentsTotal(loanId) {
    const id = (loanId || '').toString().trim();
    if (!id) return { aprobado: 0, pendiente: 0, comprometido: 0 };
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'LoanPayments!A2:O',
        });
        const filas = (resp.data.values || []).filter((r) => (r[2] || '').toString().trim() === id);
        const esEstado = (r, lista) => lista.includes((r[6] || '').toString().trim().toLowerCase());
        const aprobado = filas.filter((r) => esEstado(r, ['approved', 'aprobado']))
            .reduce((s, r) => s + parseMoney(r[3]), 0);
        const pendiente = filas.filter((r) => !esEstado(r, ['approved', 'aprobado', 'rejected', 'rechazado', 'rechazada']))
            .reduce((s, r) => s + parseMoney(r[3]), 0);
        return {
            aprobado: Math.round(aprobado * 100) / 100,
            pendiente: Math.round(pendiente * 100) / 100,
            comprometido: Math.round((aprobado + pendiente) * 100) / 100,
        };
    } catch (e) {
        console.error('[getCommittedPaymentsTotal]', e.message);
        return { aprobado: 0, pendiente: 0, comprometido: 0 };
    }
}

// Crea el prestamo aprobado en la hoja Loans (con interes) + transaccion del principal. Evita duplicados.
async function crearPrestamoAprobadoDesdeSolicitud(sheetsClient, loanId, email, loanGroupId, montoRaw, detalles) {
    const id = (loanId || '').toString().trim();
    if (!id) return null;
    const ex = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Loans!A:A' });
    const ids = (ex.data.values || []).map((r) => (r[0] || '').toString().trim());
    if (ids.includes(id)) return { yaExistia: true };

    // El tope de prestamos activos se revalida AQUI, no solo al pedir el credito:
    // si un socio deja dos solicitudes abiertas y luego se aprueban las dos, sin
    // esta comprobacion terminaria con dos prestamos vivos pese al reglamento.
    if (gobApi) {
        try {
            const reglas = await gobApi.getReglas(loanGroupId);
            const activos = await contarPrestamosActivos(email, loanGroupId);
            if (reglas.maxPrestamosActivos > 0 && activos.cantidad >= reglas.maxPrestamosActivos) {
                return {
                    error: `el socio ya tiene ${activos.cantidad} prestamo(s) activo(s) y el reglamento permite ${reglas.maxPrestamosActivos}`,
                };
            }
        } catch (e) {
            console.error('[crearPrestamo] no se pudo validar el tope de prestamos activos:', e.message);
        }
    }
    const principal = parseMoney(montoRaw);
    const term = parsePlazo(detalles);
    const monthlyRate = await getGroupMonthlyRate(loanGroupId);
    const totalConInteres = Math.round(principal * (1 + (monthlyRate / 100) * term) * 100) / 100;
    const startDate = new Date().toISOString();
    let dueDate = '';
    try { const d = new Date(); d.setMonth(d.getMonth() + term); dueDate = d.toISOString(); } catch (e) { dueDate = ''; }
    await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Loans!A:J', valueInputOption: 'RAW',
        requestBody: { values: [[id, email, loanGroupId, principal, startDate, dueDate, monthlyRate, 'aprobado', term, totalConInteres]] },
    });
    await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Transactions!A:H', valueInputOption: 'RAW',
        requestBody: { values: [[Date.now().toString(), email, 'loan', principal, `Prestamo aprobado por votacion (plazo ${term}m, ${monthlyRate}%/mes, total $${totalConInteres})`, new Date().toISOString(), 'loan', '']] },
    });
    return { totalConInteres, term, monthlyRate, yaExistia: false };
}

// Valor de la accion configurado del grupo (Groups col P = ValorAccion, indice 15)
async function getGroupShareValue(groupId) {
    const gid = (groupId || '').toString().trim();
    if (!gid) return 0;
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Groups!A2:Q',
        });
        const row = (resp.data.values || []).find((r) => (r[0] || '').toString().trim() === gid);
        return row ? parseMoney(row[15]) : 0;
    } catch (e) {
        return 0;
    }
}

// Registra en la hoja Acciones la compra aprobada por la junta. Idempotente por MovID.
// El estado sigue la MISMA regla que cualquier otro aporte: si el grupo exige
// confirmacion de tesoreria, queda pendiente hasta que entre el dinero.
async function crearAccionesAprobadasDesdeSolicitud(sheetsClient, solicitudId, email, groupId, cantidadRaw) {
    const id = (solicitudId || '').toString().trim();
    if (!id) return null;
    const movId = `solacc_${id}`;
    const ex = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Acciones!A2:M' });
    const filas = ex.data.values || [];
    if (filas.some((r) => (r[11] || '').toString().trim() === movId)) return { yaExistia: true };

    const cantidad = parseMoney(cantidadRaw);
    if (!(cantidad > 0)) return { error: 'cantidad invalida' };
    const valorAccion = await getGroupShareValue(groupId);
    if (!(valorAccion > 0)) return { error: 'el grupo no tiene configurado el valor de la accion' };
    const tasa = await getGroupMonthlyRate(groupId);
    const estado = await estadoInicialAporte(groupId);
    const ahora = new Date().toISOString();

    await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Acciones!A:M', valueInputOption: 'RAW',
        requestBody: {
            values: [[
                normalizeEmailKey(email), normalizeGroupKey(groupId), ahora.split('T')[0],
                cantidad, valorAccion, tasa, ahora,
                estado, normalizeEmailKey(email), estado === 'confirmado' ? 'asamblea' : '',
                estado === 'confirmado' ? ahora : '', movId,
                `Aprobado por la junta (solicitud ${id})`,
            ]],
        },
    });
    return { cantidad, valorAccion, estado, movId, yaExistia: false };
}

// Registra el ADELANTO aprobado: es una SALIDA de dinero contra el ahorro propio del
// socio, por eso se escribe en Savings con monto NEGATIVO y ya confirmado (el voto de
// la junta ES la autorizacion). Nunca puede dejar el ahorro en negativo. Idempotente.
async function crearAdelantoAprobadoDesdeSolicitud(sheetsClient, solicitudId, email, groupId, montoRaw) {
    const id = (solicitudId || '').toString().trim();
    if (!id) return null;
    const movId = `soladel_${id}`;
    const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Savings!A2:L' });
    const filas = resp.data.values || [];
    if (filas.some((r) => (r[10] || '').toString().trim() === movId)) return { yaExistia: true };

    const monto = parseMoney(montoRaw);
    if (!(monto > 0)) return { error: 'monto invalido' };

    const e = normalizeEmailKey(email);
    const g = normalizeGroupKey(groupId);
    const disponible = filas
        .filter((r) => normalizeEmailKey(r[0]) === e && normalizeGroupKey(r[1]) === g && aporteConfirmado(r[SAVINGS_ESTADO_IDX]))
        .reduce((suma, r) => suma + parseMoney(r[2]), 0);
    if (monto > disponible + 0.009) {
        return { error: `el adelanto (${monto.toFixed(2)}) supera el ahorro confirmado del socio (${disponible.toFixed(2)})` };
    }

    const ahora = new Date().toISOString();
    await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Savings!A:L', valueInputOption: 'RAW',
        requestBody: {
            values: [[
                e, g, -monto, ahora.split('T')[0], 'adelanto',
                `Adelanto aprobado por la junta (solicitud ${id})`,
                'confirmado', e, 'asamblea', ahora, movId, '',
            ]],
        },
    });
    await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: 'Transactions!A:H', valueInputOption: 'RAW',
        requestBody: { values: [[Date.now().toString(), e, 'adelanto', -monto, `Adelanto aprobado (solicitud ${id})`, ahora, 'adelanto', '']] },
    });
    return { monto, disponibleAntes: disponible, movId, yaExistia: false };
}

/**
 * PUNTO UNICO donde una solicitud aprobada se convierte en un hecho contable.
 * Antes solo los prestamos se materializaban: una solicitud de acciones o de
 * adelanto quedaba marcada "aprobado" y no pasaba absolutamente nada, asi que el
 * socio nunca recibia sus acciones ni su adelanto.
 */
async function materializarSolicitudAprobada(sheetsClient, tipo, solicitudId, email, groupId, valorRaw, detalles) {
    if (tipo === 'prestamo') {
        return crearPrestamoAprobadoDesdeSolicitud(sheetsClient, solicitudId, email, groupId, valorRaw, detalles);
    }
    if (tipo === 'accion') {
        return crearAccionesAprobadasDesdeSolicitud(sheetsClient, solicitudId, email, groupId, valorRaw);
    }
    if (tipo === 'adelanto') {
        return crearAdelantoAprobadoDesdeSolicitud(sheetsClient, solicitudId, email, groupId, valorRaw);
    }
    return null;
}

// Devuelve el GroupID REAL de una solicitud (leyendo su hoja por id), no el que envía el cliente.
async function getSolicitudGroup(sheetsClient, tipo, solicitudId) {
    const sheetMap = { prestamo: 'SolicitudesPrestamos', accion: 'SolicitudesAcciones', adelanto: 'SolicitudesAdelantos' };
    const sName = sheetMap[tipo];
    if (!sName) return '';
    try {
        const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sName}!A1:K` });
        const rows = resp.data.values || [];
        if (rows.length < 2) return '';
        const hdr = rows[0].map(h => (h || '').toString().trim().toLowerCase());
        const idCol = hdr.findIndex(h => h === 'id');
        const groupCol = hdr.findIndex(h => h === 'group');
        if (idCol === -1 || groupCol === -1) return '';
        const row = rows.find((r, i) => i > 0 && (r[idCol] || '').toString().trim() === solicitudId.toString().trim());
        return row ? (row[groupCol] || '').toString().trim() : '';
    } catch (e) {
        return '';
    }
}

async function getLoanGroupMap() {
    const sheetsClient = await getSheetsClient();
    const requestsResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'SolicitudesPrestamos!A2:C',
    });
    const rows = requestsResp.data.values || [];
    const map = new Map();
    rows.forEach((row) => {
        const loanId = (row[0] || '').toString().trim();
        const groupId = (row[2] || '').toString().trim();
        if (loanId) map.set(loanId, groupId);
    });

    // Fallback: algunos pagos pueden usar LoanID de la hoja Loans.
    try {
        const loansResp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Loans!A2:C',
        });
        const loansRows = loansResp.data.values || [];
        loansRows.forEach((row) => {
            const loanId = (row[0] || '').toString().trim();
            const groupId = (row[2] || '').toString().trim();
            if (loanId && groupId && !map.has(loanId)) {
                map.set(loanId, groupId);
            }
        });
    } catch (error) {
        // Si la hoja Loans no existe todavia, mantenemos solo el mapeo de solicitudes.
        if (!String(error?.message || '').includes('Unable to parse range')) {
            throw error;
        }
    }

    return map;
}

// UserGroupLinks: A=UserEmail, B=GroupID, C=JoinDate, D=GroupRole, E=Estado(activo|inactivo), F=InvitedBy
// Un vínculo SIEMPRE significa miembro ACTIVO (las invitaciones pendientes viven en la hoja Invitations).
async function createUserGroupLink({ UserEmail, GroupID, JoinDate, GroupRole, InvitedBy }) {
    if (!UserEmail || !GroupID || !JoinDate || !GroupRole) {
        return { ok: false, status: 400, body: { message: 'Faltan datos para vincular usuario a grupo. Se requieren: UserEmail, GroupID, JoinDate, GroupRole.' } };
    }
    const sheetsClient = await getSheetsClient();
    const normalizedEmail = normalize(UserEmail);
    const normalizedGroupId = (GroupID || '').toString().trim();
    const normalizedRole = normalizeGroupRole(GroupRole);

    // Evita duplicados (mismo usuario y mismo grupo)
    const existingResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'UserGroupLinks!A2:F',
    });
    const rows = existingResp.data.values || [];
    const alreadyLinked = rows.some((row) =>
        normalize(row[0]) === normalizedEmail && (row[1] || '').toString().trim() === normalizedGroupId
    );

    if (alreadyLinked) {
        return { ok: false, status: 409, body: { message: 'El usuario ya pertenece al grupo.' } };
    }

    const values = [[normalizedEmail, normalizedGroupId, JoinDate, normalizedRole, 'activo', normalize(InvitedBy) || 'self']];
    const response = await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'UserGroupLinks!A:F',
        valueInputOption: 'USER_ENTERED',
        resource: { values },
    });

    return {
        ok: true,
        status: 201,
        body: { message: 'Vinculo usuario-grupo creado con exito.', data: response.data },
    };
}

app.post('/api/vincular-usuario-grupo-en-sheet', bloquear((r) => `grupo:${normalizeGroupKey(r.body && (r.body.GroupID || r.body.groupId))}`), async (req, res) => {
    try {
        const targetGroupId = (req.body?.GroupID || req.body?.groupId || '').toString().trim();
        if (!(await assertGroupManager(req, res, targetGroupId))) return;
        const result = await createUserGroupLink(req.body || {});
        return res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Error escribiendo en Google Sheet (UserGroupLinks):', error.response ? error.response.data : error.message);
        return res.status(500).json({ message: 'Error al vincular usuario a grupo en Sheet.', error: error.message });
    }
});

// Alias compatible con payload legacy del frontend
app.post('/api/asignar-usuario-grupo', async (req, res) => {
    try {
        const { userEmail, groupId, UserEmail, GroupID, GroupRole, JoinDate } = req.body || {};
        const payload = {
            UserEmail: UserEmail || userEmail,
            GroupID: GroupID || groupId,
            GroupRole: GroupRole || 'member',
            JoinDate: JoinDate || new Date().toISOString(),
        };
        if (!(await assertGroupManager(req, res, payload.GroupID))) return;
        const result = await createUserGroupLink(payload);
        return res.status(result.status).json(result.body);
    } catch (error) {
        console.error('Error en /api/asignar-usuario-grupo:', error.message);
        return res.status(500).json({ message: 'Error al asignar usuario a grupo.', error: error.message });
    }
});

// Endpoint para listar todos los vínculos usuario-grupo
app.get('/api/obtener-usergrouplinks', requireAdmin, async (req, res) => {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'UserGroupLinks!A2:E',
        });
        const rows = response.data.values || [];
        const userGroupLinks = rows.map((row) => ({
            UserEmail: row[0] || '',
            GroupID: row[1] || '',
            JoinDate: row[2] || '',
            GroupRole: row[3] || '',
            Estado: row[4] || '',
        }));
        return res.json({ userGroupLinks });
    } catch (error) {
        console.error('Error al obtener userGroupLinks:', error.message);
        return res.status(500).json({ userGroupLinks: [] });
    }
});


// Endpoint para Loans
// Refactor: Usar loansService y auditLogService
const loansService = require('./services/loansService');
app.post('/api/registrar-prestamo-en-sheet', requireAdmin, async (req, res) => {
    try {
        const loan = req.body;
        if (!loan.LoanID || !loan.UserEmail || !loan.GroupID || loan.Amount === undefined) {
            return res.status(400).json({ message: 'Faltan datos del prestamo. Se requieren: LoanID, UserEmail, GroupID, Amount.' });
        }
        if (!(parseMoney(loan.Amount) > 0)) {
            return res.status(400).json({ message: 'El monto del prestamo debe ser un numero positivo.' });
        }
        const created = await loansService.createLoan(loan);
        res.status(201).json({ message: 'Prestamo registrado en Google Sheet con exito.', data: created });
    } catch (error) {
        console.error('[REGISTRAR PRESTAMO] Error:', error.message);
        res.status(500).json({ message: 'Error al registrar prestamo en Sheet.' });
    }
});

// Endpoint para listar todos los préstamos
app.get('/api/obtener-todos-prestamos', requireAdmin, async (req, res) => {
    try {
        const loans = await loansService.getAllLoans();
        return res.status(200).json({ loans });
    } catch (error) {
        return res.status(500).json({ message: 'Error al obtener préstamos.', loans: [], error: error.message });
    }
});

// Endpoint para Transactions
app.post('/api/registrar-transaccion-en-sheet', async (req, res) => {
    // Cabeceras: TransactionID, UserEmail, Type, Amount, Description, Date, Category, Icon
    const { TransactionID, Type, Amount, Description, Date, Category, Icon } = req.body;
    // La transaccion se registra a nombre del usuario autenticado (admin puede indicar otro)
    const UserEmail = selfEmail(req, req.body.UserEmail);

    if (!TransactionID || !UserEmail || !Type || Amount === undefined || !Date || !Category) {
        return res.status(400).json({ message: 'Faltan datos de la transacción. Se requieren: TransactionID, Type, Amount, Date, Category.' });
    }

    const values = [[TransactionID, UserEmail, Type, Amount, sanitizeCell(Description), Date, Category, Icon || '']];
    const resource = { values };

    try {
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Transactions!A:H', // Pestaña 'Transactions', columnas A hasta H
            valueInputOption: 'USER_ENTERED',
            resource,
        });
        console.log('Respuesta de Google Sheets API (Transactions):', response.data);
        res.status(201).json({ message: 'Transacción registrada en Google Sheet con éxito.', data: response.data });
    } catch (error) {
        console.error('Error escribiendo en Google Sheet (Transactions):', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Error al registrar transacción en Sheet.', error: error.message });
    }
});

const { ensureSheetExists } = require('./sheetsUtils');

// Endpoint para obtener aportes de un grupo
app.get('/api/aportes/:groupId', async (req, res) => {
    try {
        const { groupId } = req.params;
        if (!groupId) {
            return res.status(400).json({ message: 'groupId es requerido.', aportes: [] });
        }
        if (!(await assertGroupMember(req, res, groupId))) return;

        await ensureSheetExists('Aportes', ['GroupID', 'Email', 'Monto', 'Fecha', 'CreatedAt'], sheets, SPREADSHEET_ID);
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Aportes!A2:E',
        });

        const rows = response.data.values || [];
        const aportes = rows
            .filter((row) => (row[0] || '').toString().trim() === groupId.toString().trim())
            .map((row) => ({
                GroupID: row[0] || '',
                Email: row[1] || '',
                Monto: Number(row[2] || 0),
                Fecha: row[3] || '',
                CreatedAt: row[4] || '',
            }));

        return res.json({ aportes });
    } catch (error) {
        console.error('[APORTES] Error al obtener aportes:', error.message);
        return res.status(500).json({ message: 'Error al obtener aportes.', aportes: [] });
    }
});

// Endpoint para registrar aporte individual
app.post('/api/agregar-aporte', async (req, res) => {
    try {
        const cuerpoAporte = req.body || {};
        const GroupID = cuerpoAporte.GroupID || cuerpoAporte.groupId;
        const Email = cuerpoAporte.Email || cuerpoAporte.email;
        const Monto = cuerpoAporte.Monto !== undefined ? cuerpoAporte.Monto : cuerpoAporte.monto;
        const Fecha = cuerpoAporte.Fecha || cuerpoAporte.fecha;
        if (!GroupID || !Email || Monto === undefined || !Fecha) {
            return res.status(400).json({
                message: 'Faltan datos. Se requieren: GroupID, Email, Monto, Fecha.'
            });
        }
        if (Number(Monto) <= 0 || Number.isNaN(Number(Monto))) {
            return res.status(400).json({ message: 'El monto debe ser un numero mayor a 0.' });
        }
        // Admin/gestor del grupo pueden registrar a nombre de cualquier miembro; un miembro solo el suyo
        const isPriv = req.user.role === 'admin' || await canManageGroup(req.user.email, (GroupID || '').toString().trim());
        const contributorEmail = isPriv ? Email : req.user.email;
        if (!(await userBelongsToGroupSafe(sheets, contributorEmail, GroupID))) {
            return res.status(403).json({ message: 'El aportante no pertenece a este grupo.' });
        }

        await ensureSheetExists('Aportes', ['GroupID', 'Email', 'Monto', 'Fecha', 'CreatedAt'], sheets, SPREADSHEET_ID);
        const row = [[GroupID, contributorEmail, Number(Monto), Fecha, new Date().toISOString()]];
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Aportes!A:E',
            valueInputOption: 'USER_ENTERED',
            resource: { values: row },
        });

        return res.status(201).json({ success: true, message: 'Aporte registrado correctamente.' });
    } catch (error) {
        console.error('[APORTES] Error al registrar aporte:', error.message);
        return res.status(500).json({ success: false, message: 'Error al registrar aporte.' });
    }
});

// Endpoint genérico para registrar solicitudes dinámicas y crear pestañas si no existen
app.post('/api/registrar-solicitud', bloquear((r) => `solicitudes:${r.user && r.user.email}`), async (req, res) => {
    // Log extra para saber desde dónde llega la petición
    console.log('[SOLICITUD][INICIO] Body recibido:', req.body, 'IP:', req.ip, 'Origin:', req.headers.origin, 'User-Agent:', req.headers['user-agent']);
    // Validación de body
    if (!req.body || typeof req.body !== 'object') {
        console.error('[SOLICITUD][ERROR] Body vacío o no es un objeto:', req.body);
        return res.status(400).json({ message: 'Body vacío o formato incorrecto.' });
    }
    const { tipo, data } = req.body;
    if (!tipo || !data) {
        console.error('[SOLICITUD][ERROR] Faltan campos tipo o data:', req.body);
        return res.status(400).json({ message: 'Faltan campos tipo o data en la solicitud.' });
    }
    // La solicitud siempre se crea a nombre del usuario autenticado (no se puede solicitar por otro)
    if (req.user.role !== 'admin') {
        data.UserEmail = req.user.email;
    } else if (!data.UserEmail) {
        data.UserEmail = req.user.email;
    }
    // Validar el monto/cantidad: numero positivo y razonable (evita negativos, no numericos, NaN, overflow)
    const montoSolicitado = parseMoney(tipo === 'accion' ? (data.Cantidad != null ? data.Cantidad : data.Monto) : data.Monto);
    if (!Number.isFinite(montoSolicitado) || montoSolicitado <= 0 || montoSolicitado > MONTO_MAXIMO) {
        return res.status(400).json({ message: 'El monto/cantidad debe ser un numero positivo y valido.' });
    }
    const config = {
        prestamo: {
            sheet: 'SolicitudesPrestamos',
            headers: ['ID', 'UserEmail', 'Group', 'GroupRole', 'Monto', 'Estado', 'Fecha', 'Detalles', 'AprobadoPor', 'TasaInteres']
        },
        accion: {
            sheet: 'SolicitudesAcciones',
            headers: ['ID', 'UserEmail', 'Group', 'GroupRole', 'Cantidad', 'Estado', 'Fecha', 'Detalles', 'AprobadoPor']
        },
        adelanto: {
            sheet: 'SolicitudesAdelantos',
            headers: ['ID', 'UserEmail', 'Group', 'GroupRole', 'Monto', 'Estado', 'Fecha', 'Detalles', 'AprobadoPor']
        },
    };
    if (!config[tipo]) {
        console.error('[SOLICITUD][ERROR] Tipo de solicitud no soportado:', tipo);
        return res.status(400).json({ message: 'Tipo de solicitud no soportado.' });
    }
    try {
        // Obtener grupo y rol del usuario
        const usersRes = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Users!A1:E',
        });
        const usersRows = usersRes.data.values;
        const headers = usersRows[0];
        const emailCol = headers.findIndex(h => h.trim().toLowerCase() === 'email');
        // Manejo robusto de columnas Group y GroupRole
        const groupCol = headers.findIndex(h => h.trim().toLowerCase() === 'group');
        const groupRoleCol = headers.findIndex(h => h.trim().toLowerCase() === 'grouprole');
        // Buscar la fila del usuario SOLO por email (sin depender de columnas Group ni GroupRole)
        const userRow = usersRows.find((row, i) => i > 0 && row[emailCol] && row[emailCol].trim().toLowerCase() === data.UserEmail.trim().toLowerCase());
        if (!userRow) {
            return res.status(404).json({ message: 'Usuario no encontrado en la hoja de usuarios.' });
        }
        // Buscar todos los grupos del usuario en UserGroupLinks
        let userGroup = '';
        let userGroupRole = '';
        let userGroups = [];
        try {
            const linksResp = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'UserGroupLinks!A2:E',
            });
            const links = linksResp.data.values || [];
            userGroups = links.filter(l => (l[0] || '').trim().toLowerCase() === data.UserEmail.trim().toLowerCase());
        } catch (e) {}
        // Si el frontend envía Group y el usuario pertenece a ese grupo, usar ese grupo
        if (data.Group) {
            const found = userGroups.find(l => (l[1] || '').trim() === data.Group.trim());
            if (found) {
                userGroup = found[1] || '';
                userGroupRole = found[3] || '';
            }
        }
        // Si no se envió Group o no se encontró, usar el primer grupo encontrado
        if (!userGroup && userGroups.length > 0) {
            userGroup = userGroups[0][1] || '';
            userGroupRole = userGroups[0][3] || '';
        }
        // Si no está en ningún grupo, rechaza la solicitud
        if (!userGroup) {
            console.error('[REGISTRAR SOLICITUD] El usuario no pertenece a ningún grupo:', data.UserEmail, userGroups);
            return res.status(400).json({ message: 'El usuario no pertenece a ningún grupo. No puede registrar solicitudes.' });
        }

        // --- CONTROL INTERNO: reglamento del grupo aplicado en el SERVIDOR ---
        // (antes el tope de credito solo se validaba en el frontend, que es evitable)
        if (tipo === 'prestamo' && gobApi) {
            const reglas = await gobApi.getReglas(userGroup);

            const activos = await contarPrestamosActivos(data.UserEmail, userGroup);
            if (reglas.maxPrestamosActivos > 0 && activos.cantidad >= reglas.maxPrestamosActivos) {
                return res.status(409).json({
                    message: `Ya tienes ${activos.cantidad} prestamo(s) activo(s). El reglamento del grupo permite un maximo de ${reglas.maxPrestamosActivos}.`,
                    codigo: 'MAX_PRESTAMOS_ACTIVOS'
                });
            }

            const ahorro = await gobApi.ahorroConfirmado(data.UserEmail, userGroup);
            const tope = ahorro * reglas.topePrestamoFactorAhorro;
            if (montoSolicitado > tope) {
                return res.status(409).json({
                    message: `El monto solicitado ($${montoSolicitado.toFixed(2)}) supera tu cupo. `
                        + `Con $${ahorro.toFixed(2)} de ahorro confirmado tu cupo es $${tope.toFixed(2)} `
                        + `(${reglas.topePrestamoFactorAhorro}x el ahorro).`,
                    codigo: 'SOBRE_CUPO',
                    ahorroConfirmado: Math.round(ahorro * 100) / 100,
                    cupoMaximo: Math.round(tope * 100) / 100
                });
            }
        }
        // Autenticación correcta para cada request
        const client = await auth.getClient();
        const sheetsApi = google.sheets({ version: 'v4', auth: client });
        // LOG extra para depuración
        console.log('[REGISTRAR SOLICITUD] Tipo:', tipo);
        console.log('[REGISTRAR SOLICITUD] Data:', data);
        console.log('[REGISTRAR SOLICITUD] userGroup:', userGroup, 'userGroupRole:', userGroupRole);
        // Asegura que la pestaña existe y que su cabecera coincide con la config
        // (corrige hojas con header antiguo; p.ej. SolicitudesAcciones sin columna Group)
        await ensureSheetExists(config[tipo].sheet, config[tipo].headers, sheetsApi, SPREADSHEET_ID);
        await sheetsApi.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${config[tipo].sheet}!A1`,
            valueInputOption: 'RAW',
            resource: { values: [config[tipo].headers] },
        });
        // Prepara los valores (en el mismo orden que los headers)
        let values;
        let appendRange = `${config[tipo].sheet}!A:J`; // Extendido para incluir TasaInteres
        if (tipo === 'accion') {
            values = [[
                data.ID || Date.now().toString(),
                data.UserEmail,
                userGroup,
                userGroupRole,
                data.Cantidad || data.Monto || '',
                data.Estado || 'pendiente',
                data.Fecha || new Date().toISOString(),
                sanitizeCell(data.Detalles),
                '' // AprobadoPor
            ]];
            appendRange = `${config[tipo].sheet}!A:I`;
        } else if (tipo === 'prestamo') {
            values = [[
                data.ID || Date.now().toString(),
                data.UserEmail,
                userGroup,
                userGroupRole,
                data.Monto || '',
                data.Estado || 'pendiente',
                data.Fecha || new Date().toISOString(),
                sanitizeCell(data.Detalles),
                '', // AprobadoPor
                data.TasaInteres || 0 // Tasa de interés del grupo
            ]];
        } else {
            values = [[
                data.ID || Date.now().toString(),
                data.UserEmail,
                userGroup,
                userGroupRole,
                data.Monto || data.Cantidad || '',
                data.Estado || 'pendiente',
                data.Fecha || new Date().toISOString(),
                sanitizeCell(data.Detalles),
                '' // AprobadoPor
            ]];
            appendRange = `${config[tipo].sheet}!A:I`;
        }
        console.log('[REGISTRAR SOLICITUD] Valores a insertar:', values, 'Rango:', appendRange);
        try {
            const appendResponse = await sheetsApi.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: appendRange,
                valueInputOption: 'USER_ENTERED',
                resource: { values },
            });
            console.log('[REGISTRAR SOLICITUD] Respuesta de Google Sheets API:', appendResponse.data);
            res.status(201).json({ message: 'Solicitud registrada correctamente.' });
        } catch (appendError) {
            console.error('[REGISTRAR SOLICITUD] Error al insertar en Google Sheets:', appendError.response ? appendError.response.data : appendError.message, appendError.stack);
            res.status(500).json({ message: 'Error al registrar solicitud en Google Sheets.', error: appendError.message, stack: appendError.stack });
        }
    } catch (error) {
        // Log detallado del error
        console.error('[REGISTRAR SOLICITUD][ERROR] Error registrando solicitud dinámica:', error, 'Stack:', error.stack);
        res.status(500).json({ message: 'Error al registrar solicitud.', error: error.message, stack: error.stack });
    }
});

// Endpoint para listar solicitudes pendientes por grupo
app.get('/api/solicitudes-pendientes', async (req, res) => {
    const { group, tipo } = req.query;
    if (!(await assertGroupMember(req, res, group))) return;
    const config = {
        prestamo: 'SolicitudesPrestamos',
        accion: 'SolicitudesAcciones',
        adelanto: 'SolicitudesAdelantos',
    };
    if (!config[tipo]) return res.status(400).json({ message: 'Tipo de solicitud no soportado.' });
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${config[tipo]}!A1:I`,
        });
        const rows = response.data.values;
        const headers = rows[0];
        const groupCol = headers.findIndex(h => h.trim().toLowerCase() === 'group');
        const estadoCol = headers.findIndex(h => h.trim().toLowerCase() === 'estado');
        const pendientes = rows.slice(1).filter(row => row[groupCol] === group && row[estadoCol] === 'pendiente');
        res.json({ solicitudes: pendientes, headers });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener solicitudes pendientes.', error: error.message });
    }
});

// Endpoint para aprobar/rechazar solicitud
app.post('/api/aprobar-solicitud', bloquear((r) => `solicitud:${r.body && r.body.solicitudId}`), async (req, res) => {
    const { tipo, solicitudId, nuevoEstado } = req.body;
    const aprobadorEmail = req.user.email; // identidad desde el token
    const config = {
        prestamo: 'SolicitudesPrestamos',
        accion: 'SolicitudesAcciones',
        adelanto: 'SolicitudesAdelantos',
    };
    if (!config[tipo]) return res.status(400).json({ message: 'Tipo de solicitud no soportado.' });
    try {
        // Obtener todas las solicitudes
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: `${config[tipo]}!A1:I`,
        });
        const rows = response.data.values;
        const headers = rows[0];
        const idCol = headers.findIndex(h => h.trim().toLowerCase() === 'id');
        const estadoCol = headers.findIndex(h => h.trim().toLowerCase() === 'estado');
        const aprobadoPorCol = headers.findIndex(h => h.trim().toLowerCase() === 'aprobadopor');
        const groupCol = headers.findIndex(h => h.trim().toLowerCase() === 'group');
        const solicitudIdx = rows.findIndex((row, i) => i > 0 && row[idCol] === solicitudId);
        if (solicitudIdx === -1) return res.status(404).json({ message: 'Solicitud no encontrada.' });
        // Solo admin o gestor (presidente/tesorero) del grupo de la solicitud pueden aprobar/rechazar
        const solicitudGroup = groupCol !== -1 ? rows[solicitudIdx][groupCol] : '';
        if (!(await assertGroupManager(req, res, solicitudGroup))) return;

        // Solo se aceptan estados conocidos (evita escribir cualquier texto en la hoja)
        const estadoDestino = (nuevoEstado || '').toString().trim().toLowerCase();
        if (!['aprobado', 'rechazado'].includes(estadoDestino)) {
            return res.status(400).json({ message: 'nuevoEstado debe ser "aprobado" o "rechazado".' });
        }

        // Idempotencia: una solicitud ya resuelta no se reprocesa
        const estadoPrevio = (rows[solicitudIdx][estadoCol] || '').toString().trim().toLowerCase();
        if (['aprobado', 'aprobada', 'rechazado', 'rechazada'].includes(estadoPrevio)) {
            return res.status(409).json({ message: `La solicitud ya fue ${estadoPrevio}.`, estado: estadoPrevio });
        }

        // Control interno: si el grupo exige aprobacion colegiada, esta via directa no
        // puede usarse para prestamos; debe resolverse por la votacion de la junta.
        if (tipo === 'prestamo' && gobApi && req.user.role !== 'admin') {
            const reglas = await gobApi.getReglas(solicitudGroup);
            if (reglas.requiereAprobacionPrestamos) {
                return res.status(409).json({
                    codigo: 'REQUIERE_VOTACION',
                    message: 'Este grupo exige aprobacion colegiada. Registra tu voto en el panel de liderazgo; '
                        + 'la solicitud se aprueba sola al alcanzar el quorum.'
                });
            }
        }

        // Se materializa PRIMERO: si no se puede aplicar, la solicitud no se marca
        // como aprobada (evita solicitudes aprobadas sin efecto contable).
        if (estadoDestino === 'aprobado') {
            const r = rows[solicitudIdx];
            const emailC = headers.findIndex(h => h.trim().toLowerCase() === 'useremail');
            const montoC = headers.findIndex(h => ['monto', 'cantidad'].includes(h.trim().toLowerCase()));
            const detC = headers.findIndex(h => h.trim().toLowerCase() === 'detalles');
            const efecto = await materializarSolicitudAprobada(
                sheets, tipo, solicitudId, r[emailC], solicitudGroup, r[montoC], r[detC]
            );
            if (efecto && efecto.error) {
                return res.status(409).json({ message: `No se pudo aplicar la solicitud: ${efecto.error}` });
            }
        }
        rows[solicitudIdx][estadoCol] = estadoDestino;
        rows[solicitudIdx][aprobadoPorCol] = aprobadorEmail;
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${config[tipo]}!A${solicitudIdx+1}:I${solicitudIdx+1}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [rows[solicitudIdx]] },
        });
        res.json({ message: 'Solicitud actualizada correctamente.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar solicitud.', error: error.message });
    }
});

// ============================================================
// LIDERAZGO: Sistema de votación multi-firma y actas
// ============================================================

// Obtener todas las solicitudes pendientes de un grupo (para líderes)
app.get('/api/solicitudes-grupo', async (req, res) => {
    const { groupId } = req.query;
    if (!groupId) return res.status(400).json({ message: 'groupId requerido.' });
    if (!(await assertGroupMember(req, res, groupId))) return;
    try {
        const sheetsClient = await getSheetsClient();
        const tipos = [
            { tipo: 'prestamo', sheet: 'SolicitudesPrestamos' },
            { tipo: 'accion', sheet: 'SolicitudesAcciones' },
            { tipo: 'adelanto', sheet: 'SolicitudesAdelantos' },
        ];
        let todas = [];
        for (const { tipo, sheet } of tipos) {
            try {
                const resp = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `${sheet}!A1:K`,
                });
                const rows = resp.data.values || [];
                if (rows.length < 2) continue;
                const headers = rows[0].map(h => h.trim().toLowerCase());
                const groupCol = headers.findIndex(h => h === 'group');
                const estadoCol = headers.findIndex(h => h === 'estado');
                const idCol = headers.findIndex(h => h === 'id');
                const emailCol = headers.findIndex(h => h === 'useremail');
                const montoCol = headers.findIndex(h => h === 'monto' || h === 'cantidad');
                const fechaCol = headers.findIndex(h => h === 'fecha');
                const groupRows = rows.slice(1).filter(row =>
                    (row[groupCol] || '').trim() === groupId.trim()
                );
                groupRows.forEach(row => {
                    todas.push({
                        tipo,
                        id: row[idCol] || '',
                        userEmail: row[emailCol] || '',
                        monto: row[montoCol] || '',
                        estado: row[estadoCol] || '',
                        fecha: row[fechaCol] || '',
                        group: groupId,
                    });
                });
            } catch (e) { /* skip missing sheet */ }
        }
        res.json({ solicitudes: todas });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener solicitudes del grupo.', error: error.message });
    }
});

// Obtener votos de una solicitud específica
app.get('/api/votos-solicitud', async (req, res) => {
    const { solicitudId } = req.query;
    if (!solicitudId) return res.status(400).json({ message: 'solicitudId requerido.' });
    try {
        const sheetsClient = await getSheetsClient();
        // Asegurar que la hoja existe
        await ensureSheetExists('AprobacionesAsamblea', [
            'SolicitudID', 'Tipo', 'GrupoID', 'AprobadoPor', 'RolAprobador', 'Decision', 'Fecha', 'Comentario'
        ], sheetsClient, SPREADSHEET_ID);
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'AprobacionesAsamblea!A1:H',
        });
        const rows = resp.data.values || [];
        if (rows.length < 2) return res.json({ votos: [] });
        const headers = rows[0].map(h => h.trim().toLowerCase());
        const solicitudCol = headers.findIndex(h => h === 'solicitudid');
        const votos = rows.slice(1).filter(row =>
            (row[solicitudCol] || '').trim() === solicitudId.trim()
        ).map(row => ({
            solicitudId: row[0] || '',
            tipo: row[1] || '',
            grupoId: row[2] || '',
            aprobadoPor: row[3] || '',
            rolAprobador: row[4] || '',
            decision: row[5] || '',
            fecha: row[6] || '',
            comentario: row[7] || '',
        }));
        // Aislamiento: si hay votos, el solicitante debe ser admin o miembro del grupo de la solicitud
        const grupoDeVotos = votos.length ? votos[0].grupoId : '';
        if (grupoDeVotos && req.user.role !== 'admin') {
            const pertenece = await userBelongsToGroupSafe(sheetsClient, req.user.email, grupoDeVotos);
            if (!pertenece) return res.status(403).json({ message: 'No perteneces a este grupo.' });
        }
        res.json({ votos });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener votos.', error: error.message });
    }
});

// Registrar voto de un líder sobre una solicitud
app.post('/api/registrar-voto', bloquear((r) => `solicitud:${r.body && r.body.solicitudId}`), async (req, res) => {
    const { solicitudId, tipo, grupoId, decision, comentario } = req.body;
    if (!solicitudId || !tipo || !grupoId || !decision) {
        return res.status(400).json({ message: 'Faltan campos requeridos.' });
    }
    // Identidad y rol vienen del servidor, no del cliente (evita votos falsos / auto-aprobacion)
    const aprobadoPor = req.user.email;
    const rolesValidos = new Set(['presidente', 'tesorero', 'secretario']);
    try {
        const sheetsClient = await getSheetsClient();
        // Resolver el grupo REAL de la solicitud (no confiar en el grupoId del cliente -> evita votar en grupo ajeno)
        const grupoReal = await getSolicitudGroup(sheetsClient, tipo, solicitudId);
        if (!grupoReal) return res.status(404).json({ message: 'Solicitud no encontrada.' });
        // El rol de lider se valida contra el grupo REAL de la solicitud
        const rolAprobador = await getUserGroupRole(aprobadoPor, grupoReal);
        if (!rolesValidos.has((rolAprobador || '').toLowerCase())) {
            return res.status(403).json({ message: 'Solo lideres del grupo de la solicitud pueden votar.' });
        }
        // Asegurar que la hoja existe
        await ensureSheetExists('AprobacionesAsamblea', [
            'SolicitudID', 'Tipo', 'GrupoID', 'AprobadoPor', 'RolAprobador', 'Decision', 'Fecha', 'Comentario'
        ], sheetsClient, SPREADSHEET_ID);

        // Verificar si ya votó este líder
        const existing = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'AprobacionesAsamblea!A1:H',
        });
        const rows = existing.data.values || [];
        if (rows.length > 1) {
            const headers = rows[0].map(h => h.trim().toLowerCase());
            const solicitudCol = headers.findIndex(h => h === 'solicitudid');
            const emailCol = headers.findIndex(h => h === 'aprobadopor');
            const yaVoto = rows.slice(1).some(row =>
                (row[solicitudCol] || '').trim() === solicitudId.trim() &&
                (row[emailCol] || '').trim().toLowerCase() === aprobadoPor.trim().toLowerCase()
            );
            if (yaVoto) {
                return res.status(409).json({ message: 'Este líder ya registró su voto para esta solicitud.' });
            }
        }

        // Registrar voto
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'AprobacionesAsamblea!A:H',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[
                solicitudId, tipo, grupoReal, aprobadoPor,
                rolAprobador, decision, new Date().toISOString(), sanitizeCell(comentario)
            ]] },
        });

        // Verificar si ya hay suficientes aprobaciones (2 de 3 líderes)
        const updatedResp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'AprobacionesAsamblea!A1:H',
        });
        const updRows = updatedResp.data.values || [];
        if (updRows.length > 1) {
            const hdr = updRows[0].map(h => h.trim().toLowerCase());
            const solCol = hdr.findIndex(h => h === 'solicitudid');
            const decCol = hdr.findIndex(h => h === 'decision');
            const votosDeEstaSolicitud = updRows.slice(1).filter(r =>
                (r[solCol] || '').trim() === solicitudId.trim()
            );
            const aprobaciones = votosDeEstaSolicitud.filter(r =>
                (r[decCol] || '').toLowerCase() === 'aprobado'
            ).length;
            const rechazos = votosDeEstaSolicitud.filter(r =>
                (r[decCol] || '').toLowerCase() === 'rechazado'
            ).length;

            const sheetMap = { prestamo: 'SolicitudesPrestamos', accion: 'SolicitudesAcciones', adelanto: 'SolicitudesAdelantos' };
            const sheetName = sheetMap[tipo];

            if (sheetName) {
                // Quórum dinámico: en grupos con 1 solo líder basta 1 voto; con 2+ líderes se piden 2.
                // El quorum se calcula sobre el grupo REAL de la solicitud, nunca sobre el
                // grupoId que envia el cliente (evita bajar el quorum apuntando a otro grupo).
                const numLideres = await getActiveLeaderCount(grupoReal);
                // El reglamento del grupo puede fijar un quorum explicito; si vale 0 se usa
                // el automatico min(2, lideres activos) y nunca mas que los lideres que hay.
                let quorum = Math.min(2, Math.max(1, numLideres));
                if (gobApi) {
                    const reglasGrupo = await gobApi.getReglas(grupoReal);
                    if (reglasGrupo.quorumPrestamos > 0) {
                        quorum = Math.min(Math.max(1, numLideres), reglasGrupo.quorumPrestamos);
                    }
                }
                let nuevoEstado = null;
                if (rechazos >= 1) nuevoEstado = 'rechazado';
                else if (aprobaciones >= quorum) nuevoEstado = 'aprobado';

                if (nuevoEstado) {
                    const solResp = await sheetsClient.spreadsheets.values.get({
                        spreadsheetId: SPREADSHEET_ID,
                        range: `${sheetName}!A1:K`,
                    });
                    const solRows = solResp.data.values || [];
                    if (solRows.length > 1) {
                        const solHdr = solRows[0].map(h => h.trim().toLowerCase());
                        const idCol = solHdr.findIndex(h => h === 'id');
                        const estadoCol = solHdr.findIndex(h => h === 'estado');
                        const aprobadoPorCol = solHdr.findIndex(h => h === 'aprobadopor');
                        const solIdx = solRows.findIndex((r, i) => i > 0 && (r[idCol] || '').trim() === solicitudId.trim());
                        if (solIdx !== -1) {
                            let estadoFinal = nuevoEstado;
                            const detallesCol = solHdr.findIndex(h => h === 'detalles');

                            // Se materializa PRIMERO y solo entonces se da por aprobada.
                            // Al reves quedaban solicitudes "aprobadas" sin prestamo, sin
                            // acciones y sin adelanto: dinero prometido que no existia.
                            if (nuevoEstado === 'aprobado') {
                                const r = solRows[solIdx];
                                const efecto = await materializarSolicitudAprobada(
                                    sheetsClient, tipo, r[idCol], r[1], r[2], r[4], r[7]
                                );
                                if (efecto && efecto.error) {
                                    // No se puede ejecutar: la solicitud se cierra como rechazada
                                    // con el motivo, en vez de dejarla aprobada y vacia.
                                    estadoFinal = 'rechazado';
                                    if (detallesCol !== -1) {
                                        solRows[solIdx][detallesCol] =
                                            `${solRows[solIdx][detallesCol] || ''} | No aplicada: ${efecto.error}`.trim();
                                    }
                                    console.error('[REGISTRAR VOTO] solicitud no aplicable:', efecto.error);
                                }
                            }

                            solRows[solIdx][estadoCol] = estadoFinal;
                            if (aprobadoPorCol !== -1) solRows[solIdx][aprobadoPorCol] = aprobadoPor;
                            await sheetsClient.spreadsheets.values.update({
                                spreadsheetId: SPREADSHEET_ID,
                                range: `${sheetName}!A${solIdx + 1}:K${solIdx + 1}`,
                                valueInputOption: 'USER_ENTERED',
                                resource: { values: [solRows[solIdx]] },
                            });
                        }
                    }
                }
            }
        }

        res.status(201).json({ message: 'Voto registrado correctamente.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al registrar voto.', error: error.message });
    }
});

// Registrar acta de asamblea (secretario)
app.post('/api/registrar-acta', async (req, res) => {
    const { grupoId, titulo, contenido, asistentes } = req.body;
    if (!grupoId || !titulo) {
        return res.status(400).json({ message: 'Faltan campos: grupoId, titulo.' });
    }
    // El acta se crea a nombre del usuario autenticado; debe ser lider del grupo
    const creadaPor = req.user.email;
    const rolEnGrupo = await getUserGroupRole(creadaPor, grupoId);
    if (req.user.role !== 'admin' && !['presidente', 'tesorero', 'secretario'].includes(rolEnGrupo)) {
        return res.status(403).json({ message: 'Solo lideres del grupo pueden registrar actas.' });
    }
    try {
        const sheetsClient = await getSheetsClient();
        await ensureSheetExists('ActasAsamblea', [
            'ActaID', 'GrupoID', 'Fecha', 'CreadaPor', 'Titulo', 'Contenido', 'Asistentes'
        ], sheetsClient, SPREADSHEET_ID);
        const actaId = `acta-${Date.now()}`;
        await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'ActasAsamblea!A:G',
            valueInputOption: 'USER_ENTERED',
            resource: { values: [[
                actaId, grupoId, new Date().toISOString(),
                creadaPor, sanitizeCell(titulo), sanitizeCell(contenido), sanitizeCell(asistentes)
            ]] },
        });
        res.status(201).json({ message: 'Acta registrada correctamente.', actaId });
    } catch (error) {
        res.status(500).json({ message: 'Error al registrar acta.', error: error.message });
    }
});

// Obtener actas de asamblea de un grupo
app.get('/api/actas-asamblea', async (req, res) => {
    const { groupId } = req.query;
    if (!groupId) return res.status(400).json({ message: 'groupId requerido.' });
    if (!(await assertGroupMember(req, res, groupId))) return;
    try {
        const sheetsClient = await getSheetsClient();
        await ensureSheetExists('ActasAsamblea', [
            'ActaID', 'GrupoID', 'Fecha', 'CreadaPor', 'Titulo', 'Contenido', 'Asistentes'
        ], sheetsClient, SPREADSHEET_ID);
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'ActasAsamblea!A1:G',
        });
        const rows = resp.data.values || [];
        if (rows.length < 2) return res.json({ actas: [] });
        const headers = rows[0].map(h => h.trim().toLowerCase());
        const grupoCol = headers.findIndex(h => h === 'grupoid');
        const actas = rows.slice(1)
            .filter(row => (row[grupoCol] || '').trim() === groupId.trim())
            .map(row => ({
                actaId: row[0] || '',
                grupoId: row[1] || '',
                fecha: row[2] || '',
                creadaPor: row[3] || '',
                titulo: row[4] || '',
                contenido: row[5] || '',
                asistentes: row[6] || '',
            }))
            .sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
        res.json({ actas });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener actas.', error: error.message });
    }
});

// Endpoint para cambiar el rol de un usuario
app.post('/api/cambiar-rol-usuario', requireAdmin, async (req, res) => {
    const cuerpo = req.body || {};
    const Email = cuerpo.Email || cuerpo.email || cuerpo.userEmail || cuerpo.UserEmail;
    const Role = cuerpo.Role || cuerpo.role || cuerpo.nuevoRol || cuerpo.rol;
    const normalizedEmail = normalize(Email);
    const normalizedRole = normalizeGlobalRole(Role);
    if (!normalizedEmail || !Role) {
        return res.status(400).json({ message: 'Faltan datos: Email y Role son requeridos.' });
    }
    try {
        const sheetsClient = await getSheetsClient();
        // Leer todos los usuarios
        const response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Users!A:F',
        });
        const rows = response.data.values || [];
        if (rows.length < 2) {
            return res.status(404).json({ message: 'No hay usuarios registrados.' });
        }
        const headerRow = rows[0];
        const emailCol = headerRow.findIndex(h => normalize(h) === 'email');
        const roleCol = headerRow.findIndex(h => normalize(h) === 'role');
        if (emailCol === -1 || roleCol === -1) {
            return res.status(500).json({ message: 'No se encontraron columnas Email o Role.' });
        }
        const userIndex = rows.findIndex((row, i) => i > 0 && normalize(row[emailCol]) === normalizedEmail);
        if (userIndex === -1) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }

        const currentRole = normalizeGlobalRole(rows[userIndex][roleCol]);
        const adminsCount = rows
            .slice(1)
            .reduce((acc, row) => acc + (normalizeGlobalRole(row[roleCol]) === 'admin' ? 1 : 0), 0);

        if (currentRole === 'admin' && normalizedRole !== 'admin' && adminsCount <= 1) {
            return res.status(400).json({ message: 'No se puede quitar el último administrador global.' });
        }

        rows[userIndex][roleCol] = normalizedRole;
        const lastColumn = toColumnLetter(headerRow.length || 6);
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Users!A${userIndex + 1}:${lastColumn}${userIndex + 1}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [rows[userIndex]] },
        });
        res.json({ message: 'Rol actualizado correctamente.', role: normalizedRole });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar rol.', error: error.message });
    }
});

// Endpoint para desactivar usuario (eliminar fila)
// Asegura que la hoja Users tenga las columnas extendidas (Telefono, Cedula, Estado)
async function ensureUsersExtendedHeader() {
    const sheetsClient = await getSheetsClient();
    const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!1:1' });
    const headers = (resp.data.values && resp.data.values[0]) || [];
    const want = ['Username', 'Email', 'HashedPassword', 'Role', 'Balance', 'CreatedDate', 'Telefono', 'Cedula', 'Estado'];
    const needs = want.some((h, i) => headers[i] !== h);
    if (needs) {
        const merged = want.map((h, i) => headers[i] || h);
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID, range: 'Users!A1:I1', valueInputOption: 'RAW', resource: { values: [merged] },
        });
    }
}

// Actualiza el Estado (activo/inactivo) de un usuario por email. Baja logica reversible.
async function setUserEstado(email, estado) {
    await ensureUsersExtendedHeader();
    const sheetsClient = await getSheetsClient();
    const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:I' });
    const rows = resp.data.values || [];
    const headers = rows[0] || [];
    const emailCol = headers.findIndex(h => normalize(h) === 'email');
    let estadoCol = headers.findIndex(h => normalize(h) === 'estado');
    if (estadoCol === -1) estadoCol = 8;
    const idx = rows.findIndex((r, i) => i > 0 && normalize(r[emailCol]) === normalize(email));
    if (idx === -1) return { ok: false };
    await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `Users!${toColumnLetter(estadoCol + 1)}${idx + 1}`,
        valueInputOption: 'RAW',
        resource: { values: [[estado]] },
    });
    return { ok: true };
}

// Baja logica: marca el usuario como inactivo (reversible con /api/activar-usuario)
app.post('/api/desactivar-usuario', requireAdmin, async (req, res) => {
    const Email = (req.body || {}).Email || (req.body || {}).email
        || (req.body || {}).userEmail || (req.body || {}).UserEmail;
    if (!Email) {
        return res.status(400).json({ message: 'Falta el Email.' });
    }
    try {
        const result = await setUserEstado(Email, 'inactivo');
        if (!result.ok) return res.status(404).json({ message: 'Usuario no encontrado.' });
        res.json({ message: 'Usuario desactivado correctamente.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al desactivar usuario.', error: error.message });
    }
});

// Reactivar usuario
app.post('/api/activar-usuario', requireAdmin, async (req, res) => {
    const Email = (req.body || {}).Email || (req.body || {}).email
        || (req.body || {}).userEmail || (req.body || {}).UserEmail;
    if (!Email) {
        return res.status(400).json({ message: 'Falta el Email.' });
    }
    try {
        const result = await setUserEstado(Email, 'activo');
        if (!result.ok) return res.status(404).json({ message: 'Usuario no encontrado.' });
        res.json({ message: 'Usuario activado correctamente.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al activar usuario.', error: error.message });
    }
});

// Obtener los datos del propio perfil (incluye telefono/cedula/estado)
app.get('/api/mi-perfil', async (req, res) => {
    try {
        await ensureUsersExtendedHeader();
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:I' });
        const rows = resp.data.values || [];
        const headers = rows[0] || [];
        const col = (name) => headers.findIndex(h => normalize(h) === name);
        const emailCol = col('email');
        const row = rows.find((r, i) => i > 0 && normalize(r[emailCol]) === req.user.email);
        if (!row) return res.status(404).json({ message: 'Usuario no encontrado.' });
        const val = (name) => { const c = col(name); return c !== -1 ? (row[c] || '') : ''; };
        return res.json({
            success: true,
            perfil: {
                username: val('username'),
                email: val('email'),
                role: val('role'),
                telefono: val('telefono'),
                cedula: val('cedula'),
                estado: (val('estado') || 'activo'),
                createdDate: val('createddate'),
                balance: Number(val('balance')) || 0,
                Balance: Number(val('balance')) || 0,
            },
        });
    } catch (error) {
        console.error('[MI-PERFIL] Error:', error.message);
        return res.status(500).json({ message: 'Error al obtener el perfil.' });
    }
});

// Cambiar la propia contrasena (verifica la actual)
app.post('/api/cambiar-contrasena', async (req, res) => {
    try {
        const cuerpoClave = req.body || {};
        const currentPassword = cuerpoClave.currentPassword || cuerpoClave.actual || cuerpoClave.passwordActual;
        const newPassword = cuerpoClave.newPassword || cuerpoClave.nueva || cuerpoClave.passwordNueva;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Se requieren la contrasena actual y la nueva.' });
        }
        if (newPassword.toString().length < 6) {
            return res.status(400).json({ message: 'La nueva contrasena debe tener al menos 6 caracteres.' });
        }
        await ensureUsersExtendedHeader();
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:I' });
        const rows = resp.data.values || [];
        const headers = rows[0] || [];
        const emailCol = headers.findIndex(h => normalize(h) === 'email');
        const passCol = headers.findIndex(h => normalize(h) === 'hashedpassword');
        const idx = rows.findIndex((r, i) => i > 0 && normalize(r[emailCol]) === req.user.email);
        if (idx === -1) return res.status(404).json({ message: 'Usuario no encontrado.' });
        const currentHash = rows[idx][passCol] || '';
        if (!bcrypt.compareSync(currentPassword, currentHash)) {
            return res.status(401).json({ message: 'La contrasena actual es incorrecta.' });
        }
        const newHash = bcrypt.hashSync(newPassword.toString(), 10);
        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Users!${toColumnLetter(passCol + 1)}${idx + 1}`,
            valueInputOption: 'RAW',
            resource: { values: [[newHash]] },
        });
        return res.json({ success: true, message: 'Contrasena actualizada correctamente.' });
    } catch (error) {
        console.error('[CAMBIAR-CONTRASENA] Error:', error.message);
        return res.status(500).json({ message: 'Error al cambiar la contrasena.' });
    }
});

// Actualizar datos del propio perfil (un admin puede actualizar a otro pasando email)
app.post('/api/actualizar-perfil', async (req, res) => {
    try {
        const targetEmail = (req.user.role === 'admin' && req.body.email)
            ? normalize(req.body.email)
            : req.user.email;
        const { username, telefono, cedula } = req.body || {};
        await ensureUsersExtendedHeader();
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Users!A:I' });
        const rows = resp.data.values || [];
        const headers = rows[0] || [];
        const emailCol = headers.findIndex(h => normalize(h) === 'email');
        const idx = rows.findIndex((r, i) => i > 0 && normalize(r[emailCol]) === targetEmail);
        if (idx === -1) return res.status(404).json({ message: 'Usuario no encontrado.' });

        const setCell = async (colName, value) => {
            if (value === undefined) return;
            const c = headers.findIndex(h => normalize(h) === colName);
            if (c === -1) return;
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `Users!${toColumnLetter(c + 1)}${idx + 1}`,
                valueInputOption: 'RAW',
                resource: { values: [[value]] },
            });
        };
        await setCell('username', username !== undefined ? username.toString().trim() : undefined);
        await setCell('telefono', telefono !== undefined ? telefono.toString().trim() : undefined);
        await setCell('cedula', cedula !== undefined ? cedula.toString().trim() : undefined);

        return res.json({ success: true, message: 'Perfil actualizado correctamente.', data: { username, telefono, cedula } });
    } catch (error) {
        console.error('[ACTUALIZAR-PERFIL] Error:', error.message);
        return res.status(500).json({ message: 'Error al actualizar el perfil.' });
    }
});

// --- Endpoint para obtener todos los usuarios y sus roles/grupos (repara cabecera automáticamente si es incorrecta) ---
app.get('/api/obtener-usuarios', requireAdmin, async (req, res) => {
    try {
        const requiredHeaders = ['Username','Email','HashedPassword','Role','Balance','CreatedDate'];
        // 1) Inicializa el cliente (si no existe aún)
        const sheetsClient = await getSheetsClient();

        // 2) Ahora sí lee la hoja (A:I incluye Telefono/Cedula/Estado)
        let response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Users!A:I',
        });
        let rows = response.data.values;
        // Si la cabecera no es la correcta, la repara automáticamente
        if (!rows || !rows.length || requiredHeaders.some((h, i) => (rows[0]||[])[i] !== h)) {
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: 'Users!A1:F1',
                valueInputOption: 'RAW',
                resource: { values: [requiredHeaders] },
            });
            // Vuelve a leer después de reparar
            response = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'Users!A:I',
            });
            rows = response.data.values;
        }
        if (!rows || rows.length < 2) {
            return res.json({ usuarios: [] });
        }
        // Leer UserGroupLinks para enriquecer usuarios con grupos y roles
        let userGroupLinks = [];
        try {
            const linksResp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'UserGroupLinks!A2:E',
            });
            userGroupLinks = linksResp.data.values || [];
        } catch (e) {
            userGroupLinks = [];
        }
        // Mapear usuarios
        const usuarios = rows.slice(1).map(row => {
            const Email = row[1] || '';
            // Buscar grupos de este usuario
            const grupos = userGroupLinks
                .filter(link => (link[0] || '').trim().toLowerCase() === Email.trim().toLowerCase())
                .map(link => ({ nombre: link[1] || '', rol: link[3] || 'member' }));
            const normalizedRole = normalizeGlobalRole(row[3] || 'member');
            const estado = (row[8] || 'activo').toString().trim().toLowerCase();
            return {
                Username: row[0] || '',
                Email: normalize(Email),
                Role: normalizedRole,
                role: normalizedRole,
                Balance: row[4] || '',
                CreatedDate: row[5] || '',
                Telefono: row[6] || '',
                Cedula: row[7] || '',
                Estado: estado,
                estado,
                grupos,
                Miembros: grupos,
                isActive: estado !== 'inactivo'
            };
        });
        console.log('[OBTENER USUARIOS] Usuarios enviados al frontend:', usuarios);
        res.json({ usuarios });
    } catch (error) {
        console.error('[OBTENER USUARIOS] Error:', error.message, error.stack);
        return res.status(200).json({
            usuarios: [],
            warning: 'No se pudieron leer usuarios temporalmente.',
        });
    }
});

const DEFAULT_IMPORT_PASSWORD = '123456';
const normalizeImportCell = (value) => (value === undefined || value === null ? '' : value.toString().trim());
const normalizeImportEmail = (value) => normalizeImportCell(value).toLowerCase();
const normalizeImportLookupKey = (value) => (
    normalizeImportCell(value)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]/g, '')
);

const readExcelRows = (filePath) => {
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return xlsx.utils.sheet_to_json(sheet, { defval: '' });
};

const buildNormalizedImportRow = (row) => {
    const normalized = {};
    Object.entries(row || {}).forEach(([key, value]) => {
        const normalizedKey = normalizeImportLookupKey(key);
        if (!normalizedKey) return;
        const previous = normalized[normalizedKey];
        if (previous === undefined || normalizeImportCell(previous) === '') {
            normalized[normalizedKey] = value;
        }
    });
    return normalized;
};

const pickFirstValue = (row, keys) => {
    const normalizedRow = buildNormalizedImportRow(row);
    for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(row || {}, key) && normalizeImportCell(row[key]) !== '') {
            return row[key];
        }
        const normalizedKey = normalizeImportLookupKey(key);
        if (normalizedKey && normalizeImportCell(normalizedRow[normalizedKey]) !== '') {
            return normalizedRow[normalizedKey];
        }
    }
    return '';
};

const parseImportBalance = (value) => {
    if (value === undefined || value === null || value === '') return 0;
    const cleaned = value
        .toString()
        .replace(/[^\d.,-]/g, '')
        .trim();
    if (!cleaned) return 0;

    let normalized = cleaned;
    if (cleaned.includes(',') && cleaned.includes('.')) {
        normalized = cleaned.replace(/,/g, '');
    } else if (cleaned.includes(',') && !cleaned.includes('.')) {
        normalized = cleaned.replace(/,/g, '.');
    }

    const number = Number(normalized);
    return Number.isNaN(number) ? 0 : number;
};

const buildGroupsLookup = async () => {
    const rows = await groupsService.listAllGroups();
    const byId = new Map();
    const byName = new Map();
    const names = [];

    (rows || []).forEach((row) => {
        const groupId = normalizeImportCell(row?.[0]);
        const groupName = normalizeImportCell(row?.[1]);
        if (groupId) byId.set(normalizeImportLookupKey(groupId), groupId);
        if (groupName) {
            const normalizedName = normalizeImportLookupKey(groupName);
            byName.set(normalizedName, groupId);
            names.push({ normalizedName, groupId, groupName });
        }
    });

    return { byId, byName, names };
};

const levenshteinDistance = (a, b) => {
    const left = a || '';
    const right = b || '';
    const matrix = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));

    for (let i = 0; i <= left.length; i += 1) matrix[i][0] = i;
    for (let j = 0; j <= right.length; j += 1) matrix[0][j] = j;

    for (let i = 1; i <= left.length; i += 1) {
        for (let j = 1; j <= right.length; j += 1) {
            const cost = left[i - 1] === right[j - 1] ? 0 : 1;
            matrix[i][j] = Math.min(
                matrix[i - 1][j] + 1,
                matrix[i][j - 1] + 1,
                matrix[i - 1][j - 1] + cost
            );
        }
    }

    return matrix[left.length][right.length];
};

const resolveImportGroupId = (rawGroup, groupsLookup) => {
    const groupRef = normalizeImportCell(rawGroup);
    if (!groupRef) return '';
    const key = normalizeImportLookupKey(groupRef);

    if (!groupsLookup) return groupRef;
    const byIdMatch = groupsLookup.byId.get(key);
    if (byIdMatch) return byIdMatch;

    const byNameMatch = groupsLookup.byName.get(key);
    if (byNameMatch) return byNameMatch;

    const partialMatch = (groupsLookup.names || []).find((entry) => (
        entry.normalizedName.includes(key) || key.includes(entry.normalizedName)
    ));
    if (partialMatch?.groupId) return partialMatch.groupId;

    let best = null;
    for (const entry of (groupsLookup.names || [])) {
        const longest = Math.max(key.length, entry.normalizedName.length);
        if (!longest) continue;
        const distance = levenshteinDistance(key, entry.normalizedName);
        const similarity = 1 - (distance / longest);
        if (!best || similarity > best.similarity) {
            best = { similarity, groupId: entry.groupId };
        }
    }

    if (best && best.similarity >= 0.82) {
        return best.groupId;
    }

    return '';
};

const isLikelyGroupIdReference = (value) => {
    const raw = normalizeImportCell(value).toLowerCase();
    if (!raw) return false;
    return raw.startsWith('grupo_') || /^[a-f0-9-]{10,}$/.test(raw);
};

const cleanupUploadedFile = async (filePath) => {
    if (!filePath) return;
    try {
        await fs.promises.unlink(filePath);
    } catch (error) {
        // Ignorado de forma segura para no romper el flujo principal.
    }
};

const importUsersFromRows = async (rows, { linkGroups = false } = {}) => {
    const summary = {
        processed: rows.length,
        createdUsers: 0,
        existingUsers: 0,
        createdGroups: 0,
        linkedToGroups: 0,
        existingLinks: 0,
        defaultedPasswords: 0,
        failed: 0,
        errors: [],
    };

    const existingRows = await usersService.listAllUsers();
    const knownEmails = new Set(
        (existingRows || [])
            .map((row) => normalizeImportEmail(row[1]))
            .filter(Boolean)
    );
    const groupsLookup = linkGroups ? await buildGroupsLookup() : null;

    for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index] || {};
        const rowNumber = index + 2; // +2 porque la fila 1 del Excel es cabecera

        const email = normalizeImportEmail(pickFirstValue(row, ['Email', 'email', 'Correo', 'correo', 'CorreoElectronico', 'Mail', 'E-mail']));
        const username = normalizeImportCell(pickFirstValue(row, ['Username', 'username', 'Usuario', 'usuario', 'Nombre', 'NombreCompleto', 'Nombres'])) || email;
        const importedHash = normalizeImportCell(pickFirstValue(row, ['HashedPassword', 'hashedPassword', 'HashPassword', 'PasswordHash', 'ContrasenaHash']));
        let password = normalizeImportCell(pickFirstValue(row, ['Password', 'password', 'Pass', 'pass', 'Contrasena', 'Contraseña', 'Clave']));
        const role = normalizeGlobalRole(pickFirstValue(row, ['Role', 'role', 'Rol', 'rol']));
        const balance = parseImportBalance(pickFirstValue(row, ['Balance', 'balance', 'Saldo', 'saldo']));

        if (!email) {
            summary.failed += 1;
            summary.errors.push(`Fila ${rowNumber}: falta el campo Email.`);
            continue;
        }

        try {
            if (knownEmails.has(email)) {
                summary.existingUsers += 1;
            } else {
                if (!password && !importedHash) {
                    password = DEFAULT_IMPORT_PASSWORD;
                    summary.defaultedPasswords += 1;
                }

                await usersService.createUser({
                    Username: username,
                    Email: email,
                    Password: password,
                    HashedPassword: importedHash,
                    Role: role,
                    Balance: balance,
                });

                knownEmails.add(email);
                summary.createdUsers += 1;
            }
        } catch (error) {
            if (error?.code === 'USER_EXISTS') {
                knownEmails.add(email);
                summary.existingUsers += 1;
            } else {
                summary.failed += 1;
                summary.errors.push(`Fila ${rowNumber}: error al crear usuario ${email} (${error.message}).`);
                continue;
            }
        }

        if (!linkGroups) continue;

        const groupReference = normalizeImportCell(pickFirstValue(row, ['GroupID', 'groupId', 'Group', 'group', 'Grupo', 'grupo', 'GroupName', 'groupName', 'NombreGrupo']));
        if (!groupReference) continue;

        let resolvedGroupId = resolveImportGroupId(groupReference, groupsLookup);
        const groupRefLooksLikeId = isLikelyGroupIdReference(groupReference);
        if (!resolvedGroupId && !groupRefLooksLikeId) {
            try {
                const createdGroupRow = await groupsService.createGroup({
                    GroupName: groupReference,
                    Description: 'Grupo creado automáticamente por importación de usuarios',
                    CreatedBy: email || 'import@system.local',
                    CreatedDate: new Date().toISOString(),
                    Status: 'Activo',
                });
                const createdGroupId = normalizeImportCell(createdGroupRow?.[0]);
                if (createdGroupId) {
                    groupsLookup.byId.set(normalizeImportLookupKey(createdGroupId), createdGroupId);
                    groupsLookup.byName.set(normalizeImportLookupKey(groupReference), createdGroupId);
                    groupsLookup.names.push({
                        normalizedName: normalizeImportLookupKey(groupReference),
                        groupId: createdGroupId,
                        groupName: groupReference,
                    });
                    resolvedGroupId = createdGroupId;
                    summary.createdGroups += 1;
                }
            } catch (error) {
                summary.failed += 1;
                summary.errors.push(`Fila ${rowNumber}: no se pudo crear el grupo "${groupReference}" (${error.message}).`);
                continue;
            }
        }

        if (!resolvedGroupId && !groupRefLooksLikeId) {
            summary.failed += 1;
            summary.errors.push(`Fila ${rowNumber}: no se encontró el grupo "${groupReference}" en la hoja Groups.`);
            continue;
        }

        const groupId = resolvedGroupId || groupReference;
        const groupRole = normalizeGroupRole(pickFirstValue(row, ['GroupRole', 'groupRole', 'RolGrupo', 'rolGrupo', 'Rol Grupo', 'Rol']));
        const joinDate = normalizeImportCell(pickFirstValue(row, ['JoinDate', 'joinDate', 'FechaIngreso', 'fechaIngreso'])) || new Date().toISOString();

        let linkResult;
        try {
            linkResult = await createUserGroupLink({
                UserEmail: email,
                GroupID: groupId,
                GroupRole: groupRole || 'member',
                JoinDate: joinDate,
            });
        } catch (error) {
            summary.failed += 1;
            summary.errors.push(`Fila ${rowNumber}: error al vincular ${email} al grupo ${groupId} (${error.message}).`);
            continue;
        }

        if (linkResult.ok) {
            summary.linkedToGroups += 1;
            continue;
        }

        if (linkResult.status === 409) {
            summary.existingLinks += 1;
            continue;
        }

        summary.failed += 1;
        summary.errors.push(`Fila ${rowNumber}: no se pudo vincular ${email} al grupo ${groupId}.`);
    }

    return summary;
};

const buildImportMessage = (summary, modeLabel) => (
    `Importación ${modeLabel} finalizada. `
    + `Procesadas: ${summary.processed}, creadas: ${summary.createdUsers}, `
    + `existentes: ${summary.existingUsers}, grupos creados: ${summary.createdGroups || 0}, vinculadas: ${summary.linkedToGroups}, `
    + `vínculos existentes: ${summary.existingLinks}, `
    + `claves por defecto: ${summary.defaultedPasswords || 0}, errores: ${summary.failed}.`
);

app.post('/api/importar-usuarios-excel', requireAdmin, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No se subio ningun archivo.' });
        }

        const rows = readExcelRows(req.file.path);
        if (!rows.length) {
            return res.status(400).json({ message: 'El archivo no contiene filas para importar.' });
        }

        const summary = await importUsersFromRows(rows, { linkGroups: true });
        const message = buildImportMessage(summary, 'de usuarios');
        const hasChanges = (summary.createdUsers + summary.linkedToGroups + (summary.createdGroups || 0)) > 0;
        const hasExistingMatches = (summary.existingUsers + summary.existingLinks) > 0;
        const hardFailure = summary.failed > 0 && !hasChanges && !hasExistingMatches;
        if (hardFailure) {
            return res.status(400).json({ success: false, message, summary });
        }
        return res.json({ success: summary.failed === 0, message, summary });
    } catch (error) {
        return res.status(500).json({ message: 'Error al importar usuarios desde Excel.', error: error.message });
    } finally {
        await cleanupUploadedFile(req.file?.path);
    }
});

// Endpoint para importar usuarios y grupos desde Excel
app.post('/api/importar-usuarios-grupos', requireAdmin, upload.single('file'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No se subio ningun archivo.' });
        }

        const rows = readExcelRows(req.file.path);
        if (!rows.length) {
            return res.status(400).json({ message: 'El archivo no contiene filas para importar.' });
        }

        const summary = await importUsersFromRows(rows, { linkGroups: true });
        const message = buildImportMessage(summary, 'de usuarios y grupos');
        const hasChanges = (summary.createdUsers + summary.linkedToGroups + (summary.createdGroups || 0)) > 0;
        const hasExistingMatches = (summary.existingUsers + summary.existingLinks) > 0;
        const hardFailure = summary.failed > 0 && !hasChanges && !hasExistingMatches;
        if (hardFailure) {
            return res.status(400).json({ success: false, message, summary });
        }
        return res.json({ success: summary.failed === 0, message, summary });
    } catch (error) {
        return res.status(500).json({ message: 'Error al importar usuarios y grupos.', error: error.message });
    } finally {
        await cleanupUploadedFile(req.file?.path);
    }
});

app.post('/api/cambiar-rol-usuario-grupo', bloquear((r) => `grupo:${normalizeGroupKey(r.body && (r.body.GroupID || r.body.groupId))}`), async (req, res) => {
    // Permite tanto {UserEmail, GroupID, NewGroupRole} como {Email, GroupID, GroupRole} para compatibilidad
    const UserEmail = normalize(req.body.UserEmail || req.body.Email || req.body.userEmail || req.body.email);
    const GroupID = (req.body.GroupID || req.body.groupId || '').toString().trim();
    const rolCrudo = req.body.NewGroupRole || req.body.GroupRole || req.body.nuevoRol || req.body.role || req.body.rol;
    const NewGroupRole = normalizeGroupRole(rolCrudo);
    if (!UserEmail || !GroupID || !rolCrudo) {
        return res.status(400).json({ message: 'Faltan datos: UserEmail, GroupID y NewGroupRole son requeridos.' });
    }
    if (!esRolDeGrupoConocido(rolCrudo) || !VALID_GROUP_ROLES.has(NewGroupRole)) {
        return res.status(400).json({ message: `Rol de grupo invalido ("${rolCrudo}"). Usa member, presidente, tesorero o secretario.` });
    }
    if (!(await assertGroupManager(req, res, GroupID))) return;
    try {
        const sheetsClient = await getSheetsClient();
        // 1. Verifica y corrige cabeceras de UserGroupLinks
        let headers = [];
        try {
            const headerResp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'UserGroupLinks!1:1',
            });
            headers = headerResp.data.values[0];
        } catch (e) {
            headers = [];
        }
        const requiredHeaders = ['UserEmail', 'GroupID', 'JoinDate', 'GroupRole'];
        if (headers.length < requiredHeaders.length || requiredHeaders.some((h, i) => headers[i] !== h)) {
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: 'UserGroupLinks!1:1',
                valueInputOption: 'RAW',
                resource: { values: [requiredHeaders] },
            });
            headers = requiredHeaders;
        }
        // 2. Leer todas las filas de UserGroupLinks
        const response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'UserGroupLinks!A2:E',
        });
        const rows = response.data.values || [];
        // 3. Buscar la fila a modificar
        const userEmailCol = headers.indexOf('UserEmail');
        const groupIdCol = headers.indexOf('GroupID');
        const groupRoleCol = headers.indexOf('GroupRole');
        const joinDateCol = headers.indexOf('JoinDate');

        const isLeadershipRole = GROUP_ADMIN_ROLES.has(NewGroupRole) || NewGroupRole === 'secretario';
        const reqEmail = normalize(req.user && req.user.email);
        const isAdmin = req.user && req.user.role === 'admin';
        const groupRows = rows.filter(r => (r[groupIdCol] || '').toString().trim() === GroupID);
        const presRow = groupRows.find(r => normalize(r[groupRoleCol]) === 'presidente');
        const currentPresidentEmail = presRow ? normalize(presRow[userEmailCol]) : null;
        const targetRow = groupRows.find(r => normalize(r[userEmailCol]) === UserEmail);
        const targetCurrentRole = targetRow ? normalize(targetRow[groupRoleCol]) : null;

        // Invariante: el grupo nunca se queda sin presidente. Para "quitar" la presidencia,
        // se transfiere asignando presidente a otro miembro (esto degrada al actual automáticamente).
        if (targetCurrentRole === 'presidente' && NewGroupRole !== 'presidente') {
            return res.status(409).json({ message: 'No puedes quitar la presidencia directamente. Asigna a otro miembro como presidente y la presidencia se transferirá automáticamente.' });
        }

        // Transferencia de presidencia: solo el presidente actual (o admin) puede ceder el cargo.
        if (NewGroupRole === 'presidente' && currentPresidentEmail && currentPresidentEmail !== UserEmail) {
            if (!isAdmin && reqEmail !== currentPresidentEmail) {
                return res.status(403).json({ message: 'Solo el presidente actual puede transferir la presidencia.' });
            }
            const presIdx = rows.findIndex(r => normalize(r[userEmailCol]) === currentPresidentEmail && (r[groupIdCol] || '').toString().trim() === GroupID);
            if (presIdx !== -1) {
                rows[presIdx][groupRoleCol] = 'member';
                await sheetsClient.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `UserGroupLinks!A${presIdx + 2}:E${presIdx + 2}`,
                    valueInputOption: 'USER_ENTERED',
                    resource: { values: [rows[presIdx]] },
                });
            }
        }

        // Rol único tesorero/secretario: debe estar libre (presidente ya se maneja con transferencia arriba).
        if (isLeadershipRole && NewGroupRole !== 'presidente') {
            const conflict = rows.some((row) =>
                (row[groupIdCol] || '').toString().trim() === GroupID &&
                normalize(row[groupRoleCol]) === NewGroupRole &&
                normalize(row[userEmailCol]) !== UserEmail
            );
            if (conflict) {
                return res.status(409).json({ message: `Ya existe un ${NewGroupRole} en este grupo. Libéralo antes de asignarlo.` });
            }
        }

        const rowIndex = rows.findIndex(row =>
            row[userEmailCol] && normalize(row[userEmailCol]) === UserEmail &&
            row[groupIdCol] && (row[groupIdCol] || '').toString().trim() === GroupID
        );
        if (rowIndex === -1) {
            // Si no existe, crea la relación
            const today = new Date().toISOString().split('T')[0];
            const newRow = new Array(Math.max(headers.length, 4)).fill('');
            newRow[userEmailCol] = UserEmail;
            newRow[groupIdCol] = GroupID;
            newRow[joinDateCol] = today;
            newRow[groupRoleCol] = NewGroupRole;
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: 'UserGroupLinks!A:E',
                valueInputOption: 'USER_ENTERED',
                resource: { values: [newRow] },
            });
            return res.json({ message: 'Vínculo usuario-grupo creado y rol asignado correctamente.' });
        } else {
            // Si existe, actualiza el rol
            rows[rowIndex][groupRoleCol] = NewGroupRole;
            await sheetsClient.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `UserGroupLinks!A${rowIndex+2}:E${rowIndex+2}`,
                valueInputOption: 'USER_ENTERED',
                resource: { values: [rows[rowIndex]] },
            });
            return res.json({ message: 'Rol de usuario en grupo actualizado correctamente.' });
        }
    } catch (error) {
        console.error('[CAMBIAR ROL USUARIO-GRUPO] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error al actualizar rol de usuario en grupo.', error: error.message });
    }
});

// (Opcional) Endpoint para desvincular usuario de grupo
app.post('/api/desvincular-usuario-grupo', bloquear((r) => `grupo:${normalizeGroupKey(r.body && (r.body.GroupID || r.body.groupId))}`), async (req, res) => {
    const { UserEmail, GroupID } = req.body;
    if (!UserEmail || !GroupID) {
        return res.status(400).json({ message: 'Faltan datos: UserEmail y GroupID son requeridos.' });
    }
    if (!(await assertGroupManager(req, res, (GroupID || '').toString().trim()))) return;
    try {
        const sheetsClient = await getSheetsClient();
        // Leer cabeceras
        let headers = [];
        try {
            const headerResp = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'UserGroupLinks!1:1',
            });
            headers = headerResp.data.values[0];
        } catch (e) { headers = []; }
        const userEmailCol = headers.indexOf('UserEmail');
        const groupIdCol = headers.indexOf('GroupID');
        // Leer filas
        const response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'UserGroupLinks!A2:E',
        });
        const rows = response.data.values || [];
        const rowIndex = rows.findIndex(row =>
            row[userEmailCol] && row[userEmailCol].trim().toLowerCase() === UserEmail.trim().toLowerCase() &&
            row[groupIdCol] && row[groupIdCol].trim() === GroupID.trim()
        );
        if (rowIndex === -1) {
            return res.status(404).json({ message: 'No se encontró la relación usuario-grupo.' });
        }
        // Invariante: no eliminar al único presidente (dejaría al grupo sin liderazgo).
        const groupRoleColD = headers.indexOf('GroupRole');
        const targetRole = (rows[rowIndex][groupRoleColD] || '').toString().trim().toLowerCase();
        if (targetRole === 'presidente') {
            const otherPresident = rows.some((row, i) => i !== rowIndex &&
                (row[groupIdCol] || '').toString().trim() === GroupID.trim() &&
                (row[groupRoleColD] || '').toString().trim().toLowerCase() === 'presidente');
            if (!otherPresident) {
                return res.status(409).json({ message: 'No puedes eliminar al único presidente. Transfiere primero la presidencia a otro miembro.' });
            }
        }
        // Obtener sheetId real
        const spreadsheet = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const ugSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'UserGroupLinks');
        if (!ugSheet) return res.status(500).json({ message: 'No se encontró la hoja UserGroupLinks.' });
        const sheetId = ugSheet.properties.sheetId;
        // Eliminar la fila (rowIndex + 2 porque la fila 1 es cabecera)
        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: {
                requests: [{
                    deleteDimension: {
                        range: {
                            sheetId: sheetId,
                            dimension: 'ROWS',
                            startIndex: rowIndex + 1,
                            endIndex: rowIndex + 2
                        }
                    }
                }]
            }
        });
        res.json({ message: 'Usuario desvinculado del grupo correctamente.' });
    } catch (error) {
        console.error('[DESVINCULAR USUARIO-GRUPO] Error:', error.message, error.stack);
        res.status(500).json({ message: 'Error al desvincular usuario del grupo.', error: error.message });
    }
});

// Salir voluntariamente de un grupo (cualquier miembro, solo a sí mismo). El único presidente no puede salir sin transferir.
app.post('/api/salir-grupo', bloquear((r) => `grupo:${normalizeGroupKey(r.body && (r.body.groupId || r.body.GroupID))}`), async (req, res) => {
    const GroupID = (req.body?.groupId || req.body?.GroupID || '').toString().trim();
    if (!GroupID) return res.status(400).json({ message: 'Falta groupId.' });
    const me = req.user.email;
    try {
        const sheetsClient = await getSheetsClient();
        const response = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'UserGroupLinks!A2:F' });
        const rows = response.data.values || [];
        const rowIndex = rows.findIndex(r => normalizeEmailKey(r[0]) === me && (r[1] || '').toString().trim() === GroupID);
        if (rowIndex === -1) return res.status(404).json({ message: 'No perteneces a ese grupo.' });
        const myRole = (rows[rowIndex][3] || '').toString().trim().toLowerCase();
        if (myRole === 'presidente') {
            const otherPresident = rows.some((r, i) => i !== rowIndex && (r[1] || '').toString().trim() === GroupID && (r[3] || '').toString().trim().toLowerCase() === 'presidente');
            if (!otherPresident) {
                return res.status(409).json({ message: 'Eres el único presidente. Transfiere la presidencia antes de salir del grupo.' });
            }
        }
        const spreadsheet = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const ugSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'UserGroupLinks');
        const sheetId = ugSheet.properties.sheetId;
        await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: { requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: rowIndex + 1, endIndex: rowIndex + 2 } } }] },
        });
        res.json({ success: true, message: 'Saliste del grupo correctamente.' });
    } catch (error) {
        console.error('[SALIR-GRUPO] Error:', error.message);
        res.status(500).json({ message: 'Error al salir del grupo.', error: error.message });
    }
});

// Resumen admin: TODAS las transacciones en una sola lectura (totales correctos del panel)
app.get('/api/admin/transacciones', requireAdmin, async (req, res) => {
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Transactions!A2:H',
        });
        const rows = resp.data.values || [];
        const transacciones = rows
            .filter((r) => (r[0] || r[1]))
            .map((r) => ({
                transactionId: r[0] || '',
                userEmail: (r[1] || '').toString().trim().toLowerCase(),
                UserEmail: r[1] || '',
                type: r[2] || '',
                Type: r[2] || '',
                amount: Number(r[3] || 0),
                Amount: Number(r[3] || 0),
                description: r[4] || '',
                date: r[5] || '',
                Date: r[5] || '',
                category: r[6] || '',
                icon: r[7] || '',
            }));
        return res.json({ transacciones });
    } catch (error) {
        console.error('[ADMIN TRANSACCIONES] Error:', error.message);
        if (isQuotaExceededError(error)) {
            return res.status(200).json({ transacciones: [], warning: 'Limite temporal de lecturas alcanzado.' });
        }
        return res.status(500).json({ message: 'Error al obtener transacciones.', transacciones: [] });
    }
});

// Resumen agregado para el panel admin: totales correctos leyendo las hojas reales una sola vez.
// Esquemas reales: Savings[A=email,B=group,C=Amount,D=date,E=type], Acciones[A=email,B=group,C=date,D=Shares,E=ShareValue,F=InterestRate],
// SolicitudesPrestamos[A=id,B=email,C=group,D=role,E=Monto,F=Estado], Users[...,I=Estado], Groups[A=GroupID]
app.get('/api/admin/resumen', requireAdmin, async (req, res) => {
    try {
        const sheetsClient = await getSheetsClient();
        const ranges = ['Savings!A2:L', 'Acciones!A2:M', 'SolicitudesPrestamos!A2:I', 'Users!A2:I', 'Groups!A2:A'];
        const resp = await sheetsClient.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges });
        const vr = resp.data.valueRanges || [];
        const sav = vr[0]?.values || [];
        const acc = vr[1]?.values || [];
        const sol = vr[2]?.values || [];
        const usr = vr[3]?.values || [];
        const grp = vr[4]?.values || [];
        const r2 = (x) => Math.round(x * 100) / 100;

        // Solo los aportes confirmados por la tesoreria forman el patrimonio agregado.
        const savOk = sav.filter((r) => aporteConfirmado(r[SAVINGS_ESTADO_IDX]));
        const accOk = acc.filter((r) => aporteConfirmado(r[ACCIONES_ESTADO_IDX]));
        const totalAhorros = savOk.reduce((s, r) => s + parseMoney(r[2]), 0);
        const totalAcciones = accOk.reduce((s, r) => s + parseMoney(r[3]) * parseMoney(r[4]), 0);
        const totalAhorrosPendientes = sav
            .filter((r) => estadoAporteCell(r[SAVINGS_ESTADO_IDX]) === 'pendiente')
            .reduce((s, r) => s + parseMoney(r[2]), 0);
        const totalAccionesPendientes = acc
            .filter((r) => estadoAporteCell(r[ACCIONES_ESTADO_IDX]) === 'pendiente')
            .reduce((s, r) => s + parseMoney(r[3]) * parseMoney(r[4]), 0);

        let prestamosAprobados = 0, prestamosPendientes = 0, countAprob = 0, countPend = 0;
        sol.forEach((r) => {
            const estado = (r[5] || '').toString().trim().toLowerCase();
            const monto = parseMoney(r[4]);
            if (estado === 'aprobado') { prestamosAprobados += monto; countAprob++; }
            else if (estado === 'pendiente') { prestamosPendientes += monto; countPend++; }
        });

        const totalUsuarios = usr.filter((r) => r[1]).length;
        const usuariosActivos = usr.filter((r) => r[1] && (r[8] || 'activo').toString().trim().toLowerCase() !== 'inactivo').length;
        const adminUsuarios = usr.filter((r) => normalizeGlobalRole(r[3]) === 'admin').length;
        const totalGrupos = grp.filter((r) => r[0]).length;

        return res.json({
            resumen: {
                totalAhorros: r2(totalAhorros),
                totalAcciones: r2(totalAcciones),
                prestamosAprobados: r2(prestamosAprobados),
                prestamosPendientes: r2(prestamosPendientes),
                countPrestamosAprobados: countAprob,
                countPrestamosPendientes: countPend,
                totalUsuarios,
                usuariosActivos,
                adminUsuarios,
                totalGrupos,
                patrimonioTotal: r2(totalAhorros + totalAcciones),
                totalAhorrosPendientes: r2(totalAhorrosPendientes),
                totalAccionesPendientes: r2(totalAccionesPendientes),
                pendienteDeConfirmar: r2(totalAhorrosPendientes + totalAccionesPendientes),
            },
        });
    } catch (error) {
        console.error('[ADMIN RESUMEN] Error:', error.message);
        if (isQuotaExceededError(error)) {
            return res.status(200).json({ resumen: null, warning: 'Limite temporal de lecturas alcanzado.' });
        }
        return res.status(500).json({ message: 'Error al obtener el resumen.', resumen: null });
    }
});

// --- INICIO DEL SERVIDOR ---
app.listen(PORT, '0.0.0.0', () => {
    console.log(`[BACKEND] Servidor escuchando en http://localhost:${PORT} (y en todas las interfaces de red)`);
});

// --- Endpoint para obtener todos los grupos desde Google Sheets (siempre devuelve array válido) ---
// Refactor: Usar groupsService para obtener grupos como objetos
// const groupsService = require('./services/groupsService');
app.get('/api/obtener-grupos', async (req, res) => {
  try {
    // Leer encabezados dinámicamente usando función pública
    const headers = await groupsService.getGroupsHeaders();
    // Leer filas de datos
    const gruposRaw = await groupsService.listAllGroups();
    let grupos = gruposRaw.map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] || '';
      });
      return obj;
    });
    // Un no-admin solo ve los grupos a los que pertenece (aislamiento)
    if (req.user && req.user.role !== 'admin') {
      const misGrupos = await getUserGroupIds(req.user.email);
      grupos = grupos.filter((g) => misGrupos.has((g.GroupID || g.groupId || g.id || '').toString().trim()));
    }
    res.json({ grupos });
  } catch (error) {
    console.error('Error al leer grupos de Google Sheets:', error.message);
    return res.status(200).json({
      grupos: [],
      warning: 'No se pudieron leer grupos temporalmente.',
    });
  }
});

// --- Endpoint de prueba de red y CORS ---
app.get('/api/ping', (req, res) => {
    console.log('[PING] Petición recibida desde:', req.ip, 'Origin:', req.headers.origin, 'User-Agent:', req.headers['user-agent']);
    res.json({ 
        message: 'pong',
        version: BACKEND_VERSION,
        controlInterno: !!gobApi,
        ip: req.ip,
        origin: req.headers.origin || null,
        userAgent: req.headers['user-agent'] || null,
        time: new Date().toISOString()
    });
});

// Log extra para CORS
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        console.log('[CORS][OPTIONS] Origin:', req.headers.origin, 'URL:', req.url);
    }
    next();
});

// --- Endpoint para obtener actividad reciente (usuarios, grupos, préstamos, depósitos) ---
app.get('/api/actividad-reciente', requireAdmin, async (req, res) => {
  try {
    // 1. Leer usuarios (solo los últimos 5)
    let users = [];
    try {
      const usersResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Users!A2:F', // Incluye columna F (CreatedDate)
      });
      users = (usersResp.data.values || []).slice(-5).map(row => ({
        type: 'user_registered',
        user: row[0] || row[1] || 'Usuario',
        timestamp: row[5] || null // CreatedDate (columna F)
      }));
    } catch (e) { users = []; }

    // 2. Leer grupos (últimos 5)
    let groups = [];
    try {
      const groupsResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Groups!A2:N',
      });
      groups = (groupsResp.data.values || []).slice(-5).map(row => ({
        type: 'group_created',
        group: row[1] || 'Grupo',
        timestamp: row[5] || null // CreatedDate
      }));
    } catch (e) { groups = []; }

    // 3. Leer préstamos aprobados (últimos 5)
    let loans = [];
    try {
      const loansResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Loans!A2:I',
      });
      loans = (loansResp.data.values || [])
        .filter(row => row[5] === 'active' || row[5] === 'approved')
        .slice(-5)
        .map(row => ({
          type: 'loan_approved',
          amount: Number(row[3] || 0),
          timestamp: row[7] || row[6] || null // ApprovedDate o RequestDate
        }));
    } catch (e) { loans = []; }

    // 4. Leer depósitos de ahorro (últimos 5, de Transactions tipo 'deposit')
    let deposits = [];
    try {
      const txResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Transactions!A2:H',
      });
      deposits = (txResp.data.values || [])
        .filter(row => row[2] && row[2].toLowerCase() === 'deposit')
        .slice(-5)
        .map(row => ({
          type: 'savings_deposit',
          amount: Number(row[3] || 0),
          timestamp: row[5] || null // Date
        }));
    } catch (e) { deposits = []; }

    // Unir y ordenar por timestamp descendente (más reciente primero)
    let all = [...users, ...groups, ...loans, ...deposits];
    all = all.filter(a => a.timestamp).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    // Si no hay timestamp, poner al final
    all = all.concat([...users, ...groups, ...loans, ...deposits].filter(a => !a.timestamp));
    // Limitar a 20 actividades
    all = all.slice(0, 20);
    res.json({ actividad: all });
  } catch (error) {
    console.error('[ACTIVIDAD RECIENTE] Error:', error.message, error.stack);
    res.status(500).json({ message: 'Error al obtener actividad reciente.', error: error.message });
  }
});

// Actualizar grupo en Google Sheets
// Refactor: Usar groupsService.updateGroup para actualizar grupo y guardar TipoGrupo y PorcentajeInteresMensual
// const groupsService = require('./services/groupsService');
app.post('/api/actualizar-grupo-en-sheet', async (req, res) => {
  const group = req.body;
  if (!group || (!group.GroupID && !group.id)) {
    return res.status(400).json({ message: 'Falta el identificador del grupo (GroupID o id).' });
  }
  // Admin global o gestor (presidente/tesorero) del grupo pueden configurar
  if (!(await assertGroupManager(req, res, (group.GroupID || group.id || '').toString().trim()))) return;
  try {
    // Normalizar el identificador
    if (!group.GroupID && group.id) group.GroupID = group.id;
    const updated = await groupsService.updateGroup(group);
    res.json({ message: 'Grupo actualizado correctamente.', data: updated });
  } catch (error) {
    console.error('[ACTUALIZAR GRUPO] Error:', error.message, error.stack);
    res.status(500).json({ message: 'Error al actualizar grupo.', error: error.message });
  }
});

// Endpoint para obtener transacciones de un usuario específico
app.get('/api/obtener-transacciones', async (req, res) => {
  // Identidad desde el token: un usuario solo ve sus transacciones; un admin puede consultar cualquiera
  const userEmail = req.user.role === 'admin'
    ? (req.query.userEmail || req.user.email)
    : req.user.email;

  if (!userEmail) {
    return res.status(400).json({ message: 'Se requiere el parámetro userEmail' });
  }

  try {
    const sheetsClient = await getSheetsClient();
    // Obtener todas las transacciones de la hoja Transactions
    const transResp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Transactions!A2:H', // Empezar desde A2 para omitir headers
    });
    
    const rows = transResp.data.values || [];
    
    // Filtrar transacciones por usuario y formatear
    const userTransactions = rows
      .filter(row => row[1] && row[1].toLowerCase() === userEmail.toLowerCase()) // Filtrar por UserEmail
      .map(row => ({
        transactionId: row[0] || '',
        userEmail: row[1] || '',
        type: row[2] || '',
        amount: Number(row[3] || 0),
        description: row[4] || '',
        date: row[5] || '',
        category: row[6] || '',
        icon: row[7] || '',
        createdAt: row[5] || new Date().toISOString() // Usar la fecha de la transacción
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)) // Ordenar por fecha descendente
      .slice(0, 10); // Limitar a las últimas 10 transacciones

    res.json({ 
      transacciones: userTransactions,
      total: userTransactions.length 
    });
  } catch (error) {
    console.error('[OBTENER TRANSACCIONES] Error:', error.message, error.stack);
    return res.status(200).json({
      transacciones: [],
      total: 0,
      warning: 'No se pudieron leer transacciones temporalmente.',
    });
  }
});

// Configurar multer para subida de imágenes de pagos
const paymentUpload = multer({
  dest: 'uploads/payments/',
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB máximo
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se permiten archivos de imagen'), false);
    }
  }
});

// Endpoint para subir pagos con evidencia fotográfica
app.post('/api/upload-payment', paymentUpload.single('paymentImage'), bloquear((r) => `prestamo:${r.body && r.body.loanId}`), async (req, res) => {
  try {
    const { loanId, amount, paymentDate, description, status } = req.body;
    const userEmail = selfEmail(req, req.body.userEmail); // el pago se sube a nombre del usuario autenticado

    if (!userEmail || !loanId || !amount || !paymentDate || !req.file) {
      return res.status(400).json({
        success: false,
        message: 'Faltan campos requeridos: loanId, amount, paymentDate, paymentImage'
      });
    }

    // Validar que el monto sea válido
    const montoPago = parseMoney(amount);
    if (!Number.isFinite(montoPago) || montoPago <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El monto debe ser un número válido mayor a 0'
      });
    }

    const sheets = await getSheetsClient();

    // El prestamo debe pertenecer a un grupo del usuario (salvo admin) — evita pagar prestamos ajenos (IDOR)
    if (req.user.role !== 'admin') {
      const loanGroupMap = await getLoanGroupMap();
      const loanGroup = loanGroupMap.get((loanId || '').toString().trim()) || '';
      const userGroups = await getUserGroupIds(userEmail);
      if (!loanGroup || !userGroups.has(loanGroup)) {
        return res.status(403).json({ success: false, message: 'No puedes registrar pagos de este prestamo.' });
      }
    }

    // Tope de sobrepago: no permitir pagar mas que el saldo pendiente del prestamo
    try {
      const loansResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Loans!A:J' });
      const lrow = (loansResp.data.values || []).find(r => (r[0] || '').toString().trim() === (loanId || '').toString().trim());
      if (lrow) {
        const total = parseMoney(lrow[9]) || parseMoney(lrow[3]);
        const pagos = await getCommittedPaymentsTotal(loanId);
        const saldo = Math.round((total - pagos.comprometido) * 100) / 100;
        if (total > 0 && saldo <= 0.009) {
          return res.status(400).json({
            success: false,
            message: pagos.pendiente > 0
              ? 'Este prestamo ya tiene comprobantes por el total de la deuda esperando revision.'
              : 'Este prestamo ya esta saldado.',
            saldoPendiente: 0,
            pagosEnRevision: pagos.pendiente,
          });
        }
        if (total > 0 && montoPago > saldo + 0.01) {
          const detalle = pagos.pendiente > 0
            ? ` (ya tienes $${pagos.pendiente.toFixed(2)} en comprobantes esperando revision)`
            : '';
          return res.status(400).json({
            success: false,
            message: `El pago ($${montoPago}) supera el saldo pendiente ($${saldo.toFixed(2)})${detalle}.`,
            saldoPendiente: saldo,
            pagosEnRevision: pagos.pendiente,
          });
        }
      }
    } catch (e) { /* si no se puede leer, se permite (no bloquear por error de lectura) */ }

    // Generar ID único para el pago
    const paymentId = 'PAY_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    // Información del archivo subido
    const imageInfo = {
      originalName: req.file.originalname,
      filename: req.file.filename,
      path: req.file.path,
      size: req.file.size,
      mimetype: req.file.mimetype
    };

    // Crear registro en la hoja LoanPayments
    const paymentData = [
      paymentId,                    // PaymentID
      userEmail,                    // UserEmail
      loanId,                       // LoanID
      Number(amount),               // Amount
      paymentDate,                  // PaymentDate
      description || '',            // Description
      status || 'pending_approval', // Status
      imageInfo.filename,           // ImageFilename
      imageInfo.originalName,       // OriginalImageName
      imageInfo.path,              // ImagePath
      imageInfo.size,              // ImageSize
      new Date().toISOString(),    // CreatedAt
      '',                          // ApprovedBy
      '',                          // ApprovalDate
      ''                           // ApprovalNotes
    ];

    // Verificar si la hoja LoanPayments existe, si no, crearla
    try {
      await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'LoanPayments!A1:O1',
      });
    } catch (error) {
      // La hoja no existe, crearla con headers
      const headers = [
        'PaymentID', 'UserEmail', 'LoanID', 'Amount', 'PaymentDate', 
        'Description', 'Status', 'ImageFilename', 'OriginalImageName', 
        'ImagePath', 'ImageSize', 'CreatedAt', 'ApprovedBy', 
        'ApprovalDate', 'ApprovalNotes'
      ];
      
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: 'LoanPayments!A1:O1',
        valueInputOption: 'RAW',
        requestBody: {
          values: [headers]
        }
      });
    }

    // Agregar el pago a la hoja
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'LoanPayments!A:O',
      valueInputOption: 'RAW',
      requestBody: {
        values: [paymentData]
      }
    });

    console.log(`[UPLOAD PAYMENT] Pago registrado: ${paymentId} por ${userEmail} - $${amount}`);
    res.json({ 
      success: true, 
      message: 'Pago registrado correctamente y está pendiente de aprobación.',
      paymentId: paymentId,
      imageUploaded: true
    });

  } catch (error) {
    console.error('[UPLOAD PAYMENT] Error:', error.message, error.stack);
    
    // Si hay error, eliminar el archivo subido para no desperdiciar espacio
    if (req.file && req.file.path) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (unlinkError) {
        console.error('Error eliminando archivo:', unlinkError.message);
      }
    }
    
    res.status(500).json({ 
      success: false, 
      message: 'Error al registrar el pago: ' + error.message 
    });
  }
});

// Endpoint para obtener pagos pendientes de aprobación (para administradores)
app.get('/api/pending-payments', async (req, res) => {
  try {
    const { groupId } = req.query;
    const adminEmail = req.user.email; // identidad desde el token, no del cliente

    const sheets = await getSheetsClient();
    const managedGroupIds = await getUserManagedGroupIds(adminEmail);

    if (groupId && managedGroupIds !== null && !managedGroupIds.has((groupId || '').toString().trim())) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para revisar pagos de este grupo.'
      });
    }
    
    // Obtener todos los pagos pendientes
    const paymentsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'LoanPayments!A2:O', // Omitir headers
    });
    
    const rows = paymentsResp.data.values || [];
    const loanGroupMap = await getLoanGroupMap();
    
    // Filtrar pagos pendientes de aprobación
    let pendingPayments = rows
      .filter(row => row[6] === 'pending_approval') // Status column
      .map(row => ({
        paymentId: row[0] || '',
        userEmail: row[1] || '',
        loanId: row[2] || '',
        groupId: loanGroupMap.get((row[2] || '').toString().trim()) || '',
        amount: Number(row[3] || 0),
        paymentDate: row[4] || '',
        description: row[5] || '',
        status: row[6] || '',
        imageFilename: row[7] || '',
        originalImageName: row[8] || '',
        imagePath: row[9] || '',
        imageSize: row[10] || '',
        createdAt: row[11] || '',
        approvedBy: row[12] || '',
        approvalDate: row[13] || '',
        approvalNotes: row[14] || ''
      }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // Más recientes primero

    if (groupId) {
      const normalizedGroupId = (groupId || '').toString().trim();
      pendingPayments = pendingPayments.filter((payment) =>
        (payment.groupId || '').toString().trim() === normalizedGroupId
      );
    }

    if (managedGroupIds !== null) {
      pendingPayments = pendingPayments.filter((payment) =>
        managedGroupIds.has((payment.groupId || '').toString().trim())
      );
    }

    res.json({ 
      success: true, 
      payments: pendingPayments,
      total: pendingPayments.length 
    });

  } catch (error) {
    console.error('[PENDING PAYMENTS] Error:', error.message, error.stack);
    if (isQuotaExceededError(error)) {
      return res.status(200).json({
        success: true,
        payments: [],
        total: 0,
        warning: 'Límite temporal de lecturas alcanzado. Intenta nuevamente en unos segundos.'
      });
    }
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener pagos pendientes: ' + error.message 
    });
  }
});

// Endpoint para servir imágenes de pagos
// Endpoint para listar pagos de préstamos del usuario con aislamiento por grupo
app.get('/api/user-loan-payments', async (req, res) => {
  try {
    const normalizedUserEmail = normalizeEmailKey(selfEmail(req, req.query.userEmail));
    const normalizedGroupId = normalizeGroupKey(req.query.groupId);

    if (!normalizedUserEmail) {
      return res.status(400).json({
        success: false,
        message: 'userEmail es requerido'
      });
    }

    const sheets = await getSheetsClient();
    const userGroupIds = await getUserGroupIds(normalizedUserEmail);

    if (normalizedGroupId && !userGroupIds.has(normalizedGroupId)) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para ver pagos de este grupo.'
      });
    }

    if (userGroupIds.size === 0) {
      return res.json({
        success: true,
        payments: [],
        total: 0
      });
    }

    const paymentsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'LoanPayments!A2:O',
    });

    const rows = paymentsResp.data.values || [];
    const loanGroupMap = await getLoanGroupMap();

    const payments = rows
      .filter((row) => normalizeEmailKey(row[1]) === normalizedUserEmail)
      .map((row) => {
        const loanId = (row[2] || '').toString().trim();
        const resolvedGroupId = loanGroupMap.get(loanId) || '';
        return {
          paymentId: row[0] || '',
          userEmail: row[1] || '',
          loanId,
          groupId: resolvedGroupId,
          amount: Number(row[3] || 0),
          paymentDate: row[4] || '',
          description: row[5] || '',
          status: row[6] || '',
          imageFilename: row[7] || '',
          originalImageName: row[8] || '',
          imagePath: row[9] || '',
          imageSize: Number(row[10] || 0),
          createdAt: row[11] || '',
          approvedBy: row[12] || '',
          approvalDate: row[13] || '',
          approvalNotes: row[14] || ''
        };
      })
      .filter((payment) => {
        const paymentGroupId = (payment.groupId || '').toString().trim();
        if (!paymentGroupId) return false;
        if (normalizedGroupId) return paymentGroupId === normalizedGroupId;
        return userGroupIds.has(paymentGroupId);
      })
      .sort((a, b) => new Date(b.createdAt || b.paymentDate || 0) - new Date(a.createdAt || a.paymentDate || 0));

    return res.json({
      success: true,
      payments,
      total: payments.length
    });
  } catch (error) {
    console.error('[USER LOAN PAYMENTS] Error:', error.message, error.stack);
    if (isQuotaExceededError(error)) {
      return res.status(200).json({
        success: true,
        payments: [],
        total: 0,
        warning: 'Límite temporal de lecturas alcanzado. Intenta nuevamente en unos segundos.'
      });
    }
    return res.status(500).json({
      success: false,
      message: 'Error al obtener pagos del usuario: ' + error.message
    });
  }
});

app.get('/api/payment-image/:filename', (req, res) => {
  // Sanitizar: path.basename elimina cualquier ../ y previene path traversal
  const filename = path.basename(req.params.filename || '');
  const baseDir = path.join(__dirname, 'uploads', 'payments');
  const imagePath = path.join(baseDir, filename);

  // Defensa adicional: el archivo resuelto debe quedar dentro de baseDir
  if (!filename || !imagePath.startsWith(baseDir)) {
    return res.status(400).json({ success: false, message: 'Nombre de archivo invalido' });
  }

  // Verificar que el archivo existe
  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ success: false, message: 'Imagen no encontrada' });
  }
  
  // Servir la imagen
  res.sendFile(imagePath);
});

// Endpoint para obtener información del grupo incluyendo tasa de interés
app.get('/api/group-info/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    if (!groupId) {
      return res.status(400).json({
        success: false,
        message: 'GroupId es requerido'
      });
    }
    if (!(await assertGroupMember(req, res, groupId))) return;

    const sheets = await getSheetsClient();

    // Obtener información del grupo
    const headerResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Groups!1:1',
    });
    const headers = headerResp.data.values?.[0] || [];
    const lastColumn = toColumnLetter(headers.length || 17);

    const groupsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `Groups!A2:${lastColumn}`,
      // Range dinámico para soportar columnas adicionales de configuración.
    });
    
    const rows = groupsResp.data.values || [];
    const groupIdCol = headers.findIndex((h) => normalize(h) === 'groupid');
    const groupNameCol = headers.findIndex((h) => normalize(h) === 'groupname');
    const groupTypeCol = headers.findIndex((h) => normalize(h) === 'tipogrupo');
    const interestRateCol = headers.findIndex((h) => normalize(h) === 'porcentajeinteresmensual');
    const createdDateCol = headers.findIndex((h) => normalize(h) === 'createddate');
    const descriptionCol = headers.findIndex((h) => normalize(h) === 'description');
    const safeGroupIdCol = groupIdCol >= 0 ? groupIdCol : 0;
    const safeGroupNameCol = groupNameCol >= 0 ? groupNameCol : 1;

    const groupRow = rows.find((row) => (row[safeGroupIdCol] || '').toString().trim() === groupId);
    
    if (!groupRow) {
      return res.status(404).json({ 
        success: false, 
        message: 'Grupo no encontrado' 
      });
    }

    const groupInfo = {
      groupId: groupRow[safeGroupIdCol] || '',
      groupName: groupRow[safeGroupNameCol] || '',
      groupType: groupRow[groupTypeCol >= 0 ? groupTypeCol : 12] || '',
      interestRate: Number(groupRow[interestRateCol >= 0 ? interestRateCol : 13] || 0),
      createdDate: groupRow[createdDateCol] || '',
      description: groupRow[descriptionCol] || ''
    };

    res.json({ 
      success: true, 
      group: groupInfo
    });

  } catch (error) {
    console.error('[GROUP INFO] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener información del grupo: ' + error.message 
    });
  }
});

// Endpoint para obtener administradores de un grupo (presidentes y tesoreros)
app.get('/api/group-admins/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;

    if (!groupId) {
      return res.status(400).json({
        success: false,
        message: 'GroupId es requerido'
      });
    }
    if (!(await assertGroupMember(req, res, groupId))) return;

    const sheets = await getSheetsClient();
    
    // Obtener enlaces usuario-grupo para encontrar administradores
    const linksResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'UserGroupLinks!A2:E',
    });
    
    const rows = linksResp.data.values || [];
    
    // Filtrar administradores del grupo (presidente y tesorero)
    const admins = rows
      .filter(row => 
        row[1] === groupId && // GroupID
        (row[3] === 'presidente' || row[3] === 'tesorero') // GroupRole
      )
      .map(row => ({
        userEmail: row[0] || '',
        groupId: row[1] || '',
        role: row[3] || '',
        joinDate: row[2] || ''
      }));

    res.json({ 
      success: true, 
      admins: admins
    });

  } catch (error) {
    console.error('[GROUP ADMINS] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener administradores del grupo: ' + error.message 
    });
  }
});

// Endpoint para obtener solicitudes de préstamos pendientes para administradores
app.get('/api/pending-loan-requests', async (req, res) => {
  try {
    const { groupId } = req.query;
    const adminEmail = req.user.email; // identidad desde el token, no del cliente

    const sheets = await getSheetsClient();
    const managedGroupIds = await getUserManagedGroupIds(adminEmail);

    if (groupId && managedGroupIds !== null && !managedGroupIds.has((groupId || '').toString().trim())) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para ver solicitudes de este grupo.'
      });
    }
    
    // Obtener todas las solicitudes de préstamos
    try {
      const loansResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'SolicitudesPrestamos!A2:J',
      });
      
      const rows = loansResp.data.values || [];
      
      // Filtrar solicitudes pendientes
      let pendingLoans = rows
        .filter(row => row[5] === 'pendiente') // Estado pendiente
        .map(row => ({
          id: row[0] || '',
          userEmail: row[1] || '',
          group: row[2] || '',
          groupRole: row[3] || '',
          amount: Number(row[4] || 0),
          status: row[5] || '',
          date: row[6] || '',
          details: row[7] || '',
          approvedBy: row[8] || '',
          interestRate: Number(row[9] || 0) // Nueva columna para tasa de interés
        }));

      if (managedGroupIds !== null) {
        pendingLoans = pendingLoans.filter((loan) =>
          managedGroupIds.has((loan.group || '').toString().trim())
        );
      }

      // Si se especifica groupId, filtrar por grupo
      if (groupId) {
        const normalizedGroupId = (groupId || '').toString().trim();
        pendingLoans = pendingLoans.filter((loan) => (loan.group || '').toString().trim() === normalizedGroupId);
      }

      // Ordenar por fecha descendente (más recientes primero)
      pendingLoans.sort((a, b) => new Date(b.date) - new Date(a.date));

      res.json({ 
        success: true, 
        loans: pendingLoans,
        total: pendingLoans.length 
      });

    } catch (sheetError) {
      // Si la hoja no existe, retornar lista vacía
      if (sheetError.message.includes('Unable to parse range')) {
        res.json({ 
          success: true, 
          loans: [],
          total: 0 
        });
      } else {
        throw sheetError;
      }
    }

  } catch (error) {
    console.error('[PENDING LOAN REQUESTS] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener solicitudes pendientes: ' + error.message 
    });
  }
});

// Endpoint para aprobar/rechazar solicitudes de préstamos
app.post('/api/approve-loan-request', bloquear((r) => `solicitud:${r.body && r.body.loanId}`), async (req, res) => {
  try {
    const { loanId, action, notes } = req.body; // action: 'approve' or 'reject'
    const adminEmail = req.user.email; // identidad desde el token, no del cliente

    if (!loanId || !action) {
      return res.status(400).json({
        success: false,
        message: 'Faltan parámetros requeridos: loanId, action'
      });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Acción inválida. Debe ser "approve" o "reject"' 
      });
    }

    const sheets = await getSheetsClient();
    
    // Buscar la solicitud en la hoja
    const loansResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'SolicitudesPrestamos!A2:J',
    });
    
    const rows = loansResp.data.values || [];
    const loanRowIndex = rows.findIndex(row => row[0] === loanId);
    
    if (loanRowIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: 'Solicitud de préstamo no encontrada' 
      });
    }

    const actualRowIndex = loanRowIndex + 2; // +2 porque empezamos en A2
    const newStatus = action === 'approve' ? 'aprobado' : 'rechazado';
    const loanData = rows[loanRowIndex];
    const loanGroupId = (loanData[2] || '').toString().trim();

    if (!loanGroupId) {
      return res.status(400).json({
        success: false,
        message: 'La solicitud no tiene GroupID valido.'
      });
    }

    if (!(await canManageGroup(adminEmail, loanGroupId))) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para aprobar solicitudes de este grupo.'
      });
    }

    // Control interno: si el grupo exige aprobacion colegiada, un solo gestor no
    // puede aprobar por su cuenta; debe pasar por la votacion de la junta.
    if (gobApi) {
      const reglas = await gobApi.getReglas(loanGroupId);
      if (reglas.requiereAprobacionPrestamos && req.user.role !== 'admin') {
        return res.status(409).json({
          success: false,
          codigo: 'REQUIERE_VOTACION',
          message: 'Este grupo exige aprobacion colegiada. Registra tu voto en el panel de liderazgo; '
            + 'la solicitud se aprueba sola al alcanzar el quorum.'
        });
      }
    }

    // Idempotencia: una solicitud ya resuelta no se vuelve a procesar
    // (sin esto, dos clics creaban dos prestamos identicos en Loans).
    const estadoActual = (loanData[5] || '').toString().trim().toLowerCase();
    if (['aprobado', 'aprobada', 'rechazado', 'rechazada'].includes(estadoActual)) {
      return res.status(409).json({
        success: false,
        message: `La solicitud ya fue ${estadoActual}. No se puede volver a procesar.`,
        estado: estadoActual
      });
    }
    
    // Preservar el Detalles original (contiene "Plazo: N"); las notas se anexan, no se sobreescriben
    const detallesOriginal = (loanData[7] || '').toString();
    const detallesActualizado = notes ? `${detallesOriginal} | Nota: ${notes}` : detallesOriginal;

    // Actualizar el status y aprobador
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `SolicitudesPrestamos!F${actualRowIndex}:I${actualRowIndex}`, // Columnas F-I
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          newStatus,             // Status (F)
          loanData[6] || '',     // Date (G) - mantener
          detallesActualizado,   // Detalles (H) - preserva Plazo y anexa nota
          adminEmail             // AprobadoPor (I)
        ]]
      }
    });

    // Si se aprueba: calcular interes, persistir en Loans y registrar la transaccion (principal).
    // Se delega en el helper compartido, que ademas deduplica por LoanID.
    if (action === 'approve') {
      await crearPrestamoAprobadoDesdeSolicitud(
        sheets, loanId, loanData[1], loanGroupId, loanData[4], loanData[7]
      );
    }

    console.log(`[APPROVE LOAN] Solicitud ${loanId} ${action}d por ${adminEmail}`);
    
    res.json({ 
      success: true, 
      message: `Solicitud de préstamo ${action === 'approve' ? 'aprobada' : 'rechazada'} correctamente`,
      loanId: loanId,
      newStatus: newStatus
    });

  } catch (error) {
    console.error('[APPROVE LOAN] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al procesar la aprobación: ' + error.message 
    });
  }
});

// Endpoint para aprobar/rechazar pagos (solo para administradores)
app.post('/api/approve-payment', bloquear((r) => `pago:${r.body && r.body.paymentId}`), async (req, res) => {
  try {
    const { paymentId, action, notes } = req.body; // action: 'approve' or 'reject'
    const adminEmail = req.user.email; // identidad desde el token, no del cliente

    if (!paymentId || !action) {
      return res.status(400).json({
        success: false,
        message: 'Faltan parámetros requeridos: paymentId, action'
      });
    }

    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Acción inválida. Debe ser "approve" o "reject"' 
      });
    }

    const sheets = await getSheetsClient();
    
    // Buscar el pago en la hoja
    const paymentsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'LoanPayments!A2:O',
    });
    
    const rows = paymentsResp.data.values || [];
    const paymentRowIndex = rows.findIndex(row => row[0] === paymentId);
    
    if (paymentRowIndex === -1) {
      return res.status(404).json({ 
        success: false, 
        message: 'Pago no encontrado' 
      });
    }

    const actualRowIndex = paymentRowIndex + 2; // +2 porque empezamos en A2
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    const approvalDate = new Date().toISOString();
    const paymentData = rows[paymentRowIndex];
    const loanId = (paymentData[2] || '').toString().trim();

    // Idempotencia: un comprobante ya resuelto no se vuelve a procesar. Sin esto,
    // un pago rechazado podia aprobarse despues (bajando el saldo) o uno aprobado
    // volverse rechazado (subiendolo), sin rastro de la decision anterior.
    const estadoPago = (paymentData[6] || '').toString().trim().toLowerCase();
    if (['approved', 'aprobado', 'rejected', 'rechazado'].includes(estadoPago)) {
      const enCastellano = ['approved', 'aprobado'].includes(estadoPago) ? 'aprobado' : 'rechazado';
      return res.status(409).json({
        success: false,
        message: `Este comprobante ya fue ${enCastellano} por ${paymentData[12] || 'la junta'}. No se puede volver a procesar.`,
        estado: estadoPago,
      });
    }
    const loanGroupMap = await getLoanGroupMap();
    const loanGroupId = loanGroupMap.get(loanId) || '';
    const requesterIsGlobalAdmin = await isGlobalAdmin(adminEmail);

    if (!requesterIsGlobalAdmin) {
      if (!loanGroupId) {
        return res.status(403).json({
          success: false,
          message: 'No se pudo determinar el grupo del pago. Contacta al administrador global.'
        });
      }

      if (!(await canManageGroup(adminEmail, loanGroupId))) {
        return res.status(403).json({
          success: false,
          message: 'No tienes permisos para aprobar pagos de este grupo.'
        });
      }
    }
    
    // Actualizar el status, aprobador, fecha y notas
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `LoanPayments!G${actualRowIndex}:O${actualRowIndex}`, // Columnas G-O
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          newStatus,      // Status (G)
          paymentData[7] || '', // ImageFilename (H) - mantener
          paymentData[8] || '', // OriginalImageName (I) - mantener
          paymentData[9] || '', // ImagePath (J) - mantener
          paymentData[10] || '', // ImageSize (K) - mantener
          paymentData[11] || '', // CreatedAt (L) - mantener
          adminEmail,     // ApprovedBy (M)
          approvalDate,   // ApprovalDate (N)
          notes || ''     // ApprovalNotes (O)
        ]]
      }
    });

    console.log(`[APPROVE PAYMENT] Pago ${paymentId} ${action}d por ${adminEmail}`);
    
    res.json({ 
      success: true, 
      message: `Pago ${action === 'approve' ? 'aprobado' : 'rechazado'} correctamente`,
      paymentId: paymentId,
      newStatus: newStatus
    });

  } catch (error) {
    console.error('[APPROVE PAYMENT] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al procesar la aprobación: ' + error.message 
    });
  }
});

// --- ENDPOINTS DE AHORROS ---
const savingsService = require('./services/savingsService');

// POST /api/savings - Agregar nuevo ahorro
app.post('/api/savings', async (req, res) => {
  try {
    const { groupId, tipo, monto, descripcion, meta } = req.body;
    const email = selfEmail(req, req.body.email); // se registra siempre a nombre del usuario autenticado

    const montoIsMissing = monto === undefined || monto === null || `${monto}`.trim() === '';
    if (!email || !groupId || !tipo || montoIsMissing) {
      return res.status(400).json({ 
        success: false, 
        message: 'Faltan campos requeridos: email, groupId, tipo, monto' 
      });
    }

    const montoAporte = parseMoney(monto);
    if (!Number.isFinite(montoAporte) || montoAporte <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El monto debe ser un numero valido mayor a 0'
      });
    }
    // Tope superior: una cifra absurda casi siempre es un error de digitacion
    // (o un intento de inflar el patrimonio). El mismo limite que las solicitudes.
    if (montoAporte > MONTO_MAXIMO) {
      return res.status(400).json({
        success: false,
        message: `El monto no puede superar ${MONTO_MAXIMO.toLocaleString('es-EC')}. Revisa la cifra.`
      });
    }

    // El usuario debe pertenecer al grupo donde registra el ahorro
    if (!(await assertGroupMember(req, res, groupId))) return;

    const estadoNuevo = await estadoInicialAporte(groupId);
    const result = await savingsService.addSaving(SPREADSHEET_ID, {
      email,
      groupId,
      tipo,
      monto,
      descripcion,
      meta,
      estado: estadoNuevo,
      registradoPor: req.user.email,
      movId: nuevoMovId('sav')
    });

    console.log(`[ADD SAVING] Ahorro ${estadoNuevo}: ${result.savingId} por ${email} - $${monto}`);

    res.json({
      success: true,
      message: estadoNuevo === 'pendiente'
        ? 'Ahorro registrado. Queda PENDIENTE hasta que la tesoreria lo confirme.'
        : 'Ahorro registrado correctamente',
      savingId: result.savingId,
      movId: result.movId,
      estado: estadoNuevo
    });

  } catch (error) {
    console.error('[ADD SAVING] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al registrar ahorro: ' + error.message 
    });
  }
});

// GET /api/savings - Obtener ahorros por usuario
app.get('/api/savings', async (req, res) => {
  try {
    const { groupId } = req.query;
    const email = selfEmail(req, req.query.email);
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Se requiere el parámetro email' 
      });
    }

    const savings = await savingsService.getSavingsByUser(SPREADSHEET_ID, email, groupId);
    
    res.json({ 
      success: true,
      savings: savings,
      total: savings.length
    });

  } catch (error) {
    console.error('[GET SAVINGS] Error:', error.message, error.stack);
    if (isQuotaExceededError(error)) {
      return res.status(200).json({
        success: true,
        savings: [],
        total: 0,
        warning: 'Límite temporal de lecturas alcanzado. Intenta nuevamente en unos segundos.'
      });
    }
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener ahorros: ' + error.message 
    });
  }
});

// GET /api/savings/stats - Obtener estadísticas completas (ahorros + acciones)
app.get('/api/savings/stats', async (req, res) => {
  try {
    const { groupId } = req.query;
    const email = selfEmail(req, req.query.email);
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Se requiere el parámetro email' 
      });
    }

    const stats = await savingsService.getSavingsStats(SPREADSHEET_ID, email, groupId);
    
    res.json({ 
      success: true,
      stats: stats
    });

  } catch (error) {
    console.error('[GET SAVINGS STATS] Error:', error.message, error.stack);
    if (isQuotaExceededError(error)) {
      return res.status(200).json({
        success: true,
        stats: {
          totalSavings: 0,
          totalSavingsAmount: 0,
          totalShares: 0,
          totalSharesAmount: 0,
          monthlySavings: 0,
          monthlyShares: 0,
          monthlyTrend: [],
        },
        warning: 'Límite temporal de lecturas alcanzado. Intenta nuevamente en unos segundos.'
      });
    }
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener estadísticas: ' + error.message 
    });
  }
});

// Endpoint de prueba simple
app.get('/api/test-endpoint', (req, res) => {
  console.log('[TEST] Endpoint de prueba ejecutado');
  res.json({ message: 'Endpoint funcionando', timestamp: new Date().toISOString() });
});

// Sistema de cálculo de intereses sobre aportes (acciones) según normativa cooperativa
function calcularUtilidadesProgresivas(acciones) {
  // === PARÁMETROS CONFIGURABLES POR COOPERATIVA ===
  const CONFIG = {
    valorNominal: 10.00,           // Valor monetario por acción (USD)
    tasaAnualMax: 0.06,            // Tope anual permitido (6% = 0.06)
    usaTasaFijaMensual: true,      // Si true: i_m = tasaAnual/12, si false: promedio diario
    capitalizaMensual: false,      // Si true: intereses se suman a la base, si false: interés simple
    mesCorteExcedentes: 12,        // Mes de corte para excedentes (diciembre = 12)
    separaExcedentes: false        // Si true: excedentes se calculan aparte
  };
  
  const auditoria = [];
  const utilidades = [];
  
  console.log(`[INTERESES ACCIONES] === INICIO CÁLCULO NORMATIVO ===`);
  console.log(`[INTERESES ACCIONES] Configuración:`, CONFIG);
  console.log(`[INTERESES ACCIONES] Procesando ${acciones.length} registros de acciones`);
  
  // Validación inicial
  if (!acciones || acciones.length === 0) {
    console.log(`[INTERESES ACCIONES] No hay acciones para procesar`);
    return { utilidades: [], totalUtilidades: 0, auditoria: [] };
  }
  
  // 1. PROCESAR Y VALIDAR LOTES DE ACCIONES
  const lotes = [];
  acciones.forEach((accion, index) => {
    const fechaCompra = new Date(accion.fecha);
    if (isNaN(fechaCompra.getTime())) {
      console.log(`[INTERESES ACCIONES] Fecha inválida en lote ${index}:`, accion.fecha);
      return;
    }
    
    const cantidad = Number(accion.cantidad) || 0;
    const valorAccion = Number(accion.valorAccion) || CONFIG.valorNominal;
    const tasaAnual = Math.min(Number(accion.tasaInteres) / 100 || 0, CONFIG.tasaAnualMax);
    
    if (cantidad > 0 && valorAccion > 0 && tasaAnual > 0) {
      lotes.push({
        id: `lote_${index}`,
        fechaCompra,
        mesCompra: fechaCompra.toISOString().substring(0, 7),
        acciones: cantidad,
        valorNominal: valorAccion,
        valorInversion: cantidad * valorAccion,
        tasaAnual: tasaAnual,
        tasaAnualOriginal: Number(accion.tasaInteres) / 100 || 0,
        mesesDevengados: 0,
        interesAcumulado: 0,
        baseCapitalizada: cantidad * valorAccion // Base inicial
      });
      
      console.log(`[INTERESES ACCIONES] Lote ${index}: ${cantidad} acciones ? $${valorAccion} = $${cantidad * valorAccion} @ ${(tasaAnual*100).toFixed(2)}% anual`);
    } else {
      console.log(`[INTERESES ACCIONES] Lote inválido ${index}:`, { cantidad, valorAccion, tasaAnual });
    }
  });
  
  if (lotes.length === 0) {
    return { utilidades: [], totalUtilidades: 0, auditoria: [] };
  }
  
  console.log(`[INTERESES ACCIONES] Lotes válidos: ${lotes.length} de ${acciones.length}`);
  
  // 2. ENCONTRAR RANGO DE CÁLCULO
  const fechaPrimeraCompra = new Date(Math.min(...lotes.map(l => l.fechaCompra.getTime())));
  const fechaActual = new Date();
  
  let fechaIteracion = new Date(fechaPrimeraCompra);
  fechaIteracion.setDate(1); // Primer día del mes
  
  let totalInteresesAcumulados = 0;
  
  console.log(`[INTERESES ACCIONES] Calculando desde: ${fechaIteracion.toISOString().substring(0, 7)} hasta: ${fechaActual.toISOString().substring(0, 7)}`);
  
  // 3. CÁLCULO MENSUAL ITERATIVO
  while (fechaIteracion <= fechaActual) {
    const mesActual = fechaIteracion.toISOString().substring(0, 7);
    const esCorteAnual = fechaIteracion.getMonth() + 1 === CONFIG.mesCorteExcedentes;
    
    // 4. CONSTRUIR BASE DEVENGABLE PARA ESTE MES
    let baseDevengable = 0;
    let lotesActivos = 0;
    const detallesMes = [];
    
    lotes.forEach(lote => {
      // Solo devenga si fue comprado ANTES de este mes (mes siguiente regla)
      if (lote.mesCompra < mesActual) {
        const mesesTranscurridos = calcularMesesEntre(lote.fechaCompra, fechaIteracion);
        lote.mesesDevengados = Math.max(0, mesesTranscurridos - 1); // -1 porque empieza mes siguiente

        // Base actual del lote: con capitalizacion suma el interes acumulado; sin ella usa la inversion
        const baseLote = CONFIG.capitalizaMensual
          ? (lote.valorInversion + lote.interesAcumulado)
          : lote.valorInversion;
        baseDevengable += baseLote;
        lotesActivos++;
        
        detallesMes.push({
          loteId: lote.id,
          mesCompra: lote.mesCompra,
          acciones: lote.acciones,
          baseLote: baseLote,
          mesesDevengados: lote.mesesDevengados,
          tasaAnual: lote.tasaAnual
        });
      }
    });
    
    if (baseDevengable > 0) {
      // 5. CALCULAR TASA MENSUAL
      const tasaAnualPromedio = lotes.length > 0 
        ? lotes.reduce((sum, l) => sum + l.tasaAnual, 0) / lotes.length 
        : 0;
      const tasaMensual = CONFIG.usaTasaFijaMensual 
        ? Math.min(tasaAnualPromedio / 12, CONFIG.tasaAnualMax / 12)
        : tasaAnualPromedio / 12; // Simplificado, sin promedio diario
      
      // 6. INTER?S DEL MES
      const interesMes = baseDevengable * tasaMensual;
      
      // 7. Interes por lote (sin capitalizacion de base)
      lotes.forEach((lote) => {
        if (lote.mesCompra < mesActual) {
          const proporcion = lote.valorInversion / baseDevengable;
          const interesLote = interesMes * proporcion;
          lote.interesAcumulado += interesLote;
        }
      });
      
      // 8. REGISTRAR RESULTADO DEL MES
      utilidades.push({
        fecha: mesActual,
        baseDevengable: Math.round(baseDevengable * 100) / 100,
        tasaMensual: Math.round(tasaMensual * 10000) / 100, // Porcentaje con 2 decimales
        interesMes: Math.round(interesMes * 100) / 100,
        lotesActivos: lotesActivos,
        esCorteAnual: esCorteAnual,
        detalles: detallesMes
      });
      
      totalInteresesAcumulados += interesMes;
      
      console.log(`[INTERESES ACCIONES] ${mesActual}: ${lotesActivos} lotes activos, base $${baseDevengable.toFixed(2)} @ ${(tasaMensual*100).toFixed(3)}% = $${interesMes.toFixed(2)}`);
      
      // 9. AUDITORÍA MENSUAL
      auditoria.push({
        mes: mesActual,
        baseTotal: baseDevengable,
        tasaAplicada: tasaMensual,
        interesGenerado: interesMes,
        lotesDetalle: detallesMes.map(d => ({
          lote: d.loteId,
          acciones: d.acciones,
          base: d.baseLote,
          mesesDev: d.mesesDevengados
        }))
      });
      
    } else {
      console.log(`[INTERESES ACCIONES] ${mesActual}: Sin lotes devengando aún (ninguno comprado antes de este mes)`);
    }
    
    // Avanzar al siguiente mes
    fechaIteracion.setMonth(fechaIteracion.getMonth() + 1);
  }
  
  // 10. RESUMEN FINAL Y VALIDACIONES
  console.log(`[INTERESES ACCIONES] === RESULTADO FINAL ===`);
  console.log(`[INTERESES ACCIONES] Total intereses acumulados: $${totalInteresesAcumulados.toFixed(2)}`);
  console.log(`[INTERESES ACCIONES] Meses con devengo: ${utilidades.length}`);
  
  // Validación de tasas máximas
  lotes.forEach(lote => {
    if (lote.tasaAnualOriginal > CONFIG.tasaAnualMax) {
      console.log(`[INTERESES ACCIONES] ADVERTENCIA: Lote ${lote.id} tenía tasa ${(lote.tasaAnualOriginal*100).toFixed(2)}% (ajustada a ${(CONFIG.tasaAnualMax*100).toFixed(2)}%)`);
    }
  });
  
  return {
    utilidades,
    totalUtilidades: Math.round(totalInteresesAcumulados * 100) / 100,
    auditoria,
    configuracion: CONFIG,
    lotesResumen: lotes.map(l => ({
      id: l.id,
      mesCompra: l.mesCompra,
      acciones: l.acciones,
      valorInversion: l.valorInversion,
      mesesDevengados: l.mesesDevengados,
      interesAcumulado: Math.round(l.interesAcumulado * 100) / 100
    }))
  };
}

// Función auxiliar para calcular meses entre fechas
function calcularMesesEntre(fechaInicio, fechaFin) {
  const anosDiff = fechaFin.getFullYear() - fechaInicio.getFullYear();
  const mesesDiff = fechaFin.getMonth() - fechaInicio.getMonth();
  return anosDiff * 12 + mesesDiff;
}

// GET /api/savings/complete - Obtener resumen completo del patrimonio
app.get('/api/savings/complete', async (req, res) => {
  try {
    const normalizedEmail = normalizeEmailKey(selfEmail(req, req.query.email));
    const normalizedGroupId = normalizeGroupKey(req.query.groupId);
    console.log(`[SAVINGS COMPLETE] Iniciando para email: ${normalizedEmail}, groupId: ${normalizedGroupId}`);
    
    if (!normalizedEmail) {
      return res.status(400).json({ 
        success: false, 
        message: 'Se requiere el parámetro email' 
      });
    }

    if (!normalizedGroupId) {
      return res.status(400).json({
        success: false,
        message: 'Se requiere el parámetro groupId'
      });
    }

    const sheetsClient = await getSheetsClient();
    const belongsToGroup = await userBelongsToGroupSafe(sheetsClient, normalizedEmail, normalizedGroupId);
    if (!belongsToGroup) {
      return res.status(403).json({
        success: false,
        message: 'El usuario no pertenece al grupo solicitado'
      });
    }

    // Obtener datos directamente usando la conexión principal (sin savingsService por ahora)
    console.log('[GET COMPLETE SAVINGS] Obteniendo datos para:', normalizedEmail, normalizedGroupId);
    
    // Obtener ahorros directamente
    let totalAhorros = 0;
    let historialAhorros = [];
    let ahorrosPendientes = [];
    let totalAhorrosPendientes = 0;
    let accionesPendientes = [];
    let totalAccionesPendientes = 0;
    try {
      const ahorrosResponse = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Savings!A:L'
      });
      
      const ahorrosRows = ahorrosResponse.data.values || [];
      console.log(`[GET COMPLETE SAVINGS] Obtenidas ${ahorrosRows.length} filas de ahorros`);
      console.log(`[GET COMPLETE SAVINGS] Headers:`, ahorrosRows[0]);
      console.log(`[GET COMPLETE SAVINGS] Buscando email: ${normalizedEmail}, groupId: ${normalizedGroupId}`);
      
      if (ahorrosRows.length > 1) {
        // Los datos están directamente sin headers coincidentes
        // UserEmail, GroupID, Amount, Date, Type, Description
        const emailIndex = 0;
        const groupIndex = 1;
        const amountIndex = 2;
        const dateIndex = 3;
        const typeIndex = 4;
        
        console.log(`[GET COMPLETE SAVINGS] Índices - Email: ${emailIndex}, Group: ${groupIndex}, Amount: ${amountIndex}`);
        console.log(`[GET COMPLETE SAVINGS] Primeras 3 filas de datos:`, ahorrosRows.slice(1, 4));
        
        const misAhorros = ahorrosRows.slice(1).filter(row => (
          normalizeEmailKey(row[emailIndex]) === normalizedEmail
          && normalizeGroupKey(row[groupIndex]) === normalizedGroupId
        ));

        // Solo los aportes CONFIRMADOS por la tesoreria integran el patrimonio.
        historialAhorros = misAhorros
          .filter(row => aporteConfirmado(row[SAVINGS_ESTADO_IDX]))
          .map(row => ({
            fecha: row[dateIndex] || '',
            monto: parseMoney(row[amountIndex]),
            tipo: row[typeIndex] || 'mensual',
            descripcion: row[5] || '',
            estado: 'confirmado'
          }));

        ahorrosPendientes = misAhorros
          .filter(row => estadoAporteCell(row[SAVINGS_ESTADO_IDX]) === 'pendiente')
          .map(row => ({
            fecha: row[dateIndex] || '',
            monto: parseMoney(row[amountIndex]),
            tipo: row[typeIndex] || 'mensual',
            descripcion: row[5] || '',
            movId: row[10] || '',
            estado: 'pendiente'
          }));
        totalAhorrosPendientes = ahorrosPendientes.reduce((sum, a) => sum + a.monto, 0);

        totalAhorros = historialAhorros.reduce((sum, ahorro) => sum + ahorro.monto, 0);
        console.log(`[GET COMPLETE SAVINGS] Encontrados ${historialAhorros.length} ahorros, total: $${totalAhorros}`);
      }
    } catch (error) {
      console.error('[GET COMPLETE SAVINGS] Error obteniendo ahorros:', error.message);
    }
    
    // Obtener acciones directamente
    let totalAcciones = 0;
    let totalUtilidadesAcumuladas = 0;
    let historialAcciones = [];
    let historialUtilidades = [];
    let interesesResult = {
      auditoria: [],
      configuracion: {},
      lotesResumen: [],
      utilidades: [],
      totalUtilidades: 0
    };
    
    try {
      const accionesResponse = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Acciones!A:M'
      });

      const accionesRows = accionesResponse.data.values || [];
      console.log(`[GET COMPLETE SAVINGS] Obtenidas ${accionesRows.length} filas de acciones`);

      if (accionesRows.length > 1) {
        // Lectura POSICIONAL (la hoja Acciones es posicional, no por nombre de cabecera):
        // A=email(0) B=group(1) C=date(2) D=Shares(3) E=ShareValue(4) F=InterestRate(5) G=CreatedAt(6) H=Estado(7)
        const emailIndex = 0;
        const groupIndex = 1;
        const dateIndex = 2;
        const sharesIndex = 3;
        const valueIndex = 4;

        const misAcciones = accionesRows.slice(1).filter(row => (
          normalizeEmailKey(row[emailIndex]) === normalizedEmail
          && normalizeGroupKey(row[groupIndex]) === normalizedGroupId
        ));

        accionesPendientes = misAcciones
          .filter(row => estadoAporteCell(row[ACCIONES_ESTADO_IDX]) === 'pendiente')
          .map(row => ({
            fecha: row[dateIndex] || '',
            cantidad: parseMoney(row[sharesIndex]),
            valorAccion: parseMoney(row[valueIndex]),
            total: parseMoney(row[sharesIndex]) * parseMoney(row[valueIndex]),
            movId: row[11] || '',
            estado: 'pendiente'
          }));
        totalAccionesPendientes = accionesPendientes.reduce((sum, a) => sum + a.total, 0);

        // Solo las compras CONFIRMADAS integran el capital y devengan utilidades.
        const accionesFiltradas = misAcciones
          .filter(row => aporteConfirmado(row[ACCIONES_ESTADO_IDX]))
          .map(row => ({
            fecha: row[dateIndex] || '',
            cantidad: parseMoney(row[sharesIndex]),
            valorAccion: parseMoney(row[valueIndex]),
            tasaInteres: parseMoney(row[5]),
            total: parseMoney(row[sharesIndex]) * parseMoney(row[valueIndex])
          }));

        // Calcular intereses con sistema normativo de cooperativa
        interesesResult = calcularUtilidadesProgresivas(accionesFiltradas);
        totalUtilidadesAcumuladas = interesesResult.totalUtilidades;
        historialUtilidades = interesesResult.utilidades;
        
        historialAcciones = accionesFiltradas;
        totalAcciones = historialAcciones.reduce((sum, accion) => sum + accion.total, 0);
        
        console.log(`[GET COMPLETE SAVINGS] Encontradas ${historialAcciones.length} acciones, total: $${totalAcciones}`);
        console.log(`[GET COMPLETE SAVINGS] Utilidades acumuladas: $${totalUtilidadesAcumuladas}`);
      }
    } catch (error) {
      console.error('[GET COMPLETE SAVINGS] Error obteniendo acciones:', error.message);
    }
    
    // Calcular estadísticas
    const totalPatrimonio = totalAhorros + totalAcciones + totalUtilidadesAcumuladas;
    
    // Calcular resumen por tipo
    const mensualAmount = historialAhorros.filter(a => a.tipo === 'mensual').reduce((sum, a) => sum + a.monto, 0);
    const extraAmount = historialAhorros.filter(a => a.tipo === 'extra').reduce((sum, a) => sum + a.monto, 0);
    const metasAmount = historialAhorros.filter(a => a.tipo === 'meta').reduce((sum, a) => sum + a.monto, 0);
    
    // Generar tendencia mensual
    const monthlyTrend = [];
    for (let i = 5; i >= 0; i--) {
      const monthDate = new Date();
      monthDate.setMonth(monthDate.getMonth() - i);
      const monthStr = monthDate.toISOString().slice(0, 7); // YYYY-MM
      
      const monthSavings = historialAhorros.filter(saving => 
        saving.fecha.startsWith(monthStr)
      );
      
      monthlyTrend.push({
        month: monthDate.toLocaleDateString('es-ES', { month: 'short', year: 'numeric' }),
        amount: monthSavings.reduce((sum, saving) => sum + saving.monto, 0)
      });
    }
    
    const completeData = {
      totalPatrimonio,
      totalAhorros,
      totalAcciones,
      totalUtilidades: totalUtilidadesAcumuladas,
      resumenAhorros: {
        mensual: mensualAmount,
        extra: extraAmount,
        metas: metasAmount
      },
      historialAhorros,
      historialAcciones,
      historialUtilidades,
      // Control interno: lo que el socio declaro pero la tesoreria aun no confirma.
      // NO forma parte de totalPatrimonio; se muestra aparte para que el socio lo vea.
      pendientes: {
        ahorros: ahorrosPendientes,
        acciones: accionesPendientes,
        totalAhorros: Math.round(totalAhorrosPendientes * 100) / 100,
        totalAcciones: Math.round(totalAccionesPendientes * 100) / 100,
        total: Math.round((totalAhorrosPendientes + totalAccionesPendientes) * 100) / 100
      },
      // === INFORMACI?N DEL SISTEMA NORMATIVO ===
      sistemaNormativo: {
        auditoria: interesesResult.auditoria || [],
        configuracion: interesesResult.configuracion || {},
        lotesDetalle: interesesResult.lotesResumen || [],
        mesesConDevengo: (interesesResult.utilidades || []).length,
        lotesActivos: (interesesResult.lotesResumen || []).length
      },
      estadisticas: {
        totalAmount: totalPatrimonio,
        totalSavingsAmount: totalAhorros,
        totalSharesAmount: totalAcciones,
        totalUtilitiesAmount: totalUtilidadesAcumuladas,
        monthlyTrend,
        averageMonthly: historialAhorros.length > 0 ? totalAhorros / historialAhorros.length : 0,
        // Estadísticas normativas adicionales
        promedioMensualUtilidades: historialUtilidades.length > 0 ? totalUtilidadesAcumuladas / historialUtilidades.length : 0,
        tasaEfectivaAnual: totalAcciones > 0 ? (totalUtilidadesAcumuladas / totalAcciones) * 12 / (historialUtilidades.length || 1) : 0
      }
    };
    
    res.json({ 
      success: true,
      data: completeData
    });

  } catch (error) {
    console.error('[GET COMPLETE SAVINGS] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener datos completos: ' + error.message 
    });
  }
});

// GET /api/savings/audit - Obtener auditoría detallada del sistema normativo de intereses
app.get('/api/savings/audit', async (req, res) => {
  try {
    const { groupId } = req.query;
    const email = selfEmail(req, req.query.email);
    console.log(`[SAVINGS AUDIT] Generando auditoría para email: ${email}, groupId: ${groupId}`);
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Se requiere el parámetro email' 
      });
    }

    // Obtener acciones del usuario
    const accionesResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Acciones!A:M'   // hoja canonica (antes apuntaba a 'Shares', que no existe)
    });
    
    const accionesRows = accionesResponse.data.values || [];
    if (accionesRows.length <= 1) {
      return res.json({ 
        success: true, 
        data: { 
          auditoria: [], 
          configuracion: {},
          mensaje: 'No hay acciones para auditar' 
        } 
      });
    }

    // Acciones real: A=email(0), B=group(1), C=date(2), D=Shares(3), E=ShareValue(4), F=InterestRate(5)
    const accionesFiltradas = accionesRows.slice(1)
      .filter(row => {
        const emailMatch = normalizeEmailKey(row[0]) === normalizeEmailKey(email);
        const groupMatch = !groupId || normalizeGroupKey(row[1]) === normalizeGroupKey(groupId);
        // La auditoria de intereses solo considera acciones confirmadas
        return emailMatch && groupMatch && parseMoney(row[3]) > 0 && aporteConfirmado(row[ACCIONES_ESTADO_IDX]);
      })
      .map(row => ({
        fecha: row[2] || '',
        cantidad: parseMoney(row[3]),
        valorAccion: parseMoney(row[4]),
        tasaInteres: parseMoney(row[5])
      }));

    if (accionesFiltradas.length === 0) {
      return res.json({ 
        success: true, 
        data: { 
          auditoria: [], 
          configuracion: {},
          mensaje: 'No hay acciones del usuario para auditar' 
        } 
      });
    }

    // Generar auditoría completa
    const interesesResult = calcularUtilidadesProgresivas(accionesFiltradas);
    
    const auditData = {
      fechaAuditoria: new Date().toISOString(),
      usuario: email,
      grupo: groupId || 'todos',
      configuracionNormativa: interesesResult.configuracion,
      resumenGeneral: {
        totalLotes: interesesResult.lotesResumen.length,
        totalAcciones: accionesFiltradas.reduce((sum, a) => sum + a.cantidad, 0),
        totalInvertido: accionesFiltradas.reduce((sum, a) => sum + (a.cantidad * a.valorAccion), 0),
        totalInteresesGenerados: interesesResult.totalUtilidades,
        mesesConDevengo: interesesResult.utilidades.length,
        fechaInicioDevengo: interesesResult.utilidades.length > 0 ? interesesResult.utilidades[0].fecha : null,
        fechaFinDevengo: interesesResult.utilidades.length > 0 ? interesesResult.utilidades[interesesResult.utilidades.length - 1].fecha : null
      },
      detallesPorLote: interesesResult.lotesResumen,
      historicoMensual: interesesResult.utilidades,
      trazabilidadAuditoria: interesesResult.auditoria,
      validacionesNormativas: {
        lotesConTasaAjustada: interesesResult.lotesResumen.filter(l => 
          accionesFiltradas.find(a => a.cantidad === l.acciones)?.tasaInteres / 100 > interesesResult.configuracion.tasaAnualMax
        ).length,
        cumpleReglaMesSiguiente: true, // Ya validado en el algoritmo
        capitalizacion: interesesResult.configuracion.capitalizaMensual ? 'ACTIVADA' : 'DESACTIVADA',
        separacionExcedentes: interesesResult.configuracion.separaExcedentes ? 'ACTIVADA' : 'DESACTIVADA'
      }
    };

    console.log(`[SAVINGS AUDIT] Auditoría generada: ${interesesResult.lotesResumen.length} lotes, $${interesesResult.totalUtilidades} en intereses`);

    res.json({ 
      success: true,
      data: auditData
    });

  } catch (error) {
    console.error('[SAVINGS AUDIT] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al generar auditoría del sistema normativo' 
    });
  }
});

// POST /api/savings/goals - Crear nueva meta de ahorro
app.post('/api/savings/goals', async (req, res) => {
  try {
    const {
      groupId,
      nombre,
      montoObjetivo,
      fechaObjetivo,
      descripcion,
      prioridad,
      categoria
    } = req.body;
    const email = selfEmail(req, req.body.email); // la meta se crea a nombre del usuario autenticado

    const montoObjetivoIsMissing = montoObjetivo === undefined || montoObjetivo === null || `${montoObjetivo}`.trim() === '';
    if (!email || !groupId || !nombre || montoObjetivoIsMissing || !fechaObjetivo) {
      return res.status(400).json({ 
        success: false, 
        message: 'Faltan campos requeridos: email, groupId, nombre, montoObjetivo, fechaObjetivo' 
      });
    }

    if (isNaN(Number(montoObjetivo)) || Number(montoObjetivo) <= 0) {
      return res.status(400).json({
        success: false,
        message: 'El monto objetivo debe ser un número válido mayor a 0'
      });
    }

    // El usuario debe pertenecer al grupo donde crea la meta
    if (!(await assertGroupMember(req, res, groupId))) return;

    const result = await savingsService.addSavingGoal(SPREADSHEET_ID, {
      email,
      groupId,
      nombre,
      montoObjetivo,
      fechaObjetivo,
      descripcion,
      prioridad,
      categoria
    });

    console.log(`[ADD SAVINGS GOAL] Meta creada: ${result.goalId} por ${email} - ${nombre}`);
    
    res.json({ 
      success: true, 
      message: 'Meta de ahorro creada correctamente',
      goalId: result.goalId
    });

  } catch (error) {
    console.error('[ADD SAVINGS GOAL] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al crear meta: ' + error.message 
    });
  }
});

// GET /api/savings/goals - Obtener metas de ahorro por usuario
app.get('/api/savings/goals', async (req, res) => {
  try {
    const { groupId } = req.query;
    const email = selfEmail(req, req.query.email);
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Se requiere el parámetro email' 
      });
    }

    const goals = await savingsService.getSavingsGoalsByUser(SPREADSHEET_ID, email, groupId);
    
    res.json({ 
      success: true,
      goals: goals,
      total: goals.length
    });

  } catch (error) {
    console.error('[GET SAVINGS GOALS] Error:', error.message, error.stack);
    if (isQuotaExceededError(error)) {
      return res.status(200).json({
        success: true,
        goals: [],
        total: 0,
        warning: 'Límite temporal de lecturas alcanzado. Intenta nuevamente en unos segundos.'
      });
    }
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener metas: ' + error.message 
    });
  }
});

// PUT /api/savings/goals/:goalId - Actualizar progreso de meta
app.put('/api/savings/goals/:goalId', async (req, res) => {
  try {
    const { goalId } = req.params;
    const { nuevoMonto } = req.body;
    
    if (!goalId || nuevoMonto === undefined) {
      return res.status(400).json({ 
        success: false, 
        message: 'Se requieren goalId y nuevoMonto' 
      });
    }

    if (isNaN(Number(nuevoMonto)) || Number(nuevoMonto) < 0) {
      return res.status(400).json({
        success: false,
        message: 'El nuevo monto debe ser un número válido mayor o igual a 0'
      });
    }

    if (!(await assertGoalOwner(req, res, goalId))) return;

    const result = await savingsService.updateGoalProgress(SPREADSHEET_ID, goalId, Number(nuevoMonto));
    
    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.message
      });
    }

    console.log(`[UPDATE GOAL PROGRESS] Meta ${goalId} actualizada: $${nuevoMonto}`);
    
    res.json({ 
      success: true, 
      message: 'Progreso de meta actualizado',
      progreso: result.progreso,
      estado: result.estado
    });

  } catch (error) {
    console.error('[UPDATE GOAL PROGRESS] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al actualizar meta: ' + error.message 
    });
  }
});

// DELETE /api/savings/goals/:goalId - Eliminar meta de ahorro
app.delete('/api/savings/goals/:goalId', async (req, res) => {
  try {
    const { goalId } = req.params;
    
    if (!goalId) {
      return res.status(400).json({
        success: false,
        message: 'Se requiere goalId'
      });
    }

    if (!(await assertGoalOwner(req, res, goalId))) return;

    const result = await savingsService.deleteGoal(SPREADSHEET_ID, goalId);
    
    if (!result.success) {
      return res.status(404).json({
        success: false,
        message: result.message
      });
    }

    console.log(`[DELETE GOAL] Meta ${goalId} eliminada`);
    
    res.json({ 
      success: true, 
      message: 'Meta eliminada correctamente'
    });

  } catch (error) {
    console.error('[DELETE GOAL] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al eliminar meta: ' + error.message 
    });
  }
});

// ===========================================================================
//  MODULO DE CONTROL INTERNO (gobernanza)
//  Se registra al FINAL para que todos los helpers de arriba ya existan.
//  Las rutas quedan igualmente detras del gate global de autenticacion, que se
//  monto como middleware antes de cualquier ruta.
// ===========================================================================
const governance = require('./governance');
gobApi = governance.register(app, {
    getSheetsClient,
    SPREADSHEET_ID,
    ensureSheetExists,
    normalizeEmailKey,
    normalizeGroupKey,
    normalizeGroupRole,
    parseMoney,
    sanitizeCell,
    assertGroupManager,
    assertGroupMember,
    getUserGroupRole,
    canManageGroup,
    readUserGroupLinks,
    linkIsActive,
    getActiveLeaderCount,
    getApprovedPaymentsTotal,
    crearPrestamoAprobadoDesdeSolicitud,
    contarPrestamosActivos,
    bloquear,
});
console.log('[BACKEND] Modulo de control interno registrado (/api/gob/*).');
