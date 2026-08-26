/**
 * ============================================================================
 *  JuntaGO - MODULO DE CONTROL INTERNO (gobernanza del grupo)
 * ============================================================================
 *
 *  Principio: el patrimonio del grupo NO se forma por lo que declara un socio,
 *  sino por lo que CONFIRMA la tesoreria; y todo cambio estructural (saldos de
 *  apertura al pasar de papel a digital, reglamento, condonaciones, sanciones)
 *  pasa por ASAMBLEA con quorum, votacion y acta.
 *
 *  Este archivo se registra desde server.js con `register(app, ctx)` y reutiliza
 *  los helpers ya existentes (auth, permisos, dinero) que se le inyectan en ctx.
 *
 *  Hojas que administra:
 *    GrupoReglas        reglamento financiero de cada grupo
 *    Asambleas          convocatorias / reuniones
 *    AsambleaAsistencia quien asistio a cada asamblea
 *    Acuerdos           mociones sometidas a votacion
 *    AcuerdoVotos       voto de cada socio sobre cada acuerdo
 *    LotesApertura      cabecera del lote de saldos iniciales (papel -> digital)
 *    AperturaDetalle    una fila por socio dentro del lote
 *    GobernanzaLog      bitacora de acciones de control interno
 *
 *  Columnas anadidas a hojas existentes (siempre A LA DERECHA, para no romper
 *  las lecturas posicionales que ya existian):
 *    Savings   G=Estado H=RegistradoPor I=ResueltoPor J=FechaEstado K=MovID L=Nota
 *    Acciones  H=Estado I=RegistradoPor J=ResueltoPor K=FechaEstado L=MovID M=Nota
 *  Estado vacio se interpreta como 'confirmado' (compatibilidad con el historico).
 */

'use strict';

// ---------------------------------------------------------------------------
// Esquemas
// ---------------------------------------------------------------------------

const SHEETS = {
  reglas: {
    name: 'GrupoReglas',
    headers: ['GroupID', 'RequiereAprobacionAportes', 'RequiereAprobacionPrestamos', 'QuorumPrestamos',
      'TopePrestamoFactorAhorro', 'MaxPrestamosActivos', 'AporteMinimo', 'AporteMaximo',
      'QuorumAsambleaPct', 'ActualizadoPor', 'ActualizadoEn'],
  },
  asambleas: {
    name: 'Asambleas',
    headers: ['AsambleaID', 'GroupID', 'Titulo', 'FechaProgramada', 'Modalidad', 'Estado', 'Agenda',
      'CreadaPor', 'CreadaEn', 'AbiertaEn', 'CerradaEn', 'CerradaPor', 'ActaID', 'Nota'],
  },
  asistencia: {
    name: 'AsambleaAsistencia',
    headers: ['AsambleaID', 'GroupID', 'Email', 'Estado', 'RegistradoPor', 'RegistradoEn'],
  },
  acuerdos: {
    name: 'Acuerdos',
    headers: ['AcuerdoID', 'AsambleaID', 'GroupID', 'Tipo', 'Titulo', 'Descripcion', 'Payload',
      'Estado', 'PropuestoPor', 'CreadoEn', 'ResueltoEn', 'EjecutadoEn', 'AFavor', 'EnContra', 'Abstenciones'],
  },
  votos: {
    name: 'AcuerdoVotos',
    headers: ['AcuerdoID', 'AsambleaID', 'GroupID', 'Email', 'Voto', 'Fecha', 'RolEnGrupo'],
  },
  lotes: {
    name: 'LotesApertura',
    headers: ['LoteID', 'GroupID', 'Estado', 'CreadoPor', 'CreadoEn', 'AsambleaID', 'AcuerdoID',
      'AplicadoEn', 'TotalAhorro', 'TotalAcciones', 'TotalDeuda', 'Miembros', 'Nota'],
  },
  apertura: {
    name: 'AperturaDetalle',
    headers: ['LoteID', 'GroupID', 'Email', 'Ahorro', 'Acciones', 'ValorAccion', 'Deuda', 'PlazoDeuda', 'Nota'],
  },
  log: {
    name: 'GobernanzaLog',
    headers: ['Fecha', 'GroupID', 'Actor', 'Accion', 'Objetivo', 'Detalle'],
  },
};

// Reglamento por defecto de un grupo nuevo: control interno ACTIVADO.
const REGLAS_DEFECTO = {
  requiereAprobacionAportes: true,
  requiereAprobacionPrestamos: true,
  quorumPrestamos: 0,               // 0 = automatico: min(2, numero de lideres activos)
  topePrestamoFactorAhorro: 3,      // el prestamo no puede superar 3x el ahorro confirmado
  maxPrestamosActivos: 1,
  aporteMinimo: 0,
  aporteMaximo: 0,                  // 0 = sin tope
  quorumAsambleaPct: 50,            // % de miembros activos que deben estar presentes
};

const ESTADOS_APORTE = new Set(['pendiente', 'confirmado', 'rechazado']);
const ESTADOS_ASAMBLEA = new Set(['programada', 'abierta', 'cerrada', 'cancelada']);
const ESTADOS_ASISTENCIA = new Set(['presente', 'ausente', 'justificado']);
const VOTOS_VALIDOS = new Set(['favor', 'contra', 'abstencion']);
const TIPOS_ACUERDO = new Set(['apertura_saldos', 'cambio_reglas', 'prestamo', 'sancion', 'gasto', 'otro']);
const ROLES_LIDER = new Set(['presidente', 'tesorero', 'secretario']);

// Indices de las columnas de control anadidas
const SAV = { email: 0, group: 1, amount: 2, date: 3, type: 4, desc: 5, estado: 6, registradoPor: 7, resueltoPor: 8, fechaEstado: 9, movId: 10, nota: 11 };
const ACC = { email: 0, group: 1, date: 2, shares: 3, value: 4, rate: 5, createdAt: 6, estado: 7, registradoPor: 8, resueltoPor: 9, fechaEstado: 10, movId: 11, nota: 12 };

const SAVINGS_LAST_COL = 'L';
const ACCIONES_LAST_COL = 'M';

// ---------------------------------------------------------------------------
// Utilidades independientes del contexto (exportadas para pruebas unitarias)
// ---------------------------------------------------------------------------

/** Estado efectivo de un aporte. Celda vacia = historico ya consolidado. */
function estadoAporte(valor) {
  const v = (valor == null ? '' : valor).toString().trim().toLowerCase();
  if (!v) return 'confirmado';
  return ESTADOS_APORTE.has(v) ? v : 'confirmado';
}

/** True si el aporte debe sumar al patrimonio. */
function aporteCuenta(valor) {
  return estadoAporte(valor) === 'confirmado';
}

function colLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Quorum de asamblea: techo del porcentaje sobre miembros activos, minimo 2 (o todos si el grupo es de 1). */
function quorumAsamblea(miembrosActivos, pct) {
  const n = Math.max(0, Number(miembrosActivos) || 0);
  if (n === 0) return 0;
  const porcentaje = Math.min(100, Math.max(1, Number(pct) || 50));
  const requerido = Math.ceil((n * porcentaje) / 100);
  return Math.max(1, Math.min(n, requerido));
}

/** Resultado de una votacion por mayoria simple de los votos emitidos. */
function resultadoVotacion({ aFavor, enContra, presentes, quorum }) {
  if (presentes < quorum) return { resuelto: false, motivo: 'sin_quorum' };
  const emitidos = aFavor + enContra;
  if (emitidos === 0) return { resuelto: false, motivo: 'sin_votos' };
  const faltanPorVotar = presentes - (aFavor + enContra);
  // Se resuelve en cuanto el resultado ya no puede cambiar
  if (aFavor > enContra + faltanPorVotar) return { resuelto: true, estado: 'aprobado' };
  if (enContra >= aFavor + faltanPorVotar) return { resuelto: true, estado: 'rechazado' };
  return { resuelto: false, motivo: 'en_curso' };
}

module.exports = {
  SHEETS,
  REGLAS_DEFECTO,
  estadoAporte,
  aporteCuenta,
  quorumAsamblea,
  resultadoVotacion,
  colLetter,
  SAV,
  ACC,
  SAVINGS_LAST_COL,
  ACCIONES_LAST_COL,
  ROLES_LIDER,
  ESTADOS_ASAMBLEA,
  ESTADOS_ASISTENCIA,
  VOTOS_VALIDOS,
  TIPOS_ACUERDO,
  register: null, // se asigna abajo
};

// ---------------------------------------------------------------------------
// Registro de rutas
// ---------------------------------------------------------------------------

module.exports.register = function register(app, ctx) {
  const {
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
    bloquear,
  } = ctx;

  const nowIso = () => new Date().toISOString();
  const newId = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const num = (v) => {
    const n = parseMoney(v);
    return Number.isFinite(n) ? n : 0;
  };
  const boolCell = (v, porDefecto = false) => {
    const s = (v == null ? '' : v).toString().trim().toLowerCase();
    if (!s) return porDefecto;
    return ['si', 'sí', 'true', '1', 'yes', 'x'].includes(s);
  };
  const cellBool = (b) => (b ? 'si' : 'no');

  // --- acceso generico a hojas ---------------------------------------------
  async function ensure(def) {
    const sheetsClient = await getSheetsClient();
    await ensureSheetExists(def.name, def.headers, sheetsClient, SPREADSHEET_ID);
    return sheetsClient;
  }

  async function readAll(def) {
    const sheetsClient = await ensure(def);
    const last = colLetter(def.headers.length - 1);
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${def.name}!A2:${last}`,
    });
    return resp.data.values || [];
  }

  async function appendRow(def, row) {
    const sheetsClient = await ensure(def);
    const last = colLetter(def.headers.length - 1);
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${def.name}!A:${last}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
    return row;
  }

  /** Actualiza (por indice 0-based sobre las filas de datos) una fila completa. */
  async function updateRow(def, dataIndex, row) {
    const sheetsClient = await ensure(def);
    const last = colLetter(def.headers.length - 1);
    const sheetRow = dataIndex + 2; // +1 header, +1 base 1
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${def.name}!A${sheetRow}:${last}${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [row] },
    });
  }

  async function logGob(groupId, actor, accion, objetivo, detalle) {
    try {
      await appendRow(SHEETS.log, [nowIso(), groupId, actor, accion, objetivo, sanitizeCell(detalle, 900)]);
    } catch (e) {
      console.error('[GOB] no se pudo escribir la bitacora:', e.message);
    }
  }

  // --- reglamento del grupo -------------------------------------------------
  function reglasDesdeFila(row) {
    if (!row) return { ...REGLAS_DEFECTO, existe: false };
    return {
      existe: true,
      requiereAprobacionAportes: boolCell(row[1], REGLAS_DEFECTO.requiereAprobacionAportes),
      requiereAprobacionPrestamos: boolCell(row[2], REGLAS_DEFECTO.requiereAprobacionPrestamos),
      quorumPrestamos: Math.max(0, Math.trunc(num(row[3]))),
      topePrestamoFactorAhorro: num(row[4]) > 0 ? num(row[4]) : REGLAS_DEFECTO.topePrestamoFactorAhorro,
      maxPrestamosActivos: Math.max(0, Math.trunc(num(row[5]))) || REGLAS_DEFECTO.maxPrestamosActivos,
      aporteMinimo: Math.max(0, num(row[6])),
      aporteMaximo: Math.max(0, num(row[7])),
      quorumAsambleaPct: num(row[8]) > 0 ? num(row[8]) : REGLAS_DEFECTO.quorumAsambleaPct,
      actualizadoPor: row[9] || '',
      actualizadoEn: row[10] || '',
    };
  }

  async function getReglas(groupId) {
    const gid = normalizeGroupKey(groupId);
    const rows = await readAll(SHEETS.reglas);
    const idx = rows.findIndex((r) => normalizeGroupKey(r[0]) === gid);
    const reglas = reglasDesdeFila(idx === -1 ? null : rows[idx]);
    reglas.groupId = gid;
    reglas._index = idx;
    return reglas;
  }

  function filaReglas(gid, r, actor) {
    return [
      gid,
      cellBool(r.requiereAprobacionAportes),
      cellBool(r.requiereAprobacionPrestamos),
      r.quorumPrestamos,
      r.topePrestamoFactorAhorro,
      r.maxPrestamosActivos,
      r.aporteMinimo,
      r.aporteMaximo,
      r.quorumAsambleaPct,
      actor,
      nowIso(),
    ];
  }

  async function guardarReglas(groupId, reglas, actor) {
    const gid = normalizeGroupKey(groupId);
    const actual = await getReglas(gid);
    const fila = filaReglas(gid, reglas, actor);
    if (actual._index === -1) await appendRow(SHEETS.reglas, fila);
    else await updateRow(SHEETS.reglas, actual._index, fila);
    return reglas;
  }

  // --- miembros del grupo ---------------------------------------------------
  async function miembrosActivos(groupId) {
    const gid = normalizeGroupKey(groupId);
    const links = await readUserGroupLinks();
    return links
      .filter((r) => normalizeGroupKey(r[1]) === gid && linkIsActive(r))
      .map((r) => ({ email: normalizeEmailKey(r[0]), rol: normalizeGroupRole(r[3]) || 'member' }));
  }

  const esLider = (rol) => ROLES_LIDER.has((rol || '').toLowerCase());

  /** Exige rol de lider del grupo (o admin global). Responde 403 si no. */
  async function requireLider(req, res, groupId, rolesPermitidos = ROLES_LIDER) {
    const gid = normalizeGroupKey(groupId);
    if (!gid) {
      res.status(400).json({ success: false, message: 'Falta el identificador del grupo.' });
      return null;
    }
    if (req.user.role === 'admin') return 'admin';
    const rol = await getUserGroupRole(req.user.email, gid);
    if (!rolesPermitidos.has((rol || '').toLowerCase())) {
      res.status(403).json({
        success: false,
        message: `Accion reservada a ${[...rolesPermitidos].join(' / ')} del grupo.`,
      });
      return null;
    }
    return rol;
  }

  // =========================================================================
  //  1. REGLAMENTO DEL GRUPO
  // =========================================================================

  app.get('/api/gob/reglas', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!(await assertGroupMember(req, res, groupId))) return;
      const reglas = await getReglas(groupId);
      delete reglas._index;
      res.json({ success: true, reglas });
    } catch (e) {
      console.error('[GOB reglas GET]', e);
      res.status(500).json({ success: false, message: 'Error al leer el reglamento.' });
    }
  });

  app.post('/api/gob/reglas', bloquear((r) => `reglas:${normalizeGroupKey(r.body && r.body.groupId)}`), async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.body?.groupId);
      const rol = await requireLider(req, res, groupId, new Set(['presidente']));
      if (!rol) return;

      const actuales = await getReglas(groupId);
      const b = req.body || {};
      const propuesta = {
        requiereAprobacionAportes: b.requiereAprobacionAportes === undefined
          ? actuales.requiereAprobacionAportes : !!b.requiereAprobacionAportes,
        requiereAprobacionPrestamos: b.requiereAprobacionPrestamos === undefined
          ? actuales.requiereAprobacionPrestamos : !!b.requiereAprobacionPrestamos,
        quorumPrestamos: b.quorumPrestamos === undefined
          ? actuales.quorumPrestamos : Math.max(0, Math.trunc(num(b.quorumPrestamos))),
        topePrestamoFactorAhorro: b.topePrestamoFactorAhorro === undefined
          ? actuales.topePrestamoFactorAhorro : num(b.topePrestamoFactorAhorro),
        maxPrestamosActivos: b.maxPrestamosActivos === undefined
          ? actuales.maxPrestamosActivos : Math.max(1, Math.trunc(num(b.maxPrestamosActivos))),
        aporteMinimo: b.aporteMinimo === undefined ? actuales.aporteMinimo : Math.max(0, num(b.aporteMinimo)),
        aporteMaximo: b.aporteMaximo === undefined ? actuales.aporteMaximo : Math.max(0, num(b.aporteMaximo)),
        quorumAsambleaPct: b.quorumAsambleaPct === undefined
          ? actuales.quorumAsambleaPct : Math.min(100, Math.max(1, num(b.quorumAsambleaPct))),
      };

      if (propuesta.topePrestamoFactorAhorro <= 0) {
        return res.status(400).json({ success: false, message: 'El tope de prestamo debe ser mayor a 0.' });
      }
      if (propuesta.aporteMaximo > 0 && propuesta.aporteMaximo < propuesta.aporteMinimo) {
        return res.status(400).json({ success: false, message: 'El aporte maximo no puede ser menor que el minimo.' });
      }

      // Relajar el control interno (quitar aprobaciones o subir el tope de credito)
      // exige un acuerdo de asamblea aprobado y no ejecutado.
      const relaja = (actuales.requiereAprobacionAportes && !propuesta.requiereAprobacionAportes)
        || (actuales.requiereAprobacionPrestamos && !propuesta.requiereAprobacionPrestamos)
        || (propuesta.topePrestamoFactorAhorro > actuales.topePrestamoFactorAhorro)
        || (propuesta.maxPrestamosActivos > actuales.maxPrestamosActivos);

      if (relaja && actuales.existe) {
        const acuerdoId = (b.acuerdoId || '').toString().trim();
        const ok = await acuerdoAprobadoValido(groupId, acuerdoId, 'cambio_reglas');
        if (!ok.valido) {
          return res.status(409).json({
            success: false,
            requiereAcuerdo: true,
            message: 'Relajar el control interno requiere un acuerdo de asamblea aprobado. '
              + 'Convoca una asamblea, propone el cambio y sometelo a votacion.',
            detalle: ok.motivo,
          });
        }
        await marcarAcuerdoEjecutado(acuerdoId);
      }

      await guardarReglas(groupId, propuesta, req.user.email);
      await logGob(groupId, req.user.email, 'reglas_actualizadas', groupId, JSON.stringify(propuesta));
      res.json({ success: true, reglas: { ...propuesta, groupId } });
    } catch (e) {
      console.error('[GOB reglas POST]', e);
      res.status(500).json({ success: false, message: 'Error al guardar el reglamento.' });
    }
  });

  // =========================================================================
  //  2. APORTES CON CONFIRMACION DE TESORERIA
  // =========================================================================

  async function leerSavings() {
    const sheetsClient = await getSheetsClient();
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `Savings!A2:${SAVINGS_LAST_COL}`,
    });
    return resp.data.values || [];
  }

  async function leerAcciones() {
    const sheetsClient = await getSheetsClient();
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `Acciones!A2:${ACCIONES_LAST_COL}`,
    });
    return resp.data.values || [];
  }

  /** Ahorro CONFIRMADO de un socio en un grupo. */
  async function ahorroConfirmado(email, groupId) {
    const e = normalizeEmailKey(email);
    const g = normalizeGroupKey(groupId);
    const rows = await leerSavings();
    return rows
      .filter((r) => normalizeEmailKey(r[SAV.email]) === e
        && normalizeGroupKey(r[SAV.group]) === g
        && aporteCuenta(r[SAV.estado]))
      .reduce((s, r) => s + num(r[SAV.amount]), 0);
  }

  app.get('/api/gob/aportes-pendientes', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      const rol = await requireLider(req, res, groupId, new Set(['presidente', 'tesorero', 'secretario']));
      if (!rol) return;

      const [savings, acciones] = [await leerSavings(), await leerAcciones()];
      const ahorros = savings
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => normalizeGroupKey(r[SAV.group]) === groupId && estadoAporte(r[SAV.estado]) === 'pendiente')
        .map(({ r, i }) => ({
          movId: r[SAV.movId] || `SAVROW_${i}`,
          fila: i,
          email: normalizeEmailKey(r[SAV.email]),
          monto: num(r[SAV.amount]),
          fecha: r[SAV.date] || '',
          tipo: r[SAV.type] || 'mensual',
          descripcion: r[SAV.desc] || '',
          registradoPor: normalizeEmailKey(r[SAV.registradoPor]),
        }));

      const compras = acciones
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => normalizeGroupKey(r[ACC.group]) === groupId && estadoAporte(r[ACC.estado]) === 'pendiente')
        .map(({ r, i }) => ({
          movId: r[ACC.movId] || `ACCROW_${i}`,
          fila: i,
          email: normalizeEmailKey(r[ACC.email]),
          acciones: num(r[ACC.shares]),
          valorAccion: num(r[ACC.value]),
          monto: num(r[ACC.shares]) * num(r[ACC.value]),
          fecha: r[ACC.date] || '',
          registradoPor: normalizeEmailKey(r[ACC.registradoPor]),
        }));

      // Movimientos ya resueltos: la presidencia los necesita a la vista para poder
      // corregir una confirmacion equivocada sin tener que editar la hoja a mano.
      const resueltos = [
        ...savings
          .filter((r) => normalizeGroupKey(r[SAV.group]) === groupId && estadoAporte(r[SAV.estado]) !== 'pendiente' && r[SAV.movId])
          .map((r) => ({
            tipo: 'ahorro',
            movId: r[SAV.movId],
            email: normalizeEmailKey(r[SAV.email]),
            monto: num(r[SAV.amount]),
            fecha: r[SAV.date] || '',
            estado: estadoAporte(r[SAV.estado]),
            resueltoPor: normalizeEmailKey(r[SAV.resueltoPor]),
            fechaEstado: r[SAV.fechaEstado] || '',
            nota: r[SAV.nota] || '',
          })),
        ...acciones
          .filter((r) => normalizeGroupKey(r[ACC.group]) === groupId && estadoAporte(r[ACC.estado]) !== 'pendiente' && r[ACC.movId])
          .map((r) => ({
            tipo: 'accion',
            movId: r[ACC.movId],
            email: normalizeEmailKey(r[ACC.email]),
            monto: num(r[ACC.shares]) * num(r[ACC.value]),
            acciones: num(r[ACC.shares]),
            fecha: r[ACC.date] || '',
            estado: estadoAporte(r[ACC.estado]),
            resueltoPor: normalizeEmailKey(r[ACC.resueltoPor]),
            fechaEstado: r[ACC.fechaEstado] || '',
            nota: r[ACC.nota] || '',
          })),
      ]
        .sort((a, b) => new Date(b.fechaEstado || 0) - new Date(a.fechaEstado || 0))
        .slice(0, 25);

      res.json({
        success: true,
        ahorros,
        acciones: compras,
        resueltos,
        totalPendiente: ahorros.reduce((s, a) => s + a.monto, 0) + compras.reduce((s, a) => s + a.monto, 0),
      });
    } catch (e) {
      console.error('[GOB aportes-pendientes]', e);
      res.status(500).json({ success: false, message: 'Error al listar aportes pendientes.' });
    }
  });

  app.get('/api/gob/mis-aportes', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!(await assertGroupMember(req, res, groupId))) return;
      const email = req.user.role === 'admin' && req.query.email
        ? normalizeEmailKey(req.query.email) : req.user.email;

      const savings = await leerSavings();
      const acciones = await leerAcciones();
      const mine = (rows, idx) => rows.filter((r) => normalizeEmailKey(r[idx.email]) === email
        && normalizeGroupKey(r[idx.group]) === groupId);

      const ahorros = mine(savings, SAV).map((r) => ({
        movId: r[SAV.movId] || '',
        monto: num(r[SAV.amount]),
        fecha: r[SAV.date] || '',
        tipo: r[SAV.type] || 'mensual',
        descripcion: r[SAV.desc] || '',
        estado: estadoAporte(r[SAV.estado]),
        resueltoPor: normalizeEmailKey(r[SAV.resueltoPor]),
        nota: r[SAV.nota] || '',
      }));
      const compras = mine(acciones, ACC).map((r) => ({
        movId: r[ACC.movId] || '',
        acciones: num(r[ACC.shares]),
        valorAccion: num(r[ACC.value]),
        monto: num(r[ACC.shares]) * num(r[ACC.value]),
        fecha: r[ACC.date] || '',
        estado: estadoAporte(r[ACC.estado]),
        resueltoPor: normalizeEmailKey(r[ACC.resueltoPor]),
        nota: r[ACC.nota] || '',
      }));

      res.json({
        success: true,
        ahorros,
        acciones: compras,
        resumen: {
          ahorroConfirmado: ahorros.filter((a) => a.estado === 'confirmado').reduce((s, a) => s + a.monto, 0),
          ahorroPendiente: ahorros.filter((a) => a.estado === 'pendiente').reduce((s, a) => s + a.monto, 0),
          accionesConfirmadas: compras.filter((a) => a.estado === 'confirmado').reduce((s, a) => s + a.acciones, 0),
          accionesPendientes: compras.filter((a) => a.estado === 'pendiente').reduce((s, a) => s + a.acciones, 0),
        },
      });
    } catch (e) {
      console.error('[GOB mis-aportes]', e);
      res.status(500).json({ success: false, message: 'Error al listar tus aportes.' });
    }
  });

  app.post('/api/gob/aportes/resolver', bloquear((r) => `aporte:${r.body && r.body.movId}`), async (req, res) => {
    try {
      const { tipo, movId, accion, nota } = req.body || {};
      const groupId = normalizeGroupKey(req.body?.groupId);
      if (!['ahorro', 'accion'].includes(tipo)) {
        return res.status(400).json({ success: false, message: 'tipo debe ser "ahorro" o "accion".' });
      }
      if (!['confirmar', 'rechazar', 'revertir'].includes(accion)) {
        return res.status(400).json({ success: false, message: 'accion debe ser "confirmar", "rechazar" o "revertir".' });
      }
      if (!movId) return res.status(400).json({ success: false, message: 'Falta movId.' });

      // Revertir una decision ya tomada es potestad exclusiva de la presidencia y
      // exige motivo: es la unica forma de corregir un error sin editar la hoja a
      // mano (lo que dejaria el patrimonio cambiado sin rastro de quien lo hizo).
      const rolesPermitidos = accion === 'revertir'
        ? new Set(['presidente'])
        : new Set(['presidente', 'tesorero']);
      const rol = await requireLider(req, res, groupId, rolesPermitidos);
      if (!rol) return;
      if (accion === 'revertir' && !(nota || '').toString().trim()) {
        return res.status(400).json({ success: false, message: 'Para revertir hay que indicar el motivo.' });
      }

      const esAhorro = tipo === 'ahorro';
      const idx = esAhorro ? SAV : ACC;
      const sheetName = esAhorro ? 'Savings' : 'Acciones';
      const lastCol = esAhorro ? SAVINGS_LAST_COL : ACCIONES_LAST_COL;
      const rows = esAhorro ? await leerSavings() : await leerAcciones();

      const fila = rows.findIndex((r) => (r[idx.movId] || '').toString().trim() === movId.toString().trim());
      if (fila === -1) return res.status(404).json({ success: false, message: 'Movimiento no encontrado.' });

      const row = rows[fila];
      if (normalizeGroupKey(row[idx.group]) !== groupId) {
        return res.status(403).json({ success: false, message: 'El movimiento pertenece a otro grupo.' });
      }
      const estado = estadoAporte(row[idx.estado]);

      if (accion === 'revertir') {
        if (estado === 'pendiente') {
          return res.status(409).json({ success: false, message: 'Este movimiento sigue pendiente: no hay nada que revertir.', estado });
        }
      } else {
        if (estado !== 'pendiente') {
          return res.status(409).json({
            success: false,
            message: `El movimiento ya esta ${estado}. Si fue un error, la presidencia puede revertirlo indicando el motivo.`,
            estado,
          });
        }
        // Separacion de funciones: quien registro el aporte no puede resolverlo el mismo.
        if (normalizeEmailKey(row[idx.registradoPor]) === req.user.email) {
          return res.status(403).json({
            success: false,
            message: 'No puedes confirmar un aporte que registraste tu mismo. Debe revisarlo otro miembro de la junta.',
          });
        }
      }

      const nuevoEstado = accion === 'confirmar' ? 'confirmado'
        : accion === 'rechazar' ? 'rechazado'
          : 'pendiente';
      const completo = row.slice();
      while (completo.length <= idx.nota) completo.push('');
      completo[idx.estado] = nuevoEstado;
      completo[idx.resueltoPor] = accion === 'revertir' ? '' : req.user.email;
      completo[idx.fechaEstado] = accion === 'revertir' ? '' : nowIso();
      completo[idx.nota] = accion === 'revertir'
        ? sanitizeCell(`Revertido por ${req.user.email}: ${nota}`, 300)
        : sanitizeCell(nota || '', 300);

      const sheetsClient = await getSheetsClient();
      const sheetRow = fila + 2;
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${sheetName}!A${sheetRow}:${lastCol}${sheetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [completo] },
      });

      await logGob(groupId, req.user.email,
        accion === 'revertir' ? `aporte_revertido_desde_${estado}` : `aporte_${nuevoEstado}`,
        movId,
        `${tipo} de ${normalizeEmailKey(row[idx.email])}${nota ? ` | ${nota}` : ''}`);

      res.json({
        success: true,
        estado: nuevoEstado,
        estadoAnterior: estado,
        movId,
        message: accion === 'revertir'
          ? 'Movimiento revertido: vuelve a la bandeja de pendientes.'
          : undefined,
      });
    } catch (e) {
      console.error('[GOB aportes/resolver]', e);
      res.status(500).json({ success: false, message: 'Error al resolver el aporte.' });
    }
  });

  // =========================================================================
  //  3. ASAMBLEAS
  // =========================================================================

  async function getAsamblea(asambleaId) {
    const rows = await readAll(SHEETS.asambleas);
    const i = rows.findIndex((r) => (r[0] || '').toString().trim() === asambleaId);
    if (i === -1) return null;
    const r = rows[i];
    return {
      _index: i,
      _row: r,
      asambleaId: r[0], groupId: normalizeGroupKey(r[1]), titulo: r[2], fechaProgramada: r[3],
      modalidad: r[4], estado: (r[5] || 'programada').toString().toLowerCase(), agenda: r[6],
      creadaPor: normalizeEmailKey(r[7]), creadaEn: r[8], abiertaEn: r[9], cerradaEn: r[10],
      cerradaPor: normalizeEmailKey(r[11]), actaId: r[12], nota: r[13],
    };
  }

  app.post('/api/gob/asambleas', bloquear((r) => `asambleas:${normalizeGroupKey(r.body && r.body.groupId)}`), async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.body?.groupId);
      const rol = await requireLider(req, res, groupId, new Set(['presidente', 'secretario']));
      if (!rol) return;

      const titulo = (req.body?.titulo || '').toString().trim();
      const fecha = (req.body?.fechaProgramada || '').toString().trim();
      if (!titulo) return res.status(400).json({ success: false, message: 'Falta el titulo de la asamblea.' });
      if (!fecha) return res.status(400).json({ success: false, message: 'Falta la fecha programada.' });
      if (Number.isNaN(new Date(fecha).getTime())) {
        return res.status(400).json({ success: false, message: 'La fecha programada no es valida.' });
      }

      const abiertas = (await readAll(SHEETS.asambleas)).filter((r) => normalizeGroupKey(r[1]) === groupId
        && (r[5] || '').toString().toLowerCase() === 'abierta');
      if (abiertas.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Ya hay una asamblea abierta en el grupo. Cierrala antes de convocar otra.',
          asambleaId: abiertas[0][0],
        });
      }

      const asambleaId = newId('asm');
      await appendRow(SHEETS.asambleas, [
        asambleaId, groupId, sanitizeCell(titulo, 200), fecha,
        sanitizeCell(req.body?.modalidad || 'presencial', 40), 'programada',
        sanitizeCell(req.body?.agenda || '', 2000),
        req.user.email, nowIso(), '', '', '', '', '',
      ]);
      await logGob(groupId, req.user.email, 'asamblea_convocada', asambleaId, titulo);
      res.status(201).json({ success: true, asambleaId });
    } catch (e) {
      console.error('[GOB asambleas POST]', e);
      res.status(500).json({ success: false, message: 'Error al convocar la asamblea.' });
    }
  });

  app.get('/api/gob/asambleas', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!(await assertGroupMember(req, res, groupId))) return;
      const rows = await readAll(SHEETS.asambleas);
      const asambleas = rows
        .filter((r) => normalizeGroupKey(r[1]) === groupId)
        .map((r) => ({
          asambleaId: r[0], groupId: r[1], titulo: r[2], fechaProgramada: r[3], modalidad: r[4],
          estado: (r[5] || 'programada').toString().toLowerCase(), agenda: r[6],
          creadaPor: r[7], creadaEn: r[8], abiertaEn: r[9], cerradaEn: r[10], actaId: r[12],
        }))
        .sort((a, b) => new Date(b.fechaProgramada || 0) - new Date(a.fechaProgramada || 0));
      res.json({ success: true, asambleas });
    } catch (e) {
      console.error('[GOB asambleas GET]', e);
      res.status(500).json({ success: false, message: 'Error al listar asambleas.' });
    }
  });

  app.get('/api/gob/asambleas/:id', async (req, res) => {
    try {
      const asamblea = await getAsamblea(req.params.id);
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      if (!(await assertGroupMember(req, res, asamblea.groupId))) return;

      const [asistRows, acuRows, votoRows, miembros, reglas] = [
        await readAll(SHEETS.asistencia),
        await readAll(SHEETS.acuerdos),
        await readAll(SHEETS.votos),
        await miembrosActivos(asamblea.groupId),
        await getReglas(asamblea.groupId),
      ];

      const asistencia = asistRows
        .filter((r) => (r[0] || '') === asamblea.asambleaId)
        .map((r) => ({ email: normalizeEmailKey(r[2]), estado: (r[3] || '').toLowerCase(), registradoPor: r[4], registradoEn: r[5] }));
      const presentes = asistencia.filter((a) => a.estado === 'presente').length;
      const quorum = quorumAsamblea(miembros.length, reglas.quorumAsambleaPct);

      const acuerdos = acuRows
        .filter((r) => (r[1] || '') === asamblea.asambleaId)
        .map((r) => ({
          acuerdoId: r[0], asambleaId: r[1], groupId: r[2], tipo: r[3], titulo: r[4],
          descripcion: r[5], payload: safeJson(r[6]), estado: (r[7] || 'abierto').toLowerCase(),
          propuestoPor: r[8], creadoEn: r[9], resueltoEn: r[10], ejecutadoEn: r[11],
          aFavor: num(r[12]), enContra: num(r[13]), abstenciones: num(r[14]),
          votos: votoRows.filter((v) => (v[0] || '') === r[0])
            .map((v) => ({ email: normalizeEmailKey(v[3]), voto: (v[4] || '').toLowerCase(), fecha: v[5], rol: v[6] })),
        }));

      delete asamblea._index; delete asamblea._row;
      res.json({
        success: true,
        asamblea,
        asistencia,
        acuerdos,
        quorum: { requerido: quorum, presentes, miembrosActivos: miembros.length, alcanzado: presentes >= quorum },
        miembros,
      });
    } catch (e) {
      console.error('[GOB asamblea detalle]', e);
      res.status(500).json({ success: false, message: 'Error al leer la asamblea.' });
    }
  });

  app.post('/api/gob/asambleas/:id/estado', bloquear((r) => `asamblea:${r.params.id}`), async (req, res) => {
    try {
      const asamblea = await getAsamblea(req.params.id);
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      const rol = await requireLider(req, res, asamblea.groupId, new Set(['presidente', 'secretario']));
      if (!rol) return;

      const destino = (req.body?.estado || '').toString().trim().toLowerCase();
      if (!ESTADOS_ASAMBLEA.has(destino)) {
        return res.status(400).json({ success: false, message: 'Estado invalido.' });
      }
      const transiciones = {
        programada: ['abierta', 'cancelada'],
        abierta: ['cerrada', 'cancelada'],
        cerrada: [],
        cancelada: [],
      };
      if (!transiciones[asamblea.estado] || !transiciones[asamblea.estado].includes(destino)) {
        return res.status(409).json({
          success: false,
          message: `No se puede pasar de "${asamblea.estado}" a "${destino}".`,
        });
      }

      // Al cerrar, los acuerdos que sigan abiertos se resuelven con lo votado.
      if (destino === 'cerrada') {
        await cerrarAcuerdosPendientes(asamblea);
      }

      const row = asamblea._row.slice();
      while (row.length < SHEETS.asambleas.headers.length) row.push('');
      row[5] = destino;
      if (destino === 'abierta') row[9] = nowIso();
      if (destino === 'cerrada') { row[10] = nowIso(); row[11] = req.user.email; }
      await updateRow(SHEETS.asambleas, asamblea._index, row);
      await logGob(asamblea.groupId, req.user.email, `asamblea_${destino}`, asamblea.asambleaId, '');
      res.json({ success: true, estado: destino });
    } catch (e) {
      console.error('[GOB asamblea estado]', e);
      res.status(500).json({ success: false, message: 'Error al cambiar el estado de la asamblea.' });
    }
  });

  app.post('/api/gob/asambleas/:id/asistencia', bloquear((r) => `asamblea:${r.params.id}`), async (req, res) => {
    try {
      const asamblea = await getAsamblea(req.params.id);
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      const rol = await requireLider(req, res, asamblea.groupId, new Set(['presidente', 'secretario']));
      if (!rol) return;
      if (!['programada', 'abierta'].includes(asamblea.estado)) {
        return res.status(409).json({ success: false, message: 'La asamblea ya esta cerrada o cancelada.' });
      }

      const registros = Array.isArray(req.body?.registros) ? req.body.registros : [];
      if (registros.length === 0) {
        return res.status(400).json({ success: false, message: 'Envia al menos un registro de asistencia.' });
      }
      const miembros = await miembrosActivos(asamblea.groupId);
      const setMiembros = new Set(miembros.map((m) => m.email));

      const existentes = await readAll(SHEETS.asistencia);
      const nuevas = [];
      const actualizaciones = [];
      for (const reg of registros) {
        const email = normalizeEmailKey(reg?.email);
        const estado = (reg?.estado || 'presente').toString().trim().toLowerCase();
        if (!email || !setMiembros.has(email)) {
          return res.status(400).json({ success: false, message: `${email || '(vacio)'} no es miembro activo del grupo.` });
        }
        if (!ESTADOS_ASISTENCIA.has(estado)) {
          return res.status(400).json({ success: false, message: `Estado de asistencia invalido: ${estado}` });
        }
        const i = existentes.findIndex((r) => (r[0] || '') === asamblea.asambleaId && normalizeEmailKey(r[2]) === email);
        if (i === -1) nuevas.push([asamblea.asambleaId, asamblea.groupId, email, estado, req.user.email, nowIso()]);
        else actualizaciones.push({ i, row: [asamblea.asambleaId, asamblea.groupId, email, estado, req.user.email, nowIso()] });
      }

      for (const u of actualizaciones) await updateRow(SHEETS.asistencia, u.i, u.row);
      if (nuevas.length) {
        const sheetsClient = await ensure(SHEETS.asistencia);
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEETS.asistencia.name}!A:F`,
          valueInputOption: 'RAW',
          requestBody: { values: nuevas },
        });
      }

      await logGob(asamblea.groupId, req.user.email, 'asistencia_registrada', asamblea.asambleaId,
        `${registros.length} registros`);
      res.json({ success: true, registrados: registros.length });
    } catch (e) {
      console.error('[GOB asistencia]', e);
      res.status(500).json({ success: false, message: 'Error al registrar la asistencia.' });
    }
  });

  // =========================================================================
  //  4. ACUERDOS Y VOTACION
  // =========================================================================

  function safeJson(txt) {
    try { return txt ? JSON.parse(txt) : null; } catch (e) { return null; }
  }

  async function getAcuerdo(acuerdoId) {
    const rows = await readAll(SHEETS.acuerdos);
    const i = rows.findIndex((r) => (r[0] || '').toString().trim() === acuerdoId);
    if (i === -1) return null;
    const r = rows[i];
    return {
      _index: i, _row: r,
      acuerdoId: r[0], asambleaId: r[1], groupId: normalizeGroupKey(r[2]), tipo: r[3],
      titulo: r[4], descripcion: r[5], payload: safeJson(r[6]),
      estado: (r[7] || 'abierto').toString().toLowerCase(), propuestoPor: normalizeEmailKey(r[8]),
      creadoEn: r[9], resueltoEn: r[10], ejecutadoEn: r[11],
      aFavor: num(r[12]), enContra: num(r[13]), abstenciones: num(r[14]),
    };
  }

  async function acuerdoAprobadoValido(groupId, acuerdoId, tipo) {
    if (!acuerdoId) return { valido: false, motivo: 'No se indico ningun acuerdo.' };
    const ac = await getAcuerdo(acuerdoId);
    if (!ac) return { valido: false, motivo: 'El acuerdo no existe.' };
    if (normalizeGroupKey(ac.groupId) !== normalizeGroupKey(groupId)) {
      return { valido: false, motivo: 'El acuerdo pertenece a otro grupo.' };
    }
    if (tipo && ac.tipo !== tipo) return { valido: false, motivo: `El acuerdo no es de tipo ${tipo}.` };
    if (ac.estado !== 'aprobado') return { valido: false, motivo: `El acuerdo esta "${ac.estado}", no aprobado.` };
    return { valido: true, acuerdo: ac };
  }

  async function marcarAcuerdoEjecutado(acuerdoId) {
    const ac = await getAcuerdo(acuerdoId);
    if (!ac) return;
    const row = ac._row.slice();
    while (row.length < SHEETS.acuerdos.headers.length) row.push('');
    row[7] = 'ejecutado';
    row[11] = nowIso();
    await updateRow(SHEETS.acuerdos, ac._index, row);
  }

  async function contarPresentes(asambleaId) {
    const rows = await readAll(SHEETS.asistencia);
    return rows.filter((r) => (r[0] || '') === asambleaId && (r[3] || '').toLowerCase() === 'presente').length;
  }

  /** Recalcula el estado de un acuerdo tras un voto. */
  async function recalcularAcuerdo(acuerdoId) {
    const ac = await getAcuerdo(acuerdoId);
    if (!ac || ['aprobado', 'rechazado', 'ejecutado'].includes(ac.estado)) return ac;

    const votos = (await readAll(SHEETS.votos)).filter((v) => (v[0] || '') === acuerdoId);
    const aFavor = votos.filter((v) => (v[4] || '').toLowerCase() === 'favor').length;
    const enContra = votos.filter((v) => (v[4] || '').toLowerCase() === 'contra').length;
    const abst = votos.filter((v) => (v[4] || '').toLowerCase() === 'abstencion').length;

    const presentes = await contarPresentes(ac.asambleaId);
    const miembros = await miembrosActivos(ac.groupId);
    const reglas = await getReglas(ac.groupId);
    const quorum = quorumAsamblea(miembros.length, reglas.quorumAsambleaPct);
    const r = resultadoVotacion({ aFavor, enContra, presentes, quorum });

    const row = ac._row.slice();
    while (row.length < SHEETS.acuerdos.headers.length) row.push('');
    row[12] = aFavor; row[13] = enContra; row[14] = abst;
    if (r.resuelto) { row[7] = r.estado; row[10] = nowIso(); }
    await updateRow(SHEETS.acuerdos, ac._index, row);
    return { ...ac, aFavor, enContra, abstenciones: abst, estado: r.resuelto ? r.estado : ac.estado, quorum, presentes };
  }

  /** Al cerrar una asamblea, los acuerdos abiertos se resuelven con lo ya votado. */
  async function cerrarAcuerdosPendientes(asamblea) {
    const acuerdos = (await readAll(SHEETS.acuerdos))
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => (r[1] || '') === asamblea.asambleaId && (r[7] || 'abierto').toLowerCase() === 'abierto');
    if (!acuerdos.length) return;

    const presentes = await contarPresentes(asamblea.asambleaId);
    const miembros = await miembrosActivos(asamblea.groupId);
    const reglas = await getReglas(asamblea.groupId);
    const quorum = quorumAsamblea(miembros.length, reglas.quorumAsambleaPct);
    const votosTodos = await readAll(SHEETS.votos);

    for (const { r, i } of acuerdos) {
      const votos = votosTodos.filter((v) => (v[0] || '') === r[0]);
      const aFavor = votos.filter((v) => (v[4] || '').toLowerCase() === 'favor').length;
      const enContra = votos.filter((v) => (v[4] || '').toLowerCase() === 'contra').length;
      const abst = votos.filter((v) => (v[4] || '').toLowerCase() === 'abstencion').length;
      const row = r.slice();
      while (row.length < SHEETS.acuerdos.headers.length) row.push('');
      row[12] = aFavor; row[13] = enContra; row[14] = abst;
      // Sin quorum o sin mayoria a favor => rechazado al cerrar
      row[7] = (presentes >= quorum && aFavor > enContra) ? 'aprobado' : 'rechazado';
      row[10] = nowIso();
      await updateRow(SHEETS.acuerdos, i, row);
    }
  }

  app.post('/api/gob/asambleas/:id/acuerdos', bloquear((r) => `asamblea:${r.params.id}`), async (req, res) => {
    try {
      const asamblea = await getAsamblea(req.params.id);
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      const rol = await requireLider(req, res, asamblea.groupId, ROLES_LIDER);
      if (!rol) return;
      if (!['programada', 'abierta'].includes(asamblea.estado)) {
        return res.status(409).json({ success: false, message: 'La asamblea ya no admite nuevos puntos.' });
      }

      const tipo = (req.body?.tipo || 'otro').toString().trim().toLowerCase();
      const titulo = (req.body?.titulo || '').toString().trim();
      if (!TIPOS_ACUERDO.has(tipo)) {
        return res.status(400).json({ success: false, message: `Tipo de acuerdo invalido. Validos: ${[...TIPOS_ACUERDO].join(', ')}` });
      }
      if (!titulo) return res.status(400).json({ success: false, message: 'Falta el titulo del acuerdo.' });

      const acuerdoId = newId('acu');
      await appendRow(SHEETS.acuerdos, [
        acuerdoId, asamblea.asambleaId, asamblea.groupId, tipo,
        sanitizeCell(titulo, 200), sanitizeCell(req.body?.descripcion || '', 2000),
        sanitizeCell(JSON.stringify(req.body?.payload || {}), 4000),
        'abierto', req.user.email, nowIso(), '', '', 0, 0, 0,
      ]);
      await logGob(asamblea.groupId, req.user.email, 'acuerdo_propuesto', acuerdoId, titulo);
      res.status(201).json({ success: true, acuerdoId });
    } catch (e) {
      console.error('[GOB acuerdo POST]', e);
      res.status(500).json({ success: false, message: 'Error al proponer el acuerdo.' });
    }
  });

  app.post('/api/gob/acuerdos/:id/votar', bloquear((r) => `acuerdo:${r.params.id}`), async (req, res) => {
    try {
      const ac = await getAcuerdo(req.params.id);
      if (!ac) return res.status(404).json({ success: false, message: 'Acuerdo no encontrado.' });
      if (!(await assertGroupMember(req, res, ac.groupId))) return;

      const voto = (req.body?.voto || '').toString().trim().toLowerCase();
      if (!VOTOS_VALIDOS.has(voto)) {
        return res.status(400).json({ success: false, message: 'Voto invalido. Usa favor, contra o abstencion.' });
      }
      if (ac.estado !== 'abierto') {
        return res.status(409).json({ success: false, message: `El acuerdo ya esta ${ac.estado}.` });
      }

      const asamblea = await getAsamblea(ac.asambleaId);
      if (!asamblea || asamblea.estado !== 'abierta') {
        return res.status(409).json({ success: false, message: 'Solo se puede votar con la asamblea abierta.' });
      }

      // Solo vota quien esta marcado presente en la asamblea
      const asistencia = (await readAll(SHEETS.asistencia))
        .find((r) => (r[0] || '') === ac.asambleaId && normalizeEmailKey(r[2]) === req.user.email);
      if (!asistencia || (asistencia[3] || '').toLowerCase() !== 'presente') {
        return res.status(403).json({
          success: false,
          message: 'Solo pueden votar los socios registrados como presentes en la asamblea.',
        });
      }

      const yaVoto = (await readAll(SHEETS.votos))
        .some((v) => (v[0] || '') === ac.acuerdoId && normalizeEmailKey(v[3]) === req.user.email);
      if (yaVoto) return res.status(409).json({ success: false, message: 'Ya registraste tu voto en este acuerdo.' });

      const rolEnGrupo = await getUserGroupRole(req.user.email, ac.groupId);
      await appendRow(SHEETS.votos, [
        ac.acuerdoId, ac.asambleaId, ac.groupId, req.user.email, voto, nowIso(), rolEnGrupo || 'member',
      ]);

      const actualizado = await recalcularAcuerdo(ac.acuerdoId);
      await logGob(ac.groupId, req.user.email, 'voto_acuerdo', ac.acuerdoId, voto);
      res.status(201).json({
        success: true,
        estado: actualizado.estado,
        aFavor: actualizado.aFavor,
        enContra: actualizado.enContra,
        abstenciones: actualizado.abstenciones,
        quorum: actualizado.quorum,
        presentes: actualizado.presentes,
      });
    } catch (e) {
      console.error('[GOB votar]', e);
      res.status(500).json({ success: false, message: 'Error al registrar el voto.' });
    }
  });

  // =========================================================================
  //  5. APERTURA: PASO DE PAPEL A DIGITAL (saldos iniciales)
  // =========================================================================

  async function getLote(loteId) {
    const rows = await readAll(SHEETS.lotes);
    const i = rows.findIndex((r) => (r[0] || '').toString().trim() === loteId);
    if (i === -1) return null;
    const r = rows[i];
    return {
      _index: i, _row: r,
      loteId: r[0], groupId: normalizeGroupKey(r[1]), estado: (r[2] || 'borrador').toLowerCase(),
      creadoPor: normalizeEmailKey(r[3]), creadoEn: r[4], asambleaId: r[5], acuerdoId: r[6],
      aplicadoEn: r[7], totalAhorro: num(r[8]), totalAcciones: num(r[9]), totalDeuda: num(r[10]),
      miembros: num(r[11]), nota: r[12],
    };
  }

  async function detalleLote(loteId) {
    return (await readAll(SHEETS.apertura))
      .filter((r) => (r[0] || '').toString().trim() === loteId)
      .map((r) => ({
        loteId: r[0], groupId: r[1], email: normalizeEmailKey(r[2]),
        ahorro: num(r[3]), acciones: num(r[4]), valorAccion: num(r[5]),
        deuda: num(r[6]), plazoDeuda: Math.max(1, Math.trunc(num(r[7])) || 1), nota: r[8] || '',
      }));
  }

  app.post('/api/gob/apertura/lote', bloquear((r) => `lotes:${normalizeGroupKey(r.body && r.body.groupId)}`), async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.body?.groupId);
      const rol = await requireLider(req, res, groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;

      const filas = Array.isArray(req.body?.filas) ? req.body.filas : [];
      if (filas.length === 0) {
        return res.status(400).json({ success: false, message: 'El lote necesita al menos una fila.' });
      }
      if (filas.length > 300) {
        return res.status(400).json({ success: false, message: 'Maximo 300 filas por lote.' });
      }

      const miembros = await miembrosActivos(groupId);
      const setMiembros = new Set(miembros.map((m) => m.email));
      const vistos = new Set();
      const normalizadas = [];

      for (const f of filas) {
        const email = normalizeEmailKey(f?.email);
        if (!email) return res.status(400).json({ success: false, message: 'Hay una fila sin correo.' });
        if (!setMiembros.has(email)) {
          return res.status(400).json({ success: false, message: `${email} no es miembro activo del grupo. Invitalo primero.` });
        }
        if (vistos.has(email)) {
          return res.status(400).json({ success: false, message: `${email} aparece dos veces en el lote.` });
        }
        vistos.add(email);

        const ahorro = num(f?.ahorro);
        const acciones = num(f?.acciones);
        const valorAccion = num(f?.valorAccion);
        const deuda = num(f?.deuda);
        const plazo = Math.max(1, Math.trunc(num(f?.plazoDeuda)) || 1);

        if (ahorro < 0 || acciones < 0 || deuda < 0 || valorAccion < 0) {
          return res.status(400).json({ success: false, message: `Valores negativos en la fila de ${email}.` });
        }
        if (ahorro > 100000000 || deuda > 100000000 || acciones > 1000000) {
          return res.status(400).json({ success: false, message: `Valores fuera de rango en la fila de ${email}.` });
        }
        if (acciones > 0 && valorAccion <= 0) {
          return res.status(400).json({ success: false, message: `Falta el valor de la accion para ${email}.` });
        }
        if (ahorro === 0 && acciones === 0 && deuda === 0) {
          return res.status(400).json({ success: false, message: `La fila de ${email} no aporta ningun saldo.` });
        }
        normalizadas.push({ email, ahorro, acciones, valorAccion, deuda, plazo, nota: sanitizeCell(f?.nota || '', 200) });
      }

      const loteId = newId('lote');
      const totalAhorro = normalizadas.reduce((s, f) => s + f.ahorro, 0);
      const totalAcciones = normalizadas.reduce((s, f) => s + f.acciones, 0);
      const totalDeuda = normalizadas.reduce((s, f) => s + f.deuda, 0);

      await appendRow(SHEETS.lotes, [
        loteId, groupId, 'borrador', req.user.email, nowIso(), '', '', '',
        totalAhorro, totalAcciones, totalDeuda, normalizadas.length,
        sanitizeCell(req.body?.nota || '', 400),
      ]);

      const sheetsClient = await ensure(SHEETS.apertura);
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEETS.apertura.name}!A:I`,
        valueInputOption: 'RAW',
        requestBody: {
          values: normalizadas.map((f) => [
            loteId, groupId, f.email, f.ahorro, f.acciones, f.valorAccion, f.deuda, f.plazo, f.nota,
          ]),
        },
      });

      await logGob(groupId, req.user.email, 'lote_apertura_creado', loteId,
        `${normalizadas.length} socios, ahorro ${totalAhorro}, acciones ${totalAcciones}, deuda ${totalDeuda}`);
      res.status(201).json({
        success: true, loteId, resumen: { totalAhorro, totalAcciones, totalDeuda, miembros: normalizadas.length },
      });
    } catch (e) {
      console.error('[GOB lote POST]', e);
      res.status(500).json({ success: false, message: 'Error al crear el lote de apertura.' });
    }
  });

  app.get('/api/gob/apertura/lotes', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!(await assertGroupMember(req, res, groupId))) return;
      const lotes = (await readAll(SHEETS.lotes))
        .filter((r) => normalizeGroupKey(r[1]) === groupId)
        .map((r) => ({
          loteId: r[0], groupId: r[1], estado: (r[2] || 'borrador').toLowerCase(), creadoPor: r[3],
          creadoEn: r[4], asambleaId: r[5], acuerdoId: r[6], aplicadoEn: r[7],
          totalAhorro: num(r[8]), totalAcciones: num(r[9]), totalDeuda: num(r[10]), miembros: num(r[11]),
        }))
        .sort((a, b) => new Date(b.creadoEn || 0) - new Date(a.creadoEn || 0));
      res.json({ success: true, lotes });
    } catch (e) {
      console.error('[GOB lotes GET]', e);
      res.status(500).json({ success: false, message: 'Error al listar los lotes.' });
    }
  });

  app.get('/api/gob/apertura/lote/:id', async (req, res) => {
    try {
      const lote = await getLote(req.params.id);
      if (!lote) return res.status(404).json({ success: false, message: 'Lote no encontrado.' });
      if (!(await assertGroupMember(req, res, lote.groupId))) return;
      delete lote._index; delete lote._row;
      res.json({ success: true, lote, filas: await detalleLote(lote.loteId) });
    } catch (e) {
      console.error('[GOB lote GET]', e);
      res.status(500).json({ success: false, message: 'Error al leer el lote.' });
    }
  });

  app.post('/api/gob/apertura/lote/:id/proponer', bloquear((r) => `lote:${r.params.id}`), async (req, res) => {
    try {
      const lote = await getLote(req.params.id);
      if (!lote) return res.status(404).json({ success: false, message: 'Lote no encontrado.' });
      const rol = await requireLider(req, res, lote.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      if (lote.estado !== 'borrador') {
        return res.status(409).json({ success: false, message: `El lote ya esta "${lote.estado}".` });
      }

      const asamblea = await getAsamblea((req.body?.asambleaId || '').toString().trim());
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      if (normalizeGroupKey(asamblea.groupId) !== lote.groupId) {
        return res.status(403).json({ success: false, message: 'Esa asamblea es de otro grupo.' });
      }
      if (!['programada', 'abierta'].includes(asamblea.estado)) {
        return res.status(409).json({ success: false, message: 'La asamblea ya no admite nuevos puntos.' });
      }

      const acuerdoId = newId('acu');
      await appendRow(SHEETS.acuerdos, [
        acuerdoId, asamblea.asambleaId, lote.groupId, 'apertura_saldos',
        sanitizeCell(`Aprobacion de saldos iniciales (${lote.miembros} socios)`, 200),
        sanitizeCell(`Ahorro ${lote.totalAhorro}, acciones ${lote.totalAcciones}, deuda ${lote.totalDeuda}. Lote ${lote.loteId}.`, 2000),
        JSON.stringify({ loteId: lote.loteId }),
        'abierto', req.user.email, nowIso(), '', '', 0, 0, 0,
      ]);

      const row = lote._row.slice();
      while (row.length < SHEETS.lotes.headers.length) row.push('');
      row[2] = 'propuesto'; row[5] = asamblea.asambleaId; row[6] = acuerdoId;
      await updateRow(SHEETS.lotes, lote._index, row);

      await logGob(lote.groupId, req.user.email, 'lote_apertura_propuesto', lote.loteId, acuerdoId);
      res.json({ success: true, acuerdoId, asambleaId: asamblea.asambleaId, estado: 'propuesto' });
    } catch (e) {
      console.error('[GOB lote proponer]', e);
      res.status(500).json({ success: false, message: 'Error al proponer el lote.' });
    }
  });

  app.post('/api/gob/apertura/lote/:id/aplicar', bloquear((r) => `lote:${r.params.id}`), async (req, res) => {
    try {
      const lote = await getLote(req.params.id);
      if (!lote) return res.status(404).json({ success: false, message: 'Lote no encontrado.' });
      const rol = await requireLider(req, res, lote.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;

      if (lote.estado === 'aplicado') {
        return res.status(409).json({ success: false, message: 'Este lote ya fue aplicado.' });
      }
      if (lote.estado !== 'propuesto') {
        return res.status(409).json({ success: false, message: 'Primero somete el lote a una asamblea.' });
      }
      const chk = await acuerdoAprobadoValido(lote.groupId, lote.acuerdoId, 'apertura_saldos');
      if (!chk.valido) {
        return res.status(409).json({
          success: false,
          message: 'Los saldos iniciales solo se aplican con el acuerdo de asamblea aprobado.',
          detalle: chk.motivo,
        });
      }

      const filas = await detalleLote(lote.loteId);
      if (filas.length === 0) {
        return res.status(400).json({ success: false, message: 'El lote no tiene filas.' });
      }

      const sheetsClient = await getSheetsClient();
      const fecha = nowIso();
      const fechaCorta = fecha.split('T')[0];

      const savingsRows = [];
      const accionesRows = [];
      const loansRows = [];
      const transRows = [];

      for (const f of filas) {
        if (f.ahorro > 0) {
          const movId = newId('apsav');
          savingsRows.push([
            f.email, lote.groupId, f.ahorro, fechaCorta, 'saldo_inicial',
            `Saldo inicial aprobado en asamblea (lote ${lote.loteId})`,
            'confirmado', req.user.email, req.user.email, fecha, movId,
            sanitizeCell(f.nota, 200),
          ]);
          transRows.push([
            `${Date.now()}${Math.floor(Math.random() * 1000)}`, f.email, 'saving', f.ahorro,
            `Saldo inicial de apertura (lote ${lote.loteId})`, fecha, 'apertura', '',
          ]);
        }
        if (f.acciones > 0) {
          const movId = newId('apacc');
          accionesRows.push([
            f.email, lote.groupId, fechaCorta, f.acciones, f.valorAccion, 0, fecha,
            'confirmado', req.user.email, req.user.email, fecha, movId,
            sanitizeCell(f.nota, 200),
          ]);
        }
        if (f.deuda > 0) {
          const loanId = newId('aploan');
          const vence = new Date();
          vence.setMonth(vence.getMonth() + f.plazoDeuda);
          loansRows.push([
            loanId, f.email, lote.groupId, f.deuda, fecha, vence.toISOString(),
            0, 'aprobado', f.plazoDeuda, f.deuda,
          ]);
        }
      }

      if (savingsRows.length) {
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `Savings!A:${SAVINGS_LAST_COL}`,
          valueInputOption: 'RAW',
          requestBody: { values: savingsRows },
        });
      }
      if (accionesRows.length) {
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: `Acciones!A:${ACCIONES_LAST_COL}`,
          valueInputOption: 'RAW',
          requestBody: { values: accionesRows },
        });
      }
      if (loansRows.length) {
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Loans!A:J',
          valueInputOption: 'RAW',
          requestBody: { values: loansRows },
        });
      }
      if (transRows.length) {
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: 'Transactions!A:H',
          valueInputOption: 'RAW',
          requestBody: { values: transRows },
        });
      }

      const row = lote._row.slice();
      while (row.length < SHEETS.lotes.headers.length) row.push('');
      row[2] = 'aplicado';
      row[7] = fecha;
      await updateRow(SHEETS.lotes, lote._index, row);
      await marcarAcuerdoEjecutado(lote.acuerdoId);

      await logGob(lote.groupId, req.user.email, 'lote_apertura_aplicado', lote.loteId,
        `ahorros ${savingsRows.length}, acciones ${accionesRows.length}, deudas ${loansRows.length}`);

      res.json({
        success: true,
        aplicado: {
          ahorros: savingsRows.length,
          acciones: accionesRows.length,
          deudas: loansRows.length,
        },
      });
    } catch (e) {
      console.error('[GOB lote aplicar]', e);
      res.status(500).json({ success: false, message: 'Error al aplicar el lote.' });
    }
  });

  // =========================================================================
  //  6. TABLERO DE CONTROL INTERNO
  // =========================================================================

  app.get('/api/gob/tablero', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!(await assertGroupMember(req, res, groupId))) return;

      const [reglas, miembros, asambleas, lotes, savings, acciones] = [
        await getReglas(groupId),
        await miembrosActivos(groupId),
        await readAll(SHEETS.asambleas),
        await readAll(SHEETS.lotes),
        await leerSavings(),
        await leerAcciones(),
      ];

      const delGrupo = (rows, gi) => rows.filter((r) => normalizeGroupKey(r[gi]) === groupId);
      const savG = delGrupo(savings, SAV.group);
      const accG = delGrupo(acciones, ACC.group);

      const asambleaAbierta = asambleas.find((r) => normalizeGroupKey(r[1]) === groupId
        && (r[5] || '').toLowerCase() === 'abierta');

      delete reglas._index;
      res.json({
        success: true,
        reglas,
        miembros: { activos: miembros.length, lideres: miembros.filter((m) => esLider(m.rol)).length },
        aportes: {
          ahorroConfirmado: savG.filter((r) => aporteCuenta(r[SAV.estado])).reduce((s, r) => s + num(r[SAV.amount]), 0),
          ahorroPendiente: savG.filter((r) => estadoAporte(r[SAV.estado]) === 'pendiente').reduce((s, r) => s + num(r[SAV.amount]), 0),
          pendientesAhorro: savG.filter((r) => estadoAporte(r[SAV.estado]) === 'pendiente').length,
          pendientesAcciones: accG.filter((r) => estadoAporte(r[ACC.estado]) === 'pendiente').length,
          accionesConfirmadas: accG.filter((r) => aporteCuenta(r[ACC.estado])).reduce((s, r) => s + num(r[ACC.shares]), 0),
        },
        asamblea: asambleaAbierta
          ? { asambleaId: asambleaAbierta[0], titulo: asambleaAbierta[2], estado: 'abierta' }
          : null,
        apertura: {
          lotesBorrador: delGrupo(lotes, 1).filter((r) => (r[2] || '').toLowerCase() === 'borrador').length,
          lotesPropuestos: delGrupo(lotes, 1).filter((r) => (r[2] || '').toLowerCase() === 'propuesto').length,
          lotesAplicados: delGrupo(lotes, 1).filter((r) => (r[2] || '').toLowerCase() === 'aplicado').length,
        },
      });
    } catch (e) {
      console.error('[GOB tablero]', e);
      res.status(500).json({ success: false, message: 'Error al construir el tablero.' });
    }
  });

  app.get('/api/gob/bitacora', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      const rol = await requireLider(req, res, groupId, ROLES_LIDER);
      if (!rol) return;
      const limite = Math.min(500, Math.max(1, Math.trunc(num(req.query.limite)) || 100));
      const rows = (await readAll(SHEETS.log))
        .filter((r) => normalizeGroupKey(r[1]) === groupId)
        .map((r) => ({ fecha: r[0], groupId: r[1], actor: r[2], accion: r[3], objetivo: r[4], detalle: r[5] }))
        .sort((a, b) => new Date(b.fecha || 0) - new Date(a.fecha || 0))
        .slice(0, limite);
      res.json({ success: true, eventos: rows });
    } catch (e) {
      console.error('[GOB bitacora]', e);
      res.status(500).json({ success: false, message: 'Error al leer la bitacora.' });
    }
  });

  // Helpers que server.js necesita para aplicar el reglamento en sus propias rutas
  return {
    getReglas,
    ahorroConfirmado,
    miembrosActivos,
    estadoAporte,
    aporteCuenta,
    newId,
    SHEETS,
    logGob,
  };
};
