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

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ dest: 'uploads/' });

// GET /api/grupos-del-usuario?userEmail=...
app.get('/api/grupos-del-usuario', async (req, res) => {
  const { userEmail } = req.query;
  if (!userEmail) {
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
      row[0] && row[0].trim().toLowerCase() === userEmail.trim().toLowerCase()
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
        range: 'Groups!A2:N',
      });
      allGroups = groupsResp.data.values || [];
    } catch (e) {}
    // Mapear nombre del grupo
    const result = userGroups.map(g => {
      const found = allGroups.find(row => row[0] === g.groupId);
      return {
        groupId: g.groupId,
        groupRole: g.groupRole,
        joinDate: g.joinDate,
        estado: g.estado,
        groupName: found ? found[1] : ''
      };
    });
    return res.json({ grupos: result });
  } catch (err) {
    console.error('Error en /api/grupos-del-usuario:', err);
    return res.status(500).json({ error: 'Error interno al obtener grupos del usuario' });
  }
});

// GET /api/obtener-acciones
// GET /api/obtener-acciones?groupId=...&userEmail=...
app.get('/api/obtener-acciones', async (req, res) => {
  try {
    const { groupId, userEmail } = req.query;
    if (!groupId || !userEmail) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }
    const sheets = await getSheetsClient();
    // Validar que el usuario pertenece al grupo
    const linksResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'UserGroupLinks!A2:E',
    });
    const links = linksResp.data.values || [];
    const pertenece = links.some(row =>
      row[0] && row[1] &&
      row[0].trim().toLowerCase() === userEmail.trim().toLowerCase() &&
      row[1].trim() === groupId.trim()
    );
    if (!pertenece) {
      return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
    }
    const range = 'Acciones!A:G';
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });
    const rows = resp.data.values || [];
    // Filtra SIEMPRE por usuario y grupo, ignorando mayúsculas y espacios
    const filtered = rows.filter(row =>
      row[0] && row[1] &&
      row[0].trim().toLowerCase() === userEmail.trim().toLowerCase() &&
      row[1].trim() === groupId.trim()
    );
    return res.json({ shares: filtered.map(row => ({
      date:        row[2],
      shares:      Number(row[3]),
      shareValue:  Number(row[4]),
      interestRate:Number(row[5])
    })) });
  } catch (err) {
    console.error('Error en /api/obtener-acciones:', err);
    return res.status(500).json({ error: 'Error interno al obtener acciones' });
  }
});

// POST /api/registrar-acciones
app.post('/api/registrar-acciones', async (req, res) => {
  try {
    const { groupId, userEmail, date, shares, shareValue, interestRate } = req.body;
    if (!groupId || !userEmail || !date || typeof shares !== 'number'
        || typeof shareValue !== 'number' || typeof interestRate !== 'number') {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    const sheets = await getSheetsClient();
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Acciones!A2:G',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[ userEmail, groupId, date, shares, shareValue, interestRate, new Date().toISOString() ]]
      }
    });
    res.status(201).json({ success: true });
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
    const { groupId } = req.query;
    console.log('obtener-miembros groupId=', groupId);
    if (!groupId) {
      return res.status(400).json({ error: 'Falta parámetro groupId' });
    }
    const members = await fetchMembersFromSheets(groupId);
    return res.status(200).json({ members });
  } catch (err) {
    console.error('Error en /api/obtener-miembros:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'Error interno al obtener miembros' });
  }
});

// --- MIDDLEWARE ---
app.use(cors()); // Habilita CORS para todas las rutas
app.use(express.json()); // Para parsear el body de las peticiones POST como JSON

// Middleware para loggear absolutamente todas las peticiones, incluso si la ruta no existe o el body es inválido
app.use((req, res, next) => {
    console.log('[GLOBAL LOGGER] Método:', req.method, 'URL:', req.url, 'IP:', req.ip, 'Origin:', req.headers.origin, 'User-Agent:', req.headers['user-agent']);
    next();
});

// Middleware para loggear todas las peticiones entrantes (después de cors y express.json)
app.use((req, res, next) => {
  console.log(`[BACKEND REQUEST LOGGER] Method: ${req.method}, URL: ${req.url}, Body: ${JSON.stringify(req.body)}`);
  next();
});

// --- CONFIGURACIÓN ---
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
    const { groupId, userEmail, date, amount } = req.body;
    if (!groupId || !userEmail || !date || typeof amount !== 'number') {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }
    const sheets = await getSheetsClient();
    const range = 'Savings!A:E';
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[userEmail, groupId, date, amount, new Date().toISOString()]],
      },
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error en /api/registrar-ahorros:', err);
    return res.status(500).json({ error: 'Error interno al registrar ahorros' });
  }
});

// GET /api/obtener-ahorros?groupId=...&userEmail=...
app.get('/api/obtener-ahorros', async (req, res) => {
  try {
    const { groupId, userEmail } = req.query;
    if (!groupId || !userEmail) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }
    const sheets = await getSheetsClient();
    // Validar que el usuario pertenece al grupo
    const linksResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'UserGroupLinks!A2:E',
    });
    const links = linksResp.data.values || [];
    const pertenece = links.some(row =>
      row[0] && row[1] &&
      row[0].trim().toLowerCase() === userEmail.trim().toLowerCase() &&
      row[1].trim() === groupId.trim()
    );
    if (!pertenece) {
      return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
    }
    const range = 'Savings!A:E';
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });
    const rows = resp.data.values || [];
    const savings = rows
      .filter(row =>
        row[0] && row[1] &&
        row[0].trim().toLowerCase() === userEmail.trim().toLowerCase() &&
        row[1].trim() === groupId.trim()
      )
      .map(row => ({ date: row[2], amount: Number(row[3]) }));
    return res.status(200).json({ savings });
  } catch (err) {
    console.error('Error en /api/obtener-ahorros:', err);
    return res.status(500).json({ error: 'Error interno al obtener ahorros' });
  }
});

// GET /api/obtener-prestamos?groupId=...&userEmail=...
app.get('/api/obtener-prestamos', async (req, res) => {
  try {
    const { groupId, userEmail } = req.query;
    if (!groupId) {
      return res.status(400).json({ error: 'Falta parámetro groupId' });
    }
    const sheets = await getSheetsClient();
    // Validar que el usuario pertenece al grupo (solo si userEmail está presente)
    if (userEmail) {
      const linksResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'UserGroupLinks!A2:E',
      });
      const links = linksResp.data.values || [];
      const pertenece = links.some(row =>
        row[0] && row[1] &&
        row[0].trim().toLowerCase() === userEmail.trim().toLowerCase() &&
        row[1].trim() === groupId.trim()
      );
      if (!pertenece) {
        return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
      }
    }
    const range = 'Loans!A2:I';
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });
    const rows = resp.data.values || [];
    let filtered;
    if (userEmail) {
      filtered = rows.filter(row =>
        row[1] && row[2] &&
        row[1].trim().toLowerCase() === userEmail.trim().toLowerCase() &&
        row[2].trim() === groupId.trim()
      );
    } else {
      filtered = rows.filter(row => row[2] && row[2].trim() === groupId.trim());
    }
    const loans = filtered.map(row => ({
      loanId: row[0] || '',
      userEmail: row[1] || '',
      groupId: row[2] || '',
      amount: Number(row[3] || 0),
      purpose: row[4] || '',
      status: row[5] || '',
      requestDate: row[6] || '',
      approvedDate: row[7] || '',
      details: row[8] || ''
    }));
    return res.status(200).json({ loans });
  } catch (err) {
    console.error('Error en /api/obtener-prestamos:', err);
    return res.status(500).json({ error: 'Error interno al obtener préstamos' });
  }
});

// GET /api/obtener-utilidades?groupId=...&userEmail=...
// GET /api/obtener-utilidades?groupId=...&userEmail=...
app.get('/api/obtener-utilidades', async (req, res) => {
  const { groupId, userEmail } = req.query;
  if (!groupId) {
    return res.status(400).json({ error: 'Falta parámetro groupId' });
  }

  try {
    const sheets = await getSheetsClient();
    // Validar que el usuario pertenece al grupo (solo si userEmail está presente)
    if (userEmail) {
      const linksResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'UserGroupLinks!A2:E',
      });
      const links = linksResp.data.values || [];
      const pertenece = links.some(row =>
        row[0] && row[1] &&
        row[0].trim().toLowerCase() === userEmail.trim().toLowerCase() &&
        row[1].trim() === groupId.trim()
      );
      if (!pertenece) {
        return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
      }
    }
    // Leemos todas las compras de acciones
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Acciones!A2:G',        // A: UserEmail, B: GroupID, C: Date, D: Shares, E: ShareValue, F: InterestRate, G: Timestamp
    });
    const rows = resp.data.values || [];

    let filtered;
    if (userEmail) {
      filtered = rows.filter(r =>
        r[0] && r[1] &&
        r[0].trim().toLowerCase() === userEmail.trim().toLowerCase() &&
        r[1].trim() === groupId.trim()
      );
    } else {
      filtered = rows.filter(r => r[1] && r[1].trim() === groupId.trim());
    }
    const utilities = filtered.map(r => {
      const date         = r[2];
      const shares       = Number(r[3] || 0);
      const shareValue   = Number(r[4] || 0);
      const interestRate = Number(r[5] || 0) / 100; // convierto % en decimal
      // utilidad = cantidad × valor × tasa
      const amount = +(shares * shareValue * interestRate).toFixed(2);
      return { userEmail: r[0], date, amount };
    });

    return res.json({ utilities });
  } catch (err) {
    console.error('Error en /api/obtener-utilidades:', err);
    return res.status(500).json({ error: 'Error interno al obtener utilidades' });
  }
});


// POST /api/registrar-acciones
app.post('/api/registrar-acciones', async (req, res) => {
  try {
    const { groupId, userEmail, date, shares, shareValue, interestRate } = req.body;
    if (!groupId || !userEmail || !date || typeof shares !== 'number' || typeof shareValue !== 'number' || typeof interestRate !== 'number') {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }
    const sheets = await getSheetsClient();
    const range = 'Acciones!A:G';
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[userEmail, groupId, date, shares, shareValue, interestRate, new Date().toISOString()]],
      },
    });
    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('Error en /api/registrar-acciones:', err);
    return res.status(500).json({ error: 'Error interno al registrar acciones' });
  }
});

// GET /api/obtener-acciones?groupId=...&userEmail=...
app.get('/api/obtener-acciones', async (req, res) => {
  try {
    const { groupId, userEmail } = req.query;
    if (!groupId || !userEmail) {
      return res.status(400).json({ error: 'Faltan parámetros requeridos' });
    }
    const sheets = await getSheetsClient();
    const range = 'Acciones!A:G';
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range,
    });
    const rows = resp.data.values || [];
    const filtered = rows.filter(row => row[0] === userEmail && row[1] === groupId);
    return res.json({ shares: filtered.map(row => ({
      date:        row[2],
      shares:      Number(row[3]),
      shareValue:  Number(row[4]),
      interestRate:Number(row[5])
    })) });
  } catch (err) {
    console.error('Error en /api/obtener-acciones:', err);
    return res.status(500).json({ error: 'Error interno al obtener acciones' });
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
        const { Username, Email, password, Role, Balance } = req.body;
        if (!Username || !Email || !password || Role === undefined || Balance === undefined) {
            return res.status(400).json({ message: 'Faltan datos del usuario. Se requieren: Username, Email, password (en texto plano), Role, Balance.' });
        }
        // Usar usersService para crear usuario (ya hace hash y log)
        const user = {
            Username,
            Email,
            Password: password,
            Role,
            Balance
        };
        const created = await usersService.createUser(user);
        res.status(201).json({ message: 'Usuario registrado en Google Sheet con éxito.', data: created });
    } catch (error) {
        res.status(500).json({ message: 'Error al registrar usuario en Sheet.', error: error.message });
    }
});

// Endpoint para crear un grupo (mejorado)
// Refactor: Usar groupsService y auditLogService
// const groupsService = require('./services/groupsService');
app.post('/api/crear-grupo-en-sheet', async (req, res) => {
    try {
        const group = req.body;
        if (!group.GroupName || !group.CreatedBy) {
            return res.status(400).json({ message: 'Faltan datos del grupo. Se requieren: GroupName, CreatedBy.' });
        }
        const created = await groupsService.createGroup(group);
        res.status(201).json({ message: 'Grupo creado en Google Sheet con éxito.', data: created });
    } catch (error) {
        res.status(500).json({ message: 'Error al crear grupo en Sheet.', error: error.message });
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
            range: 'Users!A:E', // Asegúrate que este rango cubra todas las columnas necesarias
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
        console.log(`[LOGIN ENDPOINT] Comparando contraseñas. Sheet: '${hashedPasswordFromSheet}', Input (plain): '${password}'`);

        if (bcrypt.compareSync(password, hashedPasswordFromSheet)) {
            // Contraseña correcta
            console.log(`[LOGIN ENDPOINT] Login exitoso para ${email}`);
            res.status(200).json({
                message: 'Login exitoso.',
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
app.post('/api/vincular-usuario-grupo-en-sheet', async (req, res) => {
    // Cabeceras: UserEmail, GroupID, JoinDate, GroupRole
    const { UserEmail, GroupID, JoinDate, GroupRole } = req.body;

    if (!UserEmail || !GroupID || !JoinDate || !GroupRole) {
        return res.status(400).json({ message: 'Faltan datos para vincular usuario a grupo. Se requieren: UserEmail, GroupID, JoinDate, GroupRole.' });
    }

    const values = [[UserEmail, GroupID, JoinDate, GroupRole]];
    const resource = { values };

    try {
        const response = await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'UserGroupLinks!A:E', // Pestaña 'UserGroupLinks', columnas A hasta E
            valueInputOption: 'USER_ENTERED',
            resource,
        });
        console.log('Respuesta de Google Sheets API (UserGroupLinks):', response.data);
        res.status(201).json({ message: 'Vínculo usuario-grupo creado en Google Sheet con éxito.', data: response.data });
    } catch (error) {
        console.error('Error escribiendo en Google Sheet (UserGroupLinks):', error.response ? error.response.data : error.message);
        res.status(500).json({ message: 'Error al vincular usuario a grupo en Sheet.', error: error.message });
    }
});


// Endpoint para Loans
// Refactor: Usar loansService y auditLogService
const loansService = require('./services/loansService');
app.post('/api/registrar-prestamo-en-sheet', async (req, res) => {
    try {
        const loan = req.body;
        if (!loan.LoanID || !loan.UserEmail || !loan.GroupID || loan.Amount === undefined || !loan.Purpose || !loan.Status || !loan.RequestDate) {
            return res.status(400).json({ message: 'Faltan datos del préstamo. Se requieren: LoanID, UserEmail, GroupID, Amount, Purpose, Status, RequestDate.' });
        }
        const created = await loansService.createLoan(loan);
        res.status(201).json({ message: 'Préstamo registrado en Google Sheet con éxito.', data: created });
    } catch (error) {
        res.status(500).json({ message: 'Error al registrar préstamo en Sheet.', error: error.message });
    }
});

// Endpoint para Transactions
app.post('/api/registrar-transaccion-en-sheet', async (req, res) => {
    // Cabeceras: TransactionID, UserEmail, Type, Amount, Description, Date, Category, Icon
    const { TransactionID, UserEmail, Type, Amount, Description, Date, Category, Icon } = req.body;

    if (!TransactionID || !UserEmail || !Type || Amount === undefined || !Date || !Category) {
        return res.status(400).json({ message: 'Faltan datos de la transacción. Se requieren: TransactionID, UserEmail, Type, Amount, Date, Category.' });
    }

    const values = [[TransactionID, UserEmail, Type, Amount, Description || '', Date, Category, Icon || '']];
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

// Endpoint genérico para registrar solicitudes dinámicas y crear pestañas si no existen
app.post('/api/registrar-solicitud', async (req, res) => {
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
        // Autenticación correcta para cada request
        const client = await auth.getClient();
        const sheetsApi = google.sheets({ version: 'v4', auth: client });
        // LOG extra para depuración
        console.log('[REGISTRAR SOLICITUD] Tipo:', tipo);
        console.log('[REGISTRAR SOLICITUD] Data:', data);
        console.log('[REGISTRAR SOLICITUD] userGroup:', userGroup, 'userGroupRole:', userGroupRole);
        // Asegura que la pestaña existe
        // --- CORRECCIÓN: Para tipo 'accion', asegurar solo 6 columnas reales ---
        if (tipo === 'accion') {
            const accionHeaders = ['ID', 'UserEmail', 'Cantidad', 'Estado', 'Fecha', 'Detalles'];
            await sheetsApi.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: `${config[tipo].sheet}!A1:F1`,
                valueInputOption: 'RAW',
                resource: { values: [accionHeaders] },
            });
        } else {
            await ensureSheetExists(config[tipo].sheet, config[tipo].headers, sheetsApi, SPREADSHEET_ID);
        }
        // Prepara los valores (en el mismo orden que los headers)
        let values;
        let appendRange = `${config[tipo].sheet}!A:J`; // Extendido para incluir TasaInteres
        if (tipo === 'accion') {
            values = [[
                data.ID || Date.now().toString(),
                data.UserEmail,
                data.Cantidad || '',
                data.Estado || 'pendiente',
                data.Fecha || new Date().toISOString(),
                data.Detalles || ''
            ]];
            appendRange = `${config[tipo].sheet}!A:F`;
        } else if (tipo === 'prestamo') {
            values = [[
                data.ID || Date.now().toString(),
                data.UserEmail,
                userGroup,
                userGroupRole,
                data.Monto || '',
                data.Estado || 'pendiente',
                data.Fecha || new Date().toISOString(),
                data.Detalles || '',
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
                data.Detalles || '',
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
app.post('/api/aprobar-solicitud', async (req, res) => {
    const { tipo, solicitudId, aprobadorEmail, nuevoEstado } = req.body;
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
        const solicitudIdx = rows.findIndex((row, i) => i > 0 && row[idCol] === solicitudId);
        if (solicitudIdx === -1) return res.status(404).json({ message: 'Solicitud no encontrada.' });
        rows[solicitudIdx][estadoCol] = nuevoEstado;
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

// Endpoint para cambiar el rol de un usuario
app.post('/api/cambiar-rol-usuario', async (req, res) => {
    const { Email, Role } = req.body;
    if (!Email || !Role) {
        return res.status(400).json({ message: 'Faltan datos: Email y Role son requeridos.' });
    }
    try {
        // Leer todos los usuarios
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Users!A:E',
        });
        const rows = response.data.values;
        const headerRow = rows[0];
        const emailCol = headerRow.findIndex(h => h.trim().toLowerCase() === 'email');
        const roleCol = headerRow.findIndex(h => h.trim().toLowerCase() === 'role');
        if (emailCol === -1 || roleCol === -1) {
            return res.status(500).json({ message: 'No se encontraron columnas Email o Role.' });
        }
        const userIndex = rows.findIndex((row, i) => i > 0 && row[emailCol] && row[emailCol].trim().toLowerCase() === Email.trim().toLowerCase());
        if (userIndex === -1) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        rows[userIndex][roleCol] = Role;
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `Users!A${userIndex+1}:E${userIndex+1}`,
            valueInputOption: 'USER_ENTERED',
            resource: { values: [rows[userIndex]] },
        });
        res.json({ message: 'Rol actualizado correctamente.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar rol.', error: error.message });
    }
});

// Endpoint para desactivar usuario (eliminar fila)
app.post('/api/desactivar-usuario', async (req, res) => {
    const { Email } = req.body;
    if (!Email) {
        return res.status(400).json({ message: 'Falta el Email.' });
    }
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Users!A:E',
        });
        const rows = response.data.values;
        const headerRow = rows[0];
        const emailCol = headerRow.findIndex(h => h.trim().toLowerCase() === 'email');
        const userIndex = rows.findIndex((row, i) => i > 0 && row[emailCol] && row[emailCol].trim().toLowerCase() === Email.trim().toLowerCase());
        if (userIndex === -1) {
            return res.status(404).json({ message: 'Usuario no encontrado.' });
        }
        // Eliminar la fila (no la cabecera)
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            requestBody: {
                requests: [{
                    deleteDimension: {
                        range: {
                            sheetId: response.data.sheets ? response.data.sheets[0].properties.sheetId : 0,
                            dimension: 'ROWS',
                            startIndex: userIndex,
                            endIndex: userIndex + 1
                        }
                    }
                }]
            }
        });
        res.json({ message: 'Usuario desactivado correctamente.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al desactivar usuario.', error: error.message });
    }
});

// --- Endpoint para obtener todos los usuarios y sus roles/grupos (repara cabecera automáticamente si es incorrecta) ---
app.get('/api/obtener-usuarios', async (req, res) => {
    try {
        const requiredHeaders = ['Username','Email','HashedPassword','Role','Balance','CreatedDate'];
        // 1) Inicializa el cliente (si no existe aún)
        const sheetsClient = await getSheetsClient();

        // 2) Ahora sí lee la hoja
        let response = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Users!A:F',
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
                range: 'Users!A:F',
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
            return {
                Username: row[0] || '',
                Email,
                HashedPassword: row[2] || '',
                Role: row[3] || '',
                Balance: row[4] || '',
                CreatedDate: row[5] || '',
                Miembros: grupos // Renombrar para la UI
            };
        });
        console.log('[OBTENER USUARIOS] Usuarios enviados al frontend:', usuarios);
        res.json({ usuarios });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener usuarios.', error: error.message });
    }
});

// Endpoint para importar usuarios y grupos desde Excel
app.post('/api/importar-usuarios-grupos', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ message: 'No se subió ningún archivo.' });
        const workbook = xlsx.readFile(req.file.path);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const users = xlsx.utils.sheet_to_json(sheet);
        const headers = ['Username','Email','Group','GroupRole','Password','CreatedDate'];
        await sheets.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Users!A1:F1',
            valueInputOption: 'RAW',
            resource: { values: [headers] },
        });
        // Al importar, deja CreatedDate vacío para usuarios antiguos
        const values = users.map(u => [u.Username, u.Email, u.Group, u.GroupRole, u.Password, '']);
        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Users!A2:F',
            valueInputOption: 'RAW',
            resource: { values },
        });
        // Crea pestañas de grupos si no existen
        const groupNames = [...new Set(users.map(u => u.Group))];
        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const existingSheets = spreadsheet.data.sheets.map(s => s.properties.title);
        for (const group of groupNames) {
            if (!existingSheets.includes(group)) {
                await sheets.spreadsheets.batchUpdate({
                    spreadsheetId: SPREADSHEET_ID,
                    requestBody: { requests: [{ addSheet: { properties: { title: group } } }] },
                });
            }
        }
        res.json({ message: 'Importación completada.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al importar usuarios y grupos.', error: error.message });
    }
});

// --- Endpoint para cambiar el rol de un usuario en un grupo específico (UserGroupLinks, robusto) ---
app.post('/api/cambiar-rol-usuario-grupo', async (req, res) => {
    // Permite tanto {UserEmail, GroupID, NewGroupRole} como {Email, GroupID, GroupRole} para compatibilidad
    const UserEmail = req.body.UserEmail || req.body.Email;
    const GroupID = req.body.GroupID;
    const NewGroupRole = req.body.NewGroupRole || req.body.GroupRole;
    if (!UserEmail || !GroupID || !NewGroupRole) {
        return res.status(400).json({ message: 'Faltan datos: UserEmail, GroupID y NewGroupRole son requeridos.' });
    }
    try {
        // 1. Verifica y corrige cabeceras de UserGroupLinks
        let headers = [];
        try {
            const headerResp = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'UserGroupLinks!1:1',
            });
            headers = headerResp.data.values[0];
        } catch (e) {
            headers = [];
        }
        const requiredHeaders = ['UserEmail', 'GroupID', 'JoinDate', 'GroupRole'];
        if (headers.length < requiredHeaders.length || requiredHeaders.some((h, i) => headers[i] !== h)) {
            await sheets.spreadsheets.values.update({
                spreadsheetId: SPREADSHEET_ID,
                range: 'UserGroupLinks!1:1',
                valueInputOption: 'RAW',
                resource: { values: [requiredHeaders] },
            });
            headers = requiredHeaders;
        }
        // 2. Leer todas las filas de UserGroupLinks
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'UserGroupLinks!A2:E',
        });
        const rows = response.data.values || [];
        // 3. Buscar la fila a modificar
        const userEmailCol = headers.indexOf('UserEmail');
        const groupIdCol = headers.indexOf('GroupID');
        const groupRoleCol = headers.indexOf('GroupRole');
        const joinDateCol = headers.indexOf('JoinDate');
        const rowIndex = rows.findIndex(row =>
            row[userEmailCol] && row[userEmailCol].trim().toLowerCase() === UserEmail.trim().toLowerCase() &&
            row[groupIdCol] && row[groupIdCol].trim() === GroupID.trim()
        );
        if (rowIndex === -1) {
            // Si no existe, crea la relación
            const today = new Date().toISOString().split('T')[0];
            const newRow = [];
            newRow[userEmailCol] = UserEmail;
            newRow[groupIdCol] = GroupID;
            newRow[joinDateCol] = today;
            newRow[groupRoleCol] = NewGroupRole;
            await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
            range: 'UserGroupLinks!A:E',
                valueInputOption: 'USER_ENTERED',
                resource: { values: [newRow] },
            });
            return res.json({ message: 'Vínculo usuario-grupo creado y rol asignado correctamente.' });
        } else {
            // Si existe, actualiza el rol
            rows[rowIndex][groupRoleCol] = NewGroupRole;
            await sheets.spreadsheets.values.update({
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
app.post('/api/desvincular-usuario-grupo', async (req, res) => {
    const { UserEmail, GroupID } = req.body;
    if (!UserEmail || !GroupID) {
        return res.status(400).json({ message: 'Faltan datos: UserEmail y GroupID son requeridos.' });
    }
    try {
        // Leer cabeceras
        let headers = [];
        try {
            const headerResp = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID,
                range: 'UserGroupLinks!1:1',
            });
            headers = headerResp.data.values[0];
        } catch (e) { headers = []; }
        const userEmailCol = headers.indexOf('UserEmail');
        const groupIdCol = headers.indexOf('GroupID');
        // Leer filas
        const response = await sheets.spreadsheets.values.get({
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
        // Obtener sheetId real
        const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const ugSheet = spreadsheet.data.sheets.find(s => s.properties.title === 'UserGroupLinks');
        if (!ugSheet) return res.status(500).json({ message: 'No se encontró la hoja UserGroupLinks.' });
        const sheetId = ugSheet.properties.sheetId;
        // Eliminar la fila (rowIndex + 2 porque la fila 1 es cabecera)
        await sheets.spreadsheets.batchUpdate({
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
    const grupos = gruposRaw.map(row => {
      const obj = {};
      headers.forEach((h, i) => {
        obj[h] = row[i] || '';
      });
      return obj;
    });
    res.json({ grupos });
  } catch (error) {
    console.error('Error al leer grupos de Google Sheets:', error.message);
    return res.status(500).json({ grupos: [] });
  }
});

// --- Endpoint de prueba de red y CORS ---
app.get('/api/ping', (req, res) => {
    console.log('[PING] Petición recibida desde:', req.ip, 'Origin:', req.headers.origin, 'User-Agent:', req.headers['user-agent']);
    res.json({
        message: 'pong',
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
app.get('/api/actividad-reciente', async (req, res) => {
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
  const { userEmail } = req.query;
  
  if (!userEmail) {
    return res.status(400).json({ message: 'Se requiere el parámetro userEmail' });
  }

  try {
    // Obtener todas las transacciones de la hoja Transactions
    const transResp = await sheets.spreadsheets.values.get({
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
    res.status(500).json({ message: 'Error al obtener transacciones.', error: error.message });
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
app.post('/api/upload-payment', paymentUpload.single('paymentImage'), async (req, res) => {
  try {
    const { userEmail, loanId, amount, paymentDate, description, status } = req.body;
    
    if (!userEmail || !loanId || !amount || !paymentDate || !req.file) {
      return res.status(400).json({ 
        success: false, 
        message: 'Faltan campos requeridos: userEmail, loanId, amount, paymentDate, paymentImage' 
      });
    }

    // Validar que el monto sea válido
    if (isNaN(Number(amount)) || Number(amount) <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'El monto debe ser un número válido mayor a 0' 
      });
    }

    const sheets = await getSheetsClient();
    
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
    const { groupId, adminEmail } = req.query;
    
    const sheets = await getSheetsClient();
    
    // Obtener todos los pagos pendientes
    const paymentsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'LoanPayments!A2:O', // Omitir headers
    });
    
    const rows = paymentsResp.data.values || [];
    
    // Filtrar pagos pendientes de aprobación
    const pendingPayments = rows
      .filter(row => row[6] === 'pending_approval') // Status column
      .map(row => ({
        paymentId: row[0] || '',
        userEmail: row[1] || '',
        loanId: row[2] || '',
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

    res.json({ 
      success: true, 
      payments: pendingPayments,
      total: pendingPayments.length 
    });

  } catch (error) {
    console.error('[PENDING PAYMENTS] Error:', error.message, error.stack);
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener pagos pendientes: ' + error.message 
    });
  }
});

// Endpoint para servir imágenes de pagos
app.get('/api/payment-image/:filename', (req, res) => {
  const { filename } = req.params;
  const imagePath = path.join(__dirname, 'uploads', 'payments', filename);
  
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

    const sheets = await getSheetsClient();
    
    // Obtener información del grupo
    const groupsResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Groups!A2:N', // Asumiendo que la columna N contiene la tasa de interés
    });
    
    const rows = groupsResp.data.values || [];
    const groupRow = rows.find(row => row[0] === groupId);
    
    if (!groupRow) {
      return res.status(404).json({ 
        success: false, 
        message: 'Grupo no encontrado' 
      });
    }

    const groupInfo = {
      groupId: groupRow[0] || '',
      groupName: groupRow[1] || '',
      groupType: groupRow[2] || '',
      interestRate: Number(groupRow[13] || 0), // Columna N (índice 13) - PorcentajeInteresMensual
      createdDate: groupRow[3] || '',
      description: groupRow[4] || ''
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
    const { adminEmail, groupId } = req.query;
    
    const sheets = await getSheetsClient();
    
    // Obtener todas las solicitudes de préstamos
    try {
      const loansResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'SolicitudesPrestamos!A2:I', // Incluir columna de interés
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

      // Si se especifica groupId, filtrar por grupo
      if (groupId) {
        pendingLoans = pendingLoans.filter(loan => loan.group === groupId);
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
app.post('/api/approve-loan-request', async (req, res) => {
  try {
    const { loanId, action, adminEmail, notes } = req.body; // action: 'approve' or 'reject'
    
    if (!loanId || !action || !adminEmail) {
      return res.status(400).json({ 
        success: false, 
        message: 'Faltan parámetros requeridos: loanId, action, adminEmail' 
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
      range: 'SolicitudesPrestamos!A2:I',
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
    
    // Actualizar el status y aprobador
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `SolicitudesPrestamos!F${actualRowIndex}:I${actualRowIndex}`, // Columnas F-I
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          newStatus,           // Status (F)
          loanData[6] || '',   // Date (G) - mantener
          notes || '',         // Detalles (H) - actualizar con notas
          adminEmail           // AprobadoPor (I)
        ]]
      }
    });

    // Si se aprueba, crear la transacción de préstamo
    if (action === 'approve') {
      const transactionData = [
        Date.now().toString(),    // TransactionID
        loanData[1],             // UserEmail
        'loan',                  // Type
        Number(loanData[4]),     // Amount
        `Préstamo aprobado - ${notes || ''}`, // Description
        new Date().toISOString(), // Date
        'loan',                  // Category
        '💰'                     // Icon
      ];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Transactions!A:H',
        valueInputOption: 'RAW',
        requestBody: {
          values: [transactionData]
        }
      });
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
app.post('/api/approve-payment', async (req, res) => {
  try {
    const { paymentId, action, adminEmail, notes } = req.body; // action: 'approve' or 'reject'
    
    if (!paymentId || !action || !adminEmail) {
      return res.status(400).json({ 
        success: false, 
        message: 'Faltan parámetros requeridos: paymentId, action, adminEmail' 
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
    
    // Actualizar el status, aprobador, fecha y notas
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `LoanPayments!G${actualRowIndex}:O${actualRowIndex}`, // Columnas G-O
      valueInputOption: 'RAW',
      requestBody: {
        values: [[
          newStatus,      // Status (G)
          rows[paymentRowIndex][7] || '', // ImageFilename (H) - mantener
          rows[paymentRowIndex][8] || '', // OriginalImageName (I) - mantener  
          rows[paymentRowIndex][9] || '', // ImagePath (J) - mantener
          rows[paymentRowIndex][10] || '', // ImageSize (K) - mantener
          rows[paymentRowIndex][11] || '', // CreatedAt (L) - mantener
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
    const { email, groupId, tipo, monto, descripcion, meta } = req.body;
    
    if (!email || !groupId || !tipo || !monto) {
      return res.status(400).json({ 
        success: false, 
        message: 'Faltan campos requeridos: email, groupId, tipo, monto' 
      });
    }

    if (isNaN(Number(monto)) || Number(monto) <= 0) {
      return res.status(400).json({ 
        success: false, 
        message: 'El monto debe ser un número válido mayor a 0' 
      });
    }

    const result = await savingsService.addSaving(SPREADSHEET_ID, {
      email,
      groupId,
      tipo,
      monto,
      descripcion,
      meta
    });

    console.log(`[ADD SAVING] Ahorro agregado: ${result.savingId} por ${email} - $${monto}`);
    
    res.json({ 
      success: true, 
      message: 'Ahorro registrado correctamente',
      savingId: result.savingId
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
    const { email, groupId } = req.query;
    
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
    res.status(500).json({ 
      success: false, 
      message: 'Error al obtener ahorros: ' + error.message 
    });
  }
});

// GET /api/savings/stats - Obtener estadísticas completas (ahorros + acciones)
app.get('/api/savings/stats', async (req, res) => {
  try {
    const { email, groupId } = req.query;
    
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
      
      console.log(`[INTERESES ACCIONES] Lote ${index}: ${cantidad} acciones × $${valorAccion} = $${cantidad * valorAccion} @ ${(tasaAnual*100).toFixed(2)}% anual`);
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
        
        // Base actual del lote (con capitalización si aplica)
        const baseLote = CONFIG.capitalizaMensual ? lote.baseCapitalizada : lote.valorInversion;
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
      
      // 6. INTERÉS DEL MES
      const interesMes = baseDevengable * tasaMensual;
      
      // 7. CAPITALIZACIÓN SI APLICA
      if (CONFIG.capitalizaMensual) {
        lotes.forEach(lote => {
          if (lote.mesCompra < mesActual) {
            const proporcion = lote.baseCapitalizada / baseDevengable;
            const interesLote = interesMes * proporcion;
            lote.baseCapitalizada += interesLote;
            lote.interesAcumulado += interesLote;
          }
        });
      } else {
        // Interés simple: solo acumular para registro
        lotes.forEach(lote => {
          if (lote.mesCompra < mesActual) {
            const proporcion = lote.valorInversion / baseDevengable;
            const interesLote = interesMes * proporcion;
            lote.interesAcumulado += interesLote;
          }
        });
      }
      
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
      
      console.log(`[INTERESES ACCIONES] ${mesActual}: ${lotesActivos} lotes activos, base $${baseDevengable.toFixed(2)} @ ${(tasaMensual*100).toFixed(3)}% → $${interesMes.toFixed(2)}`);
      
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
  const añosDiff = fechaFin.getFullYear() - fechaInicio.getFullYear();
  const mesesDiff = fechaFin.getMonth() - fechaInicio.getMonth();
  return añosDiff * 12 + mesesDiff;
}

// GET /api/savings/complete - Obtener resumen completo del patrimonio
app.get('/api/savings/complete', async (req, res) => {
  try {
    const { email, groupId } = req.query;
    console.log(`[SAVINGS COMPLETE] Iniciando para email: ${email}, groupId: ${groupId}`);
    
    if (!email) {
      return res.status(400).json({ 
        success: false, 
        message: 'Se requiere el parámetro email' 
      });
    }

    // Obtener datos directamente usando la conexión principal (sin savingsService por ahora)
    console.log('[GET COMPLETE SAVINGS] Obteniendo datos para:', email, groupId);
    
    // Obtener ahorros directamente
    let totalAhorros = 0;
    let historialAhorros = [];
    try {
      const ahorrosResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Savings!A:G'
      });
      
      const ahorrosRows = ahorrosResponse.data.values || [];
      console.log(`[GET COMPLETE SAVINGS] Obtenidas ${ahorrosRows.length} filas de ahorros`);
      console.log(`[GET COMPLETE SAVINGS] Headers:`, ahorrosRows[0]);
      console.log(`[GET COMPLETE SAVINGS] Buscando email: ${email}, groupId: ${groupId}`);
      
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
        
        historialAhorros = ahorrosRows.slice(1)
          .filter(row => {
            const emailMatch = row[emailIndex] === email;
            const groupMatch = !groupId || row[groupIndex] === groupId;
            console.log(`[GET COMPLETE SAVINGS] Fila: ${row[emailIndex]} === ${email} ? ${emailMatch}, Group: ${row[groupIndex]} === ${groupId} ? ${groupMatch}`);
            return emailMatch && groupMatch;
          })
          .map(row => ({
            fecha: row[dateIndex] || '',
            monto: Number(row[amountIndex]) || 0,
            tipo: row[typeIndex] || 'mensual',
            descripcion: row[6] || ''
          }));
          
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
    
    try {
      const accionesResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: 'Acciones!A:G'
      });
      
      const accionesRows = accionesResponse.data.values || [];
      console.log(`[GET COMPLETE SAVINGS] Obtenidas ${accionesRows.length} filas de acciones`);
      
      if (accionesRows.length > 1) {
        const headers = accionesRows[0];
        const emailIndex = headers.findIndex(h => h.toLowerCase().includes('email'));
        const groupIndex = headers.findIndex(h => h.toLowerCase().includes('group'));
        const sharesIndex = headers.findIndex(h => h.toLowerCase().includes('shares'));
        const valueIndex = headers.findIndex(h => h.toLowerCase().includes('value'));
        const dateIndex = headers.findIndex(h => h.toLowerCase().includes('date'));
        
        const accionesFiltradas = accionesRows.slice(1)
          .filter(row => row[emailIndex] === email && (!groupId || row[groupIndex] === groupId))
          .map(row => ({
            fecha: row[dateIndex] || '',
            cantidad: Number(row[sharesIndex]) || 0,
            valorAccion: Number(row[valueIndex]) || 0,
            tasaInteres: Number(row[5]) || 0,
            total: (Number(row[sharesIndex]) || 0) * (Number(row[valueIndex]) || 0)
          }));

        // Calcular intereses con sistema normativo de cooperativa
        const interesesResult = calcularUtilidadesProgresivas(accionesFiltradas);
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
      // === INFORMACIÓN DEL SISTEMA NORMATIVO ===
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
    const { email, groupId } = req.query;
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
      range: 'Shares!A:F'
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

    // Filtrar acciones del usuario
    const accionesFiltradas = accionesRows.slice(1)
      .filter(row => {
        const emailMatch = row[0] === email;
        const groupMatch = !groupId || row[1] === groupId;
        return emailMatch && groupMatch && row[2] && Number(row[2]) > 0;
      })
      .map(row => ({
        fecha: row[4] || '',
        cantidad: Number(row[2]) || 0,
        valorAccion: Number(row[3]) || 0,
        tasaInteres: Number(row[5]) || 0
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
        capitalización: interesesResult.configuracion.capitalizaMensual ? 'ACTIVADA' : 'DESACTIVADA',
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
      email, 
      groupId, 
      nombre, 
      montoObjetivo, 
      fechaObjetivo, 
      descripcion, 
      prioridad, 
      categoria 
    } = req.body;
    
    if (!email || !groupId || !nombre || !montoObjetivo || !fechaObjetivo) {
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
    const { email, groupId } = req.query;
    
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
