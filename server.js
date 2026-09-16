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

// --- Cabeceras de seguridad ---
// Sin esto la app se podia enmarcar en una pagina ajena (clickjacking): montar
// un iframe invisible encima de otra cosa y conseguir que alguien pulse
// "aprobar prestamo" creyendo que pulsa otro boton.
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // La API solo devuelve JSON e imagenes de comprobantes: nada que ejecutar
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

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

/**
 * Estado y rol REALES de una persona, leidos de la hoja.
 *
 * El token dura 30 dias y no se puede revocar: dar de baja a alguien o quitarle
 * el rol de administrador no le quitaba nada hasta que caducara. Medido: una
 * socia dada de baja siguio registrando ahorros en la caja del grupo, y un
 * administrador degradado a socio conservo el poder de listar a todo el mundo
 * con sus datos personales y de desactivar cuentas ajenas.
 *
 * La lectura pasa por la memoria corta de ./hoja, asi que en la practica es una
 * lectura de la hoja Users cada doce segundos para toda la plataforma.
 */
async function estadoRealDelUsuario(email) {
  const correo = normalizeEmailKey(email);
  if (!correo) return null;
  const cliente = await getSheetsClient();
  const resp = await cliente.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:I',
  });
  const filas = resp.data.values || [];
  const fila = filas.find((r) => normalizeEmailKey(r[1]) === correo);
  if (!fila) return null;
  const estado = (fila[8] || 'activo').toString().trim().toLowerCase();
  return {
    existe: true,
    activo: estado !== 'inactivo',
    rol: normalizeGlobalRole(fila[3]) === 'admin' ? 'admin' : 'member',
  };
}

async function requireAuth(req, res, next) {
  const payload = decodeToken(req);
  if (!payload || !payload.email) {
    return res.status(401).json({ message: 'No autorizado. Inicia sesion nuevamente.' });
  }
  const email = payload.email.toString().trim().toLowerCase();
  req.user = { email, role: (payload.role || 'member') };
  // El freno de lecturas reparte la cuota POR PERSONA: sin esto, una sola
  // cuenta recargando pantallas pesadas dejaba sin servicio a las demas. El
  // administrador de la plataforma va con su propio tope, mas alto: sus
  // pantallas agregan todo y con el de una socia no le alcanzaba ni para dar
  // una vuelta al panel.
  hojaEnNombreDe(email, req.user.role === 'admin');

  // Si no se puede comprobar (la hoja no responde) se sigue con lo que dice el
  // token: dejar a todo el mundo fuera por un fallo de lectura seria peor.
  try {
    const real = await estadoRealDelUsuario(email);
    if (real && !real.activo) {
      return res.status(401).json({
        message: 'Tu cuenta esta desactivada. Contacta a la directiva de tu grupo.',
        codigo: 'CUENTA_DESACTIVADA',
      });
    }
    if (real) req.user.role = real.rol;
  } catch (e) {
    if (responderSiEsCuota(res, e)) return;
    console.error('[AUTH] no se pudo comprobar el estado del usuario:', e.message);
  }
  next();
}

async function optionalAuth(req, res, next) {
  const payload = decodeToken(req);
  if (payload && payload.email) {
    const email = payload.email.toString().trim().toLowerCase();
    req.user = { email, role: (payload.role || 'member') };
    // El rol tambien aqui: sin esto, un admin degradado seguia creando usuarios
    // con el rol que quisiera desde el registro publico.
    try {
      const real = await estadoRealDelUsuario(email);
      if (real && !real.activo) delete req.user;
      else if (real) req.user.role = real.rol;
    } catch (e) {
      console.error('[AUTH] no se pudo comprobar el estado del usuario:', e.message);
    }
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
// Ya no hay rutas publicas por prefijo. La foto del comprobante era la unica,
// y ahora la autoriza su propia direccion firmada (ver /api/payment-image).
// Registro: autenticacion opcional (un admin con token puede crear con rol; el publico crea 'member')
const OPTIONAL_AUTH_PATHS = new Set(['/api/registrar-usuario-en-sheet']);

// Gate global: por defecto todo exige token (default-deny)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  const p = req.path;
  if (PUBLIC_EXACT_PATHS.has(p)) return next();
  // La foto del comprobante se muestra con <img src> en la pantalla de la
  // tesoreria y se abre en otra pestana desde el historial. Ni la etiqueta
  // <img> ni una pestana nueva mandan la cabecera Authorization, asi que la
  // autorizacion viaja firmada dentro de la propia direccion y la comprueba el
  // endpoint. Sin firma, se exige el token de siempre.
  if (p.startsWith('/api/payment-image/')) {
    if (req.query && req.query.firma) return next();
    return requireAuth(req, res, next);
  }
  if (OPTIONAL_AUTH_PATHS.has(p)) return optionalAuth(req, res, next);
  return requireAuth(req, res, next);
});

// ---------------------------------------------------------------------------
//  Cuantas veces se usa la app de verdad
// ---------------------------------------------------------------------------
// Antes solo se anotaba el inicio de sesion, y la sesion dura 30 dias: quien
// abria la app todos los dias figuraba con UNA entrada al mes. Con eso, las
// entradas, los activos de la semana, la retencion y la curva del informe no
// median el uso, median los logins.
//
// Ahora, cuando alguien vuelve a pedir algo despues de media hora callado, se
// anota una entrada de tipo 'vuelta'. La cuenta de quien esta activo se lleva
// en memoria: si el servidor se reinicia se pierde y como mucho se anota una
// entrada de mas por persona, que es un precio barato por no leer la hoja en
// cada peticion.
const ultimaActividad = new Map();

function anotarVuelta(req) {
  const email = req.user && req.user.email;
  if (!email) return;
  const ahora = Date.now();
  const antes = ultimaActividad.get(email) || 0;
  if (ahora - antes < acc.MINUTOS_DE_SESION * 60 * 1000) {
    ultimaActividad.set(email, ahora);
    return;
  }
  ultimaActividad.set(email, ahora);
  // Sin await: la estadistica no puede hacer esperar a nadie, ni tumbar la
  // peticion si la hoja falla.
  (async () => {
    try {
      const sheetsClient = await getSheetsClient();
      await ensureSheetExists(acc.HOJA, acc.CABECERA, sheetsClient, SPREADSHEET_ID);
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${acc.HOJA}!A:H`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [acc.filaDeAcceso(
            email,
            req.headers['user-agent'],
            (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip,
            new Date().toISOString(),
            'vuelta',
          )],
        },
      });
    } catch (e) {
      // Silencio a proposito: ya se avisa en el log del servidor si hace falta
    }
  })();
}

app.use((req, res, next) => {
  // El propio login ya anota su entrada; no se cuenta dos veces
  if (req.path !== '/api/login') anotarVuelta(req);
  next();
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
    // Manda el ULTIMO separador: es el decimal. Antes se suponia siempre que el
    // punto era de miles, asi que "1,234.56" (formato anglosajon, el que sale
    // de exportar desde muchas herramientas) se leia como 1,23456: $1.234,56
    // convertidos en un dolar con veintitres.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(',', '.');   // 1.234,56
    } else {
      s = s.replace(/,/g, '');                      // 1,234.56
    }
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
const BACKEND_VERSION = '2026.09.16-demo-reglamento';

let gobApi = null;

/**
 * Decide con que estado nace un aporte (ahorro o compra de acciones).
 * Regla: si el grupo exige aprobacion, el aporte que registra el propio socio
 * nace PENDIENTE y solo la tesoreria (u otro lider) lo confirma. Asi nadie se
 * atribuye un patrimonio que no entrego.
 */
/**
 * Estado con el que nace un aporte.
 *
 * La regla del control interno es "quien registra no confirma", y esta bien:
 * impide que una sola persona mueva dinero sin que nadie mas lo vea. Pero en un
 * grupo con UN SOLO directivo no hay segunda firma posible, y el aporte de esa
 * persona se quedaba pendiente para siempre: no se podia confirmar, ni
 * rechazar, ni revertir, y apagar la regla tampoco liberaba lo ya atrapado.
 *
 * Asi que la regla se aplica cuando de verdad hay alguien mas que pueda firmar.
 * Si quien registra es el unico directivo activo, su aporte nace confirmado y
 * se deja dicho por que. Los aportes de los demas socios siguen necesitando la
 * firma del directivo, que es donde el control si sirve para algo.
 */
async function estadoInicialAporte(groupId, registrante) {
    try {
        if (!gobApi) return 'confirmado';
        const reglas = await gobApi.getReglas(groupId);
        if (!reglas.requiereAprobacionAportes) return 'confirmado';

        const correo = normalizeEmailKey(registrante);
        if (correo) {
            const rol = await getUserGroupRole(correo, groupId);
            const esDirectivo = GROUP_LEADER_ROLES.has(normalizeGroupRole(rol));
            if (esDirectivo && (await getActiveLeaderCount(groupId)) <= 1) {
                return 'confirmado_sin_segunda_firma';
            }
        }
        return 'pendiente';
    } catch (e) {
        // Ante cualquier fallo se elige el lado seguro: queda pendiente de revision.
        console.error('[GOB] no se pudo leer el reglamento, el aporte queda pendiente:', e.message);
        return 'pendiente';
    }
}

/**
 * El estado anterior lleva dentro el motivo. La hoja solo entiende
 * 'pendiente' | 'confirmado' | 'rechazado', asi que aqui se separan.
 */
function partirEstadoAporte(estado) {
    if (estado === 'confirmado_sin_segunda_firma') {
        return {
            estado: 'confirmado',
            nota: 'Confirmado sin segunda firma: el grupo todavia no tiene tesoreria.',
            motivo: 'sin_tesoreria',
        };
    }
    return { estado, nota: '', motivo: '' };
}

const nuevoMovId = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

/** Estados de un comprobante que YA se resolvieron. Todo lo demas esta por revisar. */
const RESUELTOS_DE_PAGO = new Set([
  'approved', 'aprobado', 'rejected', 'rechazado', 'anulado', 'cancelado',
]);

/**
 * Identificador de un movimiento a partir de la CLAVE que manda el telefono.
 *
 * Con datos moviles la peticion llega y la respuesta se pierde: la app dice
 * "error de conexion" y la persona vuelve a pulsar. Sin esto se grababa el
 * aporte dos veces y su ahorro del mes contaba doble en la caja del grupo.
 *
 * La clave la genera el telefono UNA vez por formulario, asi que un reenvio del
 * mismo envio produce el mismo identificador y el servidor reconoce que ya lo
 * tiene. Va mezclada con el correo para que nadie pueda chocar a proposito con
 * el movimiento de otra persona.
 */
function movIdDeClave(prefijo, email, clave) {
  const limpia = (clave == null ? '' : clave).toString().trim().slice(0, 80);
  if (!limpia) return '';
  const huella = crypto.createHash('sha256')
    .update(`${normalizeEmailKey(email)}|${limpia}`)
    .digest('hex')
    .slice(0, 20);
  return `${prefijo}_${huella}`;
}

/** Busca un movimiento ya registrado con ese identificador. */
async function movimientoYaRegistrado(hojaNombre, ultimaCol, colMovId, movId) {
  if (!movId) return null;
  try {
    const cliente = await getSheetsClient();
    const resp = await cliente.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${hojaNombre}!A2:${ultimaCol}`,
    });
    const filas = resp.data.values || [];
    const i = filas.findIndex((r) => (r[colMovId] || '').toString().trim() === movId);
    return i >= 0 ? filas[i] : null;
  } catch (e) {
    return null;
  }
}

// El mismo mensaje tanto si el correo no existe como si la clave esta mal.
// Distinguirlos permitia averiguar quien tiene cuenta en la plataforma solo
// probando correos, que en un piloto con nombres y apellidos reales es un dato
// que no hay que regalar.
const CREDENCIALES_INVALIDAS = 'Correo o contraseña incorrectos.';

// Freno a los intentos de entrada. Sin esto se podian probar claves sin limite:
// medido, 200 intentos seguidos, ninguno frenado. No hace falta nada externo:
// el servidor corre en una sola instancia, asi que basta con contarlos aqui.
const INTENTOS_MAX = 8;
const VENTANA_INTENTOS_MS = 15 * 60 * 1000;
const intentosFallidos = new Map();

function laveDeIntento(req, email) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
  return `${ip}|${(email || '').toString().trim().toLowerCase()}`;
}

/** Devuelve los segundos que faltan si esta frenado, o 0 si puede intentarlo. */
function esperaPorIntentos(req, email) {
  const reg = intentosFallidos.get(laveDeIntento(req, email));
  if (!reg) return 0;
  if (Date.now() - reg.desde > VENTANA_INTENTOS_MS) return 0;
  if (reg.veces < INTENTOS_MAX) return 0;
  return Math.ceil((VENTANA_INTENTOS_MS - (Date.now() - reg.desde)) / 1000);
}

function anotarFallo(req, email) {
  const clave = laveDeIntento(req, email);
  const reg = intentosFallidos.get(clave);
  if (!reg || Date.now() - reg.desde > VENTANA_INTENTOS_MS) {
    intentosFallidos.set(clave, { veces: 1, desde: Date.now() });
  } else {
    reg.veces += 1;
  }
  // La tabla no puede crecer sin fin
  if (intentosFallidos.size > 5000) {
    const limite = Date.now() - VENTANA_INTENTOS_MS;
    for (const [k, v2] of intentosFallidos) if (v2.desde < limite) intentosFallidos.delete(k);
  }
}

function olvidarFallos(req, email) {
  intentosFallidos.delete(laveDeIntento(req, email));
}

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
const crypto = require('crypto');
const { conBloqueo } = require('./lock');
const { envolver: envolverHoja, enNombreDe: hojaEnNombreDe } = require('./hoja');
const { actualizarFilaPorClave } = require('./escritura');
const { esDeCuota: errorDeCuota } = require('./hoja');

/**
 * Si el fallo es por haber agotado la cuota de lecturas de Google, se responde
 * 429 con la explicacion, no 500 "Error interno". No es un fallo del programa:
 * hay que esperar unos segundos. Devuelve true si ya respondio.
 */
function responderSiEsCuota(res, error) {
  if (!errorDeCuota(error) && error?.motivo !== 'cuota_hoja') return false;
  res.status(429).json({
    success: false,
    motivo: 'cuota_hoja',
    message: 'La hoja de calculo esta recibiendo demasiadas consultas ahora mismo. '
           + 'Espera unos segundos y vuelve a intentarlo.',
    reintentarEn: 30,
  });
  return true;
}

// Cabeceras de la hoja de comprobantes de pago. Se declaran aqui para que tanto
// el modulo de control interno como este puedan ASEGURAR que la pestana existe
// antes de leerla: si no existe y se lee sin mas, un catch ponia los pagos a
// cero y el saldo del prestamo volvia al total.
const LOAN_PAYMENTS_HEADERS = [
  'PaymentID', 'UserEmail', 'LoanID', 'Amount', 'PaymentDate',
  'Description', 'Status', 'ImageFilename', 'OriginalImageName',
  'ImagePath', 'ImageSize', 'CreatedAt', 'ApprovedBy',
  'ApprovalDate', 'ApprovalNotes',
];

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

/**
 * Si un vinculo usuario-grupo sigue vivo.
 *
 * La lista de lo que cuenta como BAJA es explicita, y todo lo demas se toma por
 * activo. Es a proposito: dejar a una socia fuera de su propio grupo por una
 * palabra mal escrita en la hoja es mucho peor que seguir contando a alguien
 * que ya se fue. Antes solo la palabra exacta 'inactivo' daba de baja, asi que
 * 'baja' o 'retirado' no cerraban ninguna puerta.
 */
const ESTADOS_DE_BAJA = new Set([
  'inactivo', 'inactiva', 'baja', 'de baja', 'retirado', 'retirada',
  'eliminado', 'eliminada', 'suspendido', 'suspendida', 'salio', 'salió',
  'no', 'false', 'falso', '0',
]);
function vinculoVivo(estado) {
  const e = (estado == null ? '' : estado).toString().trim().toLowerCase();
  if (!e) return true;
  return !ESTADOS_DE_BAJA.has(e);
}

/**
 * Como `userBelongsToGroupSafe`, pero para LEER: en un grupo ya cerrado deja
 * pasar a quien estuvo dentro. Escribir sigue estando cortado en el mismo sitio
 * de siempre; esto solo abre el historial a su duena.
 */
async function puedeLeerElGrupo(sheetsClient, userEmail, groupId) {
  if (await userBelongsToGroupSafe(sheetsClient, userEmail, groupId)) return true;
  if (!(await estuvoEnElGrupo(userEmail, groupId))) return false;
  return grupoDadoDeBaja(groupId);
}

async function userBelongsToGroupSafe(sheetsClient, userEmail, groupId) {
  const normalizedEmail = normalizeEmailKey(userEmail);
  const normalizedGroupId = normalizeGroupKey(groupId);

  if (!normalizedEmail || !normalizedGroupId) return false;

  const linksResp = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: 'UserGroupLinks!A2:E',
  });

  const links = linksResp.data.values || [];
  // El Estado del vinculo cuenta: marcar a alguien como inactivo o de baja no
  // le cerraba ninguna puerta. Seguia viendo el panel del grupo y registrando
  // ahorros en una caja de la que ya no forma parte.
  return links.some((row) => (
    normalizeEmailKey(row?.[0]) === normalizedEmail
    && normalizeGroupKey(row?.[1]) === normalizedGroupId
    && vinculoVivo(row?.[4])
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
    // Los grupos dados de baja no se listan: la pantalla del socio los seguia
    // mostrando y dejando entrar, mientras la de administracion los daba por
    // borrados. Dos pantallas, dos verdades.
    const dadosDeBaja = new Set(allGroups
      .filter((row) => (row[11] || '').toString().trim().toLowerCase() === 'eliminado')
      .map((row) => (row[0] || '').toString().trim()));

    const result = userGroups
      .filter((g) => !dadosDeBaja.has((g.groupId || '').toString().trim()))
      .map(g => {
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
        PorcentajeInteresMensual: found ? (found[16] || '') : '',
        // El ciclo del grupo: la directiva los edita en su propia pantalla, asi
        // que tienen que llegarle para poder rellenar el formulario.
        // 6=TargetAmount, 8=MonthlyContribution, 9=StartDate, 10=EndDate, 12=MaxMembers
        TargetAmount: found ? (found[6] || '') : '',
        MonthlyContribution: found ? (found[8] || '') : '',
        StartDate: found ? (found[9] || '') : '',
        EndDate: found ? (found[10] || '') : '',
        MaxMembers: found ? (found[12] || '') : ''
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

    const pertenece = await puedeLeerElGrupo(sheets, normalizedUserEmail, normalizedGroupId);
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
    if (responderSiEsCuota(res, err)) return;
    return res.status(500).json({ error: 'Error interno al obtener acciones' });
  }
});

// POST /api/registrar-acciones
app.post('/api/registrar-acciones', bloquear((r) => (
  `compra:${normalizeEmailKey(r.user && r.user.email)}:${(r.body && r.body.clave) || Math.random()}`
)), async (req, res) => {
  try {
    const { groupId, date, shares } = req.body;
    // Un aporte se registra SIEMPRE a nombre de quien lo manda, sin excepcion
    // para el administrador: si el dueno de la plataforma pudiera meter compras
    // de acciones a nombre de un socio, el rastro del dinero deja de valer.
    const userEmail = req.user.email;
    if (!groupId || !userEmail || !date || typeof shares !== 'number') {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }
    if (!Number.isFinite(shares) || shares <= 0) {
      return res.status(400).json({ error: 'La cantidad de acciones debe ser un numero mayor que cero.' });
    }

    // El precio de la accion y el interes NO los pone quien compra: los pone el
    // grupo. Antes se grababa lo que mandara el cliente, asi que un socio podia
    // comprar acciones a un centavo o adjudicarse un 99 % de interes, y la
    // configuracion del grupo quedaba de adorno.
    const cfg = await configuracionDelGrupo(groupId);
    if (!cfg.valorConfigurado) {
      return res.status(400).json({
        error: 'El grupo no tiene fijado el valor de cada accion, asi que no se puede calcular la compra. '
             + 'La presidencia debe establecerlo en Mas > Reglamento del grupo.',
        motivo: 'valor_accion_sin_configurar',
      });
    }
    const shareValue = cfg.valorAccion;
    const interestRate = cfg.tasaConfigurada ? cfg.tasaMensual : 0;

    // Si el cliente mando cifras distintas de las del grupo, se le avisa en vez
    // de aceptarlas en silencio: normalmente es una pantalla con datos viejos.
    const pedidoValor = Number(req.body.shareValue);
    if (Number.isFinite(pedidoValor) && Math.abs(pedidoValor - shareValue) > 0.005) {
      return res.status(409).json({
        error: `El valor de la accion del grupo es $${shareValue}, no $${pedidoValor}. `
             + 'Vuelve a abrir la pantalla para tomar la cifra actualizada.',
        motivo: 'valor_accion_desactualizado',
        valorAccion: shareValue,
        interesMensual: interestRate,
      });
    }
    const pedidoTasa = Number(req.body.interestRate);
    if (Number.isFinite(pedidoTasa) && Math.abs(pedidoTasa - interestRate) > 0.005) {
      return res.status(409).json({
        error: `El interes mensual del grupo es ${interestRate}%, no ${pedidoTasa}%. `
             + 'Vuelve a abrir la pantalla para tomar la cifra actualizada.',
        motivo: 'interes_desactualizado',
        valorAccion: shareValue,
        interesMensual: interestRate,
      });
    }
    if (shares * shareValue > MONTO_MAXIMO || shares > 1000000) {
      return res.status(400).json({ error: 'Los valores de la compra estan fuera de rango. Revisa la cifra.' });
    }
    const sheets = await getSheetsClient();
    // Sin excepcion para el administrador de la plataforma: aportar en un grupo
    // al que no perteneces es mover su caja, aunque sea bajo tu propio nombre.
    if (!(await userBelongsToGroupSafe(sheets, userEmail, groupId))) {
      return res.status(403).json({ error: 'No perteneces a este grupo.' });
    }
    if (!(await assertGrupoActivo(req, res, groupId))) return;
    const crudo = await estadoInicialAporte(groupId, req.user.email);
    const { estado: estadoNuevo, nota, motivo } = partirEstadoAporte(crudo);
    const ahoraIso = new Date().toISOString();
    const sinSegundaFirma = motivo === 'sin_tesoreria';
    const movId = movIdDeClave('acc', req.user.email, req.body?.clave) || nuevoMovId('acc');
    const compraRepetida = await movimientoYaRegistrado('Acciones', 'M', 11, movId);
    if (compraRepetida) {
      return res.status(200).json({
        success: true,
        repetido: true,
        movId,
        estado: (compraRepetida[7] || 'confirmado').toString().trim().toLowerCase(),
        message: 'Esta compra ya estaba registrada; no se duplico.',
      });
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Acciones!A:M',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[ userEmail, groupId, sanitizeCell(date, 30), shares, shareValue, interestRate, ahoraIso,
                   estadoNuevo, req.user.email,
                   sinSegundaFirma ? req.user.email : '',
                   sinSegundaFirma ? ahoraIso : '', movId, nota ]]
      }
    });
    res.status(201).json({ success: true, estado: estadoNuevo, motivo, aviso: nota, movId });
  } catch (err) {
    console.error(err);
    if (responderSiEsCuota(res, err)) return;
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
    // Solo los vinculos vivos. Antes devolvia tambien a quien ya se habia dado
    // de baja, asi que "Miembros (6)" contra los 5 del tablero, y la suma de
    // patrimonios individuales no cuadraba con la del grupo.
    const vivo = (estado) => vinculoVivo(estado);
    return rows
      .filter(row => row[1] && row[1] === groupId)
      .filter(row => vivo(row[4]))
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
      const belongs = await puedeLeerElGrupo(sheets, normalizedUserEmail, normalizedGroupId);
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
    if (responderSiEsCuota(res, err)) return;
    return res.status(500).json({ error: 'Error interno al obtener miembros' });
  }
});

// --- MIDDLEWARE ---

// Middleware para loggear absolutamente todas las peticiones, incluso si la ruta no existe o el body es inválido
app.use((req, res, next) => {
    // La firma va enmascarada. Firmar la foto y despues guardar la firma en
    // claro en el log deja el agujero donde estaba, solo que con caducidad:
    // cualquiera con acceso al log abriria el comprobante durante media hora.
    console.log('[GLOBAL LOGGER] Método:', req.method, 'URL:', ocultarFirma(req.url), 'IP:', req.ip, 'Origin:', req.headers.origin, 'User-Agent:', req.headers['user-agent']);
    next();
});

// Middleware para loggear todas las peticiones entrantes (después de cors y express.json)
app.use((req, res, next) => {
  const safeBody = { ...(req.body || {}) };
  for (const k of Object.keys(safeBody)) {
    if (/pass|contrase|password|hashed|token/i.test(k)) safeBody[k] = '***';
  }
  // Igual que en el log de arriba: la firma no se guarda en claro.
  console.log(`[BACKEND REQUEST LOGGER] Method: ${req.method}, URL: ${ocultarFirma(req.url)}, Body: ${JSON.stringify(safeBody)}`);
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
  // Envuelto con el freno y la memoria corta: la hoja es la base de datos y
  // Google corta a las 60 lecturas por minuto. Sin esto, treinta pulsaciones
  // seguidas dejaban la app sin leer para todo el grupo.
  sheets = envolverHoja(google.sheets({ version: 'v4', auth: await auth.getClient() }));
  return sheets;
}

// POST /api/registrar-ahorros
app.post('/api/registrar-ahorros', bloquear((r) => (
  `aporte:${normalizeEmailKey(r.user && r.user.email)}:${(r.body && r.body.clave) || Math.random()}`
)), async (req, res) => {
  try {
    const { groupId, date, amount } = req.body;
    // A nombre de quien lo manda, sin excepcion para el administrador de la
    // plataforma: si pudiera meter ahorros a nombre de un socio, el rastro del
    // dinero del grupo deja de valer como prueba de nada.
    const userEmail = req.user.email;
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
    // Sin excepcion para el administrador de la plataforma: aportar en un grupo
    // al que no perteneces es mover su caja, aunque sea bajo tu propio nombre.
    if (!(await userBelongsToGroupSafe(sheets, userEmail, groupId))) {
      return res.status(403).json({ error: 'No perteneces a este grupo.' });
    }
    if (!(await assertGrupoActivo(req, res, groupId))) return;
    // Convencion canonica de Savings: A=email, B=group, C=amount, D=date, E=type, F=desc
    // y columnas de control interno G..L (estado, quien lo registro, quien lo resolvio...)
    const crudo = await estadoInicialAporte(groupId, req.user.email);
    const { estado: estadoNuevo, nota, motivo } = partirEstadoAporte(crudo);
    const ahoraIso = new Date().toISOString();
    const sinSegundaFirma = motivo === 'sin_tesoreria';
    const movId = movIdDeClave('sav', req.user.email, req.body?.clave) || nuevoMovId('sav');
    const repetido = await movimientoYaRegistrado('Savings', 'L', 10, movId);
    if (repetido) {
      return res.status(200).json({
        success: true,
        repetido: true,
        movId,
        estado: (repetido[6] || 'confirmado').toString().trim().toLowerCase(),
        message: 'Este aporte ya estaba registrado; no se duplico.',
      });
    }
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Savings!A:L',
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[userEmail, groupId, amount, sanitizeCell(date, 30), 'mensual', '', estadoNuevo, req.user.email,
          sinSegundaFirma ? req.user.email : '',
          sinSegundaFirma ? ahoraIso : '', movId, nota]],
      },
    });
    return res.status(200).json({ success: true, estado: estadoNuevo, motivo, aviso: nota, movId });
  } catch (err) {
    console.error('Error en /api/registrar-ahorros:', err);
    if (responderSiEsCuota(res, err)) return;
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
    const pertenece = await puedeLeerElGrupo(sheets, normalizedUserEmail, normalizedGroupId);
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
    if (responderSiEsCuota(res, err)) return;
    return res.status(500).json({ error: 'Error interno al obtener ahorros' });
  }
});

// GET /api/obtener-prestamos?groupId=...&userEmail=...
app.get('/api/obtener-prestamos', async (req, res) => {
  try {
    const normalizedGroupId = normalizeGroupKey(req.query.groupId);
    if (!normalizedGroupId) {
      return res.status(400).json({ error: 'Falta parámetro groupId' });
    }
    // La DIRECTIVA DEL GRUPO ve la cartera entera; una socia, solo la suya.
    // Antes el filtro se abria unicamente para el administrador de la
    // plataforma, y una presidenta es `member` a nivel plataforma: medido, la
    // tesorera pedia los prestamos de su grupo y recibia una lista vacia, asi
    // que en la reunion no tenia con que cobrar. Es el mismo patron que ya
    // usaba /api/obtener-miembros.
    const puedeVerElGrupo = req.user.role === 'admin'
      || await canManageGroup(req.user.email, normalizedGroupId);
    const normalizedUserEmail = puedeVerElGrupo
      ? normalizeEmailKey(req.query.userEmail || '')
      : req.user.email;
    const sheets = await getSheetsClient();
    // Validar que el usuario pertenece al grupo (solo si userEmail está presente)
    if (normalizedUserEmail) {
      const pertenece = await puedeLeerElGrupo(sheets, normalizedUserEmail, normalizedGroupId);
      if (!pertenece) {
        return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
      }
    }
    // Loans real: [A=LoanID, B=UserEmail, C=GroupID, D=AmountApproved, E=StartDate, F=DueDate, G=InterestRate(mensual), H=Status, I=Term, J=Total]
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Loans!A2:K',
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
    const pagosPorPrestamo = {};
    const enRevisionPorPrestamo = {};
    try {
      // Si la pestana no existe todavia (grupo nuevo, nadie ha subido un
      // comprobante) se crea vacia: eso SI es cero pagos. Cualquier otro fallo
      // de lectura se propaga y responde 503, en vez de fingir que no se pago.
      await ensureSheetExists('LoanPayments', LOAN_PAYMENTS_HEADERS, sheets, SPREADSHEET_ID);
      const payResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O' });
      (payResp.data.values || []).forEach((r) => {
        const lid = (r[2] || '').toString().trim();
        const estado = (r[6] || '').toString().trim().toLowerCase();
        if (lid && ['approved', 'aprobado'].includes(estado)) {
          paidByLoan[lid] = (paidByLoan[lid] || 0) + parseMoney(r[3]);
          // Se guarda cada pago con su fecha: hace falta para saber QUE CUOTA
          // cubrio cada uno, no solo cuanto se lleva pagado en total.
          (pagosPorPrestamo[lid] = pagosPorPrestamo[lid] || []).push({
            fecha: r[4] || '', monto: parseMoney(r[3]),
          });
        } else if (lid && ['pending_approval', 'pending', 'pendiente'].includes(estado)) {
          // Lo entregado y sin revisar: el servidor SI lo descuenta al comprobar
          // el tope, asi que la pantalla tiene que poder decirlo. Sin esto,
          // pagar el saldo que la propia pantalla mostraba daba un 400.
          enRevisionPorPrestamo[lid] = (enRevisionPorPrestamo[lid] || 0) + parseMoney(r[3]);
        }
      });
    } catch (e) {
      // NO se puede seguir como si no se hubiera pagado nada. Cuando faltaba la
      // pestana LoanPayments o alguien le corria una columna, este catch dejaba
      // paidByLoan vacio y el saldo del prestamo volvia al total, con HTTP 200:
      // la socia veia $110 de deuda que ya habia pagado, la volvia a pagar, y
      // el grupo cobraba dos veces lo mismo.
      console.error('[OBTENER PRESTAMOS] no se pudieron leer los pagos:', e.message);
      return res.status(503).json({
        error: 'No se pudieron leer los pagos de los prestamos, asi que el saldo que se '
             + 'mostraria seria falso. Revisa que la pestana LoanPayments exista y tenga '
             + 'sus columnas en orden, y vuelve a intentarlo.',
        motivo: 'pagos_ilegibles',
      });
    }

    const loans = filtered.map(row => {
      const principal = parseMoney(row[3]);
      const interestRate = parseMoney(row[6]);
      const term = Number(row[8] || 0);
      // El total PACTADO arma el cuadro de cuotas; la mora se debe aparte, para
      // que un recargo no cambie el valor de todas las cuotas hacia atras.
      const total = parseMoney(row[9]) || principal;
      // Topada en cero: un negativo escrito a mano en la hoja le rebajaba la
      // deuda a la socia sin que nadie lo aprobara.
      const mora = Math.max(0, parseMoney(row[10]) || 0);
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
        totalAPagar: Math.round((total + mora) * 100) / 100,
        totalPactado: total,
        mora: Math.round(mora * 100) / 100,
        paid: Math.round(paid * 100) / 100,
        remainingBalance: Math.max(0, Math.round((total + mora - paid) * 100) / 100),
        // Comprobantes entregados que la tesoreria todavia no ha revisado.
        pagosEnRevision: Math.round(
          (enRevisionPorPrestamo[(row[0] || '').toString().trim()] || 0) * 100) / 100,
        // Cuadro mes a mes: cuanto toca cada cuota, cuales estan saldadas y
        // cuanto hay que poner hoy. Quien paga dos meses de una vez ve las dos
        // cuotas cubiertas, no un saldo suelto sin explicacion.
        ...cuadroDeCuotas(
          { total, term, startDate: row[4] || '' },
          pagosPorPrestamo[(row[0] || '').toString().trim()] || [],
        ),
      };
    });
    return res.status(200).json({ loans });
  } catch (err) {
    console.error('Error en /api/obtener-prestamos:', err);
    if (responderSiEsCuota(res, err)) return;
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
      const pertenece = await puedeLeerElGrupo(sheets, normalizedUserEmail, normalizedGroupId);
      if (!pertenece) {
        return res.status(403).json({ error: 'El usuario no pertenece al grupo solicitado.' });
      }
    }
    // Lo REALMENTE ABONADO al socio, que son las filas de Savings con tipo
    // 'utilidad' que escribe el reparto.
    //
    // Antes esto calculaba `acciones x valor x tasa`: un rendimiento
    // garantizado sobre el capital, que no existe en un banco comunal. El
    // grupo solo reparte lo que COBRO en intereses de prestamos, asi que un
    // socio con $500 en acciones veia "$10 de utilidades" aunque el grupo no
    // hubiera prestado un centavo. Tres pantallas daban tres cifras distintas
    // para el mismo dinero.
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Savings!A2:L',
    });
    const rowsTodas = resp.data.values || [];

    const utilities = rowsTodas
      .filter((r) => (r?.[4] || '').toString().trim().toLowerCase() === 'utilidad')
      .filter((r) => aporteConfirmado(r?.[6]))
      .filter((r) => normalizeGroupKey(r?.[1]) === normalizedGroupId)
      .filter((r) => (!normalizedUserEmail || normalizeEmailKey(r?.[0]) === normalizedUserEmail))
      .map((r) => ({
        userEmail: r[0],
        date: r[3] || '',
        amount: parseMoney(r[2]),
        descripcion: r[5] || '',
      }));

    return res.json({
      utilities,
      // Para que quede claro de donde sale la cifra y nadie la confunda con
      // una proyeccion
      fuente: 'repartos_abonados',
      total: Math.round(utilities.reduce((acc, u) => acc + u.amount, 0) * 100) / 100,
    });
  } catch (err) {
    console.error('Error en /api/obtener-utilidades:', err);
    if (responderSiEsCuota(res, err)) return;
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
            sheets = envolverHoja(google.sheets({ version: 'v4', auth: client }));
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
// Antes solo la palabra exacta 'inactivo' daba de baja: 'baja', 'retirado' o
// cualquier otra cosa que escribiera la directiva contaba como activo.
const linkIsActive = (row) => vinculoVivo(row && row[4]);

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
        // El identificador lo pone el SERVIDOR, nunca el cliente. Aceptarlo del
        // body permitia crear un grupo reutilizando el identificador de otro y
        // quedar como presidente activo de ese grupo ajeno: la caja entera, con
        // poder para invitar complices como tesoreros y resolver aportes. Y
        // cualquier socio ve el identificador de su grupo en su propia
        // direccion web, asi que no hacia falta ser un desconocido.
        group.GroupID = newId('grupo');

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
        if (responderSiEsCuota(res, error)) return;
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
        if (!uRow) {
            // No se crea la invitacion a ciegas: se dice claramente que esa
            // persona todavia no tiene cuenta y que primero debe crearla.
            return res.status(404).json({
                message: `No existe una cuenta con el correo ${invitedEmail}. `
                       + 'Esa persona debe crear su cuenta en la app primero; luego podrás invitarla.',
                motivo: 'sin_cuenta',
                correo: invitedEmail,
            });
        }
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
        if (responderSiEsCuota(res, error)) return;
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
        if (responderSiEsCuota(res, error)) return;
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
        if (responderSiEsCuota(res, error)) return;
        return res.status(500).json({ message: 'Error al responder la invitación.', error: error.message });
    }
});

/**
 * Dar de baja un grupo.
 *
 * Es una baja LOGICA, no un borrado. Antes se quitaba la fila de Groups y sus
 * vinculos, pero los ahorros, las acciones y los prestamos de ese grupo se
 * quedaban en la hoja sin dueño: dinero huerfano que ya no se podia atribuir a
 * nadie ni cuadrar con nada. Y para el proyecto de investigacion, borrar el
 * grupo es perder el caso entero.
 *
 * Asi que el grupo pasa a Estado 'eliminado': desaparece de los listados, nadie
 * puede seguir operando en el, y todo lo que hizo sigue ahi. Si de verdad hay
 * que borrarlo, se hace en la hoja a mano, viendo lo que se lleva por delante.
 */
app.delete('/api/eliminar-grupo/:groupId', requireAdmin, async (req, res) => {
    const groupId = (req.params.groupId || '').toString().trim();
    if (!groupId) {
        return res.status(400).json({ message: 'Se requiere groupId.' });
    }

    try {
        const existente = await groupsService.getGroupById(groupId);
        if (!existente) {
            return res.status(404).json({ message: 'Grupo no encontrado.', groupId });
        }

        await groupsService.updateGroup({ GroupID: groupId, Status: 'eliminado' });
        return res.json({
            message: 'Grupo dado de baja. Sus movimientos se conservan para el historial.',
            groupId,
            baja: 'logica',
        });
    } catch (error) {
        console.error('[ELIMINAR GRUPO] Error:', error.message, error.stack);
        if (responderSiEsCuota(res, error)) return;
        return res.status(500).json({ message: 'Error al dar de baja el grupo.', error: error.message });
    }
});

// --- Endpoint para Login ---
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    console.log(`[LOGIN ENDPOINT] Intento de login para email: ${email}`); // Log del intento

    const espera = esperaPorIntentos(req, email);
    if (espera > 0) {
        return res.status(429).json({
            message: `Demasiados intentos fallidos. Vuelve a probar en ${Math.ceil(espera / 60)} minutos.`,
            reintentarEn: espera,
        });
    }

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
            anotarFallo(req, email);
            return res.status(401).json({ message: CREDENCIALES_INVALIDAS });
        }
        console.log(`[LOGIN ENDPOINT] Usuario encontrado:`, userRow);

        // 2. Comparar la contraseña hasheada
        const hashedPasswordFromSheet = userRow[hashedPasswordColumnIndex];
        // Ahora usamos bcrypt.compareSync para comparar la contraseña en texto plano (password)
        // con el hash almacenado en la hoja (hashedPasswordFromSheet)
        console.log(`[LOGIN ENDPOINT] Comparando contraseña para ${email}. Hash disponible: ${Boolean(hashedPasswordFromSheet)}`);

        // Asincrono: `compareSync` congelaba el unico hilo del servidor mientras
        // calculaba el hash, y con eso bastaba para dejar la app sin responder a
        // nadie mas.
        if (await bcrypt.compare(password, hashedPasswordFromSheet)) {
            olvidarFallos(req, email);
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

            // Se anota el acceso para el seguimiento del proyecto: cuando entra
            // cada persona y desde que aparato. Si falla, el inicio de sesion
            // sigue adelante: no se le va a negar la entrada a alguien porque
            // no se pudo escribir una fila de estadistica.
            try {
              await ensureSheetExists(acc.HOJA, acc.CABECERA, sheets, SPREADSHEET_ID);
              await sheets.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: `${acc.HOJA}!A:H`,
                valueInputOption: 'RAW',
                requestBody: {
                  values: [acc.filaDeAcceso(
                    loginEmail,
                    req.headers['user-agent'],
                    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip,
                    new Date().toISOString(),
                    'login',
                  )],
                },
              });
              ultimaActividad.set(loginEmail, Date.now());
            } catch (errAcceso) {
              console.warn('[ACCESOS] no se pudo registrar el acceso:', errAcceso.message);
            }
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
            anotarFallo(req, email);
            res.status(401).json({ message: CREDENCIALES_INVALIDAS });
        }

    } catch (error) {
        console.error('[LOGIN ENDPOINT] Error durante el login:', error.response ? error.response.data : error.message, error.stack);
        if (responderSiEsCuota(res, error)) return;
        res.status(500).json({ message: 'Error en el servidor durante el login.', error: error.message });
    }
});


// Endpoint para UserGroupLinks
const normalize = (value) => (value || '').toString().trim().toLowerCase();
const normalizeLooseToken = (value) => normalize(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
const VALID_GLOBAL_ROLES = new Set(['admin', 'member']);
const VALID_GROUP_ROLES = new Set(['member', 'presidente', 'tesorero', 'secretario']);
const GROUP_ADMIN_ROLES = new Set(['presidente', 'tesorero']);
// Los tres puestos de los que solo cabe UNA persona por grupo.
const CARGOS_DIRECTIVA = new Set(['presidente', 'tesorero', 'secretario']);

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

    // El administrador de la plataforma NO es gestor de todos los grupos. Antes
    // esta funcion devolvia null ("acceso total") para el admin, y de ahi
    // colgaban canManageGroup y assertGroupManager: con eso una cuenta ajena al
    // grupo podia reescribir su reglamento, cambiar el valor de la accion,
    // resolver aportes y nombrar directiva. Ser dueno de la plataforma no es
    // ser dueno de la caja de nadie. Si el administrador ademas es presidente o
    // tesorero de algun grupo, lo sera por su vinculo, como cualquiera.

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

    // Un grupo CERRADO deja a todo el mundo con el vinculo 'retirada', que es lo
    // correcto: no hay mas aportes ni mas creditos. Pero decirle "no perteneces"
    // a la presidenta que acaba de cerrarlo esconde lo que pasa, y el historial
    // que se prometio conservar se volvia inalcanzable. Quien estuvo dentro
    // puede seguir MIRANDO lo suyo; escribir, no.
    if (await estuvoEnElGrupo(req.user.email, gid) && await grupoDadoDeBaja(gid)) {
        if (req.method === 'GET') return true;
        res.status(409).json({
            success: false,
            motivo: 'grupo_dado_de_baja',
            message: 'Este grupo esta cerrado: ya no admite movimientos. Puedes seguir '
                   + 'consultando todo lo que paso.',
        });
        return false;
    }

    res.status(403).json({ success: false, message: 'No perteneces a este grupo.' });
    return false;
}

/** Si esta persona estuvo alguna vez en el grupo, aunque ya no sea socia. */
async function estuvoEnElGrupo(email, groupId) {
    const correo = normalizeEmailKey(email);
    const gid = normalizeGroupKey(groupId);
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'UserGroupLinks!A2:F',
        });
        return (resp.data.values || []).some((r) => normalizeEmailKey(r[0]) === correo
            && normalizeGroupKey(r[1]) === gid);
    } catch (e) {
        return false;
    }
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
    // El ESTADO del vinculo cuenta. Sin esto, marcar a la presidenta como 'baja'
    // en la hoja no le quitaba nada: medido, seguia cambiando el reglamento
    // (HTTP 200) y convocando asambleas (HTTP 201) del grupo del que ya no
    // formaba parte.
    const found = links.find((row) => (
        normalizeEmailKey(row?.[0]) === email && (row?.[1] || '').toString().trim() === gid
        && vinculoVivo(row?.[4])
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

// Cinco anos. Mas alla de eso deja de ser un prestamo de banco comunal: con
// `plazo=999` salia un credito a 83 anos con cuotas de $0,63.
const PLAZO_MAXIMO_MESES = 60;

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
            await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Loans!A2:K' }),
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
                const total = (parseMoney(r[9]) || parseMoney(r[3]))
                    + Math.max(0, parseMoney(r[10]) || 0);
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
    const term = Math.min(PLAZO_MAXIMO_MESES, parsePlazo(detalles));
    const monthlyRate = await getGroupMonthlyRate(loanGroupId);
    const totalConInteres = Math.round(principal * (1 + (monthlyRate / 100) * term) * 100) / 100;
    // Calendario de verdad, no `setMonth`, que desborda: el 31 de enero mas un
    // mes daba el 3 de MARZO, y la hoja decia una fecha mientras la pantalla de
    // cuotas decia otra sobre el mismo prestamo. `sumarMeses` de cuotas.js ya
    // resuelve el desbordamiento (el 31 de enero + 1 mes es el 28 de febrero).
    const hoyPartes = (() => {
      const d = new Date();
      return { a: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    })();
    const startDate = formatearFecha(hoyPartes);
    let dueDate = '';
    try { dueDate = formatearFecha(sumarMesesFecha(hoyPartes, term)); } catch (e) { dueDate = ''; }
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

/**
 * Configuracion financiera del grupo, leida de una sola vez.
 *
 * Distingue CELDA VACIA de CERO, y esa diferencia importa: una tasa de 0 %
 * puede ser una decision del grupo, pero una celda vacia es que nadie la
 * configuro todavia. Confundirlas hacia que un grupo recien creado prestara
 * gratis sin que nadie se enterara hasta el cierre del ciclo.
 */
async function configuracionDelGrupo(groupId) {
    const gid = (groupId || '').toString().trim();
    const vacia = {
        existe: false, valorAccion: 0, tasaMensual: 0,
        valorConfigurado: false, tasaConfigurada: false,
    };
    if (!gid) return vacia;
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Groups!A2:Q',
        });
        const row = (resp.data.values || []).find((r) => (r[0] || '').toString().trim() === gid);
        if (!row) return vacia;
        const celdaValor = (row[15] == null ? '' : row[15]).toString().trim();
        const celdaTasa = (row[16] == null ? '' : row[16]).toString().trim();
        const valorAccion = parseMoney(celdaValor);
        const tasaMensual = parseMoney(celdaTasa);
        return {
            existe: true,
            valorAccion,
            tasaMensual,
            // Configurado = hay algo escrito Y ese algo es un numero utilizable
            valorConfigurado: celdaValor !== '' && Number.isFinite(valorAccion) && valorAccion > 0,
            tasaConfigurada: celdaTasa !== '' && Number.isFinite(tasaMensual)
                && tasaMensual >= 0 && tasaMensual <= 100,
        };
    } catch (e) {
        return vacia;
    }
}

/**
 * Un grupo dado de baja no admite movimientos.
 *
 * El borrado paso a ser una baja logica (Status='eliminado') para no dejar el
 * dinero huerfano, pero ningun endpoint miraba ese estado: se seguian metiendo
 * ahorros, comprando acciones, pidiendo prestamos y convocando asambleas en una
 * caja que ya estaba cerrada.
 */
async function grupoDadoDeBaja(groupId) {
    const gid = (groupId || '').toString().trim();
    if (!gid) return false;
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Groups!A2:L',
        });
        const row = (resp.data.values || []).find((r) => (r[0] || '').toString().trim() === gid);
        // 'cerrado' es el grupo que la asamblea liquido y repartio. Sin esto
        // seguia aceptando aportes y solicitudes: dinero entrando a una caja
        // que ya se vacio y se repartio entre todas.
        return !!row && ['eliminado', 'cerrado']
            .includes((row[11] || '').toString().trim().toLowerCase());
    } catch (e) {
        return false;   // ante la duda no se bloquea a nadie
    }
}

/**
 * Cuantas socias caben en un grupo y cuantas hay.
 *
 * `MaxMembers` (Groups columna M) estaba en la hoja desde el principio y no lo
 * aplicaba nadie: un grupo con tope de 20 aceptaba la socia 21 sin decir nada.
 */
async function cupoDeSocias(groupId) {
    const gid = normalizeGroupKey(groupId);
    try {
        const sheetsClient = await getSheetsClient();
        const [gruposResp, enlacesResp] = await Promise.all([
            sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID, range: 'Groups!A2:M',
            }),
            sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID, range: 'UserGroupLinks!A2:F',
            }),
        ]);
        const fila = (gruposResp.data.values || [])
            .find((r) => normalizeGroupKey(r[0]) === gid);
        const tope = Math.max(0, Math.trunc(parseMoney(fila ? fila[12] : 0)) || 0);
        const dentro = (enlacesResp.data.values || [])
            .filter((r) => normalizeGroupKey(r[1]) === gid && linkIsActive(r)).length;
        return { tope, dentro, haySitio: tope <= 0 || dentro < tope };
    } catch (e) {
        // Ante la duda no se deja a nadie fuera: el tope es una regla del grupo,
        // no un control de seguridad.
        return { tope: 0, dentro: 0, haySitio: true };
    }
}

/** Corta la peticion con 409 si el grupo esta dado de baja. */
async function assertGrupoActivo(req, res, groupId) {
    if (await grupoDadoDeBaja(groupId)) {
        res.status(409).json({
            success: false,
            error: 'Este grupo esta dado de baja y ya no admite movimientos.',
            message: 'Este grupo esta dado de baja y ya no admite movimientos.',
            motivo: 'grupo_dado_de_baja',
        });
        return false;
    }
    return true;
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
    const estado = partirEstadoAporte(await estadoInicialAporte(groupId, email)).estado;
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
/** Correo de quien presento la solicitud. Sirve para que no se vote a si mismo. */
async function getSolicitudSolicitante(sheetsClient, tipo, solicitudId) {
    const sheetMap = { prestamo: 'SolicitudesPrestamos', accion: 'SolicitudesAcciones', adelanto: 'SolicitudesAdelantos' };
    const sName = sheetMap[tipo];
    if (!sName) return '';
    try {
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: `${sName}!A1:K`,
        });
        const rows = resp.data.values || [];
        if (rows.length < 2) return '';
        const hdr = rows[0].map((h) => (h || '').toString().trim().toLowerCase());
        const idCol = hdr.findIndex((h) => h === 'id');
        const emailCol = hdr.findIndex((h) => h === 'useremail');
        if (idCol === -1 || emailCol === -1) return '';
        const row = rows.find((r, i) => i > 0
            && (r[idCol] || '').toString().trim() === solicitudId.toString().trim());
        return row ? normalizeEmailKey(row[emailCol]) : '';
    } catch (e) {
        return '';
    }
}

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

/**
 * De quien es un prestamo. Hace falta para que nadie apruebe el comprobante de
 * su propia deuda: sin esto, quien lo sube y quien lo revisa podian ser la
 * misma persona y la deuda desaparecia sin que la junta se enterara.
 */
async function duenoDeUnPrestamo(loanId) {
    const id = (loanId || '').toString().trim();
    if (!id) return '';
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Loans!A2:C',
        });
        const fila = (resp.data.values || []).find((r) => (r[0] || '').toString().trim() === id);
        if (fila) return normalizeEmailKey(fila[1]);
        // El pago puede referirse al ID de la solicitud, no al del prestamo.
        const sol = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'SolicitudesPrestamos!A2:C',
        });
        const fs = (sol.data.values || []).find((r) => (r[0] || '').toString().trim() === id);
        return fs ? normalizeEmailKey(fs[1]) : '';
    } catch (e) {
        // Si no se puede saber de quien es, no se inventa un dueno: el resto de
        // los frenos (permiso de grupo, idempotencia) siguen en pie.
        return '';
    }
}

/**
 * Solicitudes de prestamo que esta persona tiene SIN RESOLVER en un grupo.
 *
 * Cuentan igual que un prestamo dado: es dinero comprometido que la junta
 * todavia puede aprobar. Sin mirarlas, se podian dejar tres solicitudes vivas
 * a la vez y ocupar el cupo del grupo entero.
 */
async function solicitudesPendientesDe(userEmail, groupId) {
    const email = normalizeEmailKey(userEmail);
    const gid = normalizeGroupKey(groupId);
    const RESUELTAS = ['aprobado', 'aprobada', 'rechazado', 'rechazada', 'retirada', 'anulada'];
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'SolicitudesPrestamos!A2:G',
        });
        const filas = (resp.data.values || []).filter((r) => (
            normalizeEmailKey(r[1]) === email
            && normalizeGroupKey(r[2]) === gid
            && !RESUELTAS.includes((r[5] || '').toString().trim().toLowerCase())
        ));
        return {
            cuantas: filas.length,
            monto: Math.round(filas.reduce((a, r) => a + parseMoney(r[4]), 0) * 100) / 100,
            ids: filas.map((r) => (r[0] || '').toString().trim()),
        };
    } catch (e) {
        return { cuantas: 0, monto: 0, ids: [] };
    }
}

/** En que estado esta una solicitud, para no votar ni aprobar lo ya resuelto. */
async function getSolicitudEstado(sheetsClient, tipo, solicitudId) {
    const HOJAS = {
        prestamo: 'SolicitudesPrestamos',
        accion: 'SolicitudesAcciones',
        adelanto: 'SolicitudesAdelantos',
    };
    const hoja = HOJAS[(tipo || '').toString().trim().toLowerCase()];
    if (!hoja) return '';
    try {
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: `${hoja}!A2:F`,
        });
        const fila = (resp.data.values || [])
            .find((r) => (r[0] || '').toString().trim() === (solicitudId || '').toString().trim());
        return fila ? (fila[5] || '').toString().trim().toLowerCase() : '';
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

    // El tope de socias que el grupo se puso. Estaba en la hoja y no lo miraba
    // nadie: un grupo con tope de 20 aceptaba la socia 21 sin decir nada.
    const sitio = await cupoDeSocias(normalizedGroupId);
    if (!sitio.haySitio) {
        return {
            ok: false,
            status: 409,
            body: {
                message: `Este grupo tiene un tope de ${sitio.tope} socias y ya son ${sitio.dentro}. `
                       + 'Para que entre alguien mas, la directiva tiene que subir el tope en la '
                       + 'configuracion del grupo.',
                codigo: 'GRUPO_LLENO',
                tope: sitio.tope,
                dentro: sitio.dentro,
            },
        };
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
        if (responderSiEsCuota(res, error)) return;
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
        if (responderSiEsCuota(res, error)) return;
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
        if (responderSiEsCuota(res, error)) return;
        return res.status(500).json({ userGroupLinks: [] });
    }
});


// Endpoint para Loans
// Refactor: Usar loansService y auditLogService
const loansService = require('./services/loansService');
// Alta directa de un prestamo. Estaba reservada al administrador de la
// plataforma y VEDADA a la presidencia del grupo, que es justo al reves de como
// debe ser: el credito lo concede el grupo.
app.post('/api/registrar-prestamo-en-sheet', async (req, res) => {
    try {
        const loan = req.body;
        if (!loan.LoanID || !loan.UserEmail || !loan.GroupID || loan.Amount === undefined) {
            return res.status(400).json({ message: 'Faltan datos del prestamo. Se requieren: LoanID, UserEmail, GroupID, Amount.' });
        }
        if (!(await assertGroupManager(req, res, (loan.GroupID || '').toString().trim()))) return;
        if (!(parseMoney(loan.Amount) > 0)) {
            return res.status(400).json({ message: 'El monto del prestamo debe ser un numero positivo.' });
        }
        const created = await loansService.createLoan(loan);
        res.status(201).json({ message: 'Prestamo registrado en Google Sheet con exito.', data: created });
    } catch (error) {
        console.error('[REGISTRAR PRESTAMO] Error:', error.message);
        if (responderSiEsCuota(res, error)) return;
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
    // A nombre de quien la manda; el administrador tampoco escribe en el libro
    // de otra persona.
    const UserEmail = req.user.email;

    if (!TransactionID || !UserEmail || !Type || Amount === undefined || !Date || !Category) {
        return res.status(400).json({ message: 'Faltan datos de la transacción. Se requieren: TransactionID, Type, Amount, Date, Category.' });
    }

    // El importe TAMBIEN se sanea: era el unico campo de esta fila que se
    // escribia crudo, y `=HYPERLINK("http://malo","x")` quedaba como formula
    // viva. Al abrir la hoja un directivo, se ejecuta.
    const values = [[sanitizeCell(TransactionID, 60), UserEmail, sanitizeCell(Type, 40),
        parseMoney(Amount), sanitizeCell(Description), sanitizeCell(Date, 40),
        sanitizeCell(Category, 40), sanitizeCell(Icon || '', 40)]];
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
        if (responderSiEsCuota(res, error)) return;
        res.status(500).json({ message: 'Error al registrar transacción en Sheet.', error: error.message });
    }
});

const acc = require('./accesos');
const { cuadroDeCuotas, sumarMeses: sumarMesesFecha, formatear: formatearFecha } = require('./cuotas');
const { ensureSheetExists } = require('./sheetsUtils');

// Endpoint para obtener aportes de un grupo
app.get('/api/aportes/:groupId', async (req, res) => {
    try {
        const { groupId } = req.params;
        if (!groupId) {
            return res.status(400).json({ message: 'groupId es requerido.', aportes: [] });
        }
        if (!(await assertGroupMember(req, res, groupId))) return;

        const gid = normalizeGroupKey(groupId);

        // El libro DE VERDAD. Lo que forma el patrimonio del grupo sale de
        // `Savings`, no de la pestaña `Aportes`, que nunca conto para nada.
        const savResp = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Savings!A2:L',
        });
        const aportes = (savResp.data.values || [])
            .filter((row) => normalizeGroupKey(row[1]) === gid)
            // Las utilidades abonadas y las devoluciones al salir no son aportes:
            // son movimientos del grupo hacia la socia, no al reves.
            .filter((row) => !['utilidad', 'retiro_salida']
                .includes((row[4] || '').toString().trim().toLowerCase()))
            .map((row) => ({
                GroupID: row[1] || '',
                Email: row[0] || '',
                Monto: parseMoney(row[2]),
                Fecha: row[3] || '',
                CreatedAt: row[9] || row[3] || '',
                Estado: estadoAporteCell(row[SAVINGS_ESTADO_IDX]),
                cuenta: true,
            }));

        // Y lo que se escribio en la pestaña vieja, marcado. Esconderlo seria
        // borrar de la vista un dinero que alguien creyo haber registrado.
        let historicos = [];
        try {
            const viejos = await sheets.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID, range: 'Aportes!A2:E',
            });
            historicos = (viejos.data.values || [])
                .filter((row) => normalizeGroupKey(row[0]) === gid)
                .map((row) => ({
                    GroupID: row[0] || '',
                    Email: row[1] || '',
                    Monto: parseMoney(row[2]),
                    Fecha: row[3] || '',
                    CreatedAt: row[4] || '',
                    Estado: 'historico',
                    cuenta: false,
                    aviso: 'Se registro en una pestaña que nunca sumo al patrimonio del grupo. '
                         + 'Si el dinero se entrego de verdad, hay que registrarlo otra vez '
                         + 'como ahorro.',
                }));
        } catch (e) {
            historicos = [];   // la pestaña vieja ya no existe: mejor asi
        }

        return res.json({
            aportes: [...aportes, ...historicos],
            cuentanAlPatrimonio: aportes.length,
            soloHistoricos: historicos.length,
        });
    } catch (error) {
        console.error('[APORTES] Error al obtener aportes:', error.message);
        if (responderSiEsCuota(res, error)) return;
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
        // Solo la directiva DEL GRUPO puede registrar a nombre de un miembro. Ser
        // administrador de la plataforma no da ese poder sobre una caja ajena.
        const isPriv = await canManageGroup(req.user.email, (GroupID || '').toString().trim());
        const contributorEmail = isPriv ? Email : req.user.email;
        if (!(await userBelongsToGroupSafe(sheets, contributorEmail, GroupID))) {
            return res.status(403).json({ message: 'El aportante no pertenece a este grupo.' });
        }

        const gid = normalizeGroupKey(GroupID);
        if (!(await assertGrupoActivo(req, res, gid))) return;

        // AL LIBRO DE VERDAD. Antes esto escribia en una pestaña `Aportes` que no
        // sumaba al patrimonio, no daba cupo, no entraba al reparto y no salia en
        // la libreta de nadie: la tesorera creia haberlo guardado y no habia nada.
        const crudo = await estadoInicialAporte(gid, req.user.email);
        const { estado, nota } = partirEstadoAporte(crudo);
        const fecha = sanitizeCell(Fecha, 40);
        const ahora = new Date().toISOString();
        // Derivado del contenido: pulsar dos veces no anota el aporte dos veces.
        const movId = movIdDeClave('sav', contributorEmail,
            `aporte|${gid}|${parseMoney(Monto)}|${fecha}`);
        const yaEstaba = await movimientoYaRegistrado('Savings', 'L', 10, movId);
        if (yaEstaba) {
            return res.status(200).json({
                success: true,
                yaExistia: true,
                estado: (yaEstaba[6] || 'confirmado').toString().trim().toLowerCase(),
                message: 'Ese aporte ya estaba registrado.',
            });
        }

        await sheets.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: 'Savings!A:L',
            valueInputOption: 'USER_ENTERED',
            resource: {
                values: [[
                    contributorEmail, gid, parseMoney(Monto), fecha, 'mensual',
                    sanitizeCell(cuerpoAporte.Descripcion || cuerpoAporte.descripcion
                        || 'Aporte registrado en la reunion', 200),
                    estado, req.user.email, estado === 'confirmado' ? req.user.email : '',
                    ahora, movId, sanitizeCell(nota || '', 200),
                ]],
            },
        });

        return res.status(201).json({
            success: true,
            estado,
            movId,
            message: estado === 'pendiente'
                ? 'Aporte registrado. Queda PENDIENTE hasta que la tesoreria confirme que '
                + 'recibio el dinero: hasta entonces no suma al patrimonio.'
                : 'Aporte registrado y sumado al patrimonio del grupo.',
        });
    } catch (error) {
        console.error('[APORTES] Error al registrar aporte:', error.message);
        if (responderSiEsCuota(res, error)) return;
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

        if (!(await assertGrupoActivo(req, res, userGroup))) return;

        // --- CONTROL INTERNO: reglamento del grupo aplicado en el SERVIDOR ---
        // (antes el tope de credito solo se validaba en el frontend, que es evitable)
        if (tipo === 'prestamo' && gobApi) {
            const reglas = await gobApi.getReglas(userGroup);

            // Sin interes fijado no hay prestamo. Medido antes de este freno: la
            // solicitud pasaba, la junta la votaba y el prestamo quedaba escrito
            // al 0 % (InterestRate 0, Total = capital), asi que el grupo prestaba
            // su dinero un ano entero sin ganar nada.
            const cfgGrupo = await configuracionDelGrupo(userGroup);
            if (!cfgGrupo.tasaConfigurada) {
                return res.status(409).json({
                    message: 'El grupo todavia no ha fijado su interes mensual, asi que no se '
                        + 'pueden dar prestamos. La presidencia debe establecerlo en el '
                        + 'reglamento del grupo antes de aprobar creditos.',
                    codigo: 'SIN_TASA',
                });
            }

            // H10: el plazo se valida AQUI, no solo en el navegador. Medido con
            // `plazo=999`: un prestamo a 83 anos con cuotas de $0,63 y un total
            // de $629,40 sobre $30 prestados.
            const plazoPedido = parsePlazo(data.Detalles);
            if (!(plazoPedido >= 1 && plazoPedido <= PLAZO_MAXIMO_MESES)) {
                return res.status(400).json({
                    message: `El plazo tiene que estar entre 1 y ${PLAZO_MAXIMO_MESES} meses.`,
                    codigo: 'PLAZO_INVALIDO',
                });
            }

            const activos = await contarPrestamosActivos(data.UserEmail, userGroup);
            // Una solicitud sin resolver cuenta igual que un prestamo dado: es
            // dinero comprometido. Antes solo se miraba la hoja `Loans`, asi que
            // se podian dejar dos o tres solicitudes vivas a la vez ocupando el
            // cupo del grupo hasta que alguien votara.
            const pendientes = await solicitudesPendientesDe(data.UserEmail, userGroup);
            const comprometidos = activos.cantidad + pendientes.cuantas;
            if (reglas.maxPrestamosActivos > 0 && comprometidos >= reglas.maxPrestamosActivos) {
                return res.status(409).json({
                    message: pendientes.cuantas > 0
                        ? `Ya tienes ${activos.cantidad} prestamo(s) activo(s) y `
                          + `${pendientes.cuantas} solicitud(es) esperando respuesta. El `
                          + `reglamento permite un maximo de ${reglas.maxPrestamosActivos}. `
                          + 'Retira la que ya no quieras o espera a que la junta las resuelva.'
                        : `Ya tienes ${activos.cantidad} prestamo(s) activo(s). El reglamento del grupo permite un maximo de ${reglas.maxPrestamosActivos}.`,
                    codigo: 'MAX_PRESTAMOS_ACTIVOS',
                    prestamosActivos: activos.cantidad,
                    solicitudesPendientes: pendientes.cuantas,
                });
            }

            const ahorro = await gobApi.ahorroConfirmado(data.UserEmail, userGroup);
            // El cupo extraordinario que la asamblea le haya aprobado con aval.
            // Sin esto, quien recien entra no tiene ahorro, no tiene cupo, y es
            // justamente a quien un banco comunal presta con la firma de otra.
            const aval = gobApi.avalVigenteDe
                ? await gobApi.avalVigenteDe(userGroup, data.UserEmail) : null;
            const tope = (ahorro * reglas.topePrestamoFactorAhorro) + (aval ? aval.cupo : 0);
            if (montoSolicitado > tope) {
                return res.status(409).json({
                    message: `El monto solicitado ($${montoSolicitado.toFixed(2)}) supera tu cupo. `
                        + `Con $${ahorro.toFixed(2)} de ahorro confirmado tu cupo es $${tope.toFixed(2)} `
                        + `(${reglas.topePrestamoFactorAhorro}x el ahorro`
                        + (aval ? `, mas $${aval.cupo.toFixed(2)} que te avala ${aval.avalEmail}` : '')
                        + ').',
                    codigo: 'SOBRE_CUPO',
                    ahorroConfirmado: Math.round(ahorro * 100) / 100,
                    cupoMaximo: Math.round(tope * 100) / 100
                });
            }
        }
        // Autenticación correcta para cada request
        const client = await auth.getClient();
        const sheetsApi = envolverHoja(google.sheets({ version: 'v4', auth: client }));
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
                sanitizeCell(data.ID || Date.now().toString(), 60),
                data.UserEmail,
                userGroup,
                userGroupRole,
                data.Cantidad || data.Monto || '',
                data.Estado || 'pendiente',
                sanitizeCell(data.Fecha || new Date().toISOString(), 30),
                sanitizeCell(data.Detalles),
                '' // AprobadoPor
            ]];
            appendRange = `${config[tipo].sheet}!A:I`;
        } else if (tipo === 'prestamo') {
            values = [[
                sanitizeCell(data.ID || Date.now().toString(), 60),
                data.UserEmail,
                userGroup,
                userGroupRole,
                data.Monto || '',
                data.Estado || 'pendiente',
                sanitizeCell(data.Fecha || new Date().toISOString(), 30),
                sanitizeCell(data.Detalles),
                '', // AprobadoPor
                data.TasaInteres || 0 // Tasa de interés del grupo
            ]];
        } else {
            values = [[
                sanitizeCell(data.ID || Date.now().toString(), 60),
                data.UserEmail,
                userGroup,
                userGroupRole,
                data.Monto || data.Cantidad || '',
                data.Estado || 'pendiente',
                sanitizeCell(data.Fecha || new Date().toISOString(), 30),
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
            // Sin stack ni mensaje interno: el 500 de Google traia rutas del
            // servidor y el numero de proyecto. El detalle va al log, no al cliente.
            console.error('[REGISTRAR SOLICITUD] detalle:', appendError.stack || appendError.message);
            res.status(500).json({ message: 'No se pudo registrar la solicitud. Intentalo de nuevo.' });
        }
    } catch (error) {
        // Log detallado del error
        console.error('[REGISTRAR SOLICITUD][ERROR] Error registrando solicitud dinámica:', error, 'Stack:', error.stack);
        console.error('[REGISTRAR SOLICITUD] detalle:', error.stack || error.message);
        res.status(500).json({ message: 'No se pudo registrar la solicitud. Intentalo de nuevo.' });
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
        // 'retirada' cuenta como resuelta: la socia se echo atras y el credito
        // ya no lo quiere. Sin esto, la junta se lo aprobaba igual.
        if (['aprobado', 'aprobada', 'rechazado', 'rechazada', 'retirada'].includes(estadoPrevio)) {
            return res.status(409).json({
                message: estadoPrevio === 'retirada'
                    ? 'La socia retiro esta solicitud.'
                    : `La solicitud ya fue ${estadoPrevio}.`,
                estado: estadoPrevio,
            });
        }

        // Control interno: si el grupo exige aprobacion colegiada, esta via directa no
        // puede usarse para prestamos; debe resolverse por la votacion de la junta.
        // El quorum vale para todos. Antes el administrador se lo saltaba, asi
        // que tenia mas poder sobre el credito del grupo que su propia junta.
        if (tipo === 'prestamo' && gobApi) {
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
/**
 * POST /api/retirar-solicitud
 *
 * La socia se echa atras de lo que ella misma pidio. Solo mientras nadie lo
 * haya resuelto: una vez aprobada, el dinero ya salio y deshacerlo es cosa de
 * la asamblea, no de un boton.
 */
app.post('/api/retirar-solicitud', bloquear((r) => (
  `solicitudes:${normalizeEmailKey(r.user && r.user.email)}`
)), async (req, res) => {
    const HOJAS = {
        prestamo: 'SolicitudesPrestamos',
        accion: 'SolicitudesAcciones',
        adelanto: 'SolicitudesAdelantos',
    };
    try {
        const tipo = (req.body?.tipo || 'prestamo').toString().trim().toLowerCase();
        const id = (req.body?.id || '').toString().trim();
        const hoja = HOJAS[tipo];
        if (!hoja) {
            return res.status(400).json({ message: 'Tipo de solicitud invalido.' });
        }
        if (!id) return res.status(400).json({ message: 'Falta el identificador de la solicitud.' });

        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: `${hoja}!A2:J`,
        });
        const filas = resp.data.values || [];
        const i = filas.findIndex((r) => (r[0] || '').toString().trim() === id);
        if (i < 0) return res.status(404).json({ message: 'Solicitud no encontrada.' });

        const fila = filas[i];
        // Solo la suya. Ni la junta retira por otra: si la junta no la quiere,
        // la rechaza, y eso se lee distinto en el acta.
        if (normalizeEmailKey(fila[1]) !== normalizeEmailKey(req.user.email)) {
            return res.status(403).json({
                message: 'Solo puedes retirar tus propias solicitudes.',
                codigo: 'NO_ES_TUYA',
            });
        }
        const estado = (fila[5] || '').toString().trim().toLowerCase();
        if (!['pendiente', 'pending', ''].includes(estado)) {
            return res.status(409).json({
                message: estado === 'aprobado' || estado === 'aprobada'
                    ? 'Esta solicitud ya fue aprobada: el prestamo existe. Deshacerlo tiene que '
                      + 'acordarlo la asamblea.'
                    : `Esta solicitud ya esta "${estado}", asi que no hay nada que retirar.`,
                codigo: 'YA_RESUELTA',
                estado,
            });
        }

        await actualizarFilaPorClave(sheetsClient, {
            spreadsheetId: SPREADSHEET_ID,
            hoja,
            ultimaColumna: 'J',
            desdeColumna: 'F',
            indice: i,
            claveCol: 0,
            clave: id,
            construir: (filaActual) => {
                const f = filaActual || fila;
                return [
                    'retirada',                                  // Estado (F)
                    f[6] || '',                                  // Fecha (G)
                    `${f[7] || ''} [retirada por la socia]`.trim().slice(0, 500),  // Detalles (H)
                    f[8] || '',                                  // AprobadoPor (I)
                    f[9] || '',                                  // TasaInteres (J)
                ];
            },
        });

        return res.status(200).json({
            success: true,
            estado: 'retirada',
            message: 'Retiraste tu solicitud. Deja de contar para tu cupo y desaparece de la '
                   + 'bandeja de la junta.',
        });
    } catch (error) {
        console.error('[RETIRAR SOLICITUD]', error);
        if (responderSiEsCuota(res, error)) return;
        return res.status(500).json({ message: 'No se pudo retirar la solicitud.' });
    }
});

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

        // Nadie firma su propio credito. Faltaba esta comprobacion: un directivo
        // pedia un prestamo y lo aprobaba el mismo. En un grupo con una sola
        // directiva se llevaba la caja con su propia firma; con dos, bastaba una
        // sola firma ajena para llegar al quorum de dos.
        // Una solicitud retirada o ya resuelta no se vota: los votos se
        // quedarian ahi contando para algo que nadie va a ejecutar.
        const estadoDeLaSolicitud = await getSolicitudEstado(sheetsClient, tipo, solicitudId);
        if (['aprobado', 'aprobada', 'rechazado', 'rechazada', 'retirada']
            .includes(estadoDeLaSolicitud)) {
            return res.status(409).json({
                message: estadoDeLaSolicitud === 'retirada'
                    ? 'La socia retiro esta solicitud, asi que ya no se vota.'
                    : `Esta solicitud ya fue ${estadoDeLaSolicitud}.`,
                estado: estadoDeLaSolicitud,
            });
        }

        const solicitante = await getSolicitudSolicitante(sheetsClient, tipo, solicitudId);
        if (solicitante && solicitante === normalizeEmailKey(aprobadoPor)) {
            return res.status(403).json({
                message: 'No puedes votar tu propia solicitud. Debe resolverla el resto de la directiva.',
                codigo: 'ES_TU_SOLICITUD',
            });
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
                // Los lideres que DE VERDAD pueden firmar: el beneficiario no
                // cuenta. Antes se contaba a todos, asi que un grupo con dos
                // directivos donde uno pedia el prestamo exigia dos firmas y
                // solo habia una posible; y en uno con un solo directivo, el
                // quorum era 1 y se lo firmaba el mismo.
                const lideresTotales = await getActiveLeaderCount(grupoReal);
                const esLiderElSolicitante = solicitante
                    && rolesValidos.has((await getUserGroupRole(solicitante, grupoReal) || '').toLowerCase());
                const numLideres = Math.max(0, lideresTotales - (esLiderElSolicitante ? 1 : 0));

                if (numLideres === 0) {
                    return res.status(409).json({
                        message: 'Esta solicitud no la puede resolver nadie: quien la pide es el unico '
                               + 'directivo del grupo. Nombra a otra persona en la directiva para que la revise.',
                        codigo: 'SIN_QUIEN_APRUEBE',
                    });
                }
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
        // requireAuth ya la deja fuera del resto de la app, pero la foto viene
        // firmada y no pasa por requireAuth: hay que anular lo emitido a mano.
        revocarComprobantes(Email);
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
        if (responderSiEsCuota(res, error)) return;
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
        if (responderSiEsCuota(res, error)) return;
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
        // Saneado como todo lo que se escribe a la hoja: un nombre que empieza
        // por = se guardaria como formula.
        await setCell('username', username !== undefined
          ? sanitizeCell(username.toString().trim(), 120) : undefined);
        await setCell('telefono', telefono !== undefined ? telefono.toString().trim() : undefined);
        await setCell('cedula', cedula !== undefined ? cedula.toString().trim() : undefined);

        return res.json({ success: true, message: 'Perfil actualizado correctamente.', data: { username, telefono, cedula } });
    } catch (error) {
        console.error('[ACTUALIZAR-PERFIL] Error:', error.message);
        if (responderSiEsCuota(res, error)) return;
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
    // codepage 65001 = UTF-8. Multer guarda el archivo SIN extension, y sin
    // esto la libreria lee un CSV como Latin-1: "Villon" entraba como "VillÃ³n"
    // y quedaba asi, con el nombre roto, en la ficha de una persona real.
    // En un .xlsx no cambia nada (ese formato ya es UTF-8 por dentro).
    const workbook = xlsx.readFile(filePath, { codepage: 65001 });
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
    // El tope de socias (columna M) sale de ESTA misma lectura. Antes se volvia
    // a leer la hoja Groups entera una vez por cada fila del Excel solo para
    // mirar ese numero.
    const topes = new Map();

    (rows || []).forEach((row) => {
        const groupId = normalizeImportCell(row?.[0]);
        const groupName = normalizeImportCell(row?.[1]);
        if (groupId) {
            byId.set(normalizeImportLookupKey(groupId), groupId);
            topes.set(normalizeGroupKey(groupId), Math.max(0, Math.trunc(parseMoney(row?.[12])) || 0));
        }
        if (groupName) {
            const normalizedName = normalizeImportLookupKey(groupName);
            byName.set(normalizedName, groupId);
            names.push({ normalizedName, groupId, groupName });
        }
    });

    return { byId, byName, names, topes };
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

/**
 * A que grupo de la hoja corresponde lo que dice la columna Group del Excel.
 *
 * ESTO ERA DEMASIADO CONFIADO Y COSTO CARO. La regla vieja daba por bueno
 * cualquier nombre que fuera SUBCADENA de otro, y como "semilladeahorro"
 * contiene "adeahorro", las once personas de "Semilla de Ahorro" entraron en
 * "ADE AHORRO", el grupo de otra persona, sin que nada lo dijera. El umbral de
 * parecido tambien era bajo (0,82).
 *
 * El dano no es simetrico: un grupo de mas se ve en el acto y se corrige,
 * pero once socias metidas en la caja de otro grupo no las ve nadie. Asi que
 * ahora solo se empareja con el nombre EXACTO (ya sin tildes, mayusculas ni
 * espacios) o con una erratita de una letra o dos sobre un nombre largo, y esa
 * segunda via siempre deja aviso. Cualquier otra cosa crea un grupo nuevo.
 */
const PARECIDO_MINIMO_GRUPO = 0.92;
const LARGO_MINIMO_GRUPO = 8;

const resolveImportGroupId = (rawGroup, groupsLookup, avisos) => {
    const groupRef = normalizeImportCell(rawGroup);
    if (!groupRef) return '';
    const key = normalizeImportLookupKey(groupRef);

    if (!groupsLookup) return groupRef;
    const byIdMatch = groupsLookup.byId.get(key);
    if (byIdMatch) return byIdMatch;

    const byNameMatch = groupsLookup.byName.get(key);
    if (byNameMatch) return byNameMatch;

    let best = null;
    for (const entry of (groupsLookup.names || [])) {
        const largo = Math.max(key.length, entry.normalizedName.length);
        if (!largo) continue;
        const similarity = 1 - (levenshteinDistance(key, entry.normalizedName) / largo);
        if (!best || similarity > best.similarity) {
            best = { similarity, groupId: entry.groupId, groupName: entry.groupName };
        }
    }

    if (best
        && best.similarity >= PARECIDO_MINIMO_GRUPO
        && key.length >= LARGO_MINIMO_GRUPO
        && normalizeImportLookupKey(best.groupName).length >= LARGO_MINIMO_GRUPO) {
        if (Array.isArray(avisos)) {
            avisos.push(
                `El Excel dice "${groupRef}" y se ha usado el grupo "${best.groupName}", que ya existia `
                + 'y se escribe casi igual. Si no era ese, corrige el nombre en el Excel y vuelve a subirlo.'
            );
        }
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

/**
 * Da de alta a las socias de un Excel y las mete en su grupo.
 *
 * ANTES iba fila por fila, y cada fila costaba unas ocho operaciones contra
 * Google: releer la hoja Users entera para ver si la persona ya estaba, releer
 * UserGroupLinks entera para ver si el vinculo existia, releer Groups entera
 * para mirar el tope, y cuatro escrituras que ademas borraban la memoria del
 * servidor, con lo que la fila siguiente no podia reaprovechar nada. Con las
 * 52 socias de un grupo salian mas de 260 lecturas contra un limite de 40 por
 * minuto: cinco minutos de espera y, al final, un error de cuota que se
 * mostraba como un 500 pelado y no dejaba nada cargado.
 *
 * AHORA son tres pasos: se lee una vez lo que hace falta, se arma todo en
 * memoria, y se escribe en dos envios. El coste ya no depende de cuanta gente
 * traiga el archivo.
 *
 * Las personas se escriben ANTES que los vinculos a proposito: si fallara el
 * segundo envio, quedan creadas y volver a subir el mismo archivo completa solo
 * lo que falta, sin duplicar a nadie.
 */
const importUsersFromRows = async (rows, { linkGroups = false } = {}) => {
    const summary = {
        processed: rows.length,
        createdUsers: 0,
        existingUsers: 0,
        createdGroups: 0,
        linkedToGroups: 0,
        existingLinks: 0,
        defaultedPasswords: 0,
        cargosAsignados: 0,
        cargosDegradados: 0,
        failed: 0,
        errors: [],
        avisos: [],
    };

    // ---------------------------------------------------------------- PASO 1
    // Todo lo que hay que saber de la hoja, leido UNA vez.
    const existingRows = await usersService.listAllUsers();
    const knownEmails = new Set(
        (existingRows || [])
            .map((row) => normalizeImportEmail(row[1]))
            .filter(Boolean)
    );
    const groupsLookup = linkGroups ? await buildGroupsLookup() : null;

    // Vinculos ya escritos. El mismo recorrido sirve para dos cosas: no repetir
    // a nadie en su grupo y saber cuantas socias hay dentro para respetar el
    // tope. Un vinculo dado de baja SIGUE contando como duplicado (es lo que ya
    // hacia el alta de una en una) pero no ocupa cupo.
    const vinculos = new Set();
    const dentroPorGrupo = new Map();
    // Donde vive cada vinculo y que cargo tiene hoy, para poder rellenar una
    // directiva vacia sin tocar a quien ya ocupa un puesto.
    const filaDeVinculo = new Map();
    const rolDeVinculo = new Map();
    const cargosTomados = new Map();
    if (linkGroups) {
        const sheetsClient = await getSheetsClient();
        const enlacesResp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID,
            range: 'UserGroupLinks!A2:F',
        });
        (enlacesResp.data.values || []).forEach((fila, i) => {
            const gid = normalizeGroupKey(fila[1]);
            if (!gid) return;
            const clave = `${normalize(fila[0])}|${gid}`;
            vinculos.add(clave);
            // +2 porque el rango empieza en A2 y la fila 1 es la cabecera.
            filaDeVinculo.set(clave, i + 2);
            const rolHoy = normalizeGroupRole(fila[3]);
            rolDeVinculo.set(clave, rolHoy);
            if (linkIsActive(fila)) {
                dentroPorGrupo.set(gid, (dentroPorGrupo.get(gid) || 0) + 1);
                if (CARGOS_DIRECTIVA.has(rolHoy)) {
                    if (!cargosTomados.has(gid)) cargosTomados.set(gid, new Set());
                    cargosTomados.get(gid).add(rolHoy);
                }
            }
        });
    }

    /** Apunta que el cargo queda ocupado en ese grupo. */
    const ocupar = (gid, cargo) => {
        if (!CARGOS_DIRECTIVA.has(cargo)) return;
        if (!cargosTomados.has(gid)) cargosTomados.set(gid, new Set());
        cargosTomados.get(gid).add(cargo);
    };
    const cargoLibre = (gid, cargo) => !(cargosTomados.get(gid) || new Set()).has(cargo);

    // ---------------------------------------------------------------- PASO 2
    // Se arma todo en memoria. Aqui no se escribe nada, salvo los grupos que
    // haya que crear: son unos pocos y hace falta su identificador antes de
    // poder vincular a nadie.
    const filasUsuarios = [];
    const filasVinculos = [];
    const ascensos = [];
    // A donde fue a parar cada socia. El resolvedor de grupos acepta nombres
    // PARECIDOS (82% de similitud), asi que subir "Mi aguinaldo" podria meter a
    // las 52 en otro grupo de nombre parecido sin que nadie se entere. Esto lo
    // pone en la pantalla del resultado, que es donde se puede ver a tiempo.
    const destinos = new Map();

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

        if (knownEmails.has(email)) {
            summary.existingUsers += 1;
        } else {
            try {
                if (!password && !importedHash) {
                    password = DEFAULT_IMPORT_PASSWORD;
                    summary.defaultedPasswords += 1;
                }

                filasUsuarios.push(await usersService.prepararFilaUsuario({
                    Username: username,
                    Email: email,
                    Password: password,
                    HashedPassword: importedHash,
                    Role: role,
                    Balance: balance,
                }));

                knownEmails.add(email);
                summary.createdUsers += 1;
            } catch (error) {
                summary.failed += 1;
                summary.errors.push(`Fila ${rowNumber}: error al crear usuario ${email} (${error.message}).`);
                continue;
            }
        }

        if (!linkGroups) continue;

        const groupReference = normalizeImportCell(pickFirstValue(row, ['GroupID', 'groupId', 'Group', 'group', 'Grupo', 'grupo', 'GroupName', 'groupName', 'NombreGrupo']));
        if (!groupReference) continue;

        let resolvedGroupId = resolveImportGroupId(groupReference, groupsLookup, summary.avisos);
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
                    // Un grupo recien creado no trae tope: entra toda la lista.
                    groupsLookup.topes.set(normalizeGroupKey(createdGroupId), 0);
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

        const groupId = normalizeGroupKey(resolvedGroupId || groupReference);
        const groupRole = normalizeGroupRole(pickFirstValue(row, ['GroupRole', 'groupRole', 'RolGrupo', 'rolGrupo', 'Rol Grupo', 'Rol']));
        const joinDate = normalizeImportCell(pickFirstValue(row, ['JoinDate', 'joinDate', 'FechaIngreso', 'fechaIngreso'])) || new Date().toISOString();

        const clave = `${email}|${groupId}`;
        if (vinculos.has(clave)) {
            summary.existingLinks += 1;

            // UN GRUPO SIN DIRECTIVA NO PODIA RECUPERARSE NUNCA. El administrador
            // de la plataforma NO puede nombrar directiva (es deliberado: ser
            // dueno de la plataforma no es ser dueno de la caja de nadie), y una
            // socia rasa tampoco puede. Si una carga a medias dejaba a las 29
            // socias como miembros rasos, el grupo quedaba muerto: nadie en el
            // mundo podia nombrar a la presidenta.
            //
            // Esto lo desatasca por el unico sitio por donde entra la nomina,
            // y SOLO para rellenar un puesto VACANTE. Jamas releva a quien ya
            // ocupa el cargo: eso sigue siendo cosa del propio grupo.
            if (CARGOS_DIRECTIVA.has(groupRole)
                && rolDeVinculo.get(clave) === 'member'
                && cargoLibre(groupId, groupRole)
                && filaDeVinculo.has(clave)) {
                ascensos.push({ fila: filaDeVinculo.get(clave), rol: groupRole, email, groupId });
                rolDeVinculo.set(clave, groupRole);
                ocupar(groupId, groupRole);
                summary.cargosAsignados += 1;
            }
            continue;
        }

        // El tope que el grupo se puso a si mismo. Cuenta lo que ya estaba
        // dentro MAS lo que lleva pendiente este mismo archivo: si no, un Excel
        // con mas gente que el tope entraria entero.
        const tope = (groupsLookup && groupsLookup.topes.get(groupId)) || 0;
        const dentro = dentroPorGrupo.get(groupId) || 0;
        if (tope > 0 && dentro >= tope) {
            summary.failed += 1;
            summary.errors.push(
                `Fila ${rowNumber}: el grupo tiene un tope de ${tope} socias y ya son ${dentro}, `
                + `así que ${email} se queda fuera. Para que entre, la directiva tiene que subir `
                + 'el tope en la configuración del grupo.'
            );
            continue;
        }

        // Solo cabe una persona en cada cargo. Sin esto, una nomina que trae
        // seis "Lider" creaba seis presidentas en el mismo grupo, que es
        // exactamente lo que hay hoy en "Banquio de ahorros".
        let rolFinal = groupRole;
        if (CARGOS_DIRECTIVA.has(rolFinal) && !cargoLibre(groupId, rolFinal)) {
            rolFinal = 'member';
            summary.cargosDegradados += 1;
            summary.avisos.push(
                `Fila ${rowNumber}: ${email} venia como ${groupRole}, pero ese cargo ya esta `
                + 'ocupado en el grupo, asi que entra como socia. Solo cabe una persona por cargo.'
            );
        }

        vinculos.add(clave);
        dentroPorGrupo.set(groupId, dentro + 1);
        filaDeVinculo.set(clave, null);
        rolDeVinculo.set(clave, rolFinal);
        ocupar(groupId, rolFinal);
        filasVinculos.push([email, groupId, sanitizeCell(joinDate), rolFinal, 'activo', 'self']);
        summary.linkedToGroups += 1;

        if (!destinos.has(groupId)) {
            const yaExistia = (groupsLookup && groupsLookup.names
                .find((n) => n.groupId === groupId)) || null;
            destinos.set(groupId, {
                groupId,
                dice: groupReference,
                seLlama: yaExistia ? yaExistia.groupName : groupReference,
                socias: 0,
            });
        }
        destinos.get(groupId).socias += 1;
    }

    summary.grupos = [...destinos.values()];

    // ---------------------------------------------------------------- PASO 3
    // Dos envios en total: uno con todas las personas y otro con todos los
    // vinculos.
    if (filasUsuarios.length) {
        await usersService.crearUsuariosEnLote(filasUsuarios);
    }

    // Los ascensos son celdas sueltas de una columna, no filas nuevas: como
    // mucho tres por grupo, asi que no hace falta agruparlas.
    if (ascensos.length) {
        try {
            const sheetsClient = await getSheetsClient();
            for (const a of ascensos) {
                await sheetsClient.spreadsheets.values.update({
                    spreadsheetId: SPREADSHEET_ID,
                    range: `UserGroupLinks!D${a.fila}`,
                    valueInputOption: 'RAW',
                    resource: { values: [[a.rol]] },
                });
            }
        } catch (error) {
            summary.cargosAsignados = 0;
            summary.avisos.push(
                `No se pudieron asignar los cargos de la directiva (${error.message}). `
                + 'Las socias si quedaron en su grupo; vuelve a subir el mismo archivo.'
            );
        }
    }

    if (filasVinculos.length) {
        try {
            const sheetsClient = await getSheetsClient();
            await sheetsClient.spreadsheets.values.append({
                spreadsheetId: SPREADSHEET_ID,
                range: 'UserGroupLinks!A:F',
                valueInputOption: 'USER_ENTERED',
                resource: { values: filasVinculos },
            });
        } catch (error) {
            // Aqui NO se lanza el error: las personas ya quedaron creadas y, si
            // se lanzara, la pantalla perderia el detalle fila por fila y el
            // administrador no sabria que paso ni que hacer. Se devuelve el
            // informe con la verdad: quienes entraron, quienes no, y el remedio.
            summary.failed += filasVinculos.length;
            summary.linkedToGroups = 0;
            summary.vinculosPendientes = filasVinculos.length;
            summary.errors.push(
                `Se crearon ${summary.createdUsers} personas, pero no se pudieron guardar sus `
                + `${filasVinculos.length} vínculos de grupo (${error.message}). Vuelve a subir `
                + 'el mismo archivo: no se duplicará a nadie y completará solo lo que falta.'
            );
        }
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

// El cerrojo NO es decorativo: la importacion lee la foto de la hoja, arma
// todas las filas y las escribe de una vez. Dos peticiones a la vez (un doble
// clic en el boton basta) leerian la MISMA foto y escribirian las mismas 52
// socias dos veces, porque Google Sheets no impide correos repetidos.
app.post('/api/importar-usuarios-excel', requireAdmin, bloquear(() => 'hoja:Users'), upload.single('file'), async (req, res) => {
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
        // Un fallo de cuota de Google es un 429 con un remedio claro, no un
        // 500 anonimo: la pantalla decia "Error interno" y no se sabia si
        // habia que reintentar, partir el archivo o llamar a alguien.
        if (responderSiEsCuota(res, error)) return;
        return res.status(500).json({
            success: false,
            message: error.message || 'Error al importar usuarios desde Excel.',
            error: error.message,
        });
    } finally {
        await cleanupUploadedFile(req.file?.path);
    }
});

// Endpoint para importar usuarios y grupos desde Excel
// El cerrojo NO es decorativo: la importacion lee la foto de la hoja, arma
// todas las filas y las escribe de una vez. Dos peticiones a la vez (un doble
// clic en el boton basta) leerian la MISMA foto y escribirian las mismas 52
// socias dos veces, porque Google Sheets no impide correos repetidos.
app.post('/api/importar-usuarios-grupos', requireAdmin, bloquear(() => 'hoja:Users'), upload.single('file'), async (req, res) => {
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
        // Un fallo de cuota de Google es un 429 con un remedio claro, no un
        // 500 anonimo: la pantalla decia "Error interno" y no se sabia si
        // habia que reintentar, partir el archivo o llamar a alguien.
        if (responderSiEsCuota(res, error)) return;
        return res.status(500).json({
            success: false,
            message: error.message || 'Error al importar usuarios y grupos.',
            error: error.message,
        });
    } finally {
        await cleanupUploadedFile(req.file?.path);
    }
});

// Las tres rutas que borran o reescriben filas de UserGroupLinks se serializan
// sobre LA HOJA, no sobre el grupo. Con un cerrojo por grupo, la presidencia de
// G1 y la de G2 escribian a la vez en la misma hoja: una borraba una fila y la
// otra escribia en una posicion que ya se habia corrido, y una socia de un
// tercer grupo desaparecia del suyo sin que nadie la tocara.
app.post('/api/cambiar-rol-usuario-grupo', bloquear(() => 'hoja:UserGroupLinks'), async (req, res) => {
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
            // Ni siquiera el administrador de la plataforma: nombrarse presidente
            // de un grupo ajeno era la via mas corta para heredar toda su caja.
            if (reqEmail !== currentPresidentEmail) {
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
                // La presidenta que acaba de ceder el cargo se queda con las
                // firmas de los comprobantes de TODO el grupo, porque la
                // pantalla de revision se las dio todas. Aqui dejan de valer.
                // Es el momento politicamente mas delicado de un banco comunal
                // y era justo el que se quedaba con una hora de acceso abierto.
                revocarComprobantes(currentPresidentEmail);
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
            // Se localiza por correo, no por numero de fila. Escribir en la
            // posicion N pisaba a otra socia si entre la lectura y la escritura
            // desaparecia una fila de mas arriba: medido, una socia de OTRO
            // grupo se quedo sin su vinculo y sin poder entrar a su panel.
            await actualizarFilaPorClave(sheetsClient, {
                spreadsheetId: SPREADSHEET_ID,
                hoja: 'UserGroupLinks',
                ultimaColumna: 'E',
                indice: rowIndex,
                clave: `${UserEmail} en ${GroupID}`,
                // El correo NO basta: una persona tiene una fila por cada grupo.
                // Buscando solo por correo, cambiarle el rol en un grupo se lo
                // cambiaba en otro, y ademas le dejaba dos vinculos al mismo.
                esLaFila: (fila) => fila
                    && normalize(fila[userEmailCol]) === UserEmail
                    && (fila[groupIdCol] || '').toString().trim() === GroupID,
                valueInputOption: 'USER_ENTERED',
                construir: (filaActual) => {
                    const copia = (filaActual || []).slice();
                    while (copia.length <= groupRoleCol) copia.push('');
                    copia[groupRoleCol] = NewGroupRole;
                    return copia;
                },
            });
            // Una tesorera degradada a socia se queda con las firmas de los
            // comprobantes de todo el grupo, porque la pantalla de revision se
            // las dio todas. Al cambiarle el rol dejan de valer.
            //
            // Va aqui y no arriba a proposito: entre la comprobacion de rol y
            // esta linea hay tres salidas con error (409 por quitar la
            // presidencia, 403 por transferirla sin ser presidenta, 409 por
            // rol ya ocupado). Anulando antes, cualquiera que pase
            // assertGroupManager podia repetir una peticion que devuelve 409,
            // no cambia nada, y aun asi dejar a la tesorera sin poder abrir
            // ninguna foto, incluso siendo tesorera de OTRO grupo.
            revocarComprobantes(UserEmail);
            return res.json({ message: 'Rol de usuario en grupo actualizado correctamente.' });
        }
    } catch (error) {
        console.error('[CAMBIAR ROL USUARIO-GRUPO] Error:', error.message, error.stack);
        if (responderSiEsCuota(res, error)) return;
        res.status(500).json({ message: 'Error al actualizar rol de usuario en grupo.', error: error.message });
    }
});

// (Opcional) Endpoint para desvincular usuario de grupo
app.post('/api/desvincular-usuario-grupo', bloquear(() => 'hoja:UserGroupLinks'), async (req, res) => {
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
        // Las direcciones firmadas que ya se llevo no se le pueden quitar del
        // telefono: aqui dejan de valer. Sin esto seguirian abriendo
        // comprobantes del grupo hasta una hora despues de sacarla.
        revocarComprobantes(UserEmail);
        res.json({ message: 'Usuario desvinculado del grupo correctamente.' });
    } catch (error) {
        console.error('[DESVINCULAR USUARIO-GRUPO] Error:', error.message, error.stack);
        if (responderSiEsCuota(res, error)) return;
        res.status(500).json({ message: 'Error al desvincular usuario del grupo.', error: error.message });
    }
});

/**
 * Cuanto dinero ha movido esta persona DENTRO de ese grupo.
 *
 * Es el freno del endpoint de abajo: deshacer una importacion es borrar una
 * fila que nunca se uso, no sacar a una socia de una caja donde tiene ahorros.
 */
async function movimientoEnGrupo(sheetsClient, email, groupId) {
    const e = normalizeEmailKey(email);
    const g = normalizeGroupKey(groupId);
    const contar = async (rango, colEmail, colGrupo) => {
        try {
            const r = await sheetsClient.spreadsheets.values.get({
                spreadsheetId: SPREADSHEET_ID, range: rango,
            });
            return (r.data.values || []).filter((f) => (
                normalizeEmailKey(f[colEmail]) === e && normalizeGroupKey(f[colGrupo]) === g
            )).length;
        } catch (err) {
            // Que la pestana no exista es normal en un libro recien creado.
            // Cualquier OTRO fallo sube: ante la duda no se retira a nadie.
            if (/Unable to parse range/i.test(err && err.message)) return 0;
            throw err;
        }
    };
    const [ahorros, acciones, prestamos] = await Promise.all([
        contar('Savings!A2:L', 0, 1),
        contar('Acciones!A2:M', 0, 1),
        contar('Loans!A2:K', 1, 2),
    ]);
    return { ahorros, acciones, prestamos, total: ahorros + acciones + prestamos };
}

/**
 * DESHACER UN VINCULO QUE METIO UNA IMPORTACION.
 *
 * El administrador de la plataforma no gobierna grupos y no puede expulsar a
 * nadie: eso es de la directiva. Pero SI tiene que poder deshacer sus propios
 * errores de carga, y hasta ahora no podia. Paso dos veces el mismo dia: dos
 * personas quedaron duplicadas en "Mi aguinaldo" con el correo mal escrito, y
 * once socias entraron en el grupo equivocado porque el nombre se parecia.
 *
 * El limite que lo hace seguro: solo se puede retirar a quien NO ha movido
 * nada en ese grupo (ni un ahorro, ni una accion, ni un prestamo). Con eso no
 * hay forma de usarlo para sacar a una socia de una caja en marcha, que es lo
 * que la separacion protege. Tampoco se retira a la presidencia.
 *
 * No borra la fila: la marca inactiva, asi que queda el rastro y se puede
 * volver a activar.
 */
app.post('/api/admin/retirar-vinculo', requireAdmin, bloquear(() => 'hoja:UserGroupLinks'), async (req, res) => {
    const Email = normalize(req.body?.Email || req.body?.UserEmail || req.body?.email);
    const GroupID = (req.body?.GroupID || req.body?.groupId || '').toString().trim();
    if (!Email || !GroupID) {
        return res.status(400).json({ success: false, message: 'Faltan datos: Email y GroupID.' });
    }
    try {
        const sheetsClient = await getSheetsClient();
        const resp = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'UserGroupLinks!A2:F',
        });
        const rows = resp.data.values || [];
        const idx = rows.findIndex((r) => (
            normalizeEmailKey(r[0]) === normalizeEmailKey(Email)
            && normalizeGroupKey(r[1]) === normalizeGroupKey(GroupID)
        ));
        if (idx === -1) {
            return res.status(404).json({ success: false, message: 'Esa persona no esta en ese grupo.' });
        }
        if (!linkIsActive(rows[idx])) {
            return res.json({ success: true, yaEstaba: true, message: 'Ya estaba retirada de ese grupo.' });
        }
        if (normalizeGroupRole(rows[idx][3]) === 'presidente') {
            return res.status(409).json({
                success: false,
                codigo: 'ES_LA_PRESIDENCIA',
                message: 'No se retira a quien preside el grupo: primero el grupo tiene que pasar la presidencia a otra persona.',
            });
        }

        const mov = await movimientoEnGrupo(sheetsClient, Email, GroupID);
        if (mov.total > 0) {
            return res.status(409).json({
                success: false,
                codigo: 'TIENE_MOVIMIENTO',
                movimiento: mov,
                message: `Esta persona ya tiene movimiento en el grupo (${mov.ahorros} ahorro(s), `
                       + `${mov.acciones} accion(es), ${mov.prestamos} prestamo(s)), asi que sacarla `
                       + 'de aqui es cosa de la directiva del grupo, no del administrador de la plataforma.',
            });
        }

        await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `UserGroupLinks!E${idx + 2}`,
            valueInputOption: 'RAW',
            resource: { values: [['inactivo']] },
        });
        revocarComprobantes(Email);
        return res.json({ success: true, message: 'Vinculo retirado.', email: Email, grupo: GroupID });
    } catch (error) {
        console.error('[RETIRAR-VINCULO]', error.message);
        if (responderSiEsCuota(res, error)) return;
        return res.status(500).json({ success: false, message: 'Error al retirar el vinculo.', error: error.message });
    }
});

// Salir voluntariamente de un grupo (cualquier miembro, solo a sí mismo). El único presidente no puede salir sin transferir.
app.post('/api/salir-grupo', bloquear(() => 'hoja:UserGroupLinks'), async (req, res) => {
    const GroupID = (req.body?.groupId || req.body?.GroupID || '').toString().trim();
    if (!GroupID) return res.status(400).json({ message: 'Falta groupId.' });
    const me = req.user.email;
    try {
        const sheetsClient = await getSheetsClient();
        const response = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'UserGroupLinks!A2:F' });
        const rows = response.data.values || [];
        const rowIndex = rows.findIndex(r => normalizeEmailKey(r[0]) === me && (r[1] || '').toString().trim() === GroupID);
        if (rowIndex === -1) return res.status(404).json({ message: 'No perteneces a ese grupo.' });
        // Nadie sale del grupo debiendo dinero. Antes se podia: medido, un socio
        // salio con $168 pendientes de $336 y la deuda quedo incobrable, porque
        // despues ni siquiera podia pagar ("No puedes registrar pagos de este
        // prestamo"). El grupo perdia ese dinero y no se enteraba.
        try {
            const prestamos = await contarPrestamosActivos(me, GroupID);
            if (prestamos.cantidad > 0) {
                return res.status(409).json({
                    message: `No puedes salir del grupo con ${prestamos.cantidad} prestamo(s) sin terminar de pagar. `
                           + 'Termina de pagarlo o habla con la directiva para acordar como se salda.',
                    codigo: 'PRESTAMO_VIVO',
                    prestamosActivos: prestamos.cantidad,
                });
            }
        } catch (e) {
            console.error('[SALIR GRUPO] no se pudieron leer los prestamos:', e.message);
            if (responderSiEsCuota(res, e)) return;
            return res.status(500).json({ message: 'No se pudo comprobar si tienes prestamos pendientes.' });
        }

        const myRole = (rows[rowIndex][3] || '').toString().trim().toLowerCase();
        if (myRole === 'presidente') {
            const otherPresident = rows.some((r, i) => i !== rowIndex && (r[1] || '').toString().trim() === GroupID && (r[3] || '').toString().trim().toLowerCase() === 'presidente');
            if (!otherPresident) {
                return res.status(409).json({ message: 'Eres el único presidente. Transfiere la presidencia antes de salir del grupo.' });
            }
        }
        // Quien ya esta de baja no vuelve a pedir la salida: dejaria una
        // liquidacion fantasma abierta, y una liquidacion abierta bloquea el
        // cierre de utilidades del grupo entero.
        if (!linkIsActive(rows[rowIndex])) {
            return res.status(409).json({
                message: 'Ya saliste de este grupo.',
                codigo: 'YA_RETIRADA',
            });
        }

        // SALIR ES AVISAR, no borrarse. Antes se borraba la fila del vinculo y
        // ya: medido, una socia puso $210, le tocaban $2,78 de utilidades,
        // cobro $0,00, y sus $210 siguieron sumando en el patrimonio del grupo.
        // Ahora se abre su liquidacion: la tesoreria calcula lo suyo, la
        // asamblea lo aprueba, y entonces se le paga y se le da de baja. Hasta
        // ese momento sigue siendo socia, porque su dinero sigue en la caja.
        if (!gobApi || typeof gobApi.crearSalida !== 'function') {
            return res.status(503).json({
                message: 'El modulo de gobernanza no esta disponible. Intentalo en un momento.',
            });
        }
        const abierta = await gobApi.salidaAbiertaDe(GroupID, me);
        if (abierta) {
            return res.status(200).json({
                success: true,
                salidaId: abierta.salidaId,
                estado: abierta.estado,
                yaPedida: true,
                message: 'Ya pediste salir de este grupo. La directiva tiene que calcular lo que '
                       + 'te corresponde y llevarlo a la asamblea.',
            });
        }
        const salidaId = await gobApi.crearSalida(GroupID, me);
        res.json({
            success: true,
            salidaId,
            estado: 'solicitada',
            message: 'Pediste salir del grupo. Sigues siendo socia hasta que la asamblea apruebe '
                   + 'tu liquidacion y se te devuelva lo tuyo: tu ahorro, tus acciones y las '
                   + 'utilidades que te correspondan.',
        });
    } catch (error) {
        console.error('[SALIR-GRUPO] Error:', error.message);
        if (responderSiEsCuota(res, error)) return;
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
        const ranges = ['Savings!A2:L', 'Acciones!A2:M', 'SolicitudesPrestamos!A2:I', 'Users!A2:I',
            'Groups!A2:L', 'Loans!A2:J', 'LoanPayments!A2:O'];
        const resp = await sheetsClient.spreadsheets.values.batchGet({ spreadsheetId: SPREADSHEET_ID, ranges });
        const vr = resp.data.valueRanges || [];
        const sav = vr[0]?.values || [];
        const acc = vr[1]?.values || [];
        const sol = vr[2]?.values || [];
        const usr = vr[3]?.values || [];
        const grp = vr[4]?.values || [];
        const loans = vr[5]?.values || [];
        const pagos = vr[6]?.values || [];
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

        // Lo que de verdad se ha desembolsado y lo que de verdad se ha cobrado.
        // El panel calculaba la "recuperacion de prestamos" con un numerador que
        // salia de la hoja Transactions, donde NADA escribe filas de tipo
        // loan_payment: el indicador marcaba 0% pasara lo que pasara. Aqui las
        // dos cifras salen de la misma fuente que el saldo de cada prestamo.
        const prestamosVivos = loans.filter((r) => !['rechazado', 'rejected', 'cancelado']
            .includes((r[7] || '').toString().trim().toLowerCase()));
        const totalPrestado = prestamosVivos.reduce((s2, r) => s2 + parseMoney(r[3]), 0);
        const totalAPagar = prestamosVivos.reduce((s2, r) => s2 + (parseMoney(r[9]) || parseMoney(r[3])), 0);
        const totalPagosAprobados = pagos
            .filter((r) => ['approved', 'aprobado'].includes((r[6] || '').toString().trim().toLowerCase()))
            .reduce((s2, r) => s2 + parseMoney(r[3]), 0);
        const pagosPendientesRevision = pagos
            .filter((r) => !['approved', 'aprobado', 'rejected', 'rechazado']
                .includes((r[6] || '').toString().trim().toLowerCase()))
            .reduce((s2, r) => s2 + parseMoney(r[3]), 0);

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
                // Cartera: numerador y denominador de la MISMA fuente
                totalPrestado: r2(totalPrestado),
                totalAPagar: r2(totalAPagar),
                totalPagosAprobados: r2(totalPagosAprobados),
                pagosPendientesRevision: r2(pagosPendientesRevision),
                saldoPorCobrar: r2(Math.max(0, totalAPagar - totalPagosAprobados)),
                recuperacionPct: totalAPagar > 0
                    ? Math.round((totalPagosAprobados / totalAPagar) * 1000) / 10 : 0,
                prestamosVivos: prestamosVivos.length,
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
    // Los grupos dados de baja no salen en los listados. Sus movimientos se
    // conservan en la hoja para el historial, pero el grupo ya no opera.
    grupos = grupos.filter((g) => (g.Status || g.status || '').toString().trim().toLowerCase() !== 'eliminado');

    // Un no-admin solo ve los grupos a los que pertenece (aislamiento)
    if (req.user && req.user.role !== 'admin') {
      const misGrupos = await getUserGroupIds(req.user.email);
      grupos = grupos.filter((g) => misGrupos.has((g.GroupID || g.groupId || g.id || '').toString().trim()));
    }

    // Las columnas CurrentAmount y Miembros de la hoja solo se escriben al crear
    // el grupo y NADIE las actualiza despues: un grupo con $500 y cinco socias
    // se pintaba como "$0,00 - 0 miembros". Aqui se calculan de verdad, de las
    // mismas hojas de las que sale el tablero, y se devuelven ya listas para que
    // ninguna pantalla tenga que sumarlas por su cuenta.
    try {
      const cliente = await getSheetsClient();
      const lecturas = await cliente.spreadsheets.values.batchGet({
        spreadsheetId: SPREADSHEET_ID,
        ranges: ['Savings!A2:L', 'Acciones!A2:M', 'UserGroupLinks!A2:E'],
      });
      const rangos = lecturas.data.valueRanges || [];
      const sav = rangos[0]?.values || [];
      const acc = rangos[1]?.values || [];
      const links = rangos[2]?.values || [];
      const cent = (x) => Math.round(x * 100) / 100;

      const porGrupo = new Map();
      const anota = (g, campo, valor) => {
        const k = normalizeGroupKey(g);
        if (!k) return;
        if (!porGrupo.has(k)) porGrupo.set(k, { ahorro: 0, acciones: 0, unidades: 0, miembros: 0 });
        porGrupo.get(k)[campo] += valor;
      };
      sav.filter((r) => aporteConfirmado(r[SAVINGS_ESTADO_IDX]))
        .forEach((r) => anota(r[1], 'ahorro', parseMoney(r[2])));
      acc.filter((r) => aporteConfirmado(r[ACCIONES_ESTADO_IDX])).forEach((r) => {
        anota(r[1], 'acciones', parseMoney(r[3]) * parseMoney(r[4]));
        anota(r[1], 'unidades', parseMoney(r[3]));
      });
      links.filter((r) => vinculoVivo(r[4])).forEach((r) => anota(r[1], 'miembros', 1));

      grupos = grupos.map((g) => {
        const k = normalizeGroupKey(g.GroupID || g.groupId || g.id);
        const d = porGrupo.get(k) || { ahorro: 0, acciones: 0, unidades: 0, miembros: 0 };
        return {
          ...g,
          CurrentAmount: cent(d.ahorro + d.acciones),
          Miembros: d.miembros,
          patrimonio: cent(d.ahorro + d.acciones),
          ahorroConfirmado: cent(d.ahorro),
          accionesValor: cent(d.acciones),
          accionesUnidades: cent(d.unidades),
          miembrosActivos: d.miembros,
        };
      });
    } catch (e) {
      // Si no se pueden calcular, se devuelven los grupos sin las cifras al dia
      // en vez de tumbar el listado entero.
      console.error('[OBTENER GRUPOS] no se pudieron calcular las cifras:', e.message);
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
/**
 * GET /api/mi-cupo?groupId=...
 *
 * Cuanto puede pedir esta persona en este grupo, con la MISMA regla que aplica
 * el servidor al recibir la solicitud. La pantalla lo calculaba por su cuenta y
 * con otra formula: enseñaba un limite de $1.470 cuando el real era $570, y
 * dejaba pulsar el boton aunque la persona ya tuviera su prestamo activo. El
 * rechazo llegaba despues de rellenarlo todo.
 *
 * Devuelve tambien la tasa y el ejemplo del total a devolver, para que el socio
 * vea lo que le van a cobrar ANTES de firmar.
 */
app.get('/api/mi-cupo', async (req, res) => {
  try {
    const groupId = normalizeGroupKey(req.query.groupId);
    if (!groupId) return res.status(400).json({ success: false, message: 'Falta el grupo.' });
    if (!(await assertGroupMember(req, res, groupId))) return;

    const email = req.user.email;
    const cfg = await configuracionDelGrupo(groupId);
    const reglas = gobApi ? await gobApi.getReglas(groupId) : null;
    const factor = reglas ? reglas.topePrestamoFactorAhorro : 3;
    const maxActivos = reglas ? reglas.maxPrestamosActivos : 0;

    const ahorro = gobApi ? await gobApi.ahorroConfirmado(email, groupId) : 0;
    const activos = await contarPrestamosActivos(email, groupId);
    const pendientes = await solicitudesPendientesDe(email, groupId);
    // El cupo extraordinario que la asamblea le haya aprobado con aval.
    const aval = gobApi && gobApi.avalVigenteDe
        ? await gobApi.avalVigenteDe(groupId, email) : null;
    // Y lo que ella misma avala a otras: mientras ese prestamo siga vivo, su
    // propio cupo baja en esa cantidad. Avalar tiene que costar algo, o no es
    // un aval: es una firma sin consecuencia.
    const avalando = gobApi && gobApi.loQueAvala
        ? await gobApi.loQueAvala(groupId, email) : 0;
    const cupo = Math.round(
        Math.max(0, (ahorro * factor) + (aval ? aval.cupo : 0) - avalando) * 100) / 100;

    const alcanzoElMaximo = maxActivos > 0
        && (activos.cantidad + pendientes.cuantas) >= maxActivos;
    // Sin interes fijado el cupo es CERO, no el tope teorico. Antes se devolvia
    // el cupo entero con `puedePedir: false` al lado, la pantalla miraba el cupo
    // y dejaba pedir: el prestamo salia al 0 %, $300 prestados y $300 a
    // devolver, sin una sola utilidad para el grupo.
    const disponible = (alcanzoElMaximo || !cfg.tasaConfigurada) ? 0 : cupo;

    let motivo = '';
    if (alcanzoElMaximo) {
      motivo = pendientes.cuantas > 0
        ? `Ya tienes ${activos.cantidad} préstamo(s) activo(s) y ${pendientes.cuantas} `
          + `solicitud(es) esperando respuesta. El reglamento permite un máximo de `
          + `${maxActivos}. Retira la que ya no quieras o espera a que la junta las resuelva.`
        : `Ya tienes ${activos.cantidad} préstamo(s) activo(s) y el reglamento permite `
          + `un máximo de ${maxActivos}. Termina de pagar antes de pedir otro.`;
    } else if (!cfg.tasaConfigurada) {
      motivo = 'El grupo todavía no ha fijado su interés mensual, así que todavía no se '
             + 'pueden dar préstamos. La presidencia debe establecerlo en Más > Reglamento '
             + 'del grupo.';
    } else if (!(ahorro > 0)) {
      motivo = 'Todavía no tienes ahorro confirmado en el grupo, así que aún no tienes cupo. '
             + 'Registra tus aportes y espera a que la tesorería los confirme.';
    }

    res.json({
      success: true,
      groupId,
      ahorroConfirmado: ahorro,
      factor,
      cupoMaximo: cupo,
      disponible,
      prestamosActivos: activos.cantidad,
      solicitudesPendientes: pendientes.cuantas,
      avalRecibido: aval ? { cupo: aval.cupo, de: aval.avalEmail } : null,
      cupoComprometidoAvalando: Math.round(avalando * 100) / 100,
      maxPrestamosActivos: maxActivos,
      interesMensual: cfg.tasaConfigurada ? cfg.tasaMensual : null,
      tasaConfigurada: cfg.tasaConfigurada,
      puedePedir: disponible > 0 && cfg.tasaConfigurada,
      motivo,
    });
  } catch (error) {
    console.error('[MI CUPO]', error);
    if (responderSiEsCuota(res, error)) return;
    res.status(500).json({ success: false, message: 'No se pudo calcular tu cupo.' });
  }
});

// GET /api/admin/participantes
// Para el seguimiento del proyecto: cada grupo con sus integrantes, y de cada
// persona cuando entra y desde que aparato. Solo el administrador de la
// plataforma. NO incluye saldos: para eso estan las pantallas del grupo, que
// las gobierna cada grupo.
app.get('/api/admin/participantes', requireAdmin, async (req, res) => {
    try {
        const sheetsClient = await getSheetsClient();
        const leer = async (rango) => {
            try {
                const r = await sheetsClient.spreadsheets.values.get({
                    spreadsheetId: SPREADSHEET_ID, range: rango,
                });
                return r.data.values || [];
            } catch (e) { return []; }
        };

        // Las cuatro pestanas en UNA sola unidad de cuota, no en cuatro. La
        // pantalla de grupos es la que mas se abre y era la que mas gastaba:
        // Google corta a 60 lecturas por minuto y con varias personas mirando a
        // la vez esto solo se recuperaba esperando.
        const RANGOS = ['Groups!A2:R', 'UserGroupLinks!A2:F', 'Users!A2:I', `${acc.HOJA}!A2:H`];
        let grupos; let vinculos; let usuarios; let accesos;
        try {
            const lote = await sheetsClient.spreadsheets.values.batchGet({
                spreadsheetId: SPREADSHEET_ID, ranges: RANGOS,
            });
            const vr = (lote.data && lote.data.valueRanges) || [];
            if (vr.length !== RANGOS.length) throw new Error('respuesta incompleta');
            [grupos, vinculos, usuarios, accesos] = vr.map((x) => (x && x.values) || []);
        } catch (e) {
            // Un solo rango con una pestana que no existe tumba el lote entero,
            // asi que el respaldo lee una por una y la pantalla sigue abriendo.
            [grupos, vinculos, usuarios, accesos] = await Promise.all(RANGOS.map((r) => leer(r)));
        }

        // --- Accesos agrupados por persona ---
        const porPersona = {};
        for (const fila of accesos) {
            const a = acc.accesoDesdeFila(fila);
            if (!a || !a.email) continue;
            (porPersona[a.email] = porPersona[a.email] || []).push(a);
        }

        // --- Datos de cada usuario ---
        const datosUsuario = {};
        for (const u of usuarios) {
            const correo = normalizeEmailKey(u[1]);
            if (!correo) continue;
            datosUsuario[correo] = {
                nombre: u[0] || correo,
                correo,
                rolPlataforma: (u[3] || 'member').toString().toLowerCase(),
                telefono: u[6] || '',
                alta: u[5] || '',
                estado: (u[8] || 'activo').toString().toLowerCase(),
            };
        }

        // --- Cada grupo con su gente ---
        const salida = grupos
            .filter((g) => (g[0] || '').toString().trim())
            .map((g) => {
                const gid = normalizeGroupKey(g[0]);
                const miembros = vinculos
                    .filter((v) => normalizeGroupKey(v[1]) === gid)
                    .filter((v) => (v[4] || 'activo').toString().toLowerCase() !== 'inactivo')
                    .map((v) => {
                        const correo = normalizeEmailKey(v[0]);
                        const base = datosUsuario[correo] || { nombre: correo, correo, estado: 'sin cuenta' };
                        return {
                            ...base,
                            cargo: (v[3] || 'member').toString().toLowerCase(),
                            desde: v[2] || '',
                            accesos: acc.resumirAccesos(porPersona[correo] || []),
                        };
                    })
                    .sort((a, b) => {
                        const orden = { presidente: 0, tesorero: 1, secretario: 2, member: 3 };
                        return (orden[a.cargo] ?? 9) - (orden[b.cargo] ?? 9);
                    });

                const conAcceso = miembros.filter((m) => m.accesos.entradas > 0);
                const ultimos = miembros
                    .map((m) => m.accesos.ultimo)
                    .filter(Boolean)
                    .sort();

                return {
                    groupId: gid,
                    nombre: g[1] || gid,
                    descripcion: g[2] || '',
                    presidente: normalizeEmailKey(g[3]),
                    creado: g[5] || '',
                    estado: (g[11] || 'activo').toString().toLowerCase(),
                    valorAccion: parseMoney(g[15]),
                    interesMensual: parseMoney(g[16]),
                    miembros,
                    resumen: {
                        integrantes: miembros.length,
                        directivos: miembros.filter((m) => ['presidente', 'tesorero', 'secretario'].includes(m.cargo)).length,
                        hanEntrado: conAcceso.length,
                        nuncaHanEntrado: miembros.length - conAcceso.length,
                        entradasTotales: miembros.reduce((s2, m) => s2 + m.accesos.entradas, 0),
                        ultimaActividad: ultimos.length ? ultimos[ultimos.length - 1] : null,
                    },
                };
            })
            .sort((a, b) => (b.resumen.entradasTotales - a.resumen.entradasTotales));

        // --- Totales de toda la plataforma ---
        const todosLosAccesos = Object.values(porPersona).flat();
        // El porcentaje sale de aqui, igual que en resumirAccesos: la pantalla no
        // lo recalcula, para que no puedan discrepar.
        const contar = (clave) => {
            const c = {};
            const utiles = todosLosAccesos.filter((a) => a && a[clave]);
            utiles.forEach((a) => { c[a[clave]] = (c[a[clave]] || 0) + 1; });
            return Object.entries(c)
                .sort((x, y) => y[1] - x[1])
                .map(([nombre, veces]) => ({
                    nombre,
                    veces,
                    pct: utiles.length ? Math.round((veces / utiles.length) * 1000) / 10 : 0,
                }));
        };
        const franjas = {};
        todosLosAccesos.forEach((a) => {
            if (!a.fecha) return;
            const f = acc.franjaHoraria(a.fecha);
            franjas[f] = (franjas[f] || 0) + 1;
        });

        res.json({
            success: true,
            grupos: salida,
            totales: {
                grupos: salida.length,
                personas: Object.keys(datosUsuario).length,
                conCuentaSinGrupo: Object.keys(datosUsuario)
                    .filter((c) => !vinculos.some((v) => normalizeEmailKey(v[0]) === c)).length,
                accesosRegistrados: todosLosAccesos.length,
                personasQueHanEntrado: Object.keys(porPersona).length,
                dispositivos: contar('dispositivo'),
                sistemas: contar('sistema'),
                navegadores: contar('navegador'),
                franjas,
            },
        });
    } catch (error) {
        console.error('[ADMIN participantes]', error);
        if (responderSiEsCuota(res, error)) return;
        res.status(500).json({ success: false, message: 'Error al armar el informe de participantes.' });
    }
});

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
    if (responderSiEsCuota(res, error)) return;
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

  // Las dos cifras que gobiernan todo el dinero del grupo se validan AQUI, no
  // solo en el navegador: se colaban un -5, un 500 % y hasta "poquito", y con
  // eso el grupo quedaba cobrando de mas o inoperante sin que nadie lo viera.
  const revisarCifra = (valor, etiqueta, { min, max, exigirMayorQueCero }) => {
    if (valor === undefined || valor === null || valor === '') return null;   // no se toca
    const n = parseMoney(valor);
    if (!Number.isFinite(n)) return `${etiqueta} debe ser un numero.`;
    if (exigirMayorQueCero && !(n > 0)) return `${etiqueta} debe ser mayor que cero.`;
    if (n < min || n > max) return `${etiqueta} debe estar entre ${min} y ${max}.`;
    return null;
  };
  const problema =
    revisarCifra(group.ValorAccion ?? group.valorAccion, 'El valor de la accion',
      { min: 0, max: MONTO_MAXIMO, exigirMayorQueCero: true })
    || revisarCifra(group.PorcentajeInteresMensual ?? group.porcentajeInteresMensual,
      'El interes mensual', { min: 0, max: 100, exigirMayorQueCero: false });
  if (problema) {
    return res.status(400).json({ message: problema, motivo: 'configuracion_invalida' });
  }

  try {
    // Normalizar el identificador
    if (!group.GroupID && group.id) group.GroupID = group.id;
    const updated = await groupsService.updateGroup(group);
    res.json({ message: 'Grupo actualizado correctamente.', data: updated });
  } catch (error) {
    console.error('[ACTUALIZAR GRUPO] Error:', error.message, error.stack);
    if (responderSiEsCuota(res, error)) return;
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
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); // Ordenar por fecha descendente

    // Sin recorte fijo. Antes se cortaba a los 10 ultimos movimientos, y como
    // varias pantallas de prestamo leian de aqui, a un socio con diez aportes
    // posteriores el prestamo le desaparecia de la vista. Quien quiera menos,
    // que lo pida con ?limite=
    const limite = Math.max(0, Math.trunc(Number(req.query.limite) || 0));
    const paraEnviar = limite > 0 ? userTransactions.slice(0, limite) : userTransactions;

    res.json({
      transacciones: paraEnviar,
      total: userTransactions.length,
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

/**
 * DONDE VIVEN LAS FOTOS DE LOS COMPROBANTES.
 *
 * Por defecto, al lado del codigo, que es lo que vale en un ordenador. En
 * Render hay que apuntarlo al disco persistente (`UPLOADS_DIR=/var/data`), o
 * cada despliegue borra el historico entero de evidencias y la app sigue
 * ofreciendo un enlace que ya no lleva a ninguna parte.
 */
const CARPETA_SUBIDAS = process.env.UPLOADS_DIR
  ? path.resolve(process.env.UPLOADS_DIR)
  : path.join(__dirname, 'uploads');
const CARPETA_COMPROBANTES = path.join(CARPETA_SUBIDAS, 'payments');
try {
  fs.mkdirSync(CARPETA_COMPROBANTES, { recursive: true });
} catch (e) {
  console.error('[SUBIDAS] no se pudo preparar', CARPETA_COMPROBANTES, e.message);
}
console.log('[SUBIDAS] comprobantes en', CARPETA_COMPROBANTES);

// Configurar multer para subida de imágenes de pagos
const paymentUpload = multer({
  dest: CARPETA_COMPROBANTES,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB máximo
  },
  fileFilter: (req, file, cb) => {
    // El tipo lo declara el CLIENTE, asi que un shell.php con
    // Content-Type: image/png pasaba el filtro. Sirve como primer descarte;
    // el contenido real se comprueba despues con la firma del archivo.
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      const e = new Error('Solo se permiten archivos de imagen');
      e.code = 'ARCHIVO_NO_IMAGEN';
      cb(e, false);
    }
  }
});

/**
 * Comprueba que el archivo es de verdad una imagen, mirando sus primeros bytes.
 * PNG, JPEG, GIF, WEBP, BMP y HEIC, que es lo que sacan los telefonos.
 */
function pareceImagen(ruta) {
  let fd;
  try {
    fd = fs.openSync(ruta, 'r');
    const cabeza = Buffer.alloc(16);
    fs.readSync(fd, cabeza, 0, 16, 0);
    const hex = cabeza.toString('hex').toLowerCase();
    const ascii = cabeza.toString('latin1');
    return hex.startsWith('89504e470d0a1a0a')            // PNG
      || hex.startsWith('ffd8ff')                        // JPEG
      || ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')
      || (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP')
      || ascii.startsWith('BM')                          // BMP
      || ascii.slice(4, 8) === 'ftyp';                   // HEIC/HEIF
  } catch (e) {
    return false;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) { /* ya cerrado */ } }
  }
}

// Endpoint para subir pagos con evidencia fotográfica
app.post('/api/upload-payment', paymentUpload.single('paymentImage'), bloquear((r) => `prestamo:${r.body && r.body.loanId}`), async (req, res) => {
  try {
    // OJO: `status` NO se lee del cuerpo. Se leia, y se escribia tal cual en la
    // hoja: una socia subia su comprobante con status=approved y su deuda bajaba
    // de $336 a $186 sin que la tesoreria mirara nada, y encima el comprobante
    // no salia en la bandeja, asi que nadie se enteraba. Aprobar es de la
    // tesoreria, y pasa por /api/approve-payment.
    const { loanId, amount, paymentDate, description } = req.body;
    // A nombre de quien lo sube. Antes el administrador de la plataforma podia
    // subir el comprobante de cualquier prestamo a nombre de cualquiera.
    const userEmail = req.user.email;

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

    // Cada rechazo borra el archivo que multer ya guardo en disco: si no, cada
    // subida rechazada dejaba una imagen huerfana para siempre.
    const borrarSubida = () => {
      try { if (req.file && req.file.path) fs.unlinkSync(req.file.path); } catch (e) { /* ya no esta */ }
    };

    // El tipo que declara el navegador no vale: un shell.php enviado como
    // image/png pasaba el filtro. Se miran los primeros bytes del archivo.
    if (!pareceImagen(req.file.path)) {
      borrarSubida();
      return res.status(415).json({
        success: false,
        message: 'Ese archivo no es una foto. Sube una imagen del comprobante '
               + '(la que toma la camara del telefono sirve).',
      });
    }

    // El prestamo debe pertenecer a un grupo del usuario. Sin excepcion para el
    // administrador: pagar un prestamo ajeno es mover el dinero de ese grupo.
    let loanGroupDelPago = '';
    {
      const loanGroupMap = await getLoanGroupMap();
      const loanGroup = loanGroupMap.get((loanId || '').toString().trim()) || '';
      loanGroupDelPago = loanGroup;
      const userGroups = await getUserGroupIds(userEmail);
      if (!loanGroup || !userGroups.has(loanGroup)) {
        borrarSubida();
        return res.status(403).json({ success: false, message: 'No puedes registrar pagos de este prestamo.' });
      }
      if (await grupoDadoDeBaja(loanGroup)) {
        borrarSubida();
        return res.status(409).json({
          success: false,
          message: 'Este grupo esta dado de baja y ya no admite movimientos.',
          motivo: 'grupo_dado_de_baja',
        });
      }
    }

    // La fecha del deposito. Va aqui, despues de comprobar que el archivo es una
    // imagen y que el prestamo es del grupo de quien paga: un fallo de fecha no
    // puede tapar esos dos, que son mas graves.
    const avisosDelPago = [];
    {
      const dia = (paymentDate || '').toString().trim().slice(0, 10);
      if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(dia)) {
        borrarSubida();
        return res.status(400).json({
          success: false,
          motivo: 'fecha_invalida',
          message: 'Pon el dia en que hiciste el deposito, con el formato AAAA-MM-DD.',
        });
      }
      const ahora = new Date();
      const hoyLocal = `${ahora.getFullYear()}-`
        + `${String(ahora.getMonth() + 1).padStart(2, '0')}-${String(ahora.getDate()).padStart(2, '0')}`;
      if (dia > hoyLocal) {
        borrarSubida();
        return res.status(400).json({
          success: false,
          motivo: 'fecha_futura',
          message: 'Esa fecha todavia no ha llegado. Pon el dia en que hiciste el deposito.',
        });
      }
      if (dia < '2020-01-01') {
        borrarSubida();
        return res.status(400).json({
          success: false,
          motivo: 'fecha_muy_vieja',
          message: 'Esa fecha es de hace demasiados anos. Revisa el ano que escribiste.',
        });
      }
      // Un pago de un mes ya cerrado SI se acepta: el deposito existio. Solo se
      // avisa de que su interes ira al reparto siguiente, no al de aquel mes.
      try {
        const cerradoHasta = gobApi && typeof gobApi.mesCerradoDelGrupo === 'function'
          ? await gobApi.mesCerradoDelGrupo(loanGroupDelPago) : '';
        if (cerradoHasta && dia.slice(0, 7) <= cerradoHasta) {
          avisosDelPago.push('Ese mes ya se cerro y se repartio. El pago se registra igual, '
            + 'y su interes entrara en el proximo reparto.');
        }
      } catch (e) { /* si no se puede saber, no se avisa */ }
    }

    // Tope de sobrepago: no permitir pagar mas que el saldo pendiente del prestamo
    try {
      const loansResp = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: 'Loans!A:K' });
      const lrow = (loansResp.data.values || []).find(r => (r[0] || '').toString().trim() === (loanId || '').toString().trim());
      if (lrow) {
        // H16: un deposito no puede ser anterior al prestamo que paga. Medido:
        // un pago fechado en 2020 sobre un prestamo de 2026 quedaba aprobado y
        // cubriendo la primera cuota.
        // Se deja un mes de gracia: en la reunion se acuerda un dia y la fila se
        // escribe otro, y el prestamo se fecha el dia en que la junta lo aprueba.
        // Lo que no puede pasar es un deposito de hace anos sobre un prestamo de
        // este ano: eso mete el interes en meses en los que el prestamo no
        // existia y descuadra el reparto de aquel periodo.
        const inicio = (lrow[4] || '').toString().slice(0, 10);
        const dia = (paymentDate || '').toString().slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(inicio) && /^\d{4}-\d{2}-\d{2}$/.test(dia)) {
          const aDias = (f) => Date.UTC(+f.slice(0, 4), +f.slice(5, 7) - 1, +f.slice(8, 10)) / 86400000;
          if (aDias(inicio) - aDias(dia) > 31) {
            borrarSubida();
            return res.status(400).json({
              success: false,
              motivo: 'fecha_anterior_al_prestamo',
              message: `Ese deposito es del ${dia} y el prestamo empezo el ${inicio}. `
                + 'Revisa la fecha que escribiste.',
            });
          }
        }
        // La mora tambien hay que poder pagarla: sin sumarla, el tope dejaba
        // fuera justo el recargo que se acaba de cargar.
        const total = (parseMoney(lrow[9]) || parseMoney(lrow[3]))
            + Math.max(0, parseMoney(lrow[10]) || 0);
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
        // Un comprobante identico esperando revision es un doble envio, no un
        // pago nuevo: se aceptaba dos veces y dejaba dos filas por el mismo
        // deposito en la cola de la tesoreria.
        try {
          const pagosResp = await sheets.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O',
          });
          const yaEsta = (pagosResp.data.values || []).some((f) => (
            (f[2] || '').toString().trim() === (loanId || '').toString().trim()
            && normalizeEmailKey(f[1]) === userEmail
            && Math.abs(parseMoney(f[3]) - montoPago) < 0.005
            && (f[4] || '').toString().slice(0, 10) === (paymentDate || '').toString().slice(0, 10)
            // La descripcion SI cuenta: dos depositos del mismo importe el
            // mismo dia son normales en un banco comunal, y el mensaje pedia
            // "anota la diferencia en la descripcion" mientras el filtro ni la
            // miraba. Si la anota, se acepta.
            && (f[5] || '').toString().trim().toLowerCase()
               === (description || '').toString().trim().toLowerCase()
            // Tambien si el primero YA SE APROBO. Antes el filtro solo miraba la
            // cola de revision, asi que el mismo comprobante volvia a pasar en
            // cuanto la tesorera aprobaba el original.
            && !['rejected', 'rechazado'].includes((f[6] || '').toString().trim().toLowerCase())
          ));
          if (yaEsta) {
            borrarSubida();
            return res.status(409).json({
              success: false,
              message: `Ya tienes un comprobante por $${montoPago} de esa misma fecha esperando revision. `
                     + 'Si es otro pago distinto, cambia la fecha o anota la diferencia en la descripcion.',
              motivo: 'comprobante_duplicado',
            });
          }
        } catch (e) { /* si no se puede comprobar, se sigue: mejor un duplicado que bloquear un pago */ }

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
      'pending_approval',           // Status: SIEMPRE nace por revisar
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
    const estadoPedido = (req.query.estado || 'pending_approval').toString().trim().toLowerCase();
    if (!['pending_approval', 'approved', 'rejected', 'all'].includes(estadoPedido)) {
      return res.status(400).json({
        success: false,
        message: 'Estado invalido. Usa pending_approval, approved, rejected o all.',
      });
    }
    let pendingPayments = rows
      // Por defecto sale todo lo que NO este resuelto. Antes se comparaba
      // exactamente con 'pending_approval', asi que un comprobante con la
      // casilla en blanco, con un espacio detras, o escrito a mano en la hoja
      // por la tesorera, no aparecia NUNCA: quedaba atrapado, ni aprobado ni
      // rechazado, y la socia no tenia forma de saber por que su pago no bajaba
      // su deuda.
      //
      // Con ?estado= se piden los ya resueltos. Sin eso, las pestanas
      // "Aprobados" y "Rechazados" de la pantalla de revision salian siempre
      // vacias y la presidencia no tenia por donde ver el numero de un
      // comprobante aprobado por error para poder devolverlo a revision.
      .filter(row => {
        const suyo = (row[6] || '').toString().trim().toLowerCase();
        if (estadoPedido === 'all') return true;
        if (estadoPedido === 'pending_approval') return !RESUELTOS_DE_PAGO.has(suyo);
        if (estadoPedido === 'approved') return ['approved', 'aprobado'].includes(suyo);
        return ['rejected', 'rechazado'].includes(suyo);
      })
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
      payments: conFotoFirmada(pendingPayments, adminEmail),
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

    // Los prestamos de esta persona. El historial tiene que ser el de SU DEUDA,
    // no el de las filas que ella pulso: en la reunion la socia paga en efectivo
    // y la tesorera lo registra, y asi el abono desaparecia del historial de la
    // deudora y aparecia en el de la tesorera como si fuera deuda suya.
    const misPrestamos = new Set();
    let sePudoLeerPrestamos = true;
    try {
      const loansResp = await sheets.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'Loans!A2:C',
      });
      for (const r of (loansResp.data.values || [])) {
        if (normalizeEmailKey(r[1]) === normalizedUserEmail) {
          misPrestamos.add((r[0] || '').toString().trim());
        }
      }
    } catch (e) {
      // Sin la hoja de prestamos no se puede saber de quien es cada deuda: se
      // vuelve al filtro de antes en vez de devolver una lista vacia.
      sePudoLeerPrestamos = false;
    }

    const payments = rows
      .filter((row) => (sePudoLeerPrestamos
        ? misPrestamos.has((row[2] || '').toString().trim())
        : normalizeEmailKey(row[1]) === normalizedUserEmail))
      .map((row) => {
        const loanId = (row[2] || '').toString().trim();
        const resolvedGroupId = loanGroupMap.get(loanId) || '';
        const loSubio = normalizeEmailKey(row[1]);
        return {
          paymentId: row[0] || '',
          userEmail: row[1] || '',
          // Cuando lo registro otra persona (la tesorera en la reunion) se dice,
          // para que la socia no vea un abono que no recuerda haber subido.
          registradoPorOtra: !!loSubio && loSubio !== normalizedUserEmail,
          registradoPor: row[1] || '',
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
      // La firma es un pase al portador: quien la recibe abre la foto, sin mas
      // preguntas. Por eso solo se firma para quien pide sus PROPIOS pagos.
      // selfEmail (mas arriba) deja que el administrador de la plataforma
      // consulte con el correo de otra persona (?userEmail=socia@...); sin este
      // guardia se llevaba firmas VALIDAS de los comprobantes de cualquier
      // socia de cualquier grupo, que es exactamente lo que el carril del token
      // le niega, porque getUserManagedGroupIds le devuelve un conjunto vacio.
      payments: normalizeEmailKey(req.user.email) === normalizedUserEmail
        ? conFotoFirmada(payments, req.user.email)
        : payments,
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

// ---------------------------------------------------------------------------
//  La foto del comprobante deja de ser publica
// ---------------------------------------------------------------------------
// Un comprobante es evidencia financiera: la foto del deposito, con el nombre
// de la socia, el banco y la cifra. Medido con el servidor del arnes:
//   GET /api/payment-image/<archivo>, sin token y sin ninguna cabecera,
//   respondia HTTP 200 con el archivo entero (bytes servidos = bytes en disco)
//   y con "Cache-Control: public", que autoriza a cualquier proxy del camino a
//   guardarse el comprobante. El mismo servidor respondia 401 a
//   /api/pending-payments sin token: la foto era la unica puerta abierta.
// Lo unico que la protegia era acertar el nombre del archivo, y ese nombre
// esta escrito en la columna H de la hoja LoanPayments, que la tesorera abre
// a mano.
//
// La foto no puede pedir el token: se muestra con <img src> y se abre en otra
// pestana, y ninguno de los dos manda cabeceras. Por eso la autorizacion viaja
// dentro de la propia direccion, firmada con JWT_SECRET.
//
// Al rotar JWT_SECRET caen a la vez las sesiones y estas direcciones. No hay
// que hacer nada: la pantalla vuelve a pedir la lista y recibe firmas nuevas.

const FIRMA_VERSION = 'v1';

// La firma vale entre uno y dos bloques (por defecto: entre 30 y 60 minutos) y
// dentro de un mismo bloque la direccion de una foto es SIEMPRE la misma
// cadena. Que se repita no es un detalle de estilo: si se firmara con la hora
// exacta, la direccion cambiaria en cada recarga de la lista y el navegador
// volveria a bajar las fotos enteras, porque la cache se lleva por direccion.
// Y media hora larga es mas de lo que una socia tiene abierto el historial,
// asi que no hace falta ningun endpoint para renovar la firma: si vence, se
// recarga la lista y ya.
const FIRMA_BLOQUE_MIN = Math.max(1, Number(process.env.FIRMA_COMPROBANTE_MINUTOS) || 30);
const FIRMA_BLOQUE_SEG = FIRMA_BLOQUE_MIN * 60;

const aBase64Url = (buf) => buf.toString('base64')
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Huella corta del correo de quien pidio la foto.
 *
 * En la direccion NO va el correo en claro: una direccion acaba en el historial
 * del navegador, en el log del servidor y en el grupo de WhatsApp, y el correo
 * de una socia es un dato personal. Con la huella se puede anular lo ya emitido
 * sin publicar el correo de nadie.
 */
function huellaDeCorreo(email) {
  const correo = normalizeEmailKey(email);
  if (!correo) return '';
  return crypto.createHmac('sha256', JWT_SECRET)
    .update(`quien|${correo}`)
    .digest('hex')
    .slice(0, 12);
}

/** La firma de una direccion concreta. */
function firmarComprobante(archivo, vence, quien) {
  return aBase64Url(crypto.createHmac('sha256', JWT_SECRET)
    .update(`${FIRMA_VERSION}|${archivo}|${vence}|${quien}`)
    .digest()
    // 128 bits: no se aciertan probando, y acortan la direccion, que viaja por
    // datos moviles en telefonos baratos. Medido: 22 caracteres.
    .subarray(0, 16));
}

/**
 * Firmas anuladas antes de que caduquen, por persona.
 *
 * Una direccion ya firmada no se le puede quitar del telefono a nadie: si a una
 * socia la sacan del grupo, las que se llevo seguirian valiendo hasta caducar.
 * Aqui se anota el instante en que dejo de tener derecho, y toda firma emitida
 * antes de ese instante deja de valer en el acto.
 *
 * Vive en memoria, como el freno de intentos de entrada: el servidor corre en
 * una sola instancia. Si se reinicia se pierde el apunte y no importa, porque
 * la caducidad sigue en pie. Y hay un caso que esto NO cubre y conviene tenerlo
 * escrito: si la tesorera borra una fila de UserGroupLinks desde la propia hoja
 * de calculo, no pasa por ningun endpoint y no se entera nadie. Ahi lo unico
 * que protege es la caducidad.
 */
const comprobantesAnulados = new Map();

function revocarComprobantes(email) {
  const huella = huellaDeCorreo(email);
  if (!huella) return;
  const ahora = Date.now();
  comprobantesAnulados.set(huella, ahora);
  // La tabla no puede crecer sin fin: pasada la caducidad maxima, el apunte ya
  // no anula nada que siguiera vivo.
  const limite = ahora - (2 * FIRMA_BLOQUE_SEG * 1000);
  for (const [k, cuando] of comprobantesAnulados) {
    if (cuando < limite) comprobantesAnulados.delete(k);
  }
}

/**
 * Direccion firmada de una foto, RELATIVA al backend.
 *
 * Se devuelve relativa a proposito: el backend vive detras del proxy de Render,
 * y adivinar ahi si el navegador entro por http o por https es la forma mas
 * barata de romper todas las fotos a la vez. La pantalla la completa con
 * buildApiUrl, que es quien sabe a que backend esta hablando.
 */
function rutaFirmadaDeComprobante(nombreArchivo, email) {
  const archivo = path.basename((nombreArchivo || '').toString().trim());
  const quien = huellaDeCorreo(email);
  if (!archivo || !quien) return '';
  const ahora = Math.floor(Date.now() / 1000);
  // Redondeado al bloque para que la direccion se repita. Sumando DOS bloques,
  // la firma nunca nace con menos de un bloque de vida: si se sumara uno solo,
  // la que se emitiera en el ultimo minuto del bloque duraria ese minuto.
  const vence = (Math.floor(ahora / FIRMA_BLOQUE_SEG) + 2) * FIRMA_BLOQUE_SEG;
  const firma = firmarComprobante(archivo, vence, quien);
  return `/api/payment-image/${encodeURIComponent(archivo)}`
       + `?vence=${vence}&quien=${quien}&firma=${firma}`;
}

/** Anade a cada pago la direccion firmada de su foto, a nombre de quien la pide. */
function conFotoFirmada(pagos, email) {
  return (pagos || []).map((pago) => ({
    ...pago,
    imagenUrl: pago && pago.imageFilename
      ? rutaFirmadaDeComprobante(pago.imageFilename, email)
      : '',
  }));
}

/**
 * Comprueba la firma que trae la direccion. No lee la hoja: son cuentas en
 * memoria, porque cada foto que se abre no puede costar una consulta a Google
 * (hoja.js deja 20 lecturas por minuto y por persona; una tesorera revisando
 * 20 comprobantes se comeria la cuota del grupo entero).
 * Devuelve 'vale' o el motivo por el que no.
 */
function comprobarFirmaDeComprobante(archivo, consulta) {
  const vence = (consulta.vence || '').toString();
  const quien = (consulta.quien || '').toString();
  const firma = (consulta.firma || '').toString();

  // Se filtra la FORMA antes de tocar crypto. timingSafeEqual compara bytes y
  // revienta si los dos buffers miden distinto: comprobado en node v22.17.1,
  // 22 letras acentuadas miden 22 caracteres pero 44 bytes, asi que un guardia
  // por longitud de cadena no basta. Como este manejador es async, Express 5
  // convertia esa excepcion en un 500 "Ocurrio un error en el servidor" en vez
  // de decir que la direccion no vale.
  if (!/^\d{1,12}$/.test(vence)) return 'no_coincide';
  if (!/^[0-9a-f]{12}$/.test(quien)) return 'no_coincide';
  if (!/^[A-Za-z0-9_-]{22}$/.test(firma)) return 'no_coincide';

  // El nombre del archivo y la caducidad van DENTRO de la firma: cambiar
  // ?vence= a mano para alargar el permiso, o pegar la firma de una foto en la
  // direccion de otra, deja de cuadrar.
  const esperada = firmarComprobante(archivo, vence, quien);
  const a = Buffer.from(firma, 'utf8');
  const b = Buffer.from(esperada, 'utf8');
  if (a.length !== b.length) return 'no_coincide';
  if (!crypto.timingSafeEqual(a, b)) return 'no_coincide';

  if (Number(vence) < Math.floor(Date.now() / 1000)) return 'caducada';

  // La hora de emision no viaja en la direccion: se deduce del vencimiento, que
  // si va dentro de lo firmado. Queda hasta un bloque ANTES de la emision real,
  // o sea que anula de mas y nunca de menos: quien pierde el acceso se queda
  // fuera seguro, y quien lo recupera espera como mucho al bloque siguiente.
  // Falla del lado de cerrar, que es el lado correcto cuando hay dinero.
  const emitida = Number(vence) - 2 * FIRMA_BLOQUE_SEG;
  const anuladaDesde = comprobantesAnulados.get(quien);
  if (anuladaDesde && emitida * 1000 < anuladaDesde) return 'anulada';
  return 'vale';
}

/**
 * Quita la firma del texto que se va al log.
 *
 * Medido: el log del servidor imprime la direccion entera. Firmar la foto y
 * despues guardar la firma en claro en el log deja el agujero donde estaba,
 * solo que ahora con fecha de caducidad.
 */
function ocultarFirma(url) {
  return (url || '').toString().replace(/([?&])firma=[^&]*/g, '$1firma=***');
}

/**
 * Sin firma en la direccion hace falta token Y que el comprobante sea suyo o de
 * un grupo que dirige. Antes bastaba con acertar el nombre del archivo: medido,
 * el token de una persona AJENA al grupo bajaba la foto igual (HTTP 200).
 */
async function puedeVerComprobante(usuario, nombreArchivo) {
  const correo = normalizeEmailKey(usuario && usuario.email);
  if (!correo || !nombreArchivo) return false;
  const sheets = await getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O',
  });
  const fila = (resp.data.values || [])
    .find((r) => (r[7] || '').toString().trim() === nombreArchivo);
  if (!fila) return false;
  // Su propio comprobante, siempre.
  if (normalizeEmailKey(fila[1]) === correo) return true;
  const grupo = (await getLoanGroupMap()).get((fila[2] || '').toString().trim()) || '';
  if (!grupo) {
    // La hoja la edita gente: un LoanID con un espacio de mas, o un prestamo
    // borrado, deja el comprobante sin grupo que resolver. Se niega, pero queda
    // anotado con su identificador para que se pueda arreglar la fila.
    console.warn('[IMAGEN COMPROBANTE] comprobante sin grupo resoluble:', (fila[0] || '').toString());
    return false;
  }
  // Los comprobantes de las demas los abre solo quien los revisa: presidencia y
  // tesoreria. El administrador de la plataforma no, porque
  // getUserManagedGroupIds le devuelve un conjunto vacio: no gobierna el dinero
  // de ningun grupo. La secretaria tampoco, y eso no le quita nada, porque
  // /api/pending-payments ya filtra por este mismo conjunto y a ella le
  // devuelve la lista vacia.
  return (await getUserManagedGroupIds(correo)).has(grupo);
}

app.get('/api/payment-image/:filename', async (req, res) => {
  // Sanitizar: path.basename elimina cualquier ../ y previene path traversal.
  // La cadena de consulta no llega hasta aqui (Express ya la separo), asi que
  // los parametros de la firma no abren ninguna puerta nueva a la carpeta.
  const filename = path.basename(req.params.filename || '');
  const baseDir = CARPETA_COMPROBANTES;
  const imagePath = path.join(baseDir, filename);

  // Defensa adicional: el archivo resuelto debe quedar dentro de baseDir
  if (!filename || !imagePath.startsWith(baseDir)) {
    return res.status(400).json({ success: false, message: 'Nombre de archivo invalido' });
  }

  try {
    if (req.query.firma) {
      // Carril 1: la direccion viene firmada. Es la que usan la etiqueta <img>
      // de la tesoreria y el enlace "Ver evidencia" del historial.
      const veredicto = comprobarFirmaDeComprobante(filename, req.query);
      if (veredicto !== 'vale') {
        const mensajes = {
          caducada: 'El enlace de esta foto ya venció. Vuelve atrás, actualiza la lista de pagos y ábrela otra vez.',
          anulada: 'Ya no perteneces a ese grupo, así que no podemos mostrarte este comprobante.',
        };
        return res.status(403).json({
          success: false,
          motivo: veredicto,
          message: mensajes[veredicto]
            || 'Este enlace de la foto no es válido. Vuelve a la lista de pagos y ábrela desde ahí.',
        });
      }
    } else if (!(await puedeVerComprobante(req.user, filename))) {
      // Carril 2: sin firma pero con token (una consulta directa, las pruebas).
      // El token dice quien eres, no de que grupo es este comprobante: eso hay
      // que mirarlo en la hoja.
      //
      // Un solo mensaje para "no existe" y para "no es tuyo": distinguirlos
      // convertia el endpoint en un oraculo de que comprobantes existen.
      return res.status(403).json({
        success: false,
        message: 'No podemos mostrarte este comprobante.',
      });
    }
  } catch (error) {
    // Sin este try/catch, el freno de lecturas de hoja.js (que lanza a
    // proposito cuando se pasa de 20 por minuto y por persona) le sacaba a la
    // tesorera un 500 generico en vez de decirle que espere unos segundos.
    console.error('[IMAGEN COMPROBANTE] Error:', error.message);
    if (responderSiEsCuota(res, error)) return;
    return res.status(500).json({
      success: false,
      message: 'No se pudo comprobar quién puede ver esta foto. Inténtalo de nuevo.',
    });
  }

  // Verificar que el archivo existe
  if (!fs.existsSync(imagePath)) {
    return res.status(404).json({ success: false, message: 'Imagen no encontrada' });
  }

  // 'private': la autorizacion va dentro de la direccion, asi que ningun proxy
  // compartido puede guardarsela para servirsela a otro. Medido: hoy sale como
  // "public, max-age=0", que es justo lo contrario. El navegador si la guarda
  // mientras la firma siga viva, y como la direccion se repite dentro del
  // bloque, ahi la cache acierta de verdad. Medido tambien: esta cabecera
  // sobrevive a sendFile, porque send solo pone la suya si no hay ninguna.
  const segundos = req.query.firma
    ? Math.max(0, Number(req.query.vence) - Math.floor(Date.now() / 1000))
    : 0;
  res.setHeader('Cache-Control', `private, max-age=${segundos}`);

  // Servir la imagen
  res.sendFile(imagePath);
});
app.get('/api/payment-image/:filename', (req, res) => {
  // Sanitizar: path.basename elimina cualquier ../ y previene path traversal
  const filename = path.basename(req.params.filename || '');
  const baseDir = CARPETA_COMPROBANTES;
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
      // Con Number(), "2,5" y "2%" daban null. La hoja la escribe la gente.
      interestRate: parseMoney(groupRow[interestRateCol >= 0 ? interestRateCol : 13]),
      createdDate: groupRow[createdDateCol] || '',
      description: groupRow[descriptionCol] || ''
    };

    res.json({ 
      success: true, 
      group: groupInfo
    });

  } catch (error) {
    console.error('[GROUP INFO] Error:', error.message, error.stack);
    if (responderSiEsCuota(res, error)) return;
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
    if (responderSiEsCuota(res, error)) return;
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
    if (responderSiEsCuota(res, error)) return;
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
    if (responderSiEsCuota(res, error)) return;
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
        // El mensaje anterior era un callejon sin salida: la tesorera leia "No se puede
        // volver a procesar" y no habia nada mas que hacer, ni en la app ni en la hoja.
        motivo: 'ya_revisado',
        puedeRevertir: true,
        message: `Este comprobante ya fue ${enCastellano} por ${paymentData[12] || 'la junta'}. `
          + 'Si fue un error, la presidencia puede devolverlo a revisión indicando el motivo.',
        estado: estadoPago,
      });
    }
    const loanGroupMap = await getLoanGroupMap();
    const loanGroupId = loanGroupMap.get(loanId) || '';

    // El comprobante lo revisa la tesoreria del grupo, sin excepcion para el
    // administrador de la plataforma: dar por bueno el pago de un socio es
    // gobernar el dinero del grupo, y eso no le corresponde.
    if (!loanGroupId) {
      return res.status(403).json({
        success: false,
        message: 'No se pudo determinar el grupo del pago.'
      });
    }
    if (!(await canManageGroup(adminEmail, loanGroupId))) {
      return res.status(403).json({
        success: false,
        message: 'No tienes permisos para aprobar pagos de este grupo.'
      });
    }

    // SEPARACION DE FUNCIONES. La presidencia esta en GROUP_ADMIN_ROLES, asi que puede
    // aprobar comprobantes; con el endpoint nuevo tambien puede deshacerlos. Sin este
    // freno, una sola persona rechaza, revierte y aprueba, y una deuda de $120 desaparece
    // en dos peticiones sin que nadie mas mire. La marca se lee de ApprovalNotes porque es
    // lo que la tesorera ve al abrir la hoja; el registro que manda es la bitacora.
    const quienRevirtio = (/\[REVERTIDO por ([^\s\]]+)/i.exec((paymentData[14] || '').toString()) || [])[1];
    if (quienRevirtio && normalizeEmailKey(quienRevirtio) === adminEmail) {
      return res.status(403).json({
        success: false,
        motivo: 'lo_devolviste_tu',
        message: 'Tú misma devolviste este comprobante a revisión, así que no puedes '
          + 'resolverlo. Debe revisarlo otra persona de la junta.'
      });
    }

    // Y NADIE DA POR BUENO EL PAGO DE SU PROPIA DEUDA. Es el mismo principio que
    // el de no votar tu propia solicitud, aplicado al otro extremo del prestamo.
    // Medido antes de este freno: la tesorera subia el comprobante de su propio
    // prestamo y lo aprobaba ella misma; $336 de deuda a $0,00 en dos peticiones,
    // sin que nadie de la junta mirara nada.
    const duenoDelPrestamo = await duenoDeUnPrestamo(loanId);
    if (duenoDelPrestamo && duenoDelPrestamo === adminEmail) {
      return res.status(403).json({
        success: false,
        motivo: 'es_tu_deuda',
        message: 'Este comprobante abona TU préstamo, así que no puedes aprobarlo tú. '
          + 'Tiene que revisarlo otra persona de la junta.'
      });
    }
    // Quien registra un pago tampoco lo da por bueno: si sube el comprobante y
    // acto seguido lo aprueba, la revision no ha existido.
    const quienLoSubio = normalizeEmailKey(paymentData[1]);
    if (quienLoSubio && quienLoSubio === adminEmail && duenoDelPrestamo !== adminEmail) {
      return res.status(403).json({
        success: false,
        motivo: 'tu_lo_registraste',
        message: 'Tú registraste este comprobante, así que la revisión le toca a otra '
          + 'persona de la junta.'
      });
    }
    
    // Por PaymentID, no por numero de fila: si desaparece una fila de mas
    // arriba entre la lectura y la escritura, se daba por aprobado el
    // comprobante de otra persona.
    await actualizarFilaPorClave(sheets, {
      spreadsheetId: SPREADSHEET_ID,
      hoja: 'LoanPayments',
      ultimaColumna: 'O',
      desdeColumna: 'G',
      indice: paymentRowIndex,
      claveCol: 0,
      clave: paymentId,
      construir: (filaActual) => {
        const f = filaActual || paymentData;
        return [
          newStatus,      // Status (G)
          f[7] || '',     // ImageFilename (H) - mantener
          f[8] || '',     // OriginalImageName (I) - mantener
          f[9] || '',     // ImagePath (J) - mantener
          f[10] || '',    // ImageSize (K) - mantener
          f[11] || '',    // CreatedAt (L) - mantener
          adminEmail,     // ApprovedBy (M)
          approvalDate,   // ApprovalDate (N)
          notes || '',    // ApprovalNotes (O)
        ];
      },
    });

    // Un prestamo saldado se marca como tal. Antes seguia 'aprobado' para
    // siempre: su cuadro de cuotas se pintaba entero el resto de la vida del
    // grupo, y con cinco prestamos historicos la pantalla eran treinta filas.
    if (newStatus === 'approved') {
      try {
        const lResp = await sheets.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID, range: 'Loans!A2:K',
        });
        const lrows = lResp.data.values || [];
        const li = lrows.findIndex((r) => (r[0] || '').toString().trim() === loanId);
        if (li >= 0) {
          const total = (parseMoney(lrows[li][9]) || parseMoney(lrows[li][3]))
            + Math.max(0, parseMoney(lrows[li][10]) || 0);
          const pagado = await getApprovedPaymentsTotal(loanId);
          const estadoActual = (lrows[li][7] || '').toString().trim().toLowerCase();
          if (total > 0 && pagado >= total - 0.009
            && ['aprobado', 'approved', 'activo'].includes(estadoActual)) {
            await actualizarFilaPorClave(sheets, {
              spreadsheetId: SPREADSHEET_ID,
              hoja: 'Loans',
              ultimaColumna: 'K',
              desdeColumna: 'H',
              indice: li,
              claveCol: 0,
              clave: loanId,
              construir: (filaActual) => {
                const f = filaActual || lrows[li];
                return ['pagado', f[8] || '', f[9] || '', f[10] || ''];
              },
            });
          }
        }
      } catch (e) {
        // Que no se marque no cambia el dinero: el saldo se calcula de los
        // pagos, no del estado. Se registra y se sigue.
        console.error('[APPROVE PAYMENT] no se pudo marcar el prestamo como pagado:', e.message);
      }
    }

    // Un comprobante rechazado ya no prueba nada, y su foto se quedaba en el
    // disco para siempre: 3.858 archivos acumulados, muchos de pagos que nunca
    // se aceptaron. La fila se queda (el historial es la prueba de que se
    // reviso); lo que se va es la imagen.
    if (newStatus === 'rejected') {
      const archivo = (paymentData[7] || '').toString().trim();
      if (archivo && /^[A-Za-z0-9._-]+$/.test(archivo) && !archivo.includes('..')) {
        try {
          fs.unlinkSync(path.join(CARPETA_COMPROBANTES, archivo));
        } catch (e) { /* ya no estaba: nada que borrar */ }
      }
    }

    console.log(`[APPROVE PAYMENT] Pago ${paymentId} ${action}d por ${adminEmail}`);
    
    res.json({ 
      success: true, 
      message: `Pago ${action === 'approve' ? 'aprobado' : 'rechazado'} correctamente`,
      paymentId: paymentId,
      newStatus: newStatus
    });

  } catch (error) {
    console.error('[APPROVE PAYMENT] Error:', error.message, error.stack);
    if (responderSiEsCuota(res, error)) return;
    res.status(500).json({ 
      success: false, 
      message: 'Error al procesar la aprobación: ' + error.message 
    });
  }
});

// --- ENDPOINTS DE AHORROS ---
const savingsService = require('./services/savingsService');

// POST /api/savings - Agregar nuevo ahorro
app.post('/api/savings', bloquear((r) => (
  `aporte:${normalizeEmailKey(r.user && r.user.email)}:${(r.body && r.body.clave) || Math.random()}`
)), async (req, res) => {
  try {
    const { groupId, tipo, monto, descripcion, meta, fecha } = req.body;
    // A nombre de quien lo manda, sin excepcion para el administrador de la
    // plataforma. Con selfEmail podia atribuirle un ahorro a cualquier socio de
    // cualquier grupo, y en un grupo sin aprobacion de aportes nacia
    // confirmado: dinero que esa persona nunca deposito.
    const email = req.user.email;

    // El monto tiene que ser un numero o una cadena, no un array ni un objeto:
    // parseMoney convertia [999] en 999 y "1e9" en 19.
    if (monto !== undefined && monto !== null
        && typeof monto !== 'number' && typeof monto !== 'string') {
      return res.status(400).json({ success: false, message: 'El monto debe ser un numero.' });
    }
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

    // La fecha del aporte la pone quien registra: se anota lo del mes pasado en
    // la reunion de este. Solo se comprueba que sea un dia real y que no este
    // en el futuro (nadie aporta manana).
    const diaHoy = new Date();
    const hoyLocalStr = `${diaHoy.getFullYear()}-`
      + `${String(diaHoy.getMonth() + 1).padStart(2, '0')}-${String(diaHoy.getDate()).padStart(2, '0')}`;
    let fechaAporte = '';
    if (fecha !== undefined && fecha !== null && `${fecha}`.trim() !== '') {
      fechaAporte = `${fecha}`.trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaAporte)) {
        return res.status(400).json({
          success: false,
          message: 'La fecha del aporte tiene que ser un dia real, con el formato AAAA-MM-DD.',
        });
      }
      if (fechaAporte > hoyLocalStr) {
        return res.status(400).json({
          success: false,
          message: 'No se puede registrar un aporte con fecha futura.',
        });
      }
    }

    // El usuario debe pertenecer al grupo donde registra el ahorro
    if (!(await assertGroupMember(req, res, groupId))) return;

    // Pertenencia REAL, igual que /api/registrar-ahorros. `assertGroupMember`
    // tiene atajo de administrador, asi que por aqui se seguia colando una fila
    // de ahorro en la caja de cualquier grupo.
    {
      const sheetsPert = await getSheetsClient();
      if (!(await userBelongsToGroupSafe(sheetsPert, email, groupId))) {
        return res.status(403).json({ success: false, message: 'No perteneces a este grupo.' });
      }
    }
    if (!(await assertGrupoActivo(req, res, groupId))) return;

    // Si el telefono manda su clave y ya hay un movimiento con ella, es el mismo
    // envio repetido: se devuelve el que ya existe en vez de grabar otro.
    const movIdSav = movIdDeClave('sav', email, req.body?.clave) || nuevoMovId('sav');
    const yaEstaba = await movimientoYaRegistrado('Savings', 'L', 10, movIdSav);
    if (yaEstaba) {
      return res.json({
        success: true,
        repetido: true,
        movId: movIdSav,
        estado: (yaEstaba[6] || 'confirmado').toString().trim().toLowerCase(),
        message: 'Este aporte ya estaba registrado; no se duplico.',
      });
    }

    // El aporte minimo y el maximo del reglamento se guardaban y NO se
    // aplicaban en ningun sitio: con un minimo de $20 fijado por la presidencia,
    // un aporte de $3 entraba con HTTP 200. Es una condicion que el grupo acordo
    // en asamblea; tiene que gobernar de verdad.
    if (gobApi && typeof gobApi.getReglas === 'function') {
      try {
        const reglasGrupo = await gobApi.getReglas(groupId);
        const minimo = Number(reglasGrupo?.aporteMinimo) || 0;
        const maximo = Number(reglasGrupo?.aporteMaximo) || 0;
        if (minimo > 0 && montoAporte < minimo) {
          return res.status(400).json({
            success: false,
            motivo: 'bajo_el_minimo',
            message: `El reglamento del grupo pide un aporte minimo de $${minimo.toFixed(2)}. `
                   + 'Si quieres cambiarlo, se decide en asamblea.',
          });
        }
        if (maximo > 0 && montoAporte > maximo) {
          return res.status(400).json({
            success: false,
            motivo: 'sobre_el_maximo',
            message: `El reglamento del grupo pone un tope de $${maximo.toFixed(2)} por aporte. `
                   + 'Puedes registrarlo en varias partes o cambiar el tope en asamblea.',
          });
        }
      } catch (e) {
        console.error('[ADD SAVING] no se pudo leer el reglamento del grupo:', e.message);
      }
    }

    const crudoSav = await estadoInicialAporte(groupId, req.user.email);
    const { estado: estadoNuevo, nota: notaSav } = partirEstadoAporte(crudoSav);
    const result = await savingsService.addSaving(SPREADSHEET_ID, {
      email,
      groupId,
      tipo,
      monto,
      descripcion,
      meta,
      estado: estadoNuevo,
      registradoPor: req.user.email,
      fecha: fechaAporte,
      movId: movIdSav
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
    if (responderSiEsCuota(res, error)) return;
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
  // La tasa que se guarda en cada compra es la del grupo, y el grupo la escribe
  // como interes MENSUAL (asi la pide la pantalla y asi la usan los prestamos).
  // Antes se leia como anual y se dividia entre 12: las utilidades salian doce
  // veces mas bajas de lo que correspondia, sin avisar a nadie.
  const CONFIG = {
    valorNominal: 10.00,           // Valor por accion si la compra no trae el suyo
    tasaMensualMax: 0.10,          // Tope de cordura: 10% mensual. Si recorta, se informa
    capitalizaMensual: false,      // false = interes simple sobre la inversion
    mesCorteExcedentes: 12,        // Mes de corte para excedentes (diciembre)
    separaExcedentes: false
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
    const tasaPedida = Number(accion.tasaInteres) / 100 || 0;   // ya en tanto por uno
    const tasaMensualLote = Math.min(tasaPedida, CONFIG.tasaMensualMax);
    const recortada = tasaPedida > CONFIG.tasaMensualMax;
    
    if (cantidad > 0 && valorAccion > 0 && tasaMensualLote > 0) {
      lotes.push({
        id: `lote_${index}`,
        fechaCompra,
        mesCompra: fechaCompra.toISOString().substring(0, 7),
        acciones: cantidad,
        valorNominal: valorAccion,
        valorInversion: cantidad * valorAccion,
        tasaMensual: tasaMensualLote,
        tasaMensualPedida: tasaPedida,
        tasaRecortada: recortada,
        mesesDevengados: 0,
        interesAcumulado: 0,
        baseCapitalizada: cantidad * valorAccion // Base inicial
      });
      
      console.log(`[INTERESES ACCIONES] Lote ${index}: ${cantidad} acciones x $${valorAccion} = $${cantidad * valorAccion} @ ${(tasaMensualLote*100).toFixed(2)}% mensual`);
    } else {
      console.log(`[INTERESES ACCIONES] Lote invalido ${index}:`, { cantidad, valorAccion, tasaMensualLote });
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
          tasaMensual: lote.tasaMensual
        });
      }
    });
    
    if (baseDevengable > 0) {
      // 5-7. INTERES DEL MES, LOTE POR LOTE
      // Cada compra rinde con SU tasa y sobre SU base. Promediar las tasas de
      // todos los lotes (como se hacia antes) mezclaba compras hechas con
      // reglas distintas: unas cobraban de mas y otras de menos. Ademas
      // entraban en el promedio lotes que ese mes ni siquiera devengaban.
      let interesMes = 0;
      lotes.forEach((lote) => {
        if (lote.mesCompra >= mesActual) return;      // aun no devenga
        const baseLote = CONFIG.capitalizaMensual
          ? (lote.valorInversion + lote.interesAcumulado)
          : lote.valorInversion;
        const interesLote = baseLote * lote.tasaMensual;
        lote.interesAcumulado += interesLote;
        interesMes += interesLote;
      });

      // Tasa efectiva del mes: lo ganado sobre lo invertido. Con una sola tasa
      // coincide con ella; con varias, refleja la mezcla real de ese mes.
      const tasaMensual = baseDevengable > 0 ? interesMes / baseDevengable : 0;


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
  // El recorte por el tope de cordura NO puede ser silencioso: si a alguien se
  // le calcula menos interes del que su grupo acordo, tiene que constar.
  const lotesRecortados = lotes.filter((lote) => lote.tasaRecortada);
  lotesRecortados.forEach((lote) => {
    console.log(`[INTERESES ACCIONES] AVISO: el lote ${lote.id} pedia `
      + `${(lote.tasaMensualPedida * 100).toFixed(2)}% mensual y se aplico `
      + `${(CONFIG.tasaMensualMax * 100).toFixed(2)}%, el maximo admitido.`);
  });
  
  return {
    lotesRecortados: lotesRecortados.map((l) => ({
      id: l.id, acciones: l.acciones,
      tasaPedida: l.tasaMensualPedida, tasaAplicada: l.tasaMensual,
    })),
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
    
    // Lo que de VERDAD se ha abonado por utilidades: son filas de ahorro con
    // tipo 'utilidad', asi que ya estan sumadas dentro de totalAhorros.
    const utilidadesAbonadas = Math.round(historialAhorros
      .filter((a) => (a.tipo || '').toString().toLowerCase() === 'utilidad')
      .reduce((sum, a) => sum + Number(a.monto || 0), 0) * 100) / 100;

    // El patrimonio es lo que la persona TIENE: su ahorro (que ya incluye las
    // utilidades abonadas) mas el valor de sus acciones. Antes se le sumaba
    // ademas una proyeccion teorica de intereses sobre las acciones que nadie
    // habia abonado: un socio con $500 en acciones y $50 de reparto recibido
    // veia $590, con $40 salidos de la nada.
    const totalPatrimonio = Math.round((totalAhorros + totalAcciones) * 100) / 100;

    // La proyeccion sigue calculandose, pero como ESTIMACION de lo que las
    // acciones podrian rendir, no como dinero disponible.
    const utilidadesEstimadas = totalUtilidadesAcumuladas;
    
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
      
      // La fecha puede venir como numero de serie de Excel o vacia: una hoja la
      // escribe la gente. Antes `saving.fecha.startsWith` reventaba con 500 y
      // el socio no podia abrir su panel.
      const monthSavings = historialAhorros.filter(saving =>
        String(saving && saving.fecha != null ? saving.fecha : '').startsWith(monthStr)
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
      // Lo REALMENTE abonado. Ya esta dentro de totalAhorros y de
      // totalPatrimonio: se devuelve aparte solo para poder mostrarlo.
      totalUtilidades: utilidadesAbonadas,
      // Proyeccion de lo que las acciones podrian rendir. NO es dinero que se
      // tenga, y por eso NO entra en el patrimonio.
      utilidadesEstimadas,
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
    if (responderSiEsCuota(res, error)) return;
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
        lotesConTasaAjustada: (interesesResult.lotesRecortados || []).length,
        topeMensualAplicado: interesesResult.configuracion.tasaMensualMax,
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
    if (responderSiEsCuota(res, error)) return;
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
    if (responderSiEsCuota(res, error)) return;
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
    if (responderSiEsCuota(res, error)) return;
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
    if (responderSiEsCuota(res, error)) return;
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
    configuracionDelGrupo,
    contarPrestamosActivos,
    getLoanGroupMap,
    bloquear,
});
console.log('[BACKEND] Modulo de control interno registrado (/api/gob/*).');

// Informe de evaluacion de la plataforma (/api/admin/metricas).
require('./informe').register(app, {
    getSheetsClient,
    SPREADSHEET_ID,
    normalizeEmailKey,
    normalizeGroupKey,
    parseMoney,
    requireAdmin,
    hojaAccesos: acc.HOJA,
    accesoDesdeFila: acc.accesoDesdeFila,
});
console.log('[BACKEND] Informe de evaluacion registrado (/api/admin/metricas).');

require('./demo').register(app, {
    getSheetsClient,
    SPREADSHEET_ID,
    normalizeEmailKey,
    normalizeGroupKey,
    normalizeGroupRole,
    requireAdmin,
    bloquear,
    responderSiEsCuota,
    linkIsActive,
});
console.log('[BACKEND] Datos de demostracion registrados (/api/admin/demo/*).');

// ---------------------------------------------------------------------------
//  Manejador global de errores
// ---------------------------------------------------------------------------
// Va el ULTIMO, para recoger lo que se escape de los try/catch de cada
// endpoint. Sin el, un cuerpo demasiado grande o un fallo de multer devolvian
// la pagina de error de Express con el stack entero y las rutas del servidor.
// El detalle se queda en el log; al cliente le llega lo justo para saber que
// hacer.
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  console.error('[ERROR NO CAPTURADO]', req.method, req.path, err && (err.stack || err.message));

  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ success: false, message: 'El envio es demasiado grande.' });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ success: false, message: 'La imagen pesa demasiado. El maximo son 5 MB.' });
  }
  if (err && (err.code === 'ARCHIVO_NO_IMAGEN' || /solo se permiten (archivos de )?imagen/i.test(err.message || ''))) {
    return res.status(415).json({ success: false, message: 'Solo se aceptan imagenes como comprobante.' });
  }
  return res.status(err && err.status ? err.status : 500)
    .json({ success: false, message: 'Ocurrio un error en el servidor. Intentalo de nuevo.' });
});
