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

const {
  repartirUtilidades, gananciaDelGrupo, repartoMesAMes, repartirCentavos, BASES, gananciaPorMes,
  mesDe: mesDelReparto,
} = require('./reparto');

/** El mes en curso, en el calendario de quien usa la app (nunca UTC). */
const mesActualDelReparto = (d = new Date()) => (
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
const {
  sumarMeses, partesDeFecha, formatear, cuadroDeCuotas, moraAcumulada, diasDelMes,
} = require('./cuotas');
const { actualizarFilaPorClave } = require('./escritura');
const { conBloqueo } = require('./lock');
const { esDeCuota: errorDeCuota } = require('./hoja');

/** 429 con explicacion cuando se agota la cuota de Google, no 500. */
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

const SHEETS = {
  reglas: {
    name: 'GrupoReglas',
    headers: ['GroupID', 'RequiereAprobacionAportes', 'RequiereAprobacionPrestamos', 'QuorumPrestamos',
      'TopePrestamoFactorAhorro', 'MaxPrestamosActivos', 'AporteMinimo', 'AporteMaximo',
      'QuorumAsambleaPct', 'ActualizadoPor', 'ActualizadoEn', 'BaseReparto',
      'AccionesMinimasPorMes', 'DiaDeAsamblea', 'MoraPorcentajeMensual', 'DiasDeGracia'],
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
    headers: ['LoteID', 'GroupID', 'Email', 'Ahorro', 'Acciones', 'ValorAccion', 'Deuda', 'PlazoDeuda',
      'Nota', 'InteresDeuda', 'MesesPagados', 'Utilidades'],
  },
  salidas: {
    name: 'Salidas',
    headers: ['SalidaID', 'GroupID', 'Email', 'Estado', 'SolicitadaEn', 'CalculadaEn',
      'CalculadaPor', 'AsambleaID', 'AcuerdoID', 'AplicadaEn', 'MesSalida',
      'Ahorro', 'AccionesValor', 'AccionesUnidades', 'Utilidades', 'Total',
      'ValoresJSON', 'Nota'],
  },
  cierres: {
    name: 'CierresUtilidades',
    headers: ['CierreID', 'GroupID', 'Estado', 'CreadoPor', 'CreadoEn', 'AsambleaID', 'AcuerdoID',
      'AplicadoEn', 'Ganancia', 'Base', 'Participacion', 'Socios', 'Periodo', 'Nota',
      // Ganancia = lo que se ABONA. GananciaPeriodo = lo que el periodo dio de si.
      // La diferencia es Retenido: lo que la asamblea decidio no repartir todavia.
      'GananciaPeriodo', 'Retenido', 'Decision'],
  },
  cierreDetalle: {
    name: 'CierreUtilidadesDetalle',
    headers: ['CierreID', 'GroupID', 'Email', 'Acciones', 'Ahorro', 'Participacion',
      'Proporcion', 'Utilidad',
      // Lo que le TOCABA por los meses que cierra este cierre. Si se reparte
      // menos, la diferencia es su derecho retenido, y con estos pesos (no con
      // el capital de hoy) se reparte cuando el grupo decida repartirlo.
      'Devengado'],
  },
  avales: {
    name: 'Avales',
    headers: ['AvalID', 'GroupID', 'Email', 'AvalEmail', 'Cupo', 'Estado',
      'AsambleaID', 'AcuerdoID', 'CreadoPor', 'CreadoEn', 'ResueltoPor', 'ResueltoEn', 'Motivo'],
  },
  cierreGrupo: {
    name: 'CierresGrupo',
    headers: ['CierreID', 'GroupID', 'Estado', 'CreadoPor', 'CreadoEn', 'AsambleaID',
      'AcuerdoID', 'AplicadoEn', 'AplicadoPor', 'Socias', 'TotalDevuelto',
      'DetalleJSON', 'Nota'],
  },
  caja: {
    name: 'CajaMovimientos',
    headers: ['MovID', 'GroupID', 'Tipo', 'Email', 'Concepto', 'Importe', 'Estado',
      'AsambleaID', 'AcuerdoID', 'CreadoPor', 'CreadoEn', 'ResueltoPor', 'ResueltoEn', 'Nota'],
  },
  prestamoMovs: {
    name: 'PrestamoMovimientos',
    headers: ['MovID', 'GroupID', 'LoanID', 'Email', 'Tipo', 'Importe',
      'TotalAntes', 'TotalDespues', 'PlazoAntes', 'PlazoDespues',
      'VenceAntes', 'VenceDespues', 'EstadoAntes', 'EstadoDespues',
      'AcuerdoID', 'Actor', 'Fecha', 'Motivo'],
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
  // Sobre que se reparte lo que el grupo gana con los prestamos:
  //   'acciones' = en proporcion a las acciones compradas (lo habitual)
  //   'ahorros'  = en proporcion al ahorro confirmado
  //   'ambos'    = a la suma de acciones mas ahorro
  baseReparto: 'acciones',
  // Cuantas acciones se compromete a comprar cada socia en cada ciclo. En un
  // banco comunal lo normal es "una accion al mes"; 0 = el grupo no lo exige.
  accionesMinimasPorMes: 0,
  // Que dia del mes se reune el grupo. Sirve para decirle a cada socia cuando
  // es la proxima asamblea mientras todavia no esta convocada. 0 = sin dia fijo.
  diaDeAsamblea: 0,
  // Recargo por pagar tarde, al mes, sobre lo VENCIDO y sin cubrir. 0 = el
  // grupo no cobra mora, que es como venia funcionando.
  moraPorcentajeMensual: 0,
  // Dias de cortesia despues del vencimiento antes de que empiece a correr.
  diasDeGracia: 0,
};

const ESTADOS_APORTE = new Set(['pendiente', 'confirmado', 'rechazado']);

// Movimientos que escribe el propio sistema (reparto de utilidades y traspaso
// del cuaderno). No son aportes que alguien declare, asi que no se confirman ni
// se revierten desde la bandeja de tesoreria.
const MOVIMIENTOS_DEL_SISTEMA = new Set(['utilidad', 'saldo_inicial']);
const ESTADOS_ASAMBLEA = new Set(['programada', 'abierta', 'cerrada', 'cancelada']);
const ESTADOS_ASISTENCIA = new Set(['presente', 'ausente', 'justificado']);
const VOTOS_VALIDOS = new Set(['favor', 'contra', 'abstencion']);
const TIPOS_ACUERDO = new Set(['apertura_saldos', 'cambio_reglas', 'prestamo', 'sancion', 'gasto',
  'salida_socia', 'reparto_utilidades', 'movimiento_prestamo', 'cierre_grupo', 'aval', 'otro']);

/**
 * Lo que la asamblea puede decidir sobre un prestamo ya dado.
 *
 * `mora` no esta aqui a proposito: no es una decision de asamblea sino la
 * aplicacion de lo que el grupo ya escribio en su reglamento, asi que la
 * tesoreria la aplica y queda registrada. Las cuatro de abajo si mueven dinero
 * de todos por una decision, y esas no las firma una persona sola.
 */
const MOVS_PRESTAMO = new Set(['condonacion', 'reprogramacion', 'refinanciacion', 'anulacion']);

// Un punto anulado no vale para nada: ni se recuentan sus votos, ni autoriza, ni se
// archiva al cerrar la asamblea como si hubiera perdido la votacion.
const ESTADOS_ACUERDO_CERRADOS = ['aprobado', 'rechazado', 'ejecutado', 'anulado'];
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
    configuracionDelGrupo,
    getLoanGroupMap,
    contarPrestamosActivos,
    bloquear,
  } = ctx;

  const nowIso = () => new Date().toISOString();
  const newId = (p) => `${p}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const num = (v) => {
    const n = parseMoney(v);
    return Number.isFinite(n) ? n : 0;
  };
  // Google Sheets con el idioma en espanol escribe VERDADERO y FALSO al marcar
  // una casilla. Sin reconocerlos, `RequiereAprobacionAportes = VERDADERO` se
  // leia como FALSO y se apagaba el control interno del grupo entero: cualquier
  // socio declaraba un aporte y pasaba a patrimonio sin la firma de tesoreria.
  const SI = ['si', 'sí', 'true', 'verdadero', 'v', '1', 'yes', 'x'];
  const NO = ['no', 'false', 'falso', 'f', '0'];
  const boolCell = (v, porDefecto = false) => {
    const s = (v == null ? '' : v).toString().trim().toLowerCase();
    if (!s) return porDefecto;
    if (SI.includes(s)) return true;
    if (NO.includes(s)) return false;
    return porDefecto;
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

  /**
   * Actualiza una fila completa. El indice es solo una PISTA: antes de escribir
   * se comprueba que la fila de esa posicion sigue teniendo el identificador
   * que se espera (columna A en todas las hojas de gobernanza), y si se movio
   * se la busca. Escribir a ciegas en la posicion N pisaba a otro cuando una
   * fila de mas arriba desaparecia entre la lectura y la escritura.
   */
  async function updateRow(def, dataIndex, row) {
    const sheetsClient = await ensure(def);
    const last = colLetter(def.headers.length - 1);
    const id = (row && row[0] != null ? row[0] : '').toString().trim();
    if (!id) {
      // Sin identificador no hay forma de reconocer la fila: se escribe donde
      // se dijo, como antes, pero eso solo pasa en hojas sin clave.
      const sheetRow = dataIndex + 2;
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${def.name}!A${sheetRow}:${last}${sheetRow}`,
        valueInputOption: 'RAW',
        requestBody: { values: [row] },
      });
      return;
    }
    await actualizarFilaPorClave(sheetsClient, {
      spreadsheetId: SPREADSHEET_ID,
      hoja: def.name,
      ultimaColumna: last,
      indice: dataIndex,
      claveCol: 0,
      clave: id,
      construir: () => row,
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
      baseReparto: BASES.has((row[11] || '').toString().trim().toLowerCase())
        ? (row[11] || '').toString().trim().toLowerCase()
        : REGLAS_DEFECTO.baseReparto,
      // Columnas nuevas: las filas que ya estan escritas en la hoja no las
      // traen, y `num('')` da 0, que es justo "el grupo no lo exige".
      accionesMinimasPorMes: Math.max(0, Math.trunc(num(row[12]))),
      diaDeAsamblea: Math.min(31, Math.max(0, Math.trunc(num(row[13])))),
      // Un recargo desbocado no es un banco comunal: se topa al 10 % mensual.
      moraPorcentajeMensual: Math.min(10, Math.max(0, num(row[14]))),
      diasDeGracia: Math.min(60, Math.max(0, Math.trunc(num(row[15])))),
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
      r.baseReparto || REGLAS_DEFECTO.baseReparto,
      Math.max(0, Math.trunc(Number(r.accionesMinimasPorMes) || 0)),
      Math.min(31, Math.max(0, Math.trunc(Number(r.diaDeAsamblea) || 0))),
      Math.min(10, Math.max(0, Number(r.moraPorcentajeMensual) || 0)),
      Math.min(60, Math.max(0, Math.trunc(Number(r.diasDeGracia) || 0))),
    ];
  }

  /**
   * Confirma los aportes que se quedaron esperando. Se usa al apagar la
   * aprobacion de aportes: si la regla deja de existir, lo que estaba a la
   * espera de esa firma no puede quedarse colgado para siempre.
   */
  async function confirmarPendientesDelGrupo(groupId, actor) {
    const gid = normalizeGroupKey(groupId);
    const ahora = nowIso();
    let tocados = 0;

    for (const [rows, idx, def, lastCol] of [
      [await leerSavings(), SAV, { name: 'Savings' }, SAVINGS_LAST_COL],
      [await leerAcciones(), ACC, { name: 'Acciones' }, ACCIONES_LAST_COL],
    ]) {
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (normalizeGroupKey(row[idx.group]) !== gid) continue;
        if (estadoAporte(row[idx.estado]) !== 'pendiente') continue;

        const completo = row.slice();
        while (completo.length <= idx.nota) completo.push('');
        completo[idx.estado] = 'confirmado';
        completo[idx.resueltoPor] = actor;
        completo[idx.fechaEstado] = ahora;
        completo[idx.nota] = 'Confirmado al apagar la aprobacion de aportes del grupo.';

        const sheetsClient = await getSheetsClient();
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${def.name}!A${i + 2}:${lastCol}${i + 2}`,
          valueInputOption: 'RAW',
          requestBody: { values: [completo] },
        });
        tocados += 1;
      }
    }
    return tocados;
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

  /** Un grupo dado de baja no admite ninguna operacion de gobierno. */
  async function grupoActivo(groupId) {
    try {
      const sheetsClient = await getSheetsClient();
      const resp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'Groups!A2:L',
      });
      const row = (resp.data.values || [])
        .find((r) => (r[0] || '').toString().trim() === normalizeGroupKey(groupId));
      return !row || (row[11] || '').toString().trim().toLowerCase() !== 'eliminado';
    } catch (e) {
      return true;   // ante la duda no se bloquea a nadie
    }
  }

  /** Exige rol de lider del grupo. Responde 403 si no. */
  async function requireLider(req, res, groupId, rolesPermitidos = ROLES_LIDER) {
    const gid = normalizeGroupKey(groupId);
    if (!gid) {
      res.status(400).json({ success: false, message: 'Falta el identificador del grupo.' });
      return null;
    }
    // Sin atajo para el administrador de la plataforma: el control interno de un
    // grupo (reglamento, confirmar aportes, aplicar la apertura, repartir
    // utilidades) es de su directiva. Quien no esta en la nomina del grupo, no
    // firma en el grupo.

    if (!(await grupoActivo(gid))) {
      res.status(409).json({
        success: false,
        message: 'Este grupo esta dado de baja y ya no admite movimientos.',
        motivo: 'grupo_dado_de_baja',
      });
      return null;
    }

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
      if (responderSiEsCuota(res, e)) return;
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
        baseReparto: b.baseReparto === undefined
          ? actuales.baseReparto
          : (BASES.has((b.baseReparto || '').toString().trim().toLowerCase())
            ? (b.baseReparto || '').toString().trim().toLowerCase()
            : actuales.baseReparto),
        // Cuantas acciones se compromete cada socia por ciclo y que dia se
        // reune el grupo. De aqui sale lo que la app le recuerda a cada una.
        accionesMinimasPorMes: b.accionesMinimasPorMes === undefined
          ? actuales.accionesMinimasPorMes
          : Math.max(0, Math.trunc(num(b.accionesMinimasPorMes))),
        diaDeAsamblea: b.diaDeAsamblea === undefined
          ? actuales.diaDeAsamblea
          : Math.min(31, Math.max(0, Math.trunc(num(b.diaDeAsamblea)))),
        moraPorcentajeMensual: b.moraPorcentajeMensual === undefined
          ? actuales.moraPorcentajeMensual
          : Math.min(10, Math.max(0, num(b.moraPorcentajeMensual))),
        diasDeGracia: b.diasDeGracia === undefined
          ? actuales.diasDeGracia
          : Math.min(60, Math.max(0, Math.trunc(num(b.diasDeGracia)))),
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
        || (propuesta.maxPrestamosActivos > actuales.maxPrestamosActivos)
        // Subir la mora encarece prestamos que ya estan dados: no lo firma una
        // sola persona, aunque "endurecer" suene a que protege al grupo.
        || (propuesta.moraPorcentajeMensual > actuales.moraPorcentajeMensual);

      if (relaja && actuales.existe) {
        const acuerdoId = (b.acuerdoId || '').toString().trim();
        const ok = await acuerdoAprobadoValido(groupId, acuerdoId, 'cambio_reglas');
        if (!ok.valido) {
          // Subir la mora no "relaja" nada, pero encarece prestamos que ya
          // estan dados, asi que tambien pasa por asamblea. Decirle a la
          // presidenta que esta relajando el control cuando lo esta apretando
          // la deja sin entender que hizo mal.
          const subeLaMora = propuesta.moraPorcentajeMensual > actuales.moraPorcentajeMensual;
          return res.status(409).json({
            success: false,
            requiereAcuerdo: true,
            motivo: subeLaMora ? 'mora_al_alza' : 'relaja_control',
            message: subeLaMora
              ? `Subir la mora al ${propuesta.moraPorcentajeMensual}% encarece los prestamos que `
                + 'ya estan dados, asi que lo tiene que aprobar la asamblea. Convocala, propon el '
                + 'cambio y sometelo a votacion.'
              : 'Relajar el control interno requiere un acuerdo de asamblea aprobado. '
                + 'Convoca una asamblea, propone el cambio y sometelo a votacion.',
            detalle: ok.motivo,
          });
        }
        await marcarAcuerdoEjecutado(acuerdoId);
      }

      await guardarReglas(groupId, propuesta, req.user.email);
      await logGob(groupId, req.user.email, 'reglas_actualizadas', groupId, JSON.stringify(propuesta));

      // Apagar la aprobacion de aportes tiene que liberar tambien los que ya
      // estaban esperando. Antes solo valia para los futuros, asi que los
      // pendientes se quedaban ahi para siempre: ni confirmados, ni rechazados,
      // ni contando en el patrimonio de nadie.
      let liberados = 0;
      if (actuales.requiereAprobacionAportes && !propuesta.requiereAprobacionAportes) {
        liberados = await confirmarPendientesDelGrupo(groupId, req.user.email);
        if (liberados > 0) {
          await logGob(groupId, req.user.email, 'aportes_liberados', groupId,
            `${liberados} aportes que estaban pendientes quedaron confirmados al apagar la aprobacion`);
        }
      }

      res.json({ success: true, reglas: { ...propuesta, groupId }, aportesLiberados: liberados });
    } catch (e) {
      console.error('[GOB reglas POST]', e);
      if (responderSiEsCuota(res, e)) return;
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
          // Una fila sin identificador solo se reconoce por lo que la distingue.
          // Se manda de vuelta al confirmar para comprobar que se resuelve LA
          // MISMA que la tesoreria tenia delante.
          sena: r[SAV.movId] ? '' : `${normalizeEmailKey(r[SAV.email])}|${num(r[SAV.amount])}|${r[SAV.date] || ''}`,
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
          sena: r[ACC.movId] ? '' : `${normalizeEmailKey(r[ACC.email])}|${num(r[ACC.shares])}|${r[ACC.date] || ''}`,
        }));

      // Movimientos ya resueltos: la presidencia los necesita a la vista para poder
      // corregir una confirmacion equivocada sin tener que editar la hoja a mano.
      const resueltos = [
        ...savings
          // Fuera los movimientos que escribe el sistema: aparecian con su
          // boton de Revertir y al pulsarlo el socio perdia su reparto.
          .filter((r) => !MOVIMIENTOS_DEL_SISTEMA.has((r[SAV.type] || '').toString().trim().toLowerCase()))
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
      if (responderSiEsCuota(res, e)) return;
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
      if (responderSiEsCuota(res, e)) return;
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

      const buscado = movId.toString().trim();
      const coincidencias = rows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => (r[idx.movId] || '').toString().trim() === buscado);

      // Dos filas con el mismo identificador: se resolvia siempre la primera y
      // la segunda quedaba atrapada para siempre (medido: un aporte de $999
      // que no habia forma de confirmar). Es un error de la hoja y hay que
      // decirlo, no elegir una en silencio.
      if (coincidencias.length > 1) {
        return res.status(409).json({
          success: false,
          motivo: 'movid_duplicado',
          message: `Hay ${coincidencias.length} movimientos con el identificador ${buscado} en `
            + `${sheetName}. Corrige la hoja de calculo dejando uno solo antes de resolverlo.`,
        });
      }

      let fila = coincidencias.length === 1 ? coincidencias[0].i : -1;

      // Una fila escrita a mano en la hoja no tiene MovID. La bandeja le inventa
      // uno con su posicion (`SAVROW_3`), asi que hay que aceptarlo aqui: si no,
      // la tesoreria pulsa "confirmar" sobre lo que la propia app le dio y
      // recibe un 404, y esa fila se queda pendiente para siempre. Es el caso
      // normal al traspasar el cuaderno a la hoja.
      if (fila === -1) {
        const sintetico = buscado.match(/^(SAVROW|ACCROW)_(\d+)$/i);
        if (sintetico) {
          const esperado = sintetico[1].toUpperCase() === 'SAVROW' ? 'Savings' : 'Acciones';
          // La sena identifica la fila por su CONTENIDO, no por su posicion.
          // Con la posicion sola, si desaparecia una fila de mas arriba entre
          // que la tesoreria ve la bandeja y pulsa confirmar, se confirmaba el
          // aporte de otra socia: medido, pulso sobre $25 y confirmo $900.
          const senaPedida = (req.body?.sena || '').toString().trim().toLowerCase();
          const senaDe = (r) => (sheetName === 'Savings'
            ? `${normalizeEmailKey(r[SAV.email])}|${num(r[SAV.amount])}|${r[SAV.date] || ''}`
            : `${normalizeEmailKey(r[ACC.email])}|${num(r[ACC.shares])}|${r[ACC.date] || ''}`)
            .toLowerCase();

          if (esperado !== sheetName) {
            return res.status(400).json({
              success: false,
              message: 'El identificador no corresponde a este tipo de aporte.',
            });
          }
          if (!senaPedida) {
            return res.status(409).json({
              success: false,
              motivo: 'falta_sena',
              message: 'Este movimiento se escribio directamente en la hoja y no tiene '
                + 'identificador. Vuelve a cargar la bandeja de aportes para poder resolverlo.',
            });
          }
          const iguales = rows
            .map((r, i) => ({ r, i }))
            .filter(({ r }) => !(r[idx.movId] || '').toString().trim() && senaDe(r) === senaPedida);
          if (iguales.length === 0) {
            return res.status(409).json({
              success: false,
              motivo: 'fila_movida',
              message: 'Ese movimiento ya no esta donde estaba: alguien pudo editar la hoja '
                + 'mientras tanto. Vuelve a cargar la bandeja de aportes.',
            });
          }
          if (iguales.length > 1) {
            return res.status(409).json({
              success: false,
              motivo: 'filas_identicas',
              message: `Hay ${iguales.length} filas identicas (mismo socio, mismo importe y `
                + 'misma fecha) sin identificador. Ponles un MovID distinto en la hoja para '
                + 'poder resolverlas por separado.',
            });
          }
          fila = iguales[0].i;
        }
      }

      if (fila === -1) return res.status(404).json({ success: false, message: 'Movimiento no encontrado.' });

      const row = rows[fila];
      if (normalizeGroupKey(row[idx.group]) !== groupId) {
        return res.status(403).json({ success: false, message: 'El movimiento pertenece a otro grupo.' });
      }
      const estado = estadoAporte(row[idx.estado]);

      // Las utilidades repartidas y los saldos traidos del cuaderno los genera
      // el sistema, no los declara nadie: no se tocan desde la bandeja de
      // aportes. Revertir una utilidad abonada le quitaba el dinero al socio y
      // dejaba el cierre dado por hecho, asi que ese importe no se podia
      // volver a repartir nunca.
      const tipoMov = esAhorro ? (row[idx.type] || '').toString().trim().toLowerCase() : '';
      if (MOVIMIENTOS_DEL_SISTEMA.has(tipoMov)) {
        return res.status(409).json({
          success: false,
          message: tipoMov === 'utilidad'
            ? 'Este movimiento es un reparto de utilidades, no un aporte declarado. '
              + 'Ese dinero ya está en la libreta de cada socia y no se le quita. Si la cifra '
              + 'estaba mal, revisa el comprobante que la generó en la pantalla de revisión '
              + 'de comprobantes.'
            : 'Este movimiento viene del traspaso de saldos del cuaderno. '
              + 'Para corregirlo hay que revisar el lote de apertura.',
          tipo: tipoMov,
        });
      }

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
        // Y si la celda esta vacia, la comparacion de arriba no aplica: la
        // regla se saltaba escribiendo la fila directamente en la hoja. Medido:
        // la tesorera se confirmo a si misma $500 que habia tecleado ella. Una
        // fila sin autor conocido la confirma alguien que no sea quien la esta
        // resolviendo, y queda anotado quien la trajo.
        if (!normalizeEmailKey(row[idx.registradoPor]) && accion === 'confirmar') {
          const yoSoyElDuenio = normalizeEmailKey(row[idx.email]) === req.user.email;
          if (yoSoyElDuenio) {
            return res.status(403).json({
              success: false,
              motivo: 'fila_sin_autor',
              message: 'Este movimiento se escribio directamente en la hoja de calculo y esta a tu '
                + 'nombre, asi que no puedes confirmarlo tu. Debe revisarlo otro miembro de la junta.',
            });
          }
        }
      }

      const nuevoEstado = accion === 'confirmar' ? 'confirmado'
        : accion === 'rechazar' ? 'rechazado'
          : 'pendiente';
      const completo = row.slice();
      while (completo.length <= idx.nota) completo.push('');
      // Si la fila venia sin identificador (escrita a mano), se le pone uno
      // ahora: sin el no hay forma de reconocerla la proxima vez, ni de
      // escribir sobre ella con seguridad.
      if (!(completo[idx.movId] || '').toString().trim()) {
        completo[idx.movId] = `${esAhorro ? 'sav' : 'acc'}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      }
      completo[idx.estado] = nuevoEstado;
      completo[idx.resueltoPor] = accion === 'revertir' ? '' : req.user.email;
      completo[idx.fechaEstado] = accion === 'revertir' ? '' : nowIso();
      completo[idx.nota] = accion === 'revertir'
        ? sanitizeCell(`Revertido por ${req.user.email}: ${nota}`, 300)
        : sanitizeCell(nota || '', 300);

      // Por MovID, no por numero de fila: si alguien borro una fila de mas
      // arriba mientras tanto, escribir en la posicion N duplicaba el aporte
      // (una copia pendiente y otra confirmada con el mismo identificador) y el
      // patrimonio del grupo subia sin que entrara un dolar.
      const sheetsClient = await getSheetsClient();
      const claveFila = (row[idx.movId] || '').toString().trim();
      if (claveFila) {
        await actualizarFilaPorClave(sheetsClient, {
          spreadsheetId: SPREADSHEET_ID,
          hoja: sheetName,
          ultimaColumna: lastCol,
          indice: fila,
          claveCol: idx.movId,
          clave: claveFila,
          construir: () => completo,
        });
      } else {
        // Fila sin identificador: se reconoce por correo + importe + fecha, que
        // es lo unico que la distingue. Con el correo solo, confirmar el aporte
        // de marzo escribia encima el de febrero y lo destruia.
        const senaEsperada = (sheetName === 'Savings'
          ? `${normalizeEmailKey(row[SAV.email])}|${num(row[SAV.amount])}|${row[SAV.date] || ''}`
          : `${normalizeEmailKey(row[ACC.email])}|${num(row[ACC.shares])}|${row[ACC.date] || ''}`)
          .toLowerCase();
        await actualizarFilaPorClave(sheetsClient, {
          spreadsheetId: SPREADSHEET_ID,
          hoja: sheetName,
          ultimaColumna: lastCol,
          indice: fila,
          clave: senaEsperada,
          esLaFila: (f) => !!f && !(f[idx.movId] || '').toString().trim()
            && ((sheetName === 'Savings'
              ? `${normalizeEmailKey(f[SAV.email])}|${num(f[SAV.amount])}|${f[SAV.date] || ''}`
              : `${normalizeEmailKey(f[ACC.email])}|${num(f[ACC.shares])}|${f[ACC.date] || ''}`)
              .toLowerCase() === senaEsperada),
          construir: () => completo,
        });
      }

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
      if (responderSiEsCuota(res, e)) return;
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
      if (responderSiEsCuota(res, e)) return;
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
      if (responderSiEsCuota(res, e)) return;
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
      if (responderSiEsCuota(res, e)) return;
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

      // Una sola asamblea abierta a la vez. El guardian estaba solo en la
      // convocatoria, asi que se podian dejar varias "programadas" y luego
      // abrirlas todas: la misma persona figuraba presente en dos asambleas
      // simultaneas, votaba en las dos, y podian aprobarse a la vez dos
      // acuerdos contradictorios sobre el reglamento.
      if (destino === 'abierta') {
        const otras = (await readAll(SHEETS.asambleas)).filter((r) => (
          normalizeGroupKey(r[1]) === asamblea.groupId
          && (r[5] || '').toString().trim().toLowerCase() === 'abierta'
          && (r[0] || '').toString().trim() !== asamblea.asambleaId
        ));
        if (otras.length > 0) {
          return res.status(409).json({
            success: false,
            message: 'Ya hay una asamblea abierta en este grupo. Cierrala antes de abrir otra.',
            asambleaAbierta: (otras[0][0] || '').toString(),
          });
        }
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
      if (responderSiEsCuota(res, e)) return;
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

      // Con votos ya emitidos, la asistencia no se toca. El quorum se mide
      // sobre los presentes, asi que retocar la lista despues de conocer los
      // votos era decidir el resultado a posteriori: bastaba con marcar
      // ausente a quien voto en contra, o presente a quien no fue, para mover
      // el denominador a conveniencia. Ademas el voto de quien se marcaba
      // ausente seguia contando.
      // El filtro era por ASAMBLEA, no por punto, asi que la salida que la propia app
      // recomienda ("anula el punto y vuelve a proponerlo") no desbloqueaba nada:
      // medido, tras anular el punto la asistencia seguia respondiendo 409 con los
      // mismos 2 votos. Los votos de un punto anulado ya no cuentan para nada.
      const acuerdosAnulados = new Set((await readAll(SHEETS.acuerdos))
        .filter((r) => (r[7] || '').toString().trim().toLowerCase() === 'anulado')
        .map((r) => (r[0] || '').toString().trim()));
      const votosEmitidos = (await readAll(SHEETS.votos))
        .filter((v2) => (v2[1] || '').toString().trim() === asamblea.asambleaId
          && !acuerdosAnulados.has((v2[0] || '').toString().trim()));
      if (votosEmitidos.length > 0) {
        return res.status(409).json({
          success: false,
          message: 'Ya hay votos emitidos en esta asamblea: la asistencia no se puede cambiar. '
                 + 'Si hay un error, anula el punto y vuelve a proponerlo.',
          votos: votosEmitidos.length,
        });
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
      if (responderSiEsCuota(res, e)) return;
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
    if (!ac || ESTADOS_ACUERDO_CERRADOS.includes(ac.estado)) return ac;

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

      // La MISMA regla que durante la asamblea. Antes al cerrar bastaba con
      // "mas a favor que en contra", asi que dos votos de cinco socios podian
      // aprobar un cambio de reglamento que la votacion en vivo no habia
      // aprobado, y la presidencia decidia el resultado eligiendo cuando
      // cerrar. Y lo que no se resolvia se archivaba como 'rechazado', que es
      // mentira: nadie lo voto en contra, es que no hubo quorum o no se voto.
      const veredicto = resultadoVotacion({ aFavor, enContra, presentes, quorum });
      row[7] = veredicto.resuelto ? veredicto.estado : 'sin_resolver';
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
      if (responderSiEsCuota(res, e)) return;
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
      if (responderSiEsCuota(res, e)) return;

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
        // Columnas nuevas: un grupo que viene del papel trae su prestamo con el
        // interes que de verdad le cobraban y los meses que ya pago.
        interesDeuda: num(r[9]), mesesPagados: Math.max(0, Math.trunc(num(r[10])) || 0),
        utilidades: num(r[11]),
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
        const plazoDeclarado = Math.trunc(num(f?.plazoDeuda)) || 0;
        // Una deuda sin plazo se convertia en silencio en un prestamo a un mes,
        // con vencimiento a treinta dias. Mejor pedirlo que adivinarlo mal.
        if (deuda > 0 && plazoDeclarado <= 0) {
          return res.status(400).json({
            success: false,
            message: `Falta el plazo del prestamo de ${email}. Pon en cuantos meses se acordo pagarlo.`,
          });
        }
        const plazo = Math.max(1, plazoDeclarado || 1);

        if (ahorro < 0 || acciones < 0 || deuda < 0 || valorAccion < 0) {
          return res.status(400).json({ success: false, message: `Valores negativos en la fila de ${email}.` });
        }
        if (ahorro > 100000000 || deuda > 100000000 || acciones > 1000000) {
          return res.status(400).json({ success: false, message: `Valores fuera de rango en la fila de ${email}.` });
        }
        if (acciones > 0 && valorAccion <= 0) {
          return res.status(400).json({ success: false, message: `Falta el valor de la accion para ${email}.` });
        }
        const interesDeuda = num(f?.interesDeuda);
        const mesesPagados = Math.max(0, Math.trunc(num(f?.mesesPagados)) || 0);
        const utilidades = num(f?.utilidades);

        if (interesDeuda < 0 || utilidades < 0) {
          return res.status(400).json({ success: false, message: `Valores negativos en la fila de ${email}.` });
        }
        if (interesDeuda > 100) {
          return res.status(400).json({ success: false, message: `El interes de la deuda de ${email} no puede pasar del 100% mensual.` });
        }
        if (mesesPagados > plazo) {
          return res.status(400).json({
            success: false,
            message: `${email} tiene ${mesesPagados} meses pagados pero un plazo de ${plazo}. Los meses pagados no pueden superar el plazo.`,
          });
        }
        if (utilidades > 100000000) {
          return res.status(400).json({ success: false, message: `Valores fuera de rango en la fila de ${email}.` });
        }
        if (ahorro === 0 && acciones === 0 && deuda === 0 && utilidades === 0) {
          return res.status(400).json({ success: false, message: `La fila de ${email} no aporta ningun saldo.` });
        }
        normalizadas.push({
          email, ahorro, acciones, valorAccion, deuda, plazo,
          interesDeuda, mesesPagados, utilidades,
          nota: sanitizeCell(f?.nota || '', 200),
        });
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
        range: `${SHEETS.apertura.name}!A:L`,
        valueInputOption: 'RAW',
        requestBody: {
          values: normalizadas.map((f) => [
            loteId, groupId, f.email, f.ahorro, f.acciones, f.valorAccion, f.deuda, f.plazo, f.nota,
            f.interesDeuda, f.mesesPagados, f.utilidades,
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
      if (responderSiEsCuota(res, e)) return;
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
      if (responderSiEsCuota(res, e)) return;
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
      if (responderSiEsCuota(res, e)) return;
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
      if (responderSiEsCuota(res, e)) return;
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

      // El traspaso del cuaderno se hace UNA vez. Aplicar un segundo lote
      // duplicaba el dinero de todo el grupo: una socia paso de $500 y 10
      // acciones a $1.000 y 20 acciones sin haber depositado nada, y desde la
      // app no habia forma de deshacerlo. Lo que venga despues del traspaso son
      // aportes normales, con su confirmacion de tesoreria.
      const yaAplicado = (await readAll(SHEETS.lotes)).find((r) => (
        normalizeGroupKey(r[1]) === lote.groupId
        && (r[2] || '').toString().trim().toLowerCase() === 'aplicado'
        && (r[0] || '').toString().trim() !== lote.loteId
      ));
      if (yaAplicado) {
        return res.status(409).json({
          success: false,
          message: 'Este grupo ya trajo sus saldos del cuaderno el '
                 + `${((yaAplicado[7] || '').toString().split('T')[0]) || 'dia del traspaso'}. `
                 + 'Lo que venga despues se registra como aporte normal, no como apertura.',
          motivo: 'apertura_ya_aplicada',
          loteAplicado: (yaAplicado[0] || '').toString(),
        });
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
      const pagosRows = [];
      const transRows = [];

      // La tasa que el grupo tiene configurada, para las acciones heredadas
      let tasaDelGrupo = 0;
      try {
        const gResp = await sheetsClient.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID, range: 'Groups!A2:Q',
        });
        const gRow = (gResp.data.values || []).find((r) => (r[0] || '').toString().trim() === lote.groupId);
        if (gRow) tasaDelGrupo = num(gRow[16]);
      } catch (err) { tasaDelGrupo = 0; }

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
          // Con la tasa del grupo, no con un cero: las acciones traidas del
          // cuaderno rendian 0 y el patrimonio heredado no generaba utilidades.
          accionesRows.push([
            f.email, lote.groupId, fechaCorta, f.acciones, f.valorAccion, tasaDelGrupo, fecha,
            'confirmado', req.user.email, req.user.email, fecha, movId,
            sanitizeCell(f.nota, 200),
          ]);
        }
        if (f.utilidades > 0) {
          // Las utilidades que el grupo ya habia repartido en el cuaderno entran
          // como un movimiento propio, para no confundirlas con aportes nuevos.
          const movId = newId('aputil');
          savingsRows.push([
            f.email, lote.groupId, f.utilidades, fechaCorta, 'utilidad',
            `Utilidades acumuladas del cuaderno (lote ${lote.loteId})`,
            'confirmado', req.user.email, req.user.email, fecha, movId,
            sanitizeCell(f.nota, 200),
          ]);
          transRows.push([
            `${Date.now()}${Math.floor(Math.random() * 1000)}`, f.email, 'utilidad', f.utilidades,
            `Utilidades de apertura (lote ${lote.loteId})`, fecha, 'apertura', '',
          ]);
        }
        if (f.deuda > 0) {
          const loanId = newId('aploan');
          // El prestamo heredado conserva SU interes y SUS meses ya pagados: la
          // fecha de inicio se corre hacia atras tantos meses como lleve pagados,
          // para que el plazo restante y el vencimiento cuadren con la realidad.
          // Se usa el calendario entero de cuotas.js (aritmetica de dias, no
          // UTC) para que las fechas coincidan exactamente con las del cuadro
          // que vera el socio.
          const hoyPartes = partesDeFecha(fechaCorta);
          const inicioPartes = sumarMeses(hoyPartes, -f.mesesPagados);
          const inicio = formatear(inicioPartes);
          const vence = formatear(sumarMeses(inicioPartes, f.plazoDeuda));
          const total = Math.round(f.deuda * (1 + (f.interesDeuda / 100) * f.plazoDeuda) * 100) / 100;
          loansRows.push([
            loanId, f.email, lote.groupId, f.deuda, inicio, vence,
            f.interesDeuda, 'aprobado', f.plazoDeuda, total,
          ]);

          // Lo que ya pago en el cuaderno queda registrado como pagos aprobados.
          // Sin esto, quien llevaba 2 de 6 cuotas entraba debiendo el total y
          // con cuotas vencidas: la app le decia moroso el primer dia, y no
          // habia forma de arreglarlo desde dentro (subir un comprobante exige
          // la foto del deposito y se registra a nombre de quien la sube).
          if (f.mesesPagados > 0) {
            // La cuota se calcula igual que en cuotas.js: pareja, y la ultima
            // recoge la diferencia del redondeo. Si no cuadrara al centavo, un
            // prestamo ya saldado quedaria con unos centavos colgando.
            const cuotaBase = Math.round((total / f.plazoDeuda) * 100) / 100;
            for (let k = 1; k <= f.mesesPagados; k += 1) {
              const importe = k === f.plazoDeuda
                ? Math.round((total - cuotaBase * (f.plazoDeuda - 1)) * 100) / 100
                : cuotaBase;
              pagosRows.push([
                `PAY_ap_${loanId}_${k}`, f.email, loanId, importe,
                formatear(sumarMeses(inicioPartes, k)),
                `Cuota ${k} de ${f.plazoDeuda} pagada antes de entrar a la app (lote ${lote.loteId})`,
                'approved', '', '', '', '', fecha,
                req.user.email, fecha, 'Traspaso de saldos aprobado en asamblea',
              ]);
            }
          }
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
      if (pagosRows.length) {
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID,
          range: 'LoanPayments!A:O',
          valueInputOption: 'RAW',
          requestBody: { values: pagosRows },
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
      if (responderSiEsCuota(res, e)) return;
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
        aportes: (() => {
          // `accionesConfirmadas` era un RECUENTO de acciones puesto entre cifras
          // de dinero: sumarlo al ahorro daba 1.819 donde el patrimonio son
          // 2.332. Ahora van separadas y con su nombre, y todo redondeado a
          // centavos para que cuadre al cent con /api/admin/resumen.
          const cent = (n) => Math.round(n * 100) / 100;
          const confirmadas = accG.filter((r) => aporteCuenta(r[ACC.estado]));
          const ahorro = cent(savG.filter((r) => aporteCuenta(r[SAV.estado]))
            .reduce((s2, r) => s2 + num(r[SAV.amount]), 0));
          const accionesValor = cent(confirmadas
            .reduce((s2, r) => s2 + num(r[ACC.shares]) * num(r[ACC.value]), 0));
          return {
            ahorroConfirmado: ahorro,
            ahorroPendiente: cent(savG.filter((r) => estadoAporte(r[SAV.estado]) === 'pendiente')
              .reduce((s2, r) => s2 + num(r[SAV.amount]), 0)),
            pendientesAhorro: savG.filter((r) => estadoAporte(r[SAV.estado]) === 'pendiente').length,
            pendientesAcciones: accG.filter((r) => estadoAporte(r[ACC.estado]) === 'pendiente').length,
            accionesConfirmadas: cent(confirmadas.reduce((s2, r) => s2 + num(r[ACC.shares]), 0)),
            accionesUnidades: cent(confirmadas.reduce((s2, r) => s2 + num(r[ACC.shares]), 0)),
            accionesValor,
            patrimonio: cent(ahorro + accionesValor),
          };
        })(),
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
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al construir el tablero.' });
    }
  });

  // -------------------------------------------------------------------------
  // CIERRE DE UTILIDADES
  //
  // Calcular el reparto es solo mirar. Abonarlo a las cuentas es mover dinero,
  // asi que pasa por el mismo camino que la apertura de saldos: se guarda un
  // borrador con la foto del reparto, se somete a una asamblea, y solo con el
  // acuerdo aprobado se abona. Asi queda constancia de quien lo decidio.
  // -------------------------------------------------------------------------

  /**
   * Hasta que mes llega lo ya cerrado y repartido de un grupo.
   *
   * Lo usan el propio reparto y `/api/upload-payment`, para avisar cuando un
   * comprobante cae en un mes que ya se repartio: no se rechaza (el deposito
   * existio) pero su interes ira al reparto siguiente, no a aquel.
   */
  async function mesCerradoDelGrupo(groupId) {
    const g = normalizeGroupKey(groupId);
    if (!g) return '';
    const meses = (await readAll(SHEETS.cierres))
      .filter((r) => normalizeGroupKey(r[1]) === g && (r[2] || '').toLowerCase() === 'aplicado')
      .map((r) => {
        const encontrados = (r[12] || '').toString().match(/\d{4}-\d{2}/g);
        if (encontrados && encontrados.length > 0) return encontrados[encontrados.length - 1];
        return (r[7] || '').toString().slice(0, 7);
      })
      .filter((m) => /^\d{4}-\d{2}$/.test(m))
      .sort();
    return meses.length > 0 ? meses[meses.length - 1] : '';
  }

  /** Lee un cierre por su id, con la fila y el indice para poder actualizarlo. */
  async function getCierre(cierreId) {
    const id = (cierreId || '').toString().trim();
    if (!id) return null;
    const filas = await readAll(SHEETS.cierres);
    const i = filas.findIndex((r) => (r[0] || '').toString().trim() === id);
    if (i < 0) return null;
    const r = filas[i];
    return {
      cierreId: r[0], groupId: normalizeGroupKey(r[1]), estado: (r[2] || 'borrador').toLowerCase(),
      creadoPor: r[3], creadoEn: r[4], asambleaId: r[5], acuerdoId: r[6], aplicadoEn: r[7],
      ganancia: num(r[8]), base: r[9] || 'acciones', participacion: num(r[10]),
      socios: num(r[11]), periodo: r[12] || '', nota: r[13] || '',
      gananciaPeriodo: num(r[14]) || num(r[8]),
      retenido: num(r[15]),
      decision: (r[16] || '').toString().trim().toLowerCase() || 'reparte_todo',
      _index: i, _row: r,
    };
  }

  async function detalleCierre(cierreId) {
    const id = (cierreId || '').toString().trim();
    return (await readAll(SHEETS.cierreDetalle))
      .filter((r) => (r[0] || '').toString().trim() === id)
      .map((r) => ({
        email: normalizeEmailKey(r[2]), acciones: num(r[3]), ahorro: num(r[4]),
        participacion: num(r[5]), proporcion: num(r[6]), utilidad: num(r[7]),
        devengado: num(r[8]),
      }));
  }

  /**
   * Los prestamos del grupo con sus pagos aprobados, EN EL ORDEN DE LA HOJA.
   *
   * Vive aparte porque lo consultan dos sitios: el calculo del reparto y la
   * comprobacion de si deshacer un comprobante toca un mes ya cerrado. El orden importa
   * de verdad: gananciaPorMes solo reconoce interes hasta el total pactado, asi que el
   * primer pago consume el cupo y el siguiente puede quedar en cero. Medido con las
   * filas [junio $60, marzo $120] sobre un prestamo de $100 a devolver por $120, quitar
   * el pago de JUNIO sube marzo de $10,00 a $20,00: un mes ya cerrado cambia de valor
   * por un comprobante de un mes abierto. Con dos copias de este armado, una diria una
   * cosa y la otra otra.
   *
   * `saltar` es el PaymentID que se quiere excluir, para poder preguntarle al motor
   * cuanto ganaba el grupo SIN ese comprobante.
   */
  function prestamosDelGrupo(loansRows, paysRows, groupId, saltar = '') {
    const fuera = (saltar || '').toString().trim();
    const pagosPorPrestamo = {};
    for (const r of (paysRows || [])) {
      const estado = (r[6] || '').toString().trim().toLowerCase();
      if (!['approved', 'aprobado'].includes(estado)) continue;
      if (fuera && (r[0] || '').toString().trim() === fuera) continue;
      const lid = (r[2] || '').toString().trim();
      if (!pagosPorPrestamo[lid]) pagosPorPrestamo[lid] = [];
      pagosPorPrestamo[lid].push({
        monto: num(r[3]),
        fecha: r[4] || '',        // PaymentDate, la que pone quien paga
        creado: r[11] || '',      // cuando se registro en la app
        revisado: r[13] || '',    // cuando la tesoreria lo aprobo
      });
    }
    return (loansRows || [])
      .filter((r) => normalizeGroupKey(r[2]) === groupId)
      .filter((r) => !['rechazado', 'rejected', 'cancelado'].includes(
        (r[7] || '').toString().trim().toLowerCase()))
      .map((r) => {
        const loanId = (r[0] || '').toString().trim();
        const pagos = pagosPorPrestamo[loanId] || [];
        return {
          loanId,
          userEmail: normalizeEmailKey(r[1]),
          principal: num(r[3]),
          inicio: r[4] || '',     // ultimo recurso para fechar un pago sin fecha
          // La mora cobrada TAMBIEN es ganancia del grupo, asi que entra aqui
          // sumada al total; en la hoja sigue en su columna para que el cuadro
          // de cuotas no se mueva. Topada en cero: negativa restaria ganancia
          // que el grupo si cobro.
          total: (num(r[9]) || num(r[3])) + Math.max(0, num(r[10])),
          pagado: Math.round(pagos.reduce((acc, x) => acc + x.monto, 0) * 100) / 100,
          pagos,
        };
      });
  }

  /**
   * Hasta que mes llega lo ya cerrado. El periodo se escribe como 'AAAA-MM' o
   * 'AAAA-MM a AAAA-MM'; si viene de antes y es texto libre, se usa el mes en que se
   * aplico. Tambien vive aparte: con una copia propia, el endpoint que deshace
   * comprobantes diria que marzo esta abierto donde el reparto lo tiene por cerrado, y
   * dejaria pasar sin asamblea justo lo que hay que parar.
   */
  function cerradoHastaDe(filasCierre) {
    const meses = (filasCierre || []).map((r) => {
      const encontrados = (r[12] || '').toString().match(/\d{4}-\d{2}/g);
      if (encontrados && encontrados.length > 0) return encontrados[encontrados.length - 1];
      return (r[7] || '').toString().slice(0, 7);
    }).filter((m) => /^\d{4}-\d{2}$/.test(m)).sort();
    return meses.length > 0 ? meses[meses.length - 1] : '';
  }

  /**
   * @param {string} groupId
   * @param {string} basePedida   'acciones' | 'ahorros' | 'mixta'
   * @param {number} [montoPedido] Lo que la asamblea decide repartir. Si no se
   *   pasa, se reparte todo lo que se puede colocar, que es como venia siendo.
   *   Cero es una decision valida: el grupo cierra el periodo y no reparte nada.
   */
  async function calcularReparto(groupId, basePedida, montoPedido) {
    const reglas = await getReglas(groupId);
    const base = basePedida && BASES.has(String(basePedida).toLowerCase())
      ? String(basePedida).toLowerCase() : reglas.baseReparto;

    const sheetsClient = await getSheetsClient();
    // La pestana de comprobantes puede no existir en un grupo nuevo: se asegura
    // antes de leerla. Antes un fallo de lectura se tragaba con un catch que
    // devolvia una lista vacia, y el grupo declaraba ganancia CERO el dia del
    // reparto.
    await ensureSheetExists('LoanPayments', [
      'PaymentID', 'UserEmail', 'LoanID', 'Amount', 'PaymentDate',
      'Description', 'Status', 'ImageFilename', 'OriginalImageName',
      'ImagePath', 'ImageSize', 'CreatedAt', 'ApprovedBy',
      'ApprovalDate', 'ApprovalNotes',
    ], sheetsClient, SPREADSHEET_ID);
    const [loansResp, paysResp] = await Promise.all([
      sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'Loans!A2:K',
      }),
      sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O',
      }),
    ]);

    // Los prestamos, con sus pagos uno a uno y en el orden de la hoja. El armado
    // vive en `prestamosDelGrupo` porque el endpoint que deshace un comprobante
    // necesita EXACTAMENTE el mismo para poder preguntarle al motor cuanto
    // ganaba el grupo sin ese comprobante. Con dos copias, una diria una cosa y
    // la otra otra.
    const prestamos = prestamosDelGrupo(
      loansResp.data.values || [], paysResp.data.values || [], groupId);

    // Y aparte, los comprobantes que la tesoreria todavia no ha mirado. No mueven
    // el reparto (solo se reparte lo cobrado), pero cerrar el periodo sin saber
    // que estan ahi es cerrar a ciegas: uno de $10 aprobado despues sumo $1,07 a
    // un mes ya repartido.
    const sinRevisar = (paysResp.data.values || [])
      .filter((r) => !['approved', 'aprobado', 'rejected', 'rechazado']
        .includes((r[6] || '').toString().trim().toLowerCase()))
      .map((r) => ({
        pagoId: (r[0] || '').toString().trim(),
        email: normalizeEmailKey(r[1]),
        loanId: (r[2] || '').toString().trim(),
        monto: num(r[3]),
        fecha: r[4] || '',
        estado: (r[6] || '').toString().trim().toLowerCase() || '(en blanco)',
      }));

    // El detalle por prestamo se sigue mostrando tal cual; el TOTAL lo manda el
    // calculo mes a mes, para que la cifra de arriba y la suma de los meses no
    // puedan discrepar.
    const ganancia = gananciaDelGrupo(prestamos);

    const [savRows, accRows] = await Promise.all([leerSavings(), leerAcciones()]);
    const miembros = await miembrosActivos(groupId);
    const activos = new Set(miembros.map((m) => normalizeEmailKey(m.email)));

    // Un apunte por MOVIMIENTO, con la fecha en que entro ese dinero. El reparto
    // necesita saber cuando, no solo cuanto.
    const aportes = [];
    // Aportes declarados que la tesoreria no ha confirmado. Solo estorban al
    // cierre si son de la base que el grupo eligio para repartir: con base
    // 'acciones', un ahorro pendiente no mueve ni un centavo del reparto.
    const aportesSinConfirmar = [];
    for (const r of savRows) {
      if (normalizeGroupKey(r[SAV.group]) !== groupId) continue;
      if (estadoAporte(r[SAV.estado]) === 'pendiente') {
        aportesSinConfirmar.push({
          email: normalizeEmailKey(r[SAV.email]), tipo: 'ahorro',
          monto: num(r[SAV.amount]), fecha: r[SAV.date] || '',
        });
      }
      if (!aporteCuenta(r[SAV.estado])) continue;
      const correo = normalizeEmailKey(r[SAV.email]);
      if (!activos.has(correo)) continue;
      // Las utilidades repartidas se abonan como ahorro. Contarlas otra vez como
      // capital retroalimentaria el reparto: quien mas cobro en el cierre
      // anterior tendria mas base en el siguiente, y asi indefinidamente.
      if ((r[SAV.type] || '').toString().trim().toLowerCase() === 'utilidad') continue;
      aportes.push({
        email: correo, tipo: 'ahorro',
        monto: num(r[SAV.amount]),
        desde: r[SAV.date] || r[SAV.fechaEstado] || '',
      });
    }
    for (const r of accRows) {
      if (normalizeGroupKey(r[ACC.group]) !== groupId) continue;
      if (estadoAporte(r[ACC.estado]) === 'pendiente') {
        aportesSinConfirmar.push({
          email: normalizeEmailKey(r[ACC.email]), tipo: 'acciones',
          monto: Math.round(num(r[ACC.shares]) * num(r[ACC.value]) * 100) / 100,
          fecha: r[ACC.date] || '',
        });
      }
      if (!aporteCuenta(r[ACC.estado])) continue;
      const correo = normalizeEmailKey(r[ACC.email]);
      if (!activos.has(correo)) continue;
      aportes.push({
        email: correo, tipo: 'acciones',
        monto: Math.round(num(r[ACC.shares]) * num(r[ACC.value]) * 100) / 100,
        desde: r[ACC.date] || r[ACC.createdAt] || '',
      });
    }

    // Lo que cuenta como capital depende de la base que eligio el grupo
    const deLaBase = aportes.filter((a) => (base === 'ambos'
      || (base === 'acciones' ? a.tipo === 'acciones' : a.tipo === 'ahorro')));

    const mesAMes = repartoMesAMes({ prestamos, participaciones: deLaBase, base });

    const participaciones = miembros.map((m) => {
      const correo = normalizeEmailKey(m.email);
      const suyos = aportes.filter((a) => a.email === correo);
      const suma = (tipo) => Math.round(suyos.filter((a) => a.tipo === tipo)
        .reduce((acc, a) => acc + a.monto, 0) * 100) / 100;
      return { email: correo, nombre: m.nombre || correo, acciones: suma('acciones'), ahorro: suma('ahorro') };
    });

    // UN PERIODO CERRADO ESTA CERRADO.
    //
    // Antes se rehacia toda la historia con la foto de hoy y se descontaba lo ya
    // cobrado. Mientras nadie se mueva sale bien, pero en cuanto una socia se da
    // de baja el historico se recalcula sin ella y las cifras de las demas
    // cambian. Medido: a una socia le tocaban $15,43 y la app le dio $14,36; el
    // total del grupo cuadraba, las personas no.
    const filasCierre = (await readAll(SHEETS.cierres))
      .filter((r) => normalizeGroupKey(r[1]) === groupId && (r[2] || '').toLowerCase() === 'aplicado');
    const cierresAplicados = new Set(filasCierre.map((r) => (r[0] || '').toString().trim()));
    const yaAbonado = filasCierre.reduce((acc, r) => acc + num(r[8]), 0);

    // Hasta que mes llega lo ya cerrado. Sale de `cerradoHastaDe` porque el
    // endpoint que deshace comprobantes tiene que usar EXACTAMENTE el mismo
    // corte: si los dos leyeran el periodo por su cuenta y discreparan, se
    // podria deshacer un pago cuyo interes ya esta repartido.
    const mesCerradoHasta = cerradoHastaDe(filasCierre);

    const yaCobradoPor = {};
    // Lo DEVENGADO menos lo COBRADO en los cierres ya aplicados: el derecho que
    // cada socia tiene sobre lo que el grupo decidio no repartir en su momento.
    // Se guarda con su nombre para que, cuando se reparta, vaya a quien estaba
    // entonces y no a quien haya entrado despues.
    const devengadoPor = {};
    if (cierresAplicados.size > 0) {
      for (const r of await readAll(SHEETS.cierreDetalle)) {
        if (!cierresAplicados.has((r[0] || '').toString().trim())) continue;
        const correo = normalizeEmailKey(r[2]);
        const u = num(r[7]);
        const d = num(r[8]);
        if (u > 0) yaCobradoPor[correo] = Math.round(((yaCobradoPor[correo] || 0) + u) * 100) / 100;
        if (d > 0) devengadoPor[correo] = Math.round(((devengadoPor[correo] || 0) + d) * 100) / 100;
      }
    }
    // Los cierres viejos no traen Devengado (la columna es nueva): ahi el
    // pendiente sale 0 y lo atrasado se reparte como se hacia antes, por el
    // capital de hoy. Los nuevos si llevan los pesos originales.
    const pendientePor = {};
    let pendienteTotal = 0;
    for (const correo of Object.keys(devengadoPor)) {
      const pend = Math.round((devengadoPor[correo] - (yaCobradoPor[correo] || 0)) * 100) / 100;
      if (pend > 0) {
        pendientePor[correo] = pend;
        pendienteTotal = Math.round((pendienteTotal + pend) * 100) / 100;
      }
    }

    // Los meses abiertos son los posteriores al ultimo cierre aplicado.
    const abiertos = mesAMes.porMes.filter((m) => !mesCerradoHasta || m.mes > mesCerradoHasta);
    const cerrados = mesAMes.porMes.filter((m) => mesCerradoHasta && m.mes <= mesCerradoHasta);

    // Dinero que aparece en un mes YA CERRADO: es el comprobante de diciembre
    // que la tesoreria aprueba en enero. No se puede repartir hacia atras sin
    // cambiar lo que cada socia ya cobro, asi que se lleva al primer mes
    // abierto y se dice. Perderlo en silencio seria peor.
    const ganadoCerrado = Math.round(cerrados.reduce((acc, m) => acc + m.ganado, 0) * 100) / 100;
    const gananciaCerradaNueva = Math.max(0, Math.round((ganadoCerrado - yaAbonado) * 100) / 100);

    // EL HUECO: lo que el grupo abono de utilidades por encima de lo que los meses ya
    // cerrados respaldan hoy. El Math.max de arriba lo aplasta a cero y desaparece de la
    // pantalla. Medido: con $20,00 repartidos y $10,00 de interes real, la pantalla de
    // Utilidades mostraba "Intereses cobrados $0,00 / Ya repartido antes $20,00 / Por
    // repartir ahora $0,00" sin una sola linea que lo explicara. Aqui se nombra y no se
    // compensa: descontarlo de los meses abiertos le cobraria el error de marzo a las
    // socias que estaban en junio, y eso lo decide la asamblea, no una formula.
    const hueco = Math.max(0, Math.round((yaAbonado - ganadoCerrado) * 100) / 100);

    const porMiembroAbierto = {};
    let repartidoAbierto = 0;
    let sinRepartoAbierto = 0;
    for (const m of abiertos) {
      repartidoAbierto = Math.round((repartidoAbierto + m.ganado - m.sinReparto) * 100) / 100;
      sinRepartoAbierto = Math.round((sinRepartoAbierto + m.sinReparto) * 100) / 100;
      for (const r of (m.reparto || [])) {
        porMiembroAbierto[r.email] = Math.round(
          ((porMiembroAbierto[r.email] || 0) + r.importe) * 100) / 100;
      }
    }

    // Las utilidades que ya se le pagaron a quien se fue del grupo no se vuelven
    // a repartir. Sin esto el grupo las pagaria DOS veces: una a ella en su
    // liquidacion, y otra a las que quedan, porque al salir deja de contar en el
    // reparto y su parte se reparte entre las demas.
    const yaLiquidado = (await readAll(SHEETS.salidas))
      .filter((r) => normalizeGroupKey(r[1]) === groupId
        && (r[3] || '').toString().trim().toLowerCase() === 'aplicada')
      .reduce((acc, r) => acc + num(r[14]), 0);

    // Lo que el grupo gasto sale de lo ganado ANTES de repartir, y las multas
    // que de verdad cobro entran. Antes el acuerdo se aprobaba y no movia un
    // centavo: un gasto de $35 dejaba el patrimonio exactamente igual.
    const caja = await cajaDelGrupo(groupId);

    // Lo pendiente: lo ganado en los meses abiertos, mas lo que aparecio tarde
    // en meses ya cerrados, menos lo que ya se llevaron las que se fueron.
    const porRepartir = Math.max(0, Math.round((
      abiertos.reduce((acc, m) => acc + m.ganado, 0)
      + gananciaCerradaNueva - yaLiquidado
      + caja.multasCobradas - caja.gastos) * 100) / 100);
    // Y de eso, lo que se puede colocar: si un mes abierto no tenia a nadie con
    // capital, ese dinero no tiene dueno.
    const colocable = Math.max(0,
      Math.round((repartidoAbierto + gananciaCerradaNueva - yaLiquidado
        + caja.multasCobradas - caja.gastos) * 100) / 100);

    // A cada socia le toca lo acumulado en los meses ABIERTOS. Lo de los meses
    // cerrados ya lo cobro y no se vuelve a tocar.
    const conSaldo = participaciones.map((p) => {
      const acumulado = Math.round((porMiembroAbierto[p.email] || 0) * 100) / 100;
      const yaCobrado = yaCobradoPor[p.email] || 0;
      return { ...p, acumulado, yaCobrado, peso: acumulado };
    });

    // El dinero que llego tarde a un mes ya cerrado se reparte APARTE, por el
    // capital de hoy, que es lo unico que se puede saber de el. Mezclarlo con
    // los meses abiertos en un solo peso daria una cifra que nadie sabria
    // explicar en la asamblea.
    const capitalDe = (p) => (base === 'acciones' ? p.acciones
      : base === 'ahorros' ? p.ahorro : Math.round((p.acciones + p.ahorro) * 100) / 100);

    // Lo atrasado tiene dos origenes distintos y no se reparten igual:
    //   - lo RETENIDO por decision de asamblea, que ya tiene dueno anotado;
    //   - el comprobante que se aprobo despues del cierre, que no lo tiene y se
    //     reparte por el capital de hoy porque no hay forma de saber otra cosa.
    const deRetencion = Math.min(gananciaCerradaNueva, pendienteTotal);
    const deComprobanteTardio = Math.round((gananciaCerradaNueva - deRetencion) * 100) / 100;

    // Cuanto se pone hoy sobre la mesa. Sin decision de asamblea, todo lo
    // colocable, que es como venia siendo. Con decision, lo que ella diga.
    const decidido = Number.isFinite(Number(montoPedido)) && Number(montoPedido) >= 0
      ? Math.min(Math.round(Number(montoPedido) * 100) / 100, colocable)
      : colocable;
    const tope = Math.max(0, decidido);

    // Lo viejo primero: se salda el derecho pendiente antes que lo del mes.
    const paraElAtraso = Math.min(gananciaCerradaNueva, tope);
    const atrasoRetencion = Math.min(deRetencion, paraElAtraso);
    const atrasoTardio = Math.round((paraElAtraso - atrasoRetencion) * 100) / 100;

    const delAtraso = new Map();
    const sumarAlAtraso = (mapa) => {
      for (const [correo, v] of mapa) {
        delAtraso.set(correo, Math.round(((delAtraso.get(correo) || 0) + v) * 100) / 100);
      }
    };
    if (atrasoRetencion > 0) {
      sumarAlAtraso(repartirCentavos(atrasoRetencion,
        conSaldo.map((p) => ({ clave: p.email, peso: pendientePor[p.email] || 0 }))));
    }
    if (atrasoTardio > 0) {
      sumarAlAtraso(repartirCentavos(atrasoTardio,
        conSaldo.map((p) => ({ clave: p.email, peso: capitalDe(p) }))));
    }

    // Lo que el comprobante tardio anade se DEVENGA ahora aunque no se reparta:
    // si no quedara anotado, el derecho de nadie lo respaldaria y el arrastre
    // dejaria de cuadrar en el cierre siguiente.
    const devengadoTardio = deComprobanteTardio > 0
      ? repartirCentavos(deComprobanteTardio,
        conSaldo.map((p) => ({ clave: p.email, peso: capitalDe(p) })))
      : new Map();

    // Se reparte lo COLOCABLE, que ya descuenta lo que se le pago a quien se fue.
    // Con `repartidoAbierto` a secas el grupo pagaba dos veces: medido, gano $20,
    // ella cobro $4 al salir, y el reparto seguia ofreciendo $20 a las cuatro que
    // quedaban.
    const paraLosMesesAbiertos = Math.max(0,
      Math.round((tope - paraElAtraso) * 100) / 100);
    const resultado = repartirUtilidades(paraLosMesesAbiertos, conSaldo, base);
    // Se suma lo del atraso a lo de los meses abiertos
    if (paraElAtraso > 0) {
      resultado.reparto = resultado.reparto.map((x) => ({
        ...x,
        utilidad: Math.round((x.utilidad + (delAtraso.get(x.email) || 0)) * 100) / 100,
      }));
      resultado.repartido = Math.round(
        resultado.reparto.reduce((acc, x) => acc + x.utilidad, 0) * 100) / 100;
    }

    // Lo que le TOCABA a cada una por los meses que este cierre cierra, se le
    // pague o no. De aqui salen los pesos del reparto de lo retenido.
    resultado.reparto = resultado.reparto.map((x) => {
      const p = conSaldo.find((q) => q.email === x.email);
      return {
        ...x,
        devengado: Math.round((
          (p ? p.acumulado : 0) + (devengadoTardio.get(x.email) || 0)) * 100) / 100,
      };
    });

    // Lo que la asamblea deja para mas adelante. No se pierde: vuelve entero al
    // siguiente reparto, y con los pesos de arriba.
    resultado.retenido = Math.max(0, Math.round((colocable - resultado.repartido) * 100) / 100);
    // Lo que el periodo dio de si y tenia dueno. `Ganancia` en la hoja es lo
    // que se abona; esta es la referencia contra la que se mide lo retenido.
    resultado.gananciaDelPeriodo = Math.max(0, Math.round(colocable * 100) / 100);
    // Lo que queda sin repartir es lo pendiente menos lo que se pudo colocar,
    // no el resto de la division: si nadie tiene capital, sale entero.
    resultado.sinRepartir = Math.max(0,
      Math.round((porRepartir - colocable) * 100) / 100);
    if (resultado.sinRepartir > 0 && !resultado.motivo) {
      resultado.motivo = 'Parte de lo ganado corresponde a meses en los que nadie '
        + 'tenia capital puesto segun la base elegida.';
    }
    // El mensaje de "todavia no ha cobrado intereses" solo vale si de verdad no
    // gano nada: con ganancia y sin a quien repartir, decirlo era mentira.
    if (mesAMes.ganadoTotal > 0 && /todavia no ha cobrado/i.test(resultado.motivo || '')) {
      resultado.motivo = `El grupo gano $${mesAMes.ganadoTotal.toFixed(2)}, pero nadie tiene `
        + `capital puesto segun la base elegida (${base}). Cambia la base en el reglamento `
        + 'o revisa que los aportes esten confirmados y con su fecha.';
    }
    const porEmail = Object.fromEntries(conSaldo.map((x) => [x.email, x]));
    resultado.reparto = resultado.reparto.map((x) => ({
      ...x,
      nombre: (porEmail[x.email] || {}).nombre || x.email,
      acumulado: (porEmail[x.email] || {}).acumulado || 0,
      yaCobrado: (porEmail[x.email] || {}).yaCobrado || 0,
    }));

    // ---- LO QUE FALTA REVISAR DENTRO DEL PERIODO QUE SE VA A CERRAR ----
    //
    // Solo cuenta lo que de verdad puede mover el reparto: un comprobante de un
    // prestamo sin interes, o de uno ya saldado, no cambia nada; y un aporte
    // pendiente de un tipo que no es la base del reparto, tampoco.
    const mesTope = abiertos.length > 0 ? abiertos[abiertos.length - 1].mes : mesActualDelReparto();
    const porPrestamo = Object.fromEntries(prestamos.map((x) => [x.loanId, x]));

    const comprobantesQueEstorban = sinRevisar.filter((c) => {
      const pr = porPrestamo[c.loanId];
      if (!pr) return false;                                  // pago huerfano
      const interesTotal = Math.max(0, pr.total - pr.principal);
      if (!(interesTotal > 0)) return false;                  // prestamo sin interes
      if (pr.pagado >= pr.total) return false;                // ya saldado: no anade interes
      const mes = mesDelReparto(c.fecha) || mesDelReparto(pr.inicio);
      return !mes || mes <= mesTope;                          // cae dentro de lo que se cierra
    }).map((c) => {
      const pr = porPrestamo[c.loanId];
      const porcion = pr.total > 0 ? Math.max(0, (pr.total - pr.principal) / pr.total) : 0;
      const aplicable = Math.max(0, Math.min(c.monto, pr.total - pr.pagado));
      return { ...c, interes: Math.round(aplicable * porcion * 100) / 100 };
    }).filter((c) => c.interes > 0);

    const tipoDeLaBase = base === 'ambos' ? null : (base === 'acciones' ? 'acciones' : 'ahorro');
    const aportesQueEstorban = aportesSinConfirmar.filter((a) => {
      if (tipoDeLaBase && a.tipo !== tipoDeLaBase) return false;
      const mes = mesDelReparto(a.fecha);
      return !mes || mes <= mesTope;
    });

    const cent2 = (x) => Math.round(x * 100) / 100;
    const revisionPendiente = {
      comprobantes: comprobantesQueEstorban.length,
      montoComprobantes: cent2(comprobantesQueEstorban.reduce((acc, c) => acc + c.monto, 0)),
      interesEnJuego: cent2(comprobantesQueEstorban.reduce((acc, c) => acc + c.interes, 0)),
      aportes: aportesQueEstorban.length,
      montoAportes: cent2(aportesQueEstorban.reduce((acc, a) => acc + a.monto, 0)),
      hayAlgo: comprobantesQueEstorban.length > 0 || aportesQueEstorban.length > 0,
      detalle: {
        comprobantes: comprobantesQueEstorban.slice(0, 8)
          .map((c) => ({ email: c.email, monto: c.monto, fecha: c.fecha, interes: c.interes })),
        aportes: aportesQueEstorban.slice(0, 8)
          .map((a) => ({ email: a.email, tipo: a.tipo, monto: a.monto, fecha: a.fecha })),
      },
    };

    // ---- EL INTERES QUE EL GRUPO TIENE POR COBRAR ----
    //
    // No se reparte (solo se reparte lo que entro), pero la tesoreria necesita
    // verlo para saber que le queda por entrar. Se usa el MISMO filtro que la
    // lista de prestamos: con una lista blanca de estados, un prestamo escrito
    // como 'vencido' salia en cero, y son justo los que mas deben.
    const detallePorCobrar = prestamos
      .map((pr) => ({
        loanId: pr.loanId,
        userEmail: pr.userEmail,
        pactado: cent2(Math.max(0, pr.total - pr.principal)),
        cobrado: cent2(Math.max(0, pr.total - pr.principal)
          * Math.min(1, pr.total > 0 ? pr.pagado / pr.total : 0)),
      }))
      .map((x) => ({ ...x, porCobrar: cent2(Math.max(0, x.pactado - x.cobrado)) }))
      .filter((x) => x.porCobrar > 0.004);
    const porCobrar = {
      total: cent2(detallePorCobrar.reduce((acc, x) => acc + x.porCobrar, 0)),
      prestamos: detallePorCobrar,
    };

    const meses = abiertos.map((m) => m.mes);
    const periodoSugerido = meses.length === 0
      ? (mesCerradoHasta || new Date().toISOString().slice(0, 7))
      : (meses[0] === meses[meses.length - 1] ? meses[0] : `${meses[0]} a ${meses[meses.length - 1]}`);

    return {
      ...resultado,
      base,
      basesDisponibles: [...BASES],
      periodoSugerido,
      revisionPendiente,
      porCobrar,
      porMes: abiertos,
      mesesCerrados: cerrados.map((m) => m.mes),
      cerradoHasta: mesCerradoHasta,
      ganancia: {
        total: mesAMes.ganadoTotal,
        yaRepartido: Math.round(yaAbonado * 100) / 100,
        yaLiquidado: Math.round(yaLiquidado * 100) / 100,
        gastos: caja.gastos,
        multasCobradas: caja.multasCobradas,
        multasPendientes: caja.multasPendientes,
        porRepartir,
        colocable,
        sinReparto: sinRepartoAbierto,
        llegoTarde: gananciaCerradaNueva,
        // Del atraso, lo que el grupo decidio guardar en su dia; tiene dueno
        // anotado y se reparte con los pesos de entonces. Topado por lo
        // colocable: los pesos salen del devengado mes a mes, que no sabe de
        // gastos ni multas, y sin el tope el campo prometia mas de lo que hay.
        retenidoDeAntes: Math.min(deRetencion, colocable),
        deComprobanteTardio,
        hueco,
        // Habia DOS claves `aviso:` en este mismo objeto: la segunda ganaba y la
        // primera se tiraba sin decir nada. La que se tiraba era justo la que
        // explicaba el hueco, asi que un descuadre de $480 salia como `aviso: ""`.
        aviso: [
          mesAMes.aviso,
          caja.gastos > 0
            ? `Se descuentan $${caja.gastos.toFixed(2)} de gastos que la asamblea aprobo.`
            : '',
          caja.multasCobradas > 0
            ? `Se suman $${caja.multasCobradas.toFixed(2)} de multas cobradas.`
            : '',
          deRetencion > 0
            ? `$${deRetencion.toFixed(2)} son de periodos que el grupo cerro sin repartir del `
              + 'todo. Se reparten ahora entre quienes los generaron, con los pesos de aquel '
              + 'momento: quien entro despues no cobra de esos meses.'
            : '',
          deComprobanteTardio > 0
            ? `$${deComprobanteTardio.toFixed(2)} corresponden a meses que ya se cerraron `
              + '(un comprobante aprobado despues del cierre). Se reparten ahora, por el '
              + 'capital actual, porque el reparto de aquellos meses ya se abono.'
            : '',
          hueco > 0
            ? `El grupo repartio $${(Math.round(yaAbonado * 100) / 100).toFixed(2)} en cierres `
              + `anteriores y los intereses que los respaldaban valen hoy $${ganadoCerrado.toFixed(2)}: `
              + `faltan $${hueco.toFixed(2)}. A nadie se le quita lo que ya cobro y esto no se `
              + 'descuenta de los repartos siguientes. Revisad en asamblea que comprobante cambio '
              + 'y dejadlo escrito en el acta.'
            : '',
        ].filter(Boolean).join(' '),
        prestamos: ganancia.detalle.filter((d) => d.interesGanado > 0),
        prestamosConsiderados: prestamos.length,
      },
    };
  }

  app.get('/api/gob/utilidades/reparto', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!groupId) return res.status(400).json({ success: false, message: 'Falta groupId.' });
      if (!(await assertGroupMember(req, res, groupId))) return;
      res.json({ success: true, ...(await calcularReparto(groupId, req.query.base)) });
    } catch (e) {
      console.error('[GOB reparto]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al calcular el reparto.' });
    }
  });

  /** Cierres del grupo, del mas nuevo al mas viejo. */
  app.get('/api/gob/utilidades/cierres', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!groupId) return res.status(400).json({ success: false, message: 'Falta groupId.' });
      if (!(await assertGroupMember(req, res, groupId))) return;
      const filas = (await readAll(SHEETS.cierres))
        .filter((r) => normalizeGroupKey(r[1]) === groupId)
        .map((r) => ({
          cierreId: r[0], estado: (r[2] || 'borrador').toLowerCase(), creadoPor: r[3],
          creadoEn: r[4], asambleaId: r[5], acuerdoId: r[6], aplicadoEn: r[7],
          ganancia: num(r[8]), base: r[9] || 'acciones', socios: num(r[11]), periodo: r[12] || '',
        }))
        .reverse();
      res.json({ success: true, cierres: filas });
    } catch (e) {
      console.error('[GOB cierres]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al leer los cierres.' });
    }
  });

  app.get('/api/gob/utilidades/cierre/:id', async (req, res) => {
    try {
      const cierre = await getCierre(req.params.id);
      if (!cierre) return res.status(404).json({ success: false, message: 'Cierre no encontrado.' });
      if (!(await assertGroupMember(req, res, cierre.groupId))) return;
      delete cierre._index; delete cierre._row;
      res.json({ success: true, cierre, filas: await detalleCierre(cierre.cierreId) });
    } catch (e) {
      console.error('[GOB cierre GET]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al leer el cierre.' });
    }
  });

  /** Guarda la foto del reparto como borrador. */
  app.post('/api/gob/utilidades/cierre', bloquear((r) => `cierre:${normalizeGroupKey(r.body && r.body.groupId)}`), async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.body?.groupId);
      if (!groupId) return res.status(400).json({ success: false, message: 'Falta groupId.' });
      const rol = await requireLider(req, res, groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;

      const abiertos = (await readAll(SHEETS.cierres)).filter((r) => normalizeGroupKey(r[1]) === groupId
        && ['borrador', 'propuesto'].includes((r[2] || '').toLowerCase()));
      if (abiertos.length > 0) {
        return res.status(409).json({
          success: false,
          message: `Ya hay un cierre "${(abiertos[0][2] || '').toLowerCase()}" sin terminar. Aplicalo o descartalo antes de crear otro.`,
        });
      }

      // Cuanto se reparte lo decide la asamblea, no la formula. Habra anos en
      // que el grupo prefiera seguir acumulando; hasta ahora no habia forma de
      // decirlo y el cierre repartia todo o daba error.
      const b = req.body || {};
      const pidioImporte = b.montoARepartir !== undefined && b.montoARepartir !== null
        && b.montoARepartir !== '';
      let montoDecidido;
      if (pidioImporte) {
        montoDecidido = num(b.montoARepartir);
        if (!Number.isFinite(montoDecidido) || montoDecidido < 0) {
          return res.status(400).json({
            success: false,
            motivo: 'monto_invalido',
            message: 'El importe a repartir tiene que ser un numero de cero para arriba.',
          });
        }
        montoDecidido = Math.round(montoDecidido * 100) / 100;
      }
      // Un 201 a una peticion que no se obedecio es peor que un error: quien
      // escribio `monto: 50` se queda creyendo que repartio $50.
      const inventados = ['monto', 'importe', 'parcial', 'porcentaje', 'montoARepartirPct']
        .filter((k) => b[k] !== undefined);
      if (inventados.length > 0) {
        return res.status(400).json({
          success: false,
          motivo: 'campo_desconocido',
          message: `Este cierre no entiende ${inventados.join(', ')}. Para repartir solo una `
            + 'parte, manda montoARepartir con el importe que acordo la asamblea.',
        });
      }

      const calc = await calcularReparto(groupId, b.base, montoDecidido);

      if (pidioImporte && montoDecidido > calc.ganancia.colocable + 0.005) {
        return res.status(400).json({
          success: false,
          motivo: 'monto_excede',
          disponible: calc.ganancia.colocable,
          message: `La asamblea no puede repartir $${montoDecidido.toFixed(2)}: hay `
            + `$${calc.ganancia.colocable.toFixed(2)} con dueno para repartir.`,
        });
      }

      // Cerrar el periodo con comprobantes o aportes sin revisar es cerrar a
      // ciegas: lo que se apruebe despues cae en un mes ya repartido. No se
      // prohibe (a veces hay que cerrar igual), pero hay que decidirlo sabiendo.
      const rev = calc.revisionPendiente || { hayAlgo: false };
      if (rev.hayAlgo && !b.cerrarConPendientes) {
        const trozos = [];
        if (rev.comprobantes > 0) {
          trozos.push(`${rev.comprobantes} comprobante(s) de pago por $${rev.montoComprobantes.toFixed(2)} `
            + `(traen $${rev.interesEnJuego.toFixed(2)} de interes que se quedaria fuera de este reparto)`);
        }
        if (rev.aportes > 0) {
          trozos.push(`${rev.aportes} aporte(s) por $${rev.montoAportes.toFixed(2)} sin confirmar`);
        }
        return res.status(409).json({
          success: false,
          motivo: 'falta_revisar',
          revisionPendiente: rev,
          message: `Antes de cerrar el periodo queda por revisar: ${trozos.join(' y ')}. `
            + 'Revisalo primero, o vuelve a pulsar para cerrar de todos modos: lo que se '
            + 'apruebe despues se repartira en el periodo siguiente, no en este.',
        });
      }

      if (!(calc.ganancia.porRepartir > 0)) {
        return res.status(409).json({
          success: false,
          message: calc.ganancia.total > 0
            ? 'Todo lo que el grupo ha ganado ya se repartio en cierres anteriores.'
            : 'El grupo todavia no ha cobrado intereses, asi que no hay nada que repartir.',
        });
      }
      // Repartir CERO es una decision legitima: el grupo cierra el periodo, deja
      // constancia en acta y sigue acumulando. Lo que no puede es quedarse sin
      // cerrar, porque entonces no hay acuerdo de asamblea que lo respalde.
      const noReparteNada = pidioImporte && montoDecidido === 0;
      // Hay ganancia, pero puede que no haya a QUIEN repartirla: si nadie tiene
      // capital puesto segun la base elegida, el reparto sale a cero. Guardar
      // ese cierre dejaria un borrador vacio que ni se puede abonar ni deja
      // abrir otro, con el grupo bloqueado.
      if (!noReparteNada && !(calc.repartido > 0)) {
        return res.status(409).json({
          success: false,
          message: `Hay $${calc.ganancia.porRepartir.toFixed(2)} por repartir, pero nadie tiene `
            + `capital puesto segun la base elegida (${calc.base}). Cambia la base del reparto en `
            + 'el reglamento del grupo, o espera a que haya aportes confirmados.',
        });
      }

      const cierreId = newId('cie');
      // El periodo era decorativo: ponia el mes en que se pulso el boton, no los
      // meses que se estan repartiendo. Ahora lleva el rango real.
      // El periodo NO es decorativo: de el sale hasta que mes queda cerrado, y
      // con eso se decide que se vuelve a repartir y que no. Un texto libre aqui
      // reabre o cierra meses que no tocan, asi que solo se acepta el formato
      // 'AAAA-MM' o 'AAAA-MM a AAAA-MM', y nunca por delante de lo que se cierra.
      let periodo = calc.periodoSugerido;
      if (b.periodo) {
        const pedido = b.periodo.toString().trim().slice(0, 40);
        if (!/^\d{4}-(0[1-9]|1[0-2])( a \d{4}-(0[1-9]|1[0-2]))?$/.test(pedido)) {
          return res.status(400).json({
            success: false,
            motivo: 'periodo_invalido',
            message: 'El periodo se escribe como 2026-03 o como 2026-01 a 2026-06.',
          });
        }
        const ultimoPedido = (pedido.match(/\d{4}-\d{2}/g) || []).slice(-1)[0];
        const ultimoReal = (String(calc.periodoSugerido).match(/\d{4}-\d{2}/g) || []).slice(-1)[0];
        if (ultimoReal && ultimoPedido > ultimoReal) {
          return res.status(400).json({
            success: false,
            motivo: 'periodo_adelantado',
            message: `Ese periodo llega mas lejos de lo que hay para repartir (${calc.periodoSugerido}). `
              + 'Cerrar meses en los que el grupo todavia no gano nada dejaria fuera lo que gane despues.',
          });
        }
        // Y tiene que CUBRIR lo que se esta pagando. El importe abonado son
        // todos los meses abiertos, pero hasta que mes queda cerrado sale de
        // este texto: si el texto se queda corto, los meses que sobran siguen
        // abiertos y su ganancia se vuelve a ofrecer entera. Medido: $720
        // ganados, cierre con periodo de solo 2023, se abonan los $720, y la
        // app vuelve a ofrecer $480. Con el segundo cierre el grupo pagaba
        // $1.200 habiendo ganado $720.
        const primerPedido = (pedido.match(/\d{4}-\d{2}/g) || [])[0];
        const primerReal = (String(calc.periodoSugerido).match(/\d{4}-\d{2}/g) || [])[0];
        const seQuedaCorto = (ultimoReal && ultimoPedido < ultimoReal)
          || (primerReal && primerPedido > primerReal);
        if (seQuedaCorto) {
          return res.status(400).json({
            success: false,
            motivo: 'periodo_incompleto',
            periodoSugerido: calc.periodoSugerido,
            message: `Se esta repartiendo lo de ${calc.periodoSugerido}, asi que el periodo del `
              + `cierre tiene que cubrirlo entero. Con "${pedido}" quedarian meses abiertos cuyo `
              + 'interes ya se habria pagado, y la app volveria a ofrecerlo en el cierre siguiente. '
              + 'Si lo que quereis es repartir solo una parte, dejad el periodo completo y mandad '
              + 'montoARepartir con el importe acordado.',
          });
        }
        periodo = pedido;
      }
      const retenido = Math.max(0, Math.round(
        (calc.ganancia.colocable - calc.repartido) * 100) / 100);
      const decision = calc.repartido <= 0 ? 'no_reparte'
        : (retenido > 0.004 ? 'reparte_parte' : 'reparte_todo');
      await appendRow(SHEETS.cierres, [
        cierreId, groupId, 'borrador', req.user.email, nowIso(), '', '', '',
        calc.repartido, calc.base, calc.totalParticipacion,
        calc.reparto.filter((x) => x.utilidad > 0).length, sanitizeCell(periodo, 40),
        // La nota viaja a la asamblea junto al acuerdo: el aviso se lo tiene que
        // leer quien vota, no solo quien pulsa el boton.
        sanitizeCell(rev.hayAlgo
          ? `${b.nota || ''} [Se cerro con ${rev.comprobantes} comprobante(s) y `
            + `${rev.aportes} aporte(s) sin revisar]`.trim()
          : (b.nota || ''), 200),
        calc.ganancia.colocable, retenido, decision,
      ]);
      for (const x of calc.reparto) {
        await appendRow(SHEETS.cierreDetalle, [
          cierreId, groupId, x.email, x.acciones, x.ahorro, x.participacion, x.proporcion, x.utilidad,
          // Lo que le tocaba por estos meses, se le pague ahora o mas adelante.
          // Sin esta columna lo retenido volveria repartido por el capital de
          // hoy, y quien entrara despues cobraria de anos en que no estaba.
          x.devengado,
        ]);
      }

      // Si se cerro sabiendo que faltaba revisar, queda anotado QUIEN y CUANTO,
      // no solo cuantos: esas filas se pueden aprobar, rechazar o editar a mano
      // en la hoja despues, y entonces el recuento ya no reconstruye la decision.
      const aSabiendas = rev.hayAlgo
        ? ' | cerrado a sabiendas: '
          + [
            ...(rev.detalle?.comprobantes || []).slice(0, 5)
              .map((c) => `comprobante ${c.email} $${Number(c.monto).toFixed(2)} (${c.fecha || 'sin fecha'})`),
            ...(rev.detalle?.aportes || []).slice(0, 5)
              .map((a) => `aporte ${a.email} $${Number(a.monto).toFixed(2)} (${a.fecha || 'sin fecha'})`),
          ].join('; ')
        : '';
      await logGob(groupId, req.user.email, 'cierre_utilidades_creado', cierreId,
        `${decision}: reparte ${calc.repartido} de ${calc.ganancia.colocable} `
        + `(retiene ${retenido}) por ${calc.base}${aSabiendas}`);
      res.status(201).json({ success: true, cierreId, estado: 'borrador', ...calc });
    } catch (e) {
      console.error('[GOB cierre crear]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al crear el cierre.' });
    }
  });

  /** Somete el cierre a una asamblea. */
  app.post('/api/gob/utilidades/cierre/:id/proponer', bloquear((r) => `cierre:${r.params.id}`), async (req, res) => {
    try {
      const cierre = await getCierre(req.params.id);
      if (!cierre) return res.status(404).json({ success: false, message: 'Cierre no encontrado.' });
      const rol = await requireLider(req, res, cierre.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      if (cierre.estado !== 'borrador') {
        return res.status(409).json({ success: false, message: `El cierre ya esta "${cierre.estado}".` });
      }

      const asamblea = await getAsamblea((req.body?.asambleaId || '').toString().trim());
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      if (normalizeGroupKey(asamblea.groupId) !== cierre.groupId) {
        return res.status(403).json({ success: false, message: 'Esa asamblea es de otro grupo.' });
      }
      if (!['programada', 'abierta'].includes(asamblea.estado)) {
        return res.status(409).json({ success: false, message: 'La asamblea ya no admite nuevos puntos.' });
      }

      const acuerdoId = newId('acu');
      await appendRow(SHEETS.acuerdos, [
        acuerdoId, asamblea.asambleaId, cierre.groupId, 'reparto_utilidades',
        sanitizeCell(cierre.decision === 'no_reparte'
          ? `Cerrar el periodo SIN repartir: $${cierre.retenido.toFixed(2)} quedan acumulados`
          : (cierre.retenido > 0.004
            ? `Reparto de utilidades: $${cierre.ganancia} entre ${cierre.socios} socios `
              + `(quedan $${cierre.retenido.toFixed(2)} acumulados)`
            : `Reparto de utilidades: $${cierre.ganancia} entre ${cierre.socios} socios`), 200),
        sanitizeCell(`Se reparte por ${cierre.base}. Periodo ${cierre.periodo}. `
          + `El periodo dio $${cierre.gananciaPeriodo.toFixed(2)}; se reparten `
          + `$${cierre.ganancia.toFixed(2)} y quedan $${cierre.retenido.toFixed(2)} para mas `
          + `adelante, con el derecho de cada socia anotado. Cierre ${cierre.cierreId}.`, 2000),
        JSON.stringify({ cierreId: cierre.cierreId }),
        'abierto', req.user.email, nowIso(), '', '', 0, 0, 0,
      ]);

      const row = cierre._row.slice();
      while (row.length < SHEETS.cierres.headers.length) row.push('');
      row[2] = 'propuesto'; row[5] = asamblea.asambleaId; row[6] = acuerdoId;
      await updateRow(SHEETS.cierres, cierre._index, row);

      await logGob(cierre.groupId, req.user.email, 'cierre_utilidades_propuesto', cierre.cierreId, acuerdoId);
      res.json({ success: true, acuerdoId, asambleaId: asamblea.asambleaId, estado: 'propuesto' });
    } catch (e) {
      console.error('[GOB cierre proponer]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al someter el cierre.' });
    }
  });

  /** Abona las utilidades a la cuenta de cada socio. Solo con acuerdo aprobado. */
  app.post('/api/gob/utilidades/cierre/:id/aplicar', bloquear((r) => `cierre:${r.params.id}`), async (req, res) => {
    try {
      const cierre = await getCierre(req.params.id);
      if (!cierre) return res.status(404).json({ success: false, message: 'Cierre no encontrado.' });
      const rol = await requireLider(req, res, cierre.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;

      if (cierre.estado === 'aplicado') {
        return res.status(409).json({ success: false, message: 'Este cierre ya fue abonado.' });
      }
      if (cierre.estado !== 'propuesto') {
        return res.status(409).json({ success: false, message: 'Primero somete el cierre a una asamblea.' });
      }
      const chk = await acuerdoAprobadoValido(cierre.groupId, cierre.acuerdoId, 'reparto_utilidades');
      if (!chk.valido) {
        return res.status(409).json({
          success: false,
          message: 'Las utilidades solo se abonan con el acuerdo de asamblea aprobado.',
          detalle: chk.motivo,
        });
      }

      const filas = (await detalleCierre(cierre.cierreId)).filter((f) => f.utilidad > 0);
      // Un cierre que la asamblea aprobo SIN repartir no abona nada, pero si
      // cierra el periodo y deja el acta. Antes esto era un error 400 y el grupo
      // se quedaba sin forma de decir "este ano no repartimos".
      if (filas.length === 0 && cierre.decision !== 'no_reparte') {
        return res.status(400).json({ success: false, message: 'El cierre no tiene nada que abonar.' });
      }
      if (filas.length === 0) {
        const fila = cierre._row.slice();
        while (fila.length < SHEETS.cierres.headers.length) fila.push('');
        fila[2] = 'aplicado'; fila[7] = nowIso();
        await updateRow(SHEETS.cierres, cierre._index, fila);
        await logGob(cierre.groupId, req.user.email, 'cierre_utilidades_aplicado', cierre.cierreId,
          `sin reparto: quedan $${cierre.retenido.toFixed(2)} acumulados`);
        return res.json({
          success: true,
          estado: 'aplicado',
          decision: 'no_reparte',
          retenido: cierre.retenido,
          abonado: { socios: 0, total: 0 },
          message: `El periodo ${cierre.periodo} queda cerrado sin repartir. Los `
            + `$${cierre.retenido.toFixed(2)} siguen siendo del grupo y se repartiran cuando la `
            + 'asamblea lo decida, entre quienes los generaron.',
        });
      }

      const sheetsClient = await getSheetsClient();
      const fecha = nowIso();
      const fechaCorta = fecha.split('T')[0];
      const savingsRows = [];
      const transRows = [];

      for (const f of filas) {
        const movId = newId('utisav');
        savingsRows.push([
          f.email, cierre.groupId, f.utilidad, fechaCorta, 'utilidad',
          `Utilidades repartidas en asamblea (cierre ${cierre.cierreId}, por ${cierre.base})`,
          'confirmado', req.user.email, req.user.email, fecha, movId, '',
        ]);
        transRows.push([
          `${Date.now()}${Math.floor(Math.random() * 1000)}`, f.email, 'saving', f.utilidad,
          `Utilidades del periodo ${cierre.periodo}`, fecha, 'utilidad', '',
        ]);
      }

      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: `Savings!A:${SAVINGS_LAST_COL}`,
        valueInputOption: 'RAW', requestBody: { values: savingsRows },
      });
      try {
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID, range: 'Transactions!A:H',
          valueInputOption: 'RAW', requestBody: { values: transRows },
        });
      } catch (e) { /* el historial es secundario: no bloquea el abono */ }

      const row = cierre._row.slice();
      while (row.length < SHEETS.cierres.headers.length) row.push('');
      row[2] = 'aplicado'; row[7] = fecha;
      await updateRow(SHEETS.cierres, cierre._index, row);

      await logGob(cierre.groupId, req.user.email, 'cierre_utilidades_aplicado', cierre.cierreId,
        `${filas.length} socios, $${cierre.ganancia}`);
      res.json({
        success: true, estado: 'aplicado',
        abonado: { socios: filas.length, total: cierre.ganancia },
      });
    } catch (e) {
      console.error('[GOB cierre aplicar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al abonar las utilidades.' });
    }
  });

  /** Descarta un borrador que ya no sirve. */
  app.post('/api/gob/utilidades/cierre/:id/descartar', bloquear((r) => `cierre:${r.params.id}`), async (req, res) => {
    try {
      const cierre = await getCierre(req.params.id);
      if (!cierre) return res.status(404).json({ success: false, message: 'Cierre no encontrado.' });
      const rol = await requireLider(req, res, cierre.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      if (cierre.estado === 'aplicado') {
        return res.status(409).json({ success: false, message: 'Un cierre ya abonado no se puede descartar.' });
      }
      const row = cierre._row.slice();
      while (row.length < SHEETS.cierres.headers.length) row.push('');
      row[2] = 'descartado';
      await updateRow(SHEETS.cierres, cierre._index, row);
      await logGob(cierre.groupId, req.user.email, 'cierre_utilidades_descartado', cierre.cierreId, '');
      res.json({ success: true, estado: 'descartado' });
    } catch (e) {
      console.error('[GOB cierre descartar]', e);
      if (responderSiEsCuota(res, e)) return;

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
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al leer la bitacora.' });
    }
  });

  // Helpers que server.js necesita para aplicar el reglamento en sus propias rutas
  /**
   * ANULA UN PUNTO DE ASAMBLEA QUE TODAVIA NO HA DECIDIDO NADA.
   *
   * La app ya prometia esto y no existia. Al intentar cambiar la asistencia con votos
   * emitidos, el error dice "Si hay un error, anula el punto y vuelve a proponerlo" y
   * no habia por donde: medido, POST a /api/gob/acuerdos/:id/anular, /revocar y
   * /revertir devuelven 404.
   *
   * SOLO SE ANULA LO QUE NADIE HA VOTADO TODAVIA: 'abierto' (el punto mal redactado que
   * se retira antes de votar) y 'sin_resolver' (el que se archivo al cerrar la asamblea
   * sin quorum). Un punto 'aprobado' o 'rechazado' es una decision de la asamblea, y
   * dejar que una sola firma la borre contradice la regla del grupo de que el dinero se
   * decide en asamblea: para volver atras se propone un punto nuevo que revoque al
   * anterior y se vota con el mismo quorum.
   *
   * Y PARA SABER SI ALGO YA SE EJECUTO SE MIRA EL EFECTO, NO EL ESTADO DEL ACUERDO.
   * Comprobado: solo dos sitios ponen 'ejecutado' (cambio_reglas y el lote de apertura).
   * Aplicar un cierre de utilidades escribe 'aplicado' en el cierre y DEJA el acuerdo en
   * 'aprobado'. Fiarse del estado dejaba anular el acuerdo de un reparto ya abonado en la
   * libreta de cada socia.
   */
  app.post('/api/gob/acuerdos/:id/anular', bloquear((r) => `acuerdo:${r.params.id}`), async (req, res) => {
    try {
      const ac = await getAcuerdo((req.params.id || '').toString().trim());
      if (!ac) return res.status(404).json({ success: false, message: 'Acuerdo no encontrado.' });

      // El punto SIN votos lo puede retirar tambien la secretaria, que es quien lleva el
      // acta y quien suele redactarlo. En cuanto hay un voto, solo la presidencia: asi
      // nadie mata en solitario una votacion en curso sin que se sepa quien fue.
      const votosDelPunto = (await readAll(SHEETS.votos))
        .filter((v) => (v[0] || '').toString().trim() === ac.acuerdoId);
      const roles = (ac.estado === 'abierto' && votosDelPunto.length === 0)
        ? new Set(['presidente', 'secretario'])
        : new Set(['presidente']);
      const rol = await requireLider(req, res, ac.groupId, roles);
      if (!rol) return;

      const motivo = (req.body?.motivo || '').toString().trim();
      if (!motivo) {
        return res.status(400).json({
          success: false,
          message: 'Escribe por qué se anula este punto. Queda en el acta y en la bitácora del grupo.',
        });
      }

      if (ac.estado === 'anulado') {
        return res.status(409).json({ success: false, message: 'Este punto ya estaba anulado.' });
      }
      if (!['abierto', 'sin_resolver'].includes(ac.estado)) {
        return res.status(409).json({
          success: false,
          motivo: 'ya_decidido',
          estado: ac.estado,
          message: `Este punto ya está "${ac.estado}": es una decisión de la asamblea y no se `
            + 'borra con una firma. Para dejarlo sin efecto, propone un punto nuevo que lo '
            + 'revoque y somételo a votación con el mismo quórum.',
        });
      }

      // LO QUE COLGABA DEL PUNTO SE RETIRA CON EL.
      //
      // Antes esto era un 409 y dejaba a la presidenta encerrada: un lote propuesto con
      // una cifra mal tecleada no se podia aplicar (el acuerdo no estaba aprobado), ni
      // volver a proponer ('el lote ya esta "propuesto"'), ni descartar (no existia el
      // endpoint), ni anular el punto (este mismo 409). Cuatro puertas cerradas a la vez:
      // la unica salida era hacer que la asamblea votara en contra de una cifra que nadie
      // defendia, o editar la hoja a mano.
      //
      // Lo que SI se sigue negando es anular el papel de algo ya ejecutado: ahi el dinero
      // se movio y borrar el acta no lo devuelve.
      const retirados = [];
      const yaEjecutado = (mensaje) => res.status(409).json({
        success: false, motivo: 'acuerdo_ya_ejecutado', tipo: ac.tipo, message: mensaje,
      });

      const loteId = ((ac.payload && ac.payload.loteId) || '').toString().trim();
      if (loteId) {
        const lote = await getLote(loteId);
        const est = lote ? lote.estado : '';
        if (est === 'aplicado') {
          return yaEjecutado('Los saldos del cuaderno ya se cargaron con este acuerdo y no se '
            + 'pueden descargar. Para corregir el saldo de una socia usa la bandeja de aportes; '
            + 'el traspaso del cuaderno se hace una sola vez.');
        }
        if (est === 'propuesto') {
          const row = lote._row.slice();
          while (row.length < SHEETS.lotes.headers.length) row.push('');
          row[2] = 'descartado';
          row[12] = sanitizeCell(`[RETIRADO con el punto por ${req.user.email}: ${motivo}]`, 500);
          await updateRow(SHEETS.lotes, lote._index, row);
          await logGob(ac.groupId, req.user.email, 'lote_apertura_descartado', loteId,
            `retirado con el punto ${ac.acuerdoId}`);
          retirados.push({ que: 'lote', id: loteId });
        }
      }

      const cierreId = ((ac.payload && ac.payload.cierreId) || '').toString().trim();
      if (cierreId) {
        const cierre = await getCierre(cierreId);
        const est = cierre ? cierre.estado : '';
        if (est === 'aplicado') {
          return yaEjecutado('Las utilidades de ese cierre ya están en la libreta de cada socia '
            + 'y no se les pueden quitar. Anular el papel no devuelve el dinero. Si la cifra '
            + 'estaba mal, la pantalla de Utilidades lo dice y se corrige en la próxima asamblea.');
        }
        if (est === 'propuesto') {
          const row = cierre._row.slice();
          while (row.length < SHEETS.cierres.headers.length) row.push('');
          row[2] = 'descartado';
          await updateRow(SHEETS.cierres, cierre._index, row);
          await logGob(ac.groupId, req.user.email, 'cierre_utilidades_descartado', cierreId,
            `retirado con el punto ${ac.acuerdoId}`);
          retirados.push({ que: 'cierre', id: cierreId });
        }
      }

      // Gasto o multa: se quedaba 'propuesto' para siempre en la pantalla de Caja,
      // sosteniendo un gasto que ya nadie iba a aplicar.
      const movCajaId = ((ac.payload && ac.payload.movId) || '').toString().trim();
      if (movCajaId) {
        const mov = await getMovCaja(movCajaId);
        if (mov && mov.estado === 'aplicado') {
          return yaEjecutado('Ese dinero ya salió de la caja del grupo. Anular el papel no lo '
            + 'devuelve: para deshacerlo, propone en asamblea el movimiento contrario.');
        }
        if (mov && mov.estado === 'propuesto') {
          const row = mov._row.slice();
          while (row.length < SHEETS.caja.headers.length) row.push('');
          row[6] = 'descartado';
          row[11] = req.user.email; row[12] = nowIso();
          row[13] = sanitizeCell(`[RETIRADO con el punto: ${motivo}]`, 500);
          await updateRow(SHEETS.caja, mov._index, row);
          await logGob(ac.groupId, req.user.email, 'caja_movimiento_descartado', movCajaId,
            `retirado con el punto ${ac.acuerdoId}`);
          retirados.push({ que: 'movimiento de caja', id: movCajaId });
        }
      }

      const avalId = ((ac.payload && ac.payload.avalId) || '').toString().trim();
      if (avalId) {
        const aval = await getAval(avalId);
        if (aval && aval.estado === 'aprobado') {
          return yaEjecutado('Ese aval ya está dando cupo. Para quitarlo se usa "liberar", que '
            + 'comprueba antes que el préstamo que sostiene esté pagado.');
        }
        if (aval && aval.estado === 'propuesto') {
          const row = aval._row.slice();
          while (row.length < SHEETS.avales.headers.length) row.push('');
          row[5] = 'descartado';
          row[10] = req.user.email; row[11] = nowIso();
          row[12] = sanitizeCell(`[RETIRADO con el punto: ${motivo}]`, 500);
          await updateRow(SHEETS.avales, aval._index, row);
          await logGob(ac.groupId, req.user.email, 'aval_descartado', avalId,
            `retirado con el punto ${ac.acuerdoId}`);
          retirados.push({ que: 'aval', id: avalId });
        }
      }

      const row = ac._row.slice();
      while (row.length < SHEETS.acuerdos.headers.length) row.push('');
      // La marca va DELANTE: sanitizeCell corta por la derecha, y con una descripcion
      // larga era justo la marca de anulacion la que se perdia.
      row[5] = sanitizeCell(`[ANULADO por ${req.user.email}: ${motivo}]\n${ac.descripcion || ''}`, 2000);
      row[7] = 'anulado';
      row[10] = nowIso();
      await updateRow(SHEETS.acuerdos, ac._index, row);

      await logGob(ac.groupId, req.user.email, 'acuerdo_anulado', ac.acuerdoId,
        `estaba "${ac.estado}" con ${votosDelPunto.length} voto(s) | ${motivo}`);

      res.json({
        success: true,
        estado: 'anulado',
        estadoAnterior: ac.estado,
        votosDescartados: votosDelPunto.length,
        retirados,
        message: retirados.length
          ? `Punto anulado, y se retira con él ${retirados.map((x) => x.que).join(' y ')}. `
            + 'Vuelve a proponerlo corregido en esta misma asamblea.'
          : 'Punto anulado. Vuelve a proponerlo corregido en esta misma asamblea.',
      });
    } catch (e) {
      console.error('[GOB acuerdo anular]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al anular el punto.' });
    }
  });

  /**
   * DEVUELVE UN COMPROBANTE DE PAGO A LA BANDEJA DE LA TESORERIA.
   *
   * Hasta ahora un comprobante revisado no tenia marcha atras: /api/approve-payment
   * responde 409 "Este comprobante ya fue aprobado por <quien>. No se puede volver a
   * procesar." Medido con el arnes: un comprobante de $120 aprobado por error sobre un
   * prestamo de $100 a devolver por $120 dejo el saldo en $0,00 cuando la socia solo
   * habia depositado $60, y desde la app no habia forma de corregirlo.
   *
   * LO QUE NO HACE, Y POR QUE. Solo deshace comprobantes cuyo interes NO se haya
   * repartido todavia. Si ya salio en un cierre aplicado, responde 409 y no toca nada.
   * La razon no es de permisos: es que el motor de reparto no sabe restar. Medido con el
   * motor real: cinco socias con $100, prestamo de $100 a devolver por $120, comprobante
   * de $120 aprobado por error el 2026-03-15 y cierre de marzo aplicado ($20,00
   * repartidos, $4,00 cada una). Corrigiendolo a $60 en marzo y aprobando la segunda
   * cuota real de $60 el 2026-06-10, el grupo cobro $20,00 de interes, ya habia pagado
   * $20,00 de utilidades, y el reparto ofrecia repartir OTROS $10,00 ($2,00 mas por
   * socia). La caja quedaba $10,00 corta. El Math.max(0,...) de gananciaCerradaNueva
   * tapa ese descuadre en los meses cerrados, pero los abiertos siguen repartiendo
   * enteros.
   *
   * Y EL INTERES NO SE ESTIMA, SE MIDE. Se corre gananciaPorMes dos veces, con el
   * comprobante y sin el, y se comparan los meses ya cerrados. La formula
   * monto x (interes/total) se equivoca en los dos sentidos, porque el interes se
   * reconoce hasta el total pactado y en el ORDEN de la hoja: medido, con las filas
   * [junio $60, marzo $120] quitar el pago de JUNIO sube marzo de $10,00 a $20,00, y con
   * las filas al reves ese mismo pago aporta $0,00 de interes real mientras la formula
   * anunciaba $10,00.
   */
  app.post('/api/gob/pagos/revertir',
    bloquear((r) => `pago:${((r.body && r.body.paymentId) ?? '').toString().trim()}`),
    async (req, res) => {
      try {
        const paymentId = (req.body?.paymentId || '').toString().trim();
        const motivo = (req.body?.motivo || '').toString().trim();
        if (!paymentId) {
          return res.status(400).json({ success: false, message: 'Falta el número del comprobante.' });
        }
        if (!motivo) {
          return res.status(400).json({
            success: false,
            message: 'Escribe por qué se deshace este comprobante. Queda en la hoja y en la '
              + 'bitácora del grupo.',
          });
        }

        const sheetsClient = await getSheetsClient();
        await ensureSheetExists('LoanPayments', [
          'PaymentID', 'UserEmail', 'LoanID', 'Amount', 'PaymentDate',
          'Description', 'Status', 'ImageFilename', 'OriginalImageName',
          'ImagePath', 'ImageSize', 'CreatedAt', 'ApprovedBy',
          'ApprovalDate', 'ApprovalNotes',
        ], sheetsClient, SPREADSHEET_ID);

        // EL PERMISO, ANTES DE LEER NADA GRANDE. Solo se leen las tres primeras columnas,
        // lo justo para saber de que prestamo es. Con las lecturas completas por delante,
        // cualquier socia autenticada de cualquier grupo distinguia por el codigo de
        // respuesta si un comprobante ajeno existe, y cada sondeo gastaba 4 de las 20
        // lecturas por minuto que hoja.js deja pasar en produccion.
        const claves = await sheetsClient.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:C',
        });
        const conEseNumero = (claves.data.values || [])
          .filter((r) => (r[0] || '').toString().trim() === paymentId);
        const loanId = conEseNumero.length > 0 ? (conEseNumero[0][2] || '').toString().trim() : '';
        const groupId = loanId
          ? normalizeGroupKey((await getLoanGroupMap()).get(loanId) || '') : '';
        if (!groupId) {
          // La misma respuesta para "no existe" y para "no es de tu grupo": decir cual de
          // las dos es le confirmaba a cualquiera que ese comprobante existe en otro grupo.
          return res.status(403).json({
            success: false,
            message: 'No encontramos ese comprobante entre los de tu grupo.',
          });
        }
        const rol = await requireLider(req, res, groupId, new Set(['presidente']));
        if (!rol) return;

        // Dos filas con el mismo numero: se resolveria siempre la primera y la segunda
        // quedaria atrapada. Es un error de la hoja y hay que decirlo, no elegir una en
        // silencio.
        if (conEseNumero.length > 1) {
          return res.status(409).json({
            success: false,
            motivo: 'pago_duplicado',
            message: `Hay ${conEseNumero.length} comprobantes con el número ${paymentId} en la `
              + 'hoja LoanPayments. Deja uno solo antes de deshacerlo.',
          });
        }

        // UN CIERRE A MEDIO HACER SE CALCULO CON ESTE COMPROBANTE. El cierre congela la
        // ganancia y el detalle socia por socia al CREARSE, y aplicar no recalcula nada:
        // lee la foto. Medido: comprobante de $120 aprobado por error en un mes abierto,
        // cierre creado con $20,00 y $4,00 para cada una de las cinco socias; se deshace el
        // comprobante (interes real $0,00), se aplica el cierre y se abonan los $20,00
        // igual, con la caja $20,00 corta. Por eso aqui se para.
        const cierrePendiente = (await readAll(SHEETS.cierres)).find((r) => (
          normalizeGroupKey(r[1]) === groupId
          && ['borrador', 'propuesto'].includes((r[2] || '').toString().trim().toLowerCase())));
        if (cierrePendiente) {
          return res.status(409).json({
            success: false,
            motivo: 'cierre_en_preparacion',
            cierreId: (cierrePendiente[0] || '').toString().trim(),
            message: 'Hay un cierre de utilidades en preparación que se calculó con este '
              + 'comprobante. Descártalo primero en la pantalla de Utilidades y vuelve a '
              + 'intentarlo; luego se crea otra vez con las cifras corregidas.',
          });
        }

        const [paysResp, loansResp] = await Promise.all([
          sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O',
          }),
          sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Loans!A2:K',
          }),
        ]);
        const paysRows = paysResp.data.values || [];
        const indice = paysRows.findIndex((r) => (r[0] || '').toString().trim() === paymentId);
        if (indice === -1) {
          return res.status(409).json({
            success: false,
            motivo: 'fila_desaparecida',
            message: `La fila ${paymentId} ya no está en LoanPayments. Alguien pudo borrarla `
              + 'desde la hoja de cálculo. Vuelve a cargar y revisa.',
          });
        }
        const antes = paysRows[indice];

        const estado = (antes[6] || '').toString().trim().toLowerCase();
        if (!['approved', 'aprobado', 'rejected', 'rechazado', 'rechazada'].includes(estado)) {
          return res.status(409).json({
            success: false,
            message: 'Este comprobante sigue esperando revisión: no hay nada que deshacer.',
            estado,
          });
        }
        const estabaAprobado = ['approved', 'aprobado'].includes(estado);

        // LO QUE SE PIERDE EN LOS MESES YA CERRADOS, MEDIDO CON EL MOTOR.
        const cerradoHasta = cerradoHastaDe((await readAll(SHEETS.cierres))
          .filter((r) => normalizeGroupKey(r[1]) === groupId
            && (r[2] || '').toString().trim().toLowerCase() === 'aplicado'));
        let caida = 0;
        const mesesTocados = [];
        if (cerradoHasta) {
          const loansRows = loansResp.data.values || [];
          const con = gananciaPorMes(prestamosDelGrupo(loansRows, paysRows, groupId));
          const sin = gananciaPorMes(prestamosDelGrupo(loansRows, paysRows, groupId, paymentId));
          for (const mes of Object.keys(con.porMes)) {
            if (mes > cerradoHasta) continue;
            const baja = Math.round(((con.porMes[mes] || 0) - (sin.porMes[mes] || 0)) * 100) / 100;
            if (baja > 0) {
              caida = Math.round((caida + baja) * 100) / 100;
              mesesTocados.push(mes);
            }
          }
        }
        if (caida > 0) {
          return res.status(409).json({
            success: false,
            motivo: 'periodo_ya_repartido',
            interes: caida,
            meses: mesesTocados,
            cerradoHasta,
            message: `Los $${caida.toFixed(2)} de interés que sostiene este comprobante ya se `
              + `repartieron entre las socias en el cierre de ${mesesTocados.join(', ')}. Ese `
              + 'dinero no se les quita y la app no sabe descontarlo, así que este comprobante '
              + 'no se puede deshacer desde aquí. Llévenlo a la asamblea, corrijan la cifra en '
              + 'la hoja de cálculo con el acuerdo escrito en el acta, y la pantalla de '
              + 'Utilidades les dirá cuánto falta.',
          });
        }

        // Toda la historia se queda en la propia fila, porque la tesorera abre la hoja y lee
        // ahi. Lo NUEVO va primero: sanitizeCell corta por la derecha, asi que con unas
        // notas previas largas era justo la parte nueva (quien lo deshizo y por que) la que
        // se perdia. La marca [REVERTIDO por ...] la lee /api/approve-payment para que quien
        // deshizo no sea quien vuelve a resolver.
        const aprobadoPor = (antes[12] || '').toString().trim();
        const historia = [
          `[REVERTIDO por ${req.user.email} el ${nowIso().slice(0, 10)}: ${motivo}]`,
          `antes ${estabaAprobado ? 'aprobado' : 'rechazado'} por ${aprobadoPor || 'la junta'}`,
          (antes[14] || '').toString().trim().slice(0, 120),
        ].filter(Boolean).join(' | ');

        // Por PaymentID, no por numero de fila: si alguien borro una fila de mas arriba
        // mientras tanto, escribir en la posicion N devolvia a revision el comprobante de
        // otra socia.
        //
        // ApprovedBy (M) y ApprovalDate (N) se vacian: una fila que dice "aprobada por X el
        // dia Y" con estado pendiente es una mentira en la hoja que la tesorera lee. Y no,
        // conservar N no evita que el mes se mueva al volver a aprobar: comprobado,
        // /api/approve-payment escribe SIEMPRE la fecha de hoy en N. Lo que evita el doble
        // reparto es el corte de mas arriba, que no deja tocar un mes ya cerrado.
        await actualizarFilaPorClave(sheetsClient, {
          spreadsheetId: SPREADSHEET_ID,
          hoja: 'LoanPayments',
          ultimaColumna: 'O',
          desdeColumna: 'G',
          indice,
          claveCol: 0,
          clave: paymentId,
          construir: (actual) => {
            const f = actual || antes;
            return [
              'pending_approval',            // Status (G): vuelve a la bandeja de la tesoreria
              f[7] || '', f[8] || '', f[9] || '', f[10] || '', f[11] || '',
              '',                            // ApprovedBy (M)
              '',                            // ApprovalDate (N)
              sanitizeCell(historia, 500),   // ApprovalNotes (O)
            ];
          },
        });

        const propiaRevision = normalizeEmailKey(aprobadoPor) === req.user.email;
        await logGob(groupId, req.user.email,
          propiaRevision ? 'pago_revertido_por_quien_lo_reviso' : 'pago_revertido',
          paymentId,
          `${estabaAprobado ? 'estaba aprobado' : 'estaba rechazado'} por ${aprobadoPor || 'la junta'}`
            + ` | $${num(antes[3]).toFixed(2)} del prestamo ${loanId} | ${motivo}`);

        // El AuditLog es la pista que mira la investigacion desde fuera del grupo. Si falla
        // no se deshace la correccion: el rastro que manda es el del grupo.
        try {
          await require('./services/auditLogService').log({
            UserEmail: req.user.email,
            Action: 'pago_revertido',
            Target: `${paymentId} | ${groupId} | ${motivo}`,
            Date: nowIso(),
          });
        } catch (e) {
          console.error('[GOB pagos/revertir] no se pudo escribir el AuditLog:', e.message);
        }

        // Si el prestamo estaba saldado y por eso el grupo le concedio otro, al subir el
        // saldo la socia puede quedar con mas prestamos vivos de los que permite el
        // reglamento. No se bloquea la correccion por eso, pero se dice: la junta no se
        // entera por ningun otro sitio.
        let avisoPrestamos = '';
        try {
          const reglas = await getReglas(groupId);
          const activos = await contarPrestamosActivos(normalizeEmailKey(antes[1]), groupId);
          if (reglas.maxPrestamosActivos > 0 && activos.cantidad > reglas.maxPrestamosActivos) {
            avisoPrestamos = `La socia queda con ${activos.cantidad} préstamos activos y el `
              + `reglamento permite ${reglas.maxPrestamosActivos}.`;
          }
        } catch (e) { /* el aviso es secundario: no bloquea la correccion */ }

        res.json({
          success: true,
          paymentId,
          estado: 'pending_approval',
          estadoAnterior: estado,
          avisoPrestamos,
          message: ('El comprobante vuelve a la bandeja de la tesorería y la deuda del préstamo '
            + 'sube otra vez. Mientras siga ahí, la socia no puede subir el comprobante '
            + 'corregido: la tesorería tiene que rechazarlo y pedirle que suba el del importe '
            + `correcto. ${avisoPrestamos}`).replace(/\s+/g, ' ').trim(),
        });
      } catch (e) {
        console.error('[GOB pagos/revertir]', e);
        if (responderSiEsCuota(res, e)) return;
        // La hoja la edita la tesorera a mano: si la fila desaparecio entre la lectura y la
        // escritura, actualizarFilaPorClave lo dice con su propio mensaje en vez de escribir
        // a ciegas.
        if (e && (e.motivo === 'fila_desaparecida' || e.motivo === 'fila_inestable')) {
          return res.status(409).json({ success: false, motivo: e.motivo, message: e.message });
        }
        res.status(500).json({ success: false, message: 'Error al deshacer el comprobante.' });
      }
    });

  /**
   * Quien mas ha puesto en el grupo.
   *
   * El libro del banco comunal se lee en voz alta en la asamblea, asi que la
   * lista la ve cualquier socia del grupo, no solo la directiva. Lo que no sale
   * de aqui es el correo completo: para reconocerse basta el nombre.
   */
  app.get('/api/gob/ahorradores', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!groupId) return res.status(400).json({ success: false, message: 'Falta groupId.' });
      if (!(await assertGroupMember(req, res, groupId))) return;

      const limite = Math.min(50, Math.max(1, Math.trunc(num(req.query.limite)) || 10));
      const yo = normalizeEmailKey(req.user.email);
      const cent = (x) => Math.round(x * 100) / 100;

      const [miembros, savRows, accRows, usuarios] = [
        await miembrosActivos(groupId),
        await leerSavings(),
        await leerAcciones(),
        await (async () => {
          const sheetsClient = await getSheetsClient();
          const r = await sheetsClient.spreadsheets.values.get({
            spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:B',
          });
          return r.data.values || [];
        })(),
      ];

      const nombreDe = {};
      for (const u of usuarios) nombreDe[normalizeEmailKey(u[1])] = (u[0] || '').toString().trim();

      const porSocia = new Map();
      for (const m of miembros) porSocia.set(m.email, { ahorro: 0, acciones: 0, unidades: 0 });

      for (const r of savRows) {
        if (normalizeGroupKey(r[SAV.group]) !== groupId) continue;
        if (!aporteCuenta(r[SAV.estado])) continue;
        // Las utilidades abonadas y lo devuelto al salir no son "lo que puso":
        // el ranking mide el esfuerzo de cada una, no el saldo de su cuenta.
        const tipo = (r[SAV.type] || '').toString().trim().toLowerCase();
        if (['utilidad', 'retiro_salida'].includes(tipo)) continue;
        const e = normalizeEmailKey(r[SAV.email]);
        if (!porSocia.has(e)) continue;
        porSocia.get(e).ahorro += num(r[SAV.amount]);
      }
      for (const r of accRows) {
        if (normalizeGroupKey(r[ACC.group]) !== groupId) continue;
        if (!aporteCuenta(r[ACC.estado])) continue;
        const e = normalizeEmailKey(r[ACC.email]);
        if (!porSocia.has(e)) continue;
        porSocia.get(e).acciones += num(r[ACC.shares]) * num(r[ACC.value]);
        porSocia.get(e).unidades += num(r[ACC.shares]);
      }

      const lista = [...porSocia.entries()]
        .map(([correo, v]) => ({
          nombre: nombreDe[correo] || correo.split('@')[0],
          ahorro: cent(v.ahorro),
          acciones: cent(v.acciones),
          unidades: cent(v.unidades),
          total: cent(v.ahorro + v.acciones),
          soyYo: correo === yo,
        }))
        .sort((a, b) => b.total - a.total || a.nombre.localeCompare(b.nombre))
        .map((x, i) => ({ ...x, puesto: i + 1 }));

      const miPuesto = lista.find((x) => x.soyYo) || null;
      res.json({
        success: true,
        socias: lista.length,
        // El podio; el resto no hace falta pintarlo entero en el telefono.
        top: lista.slice(0, limite),
        // Y donde esta quien pregunta, aunque no salga en el podio.
        yo: miPuesto,
        totalDelGrupo: cent(lista.reduce((acc, x) => acc + x.total, 0)),
      });
    } catch (e) {
      console.error('[GOB ahorradores]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al calcular el ranking.' });
    }
  });





  // =========================================================================
  //  AVALES: prestarle a quien todavia no tiene ahorro
  //
  //  El cupo era rigido -- ahorro por el factor -- sin excepcion. Quien recien
  //  entra no tiene ahorro, no tiene cupo, y es a quien un banco comunal presta
  //  con la firma de una companera. Aqui esa firma existe, la aprueba la
  //  asamblea, y le cuesta cupo a quien la pone.
  // =========================================================================

  async function getAval(avalId) {
    const id = (avalId || '').toString().trim();
    if (!id) return null;
    const filas = await readAll(SHEETS.avales);
    const i = filas.findIndex((r) => (r[0] || '').toString().trim() === id);
    if (i < 0) return null;
    const r = filas[i];
    return {
      avalId: r[0], groupId: normalizeGroupKey(r[1]),
      email: normalizeEmailKey(r[2]), avalEmail: normalizeEmailKey(r[3]),
      // Un aval nunca regala cupo: negativo se lee como cero.
      cupo: Math.max(0, num(r[4])),
      estado: (r[5] || 'propuesto').toString().trim().toLowerCase(),
      asambleaId: r[6] || '', acuerdoId: r[7] || '',
      creadoPor: r[8] || '', creadoEn: r[9] || '',
      resueltoPor: r[10] || '', resueltoEn: r[11] || '', motivo: r[12] || '',
      _index: i, _row: r,
    };
  }

  /** El cupo extra que una socia tiene aprobado con aval, si lo tiene. */
  async function avalVigenteDe(groupId, email) {
    const gid = normalizeGroupKey(groupId);
    const correo = normalizeEmailKey(email);
    const filas = (await readAll(SHEETS.avales)).filter((r) => (
      normalizeGroupKey(r[1]) === gid
      && normalizeEmailKey(r[2]) === correo
      && (r[5] || '').toString().trim().toLowerCase() === 'aprobado'));
    if (filas.length === 0) return null;
    const cupo = Math.round(filas.reduce((a, r) => a + Math.max(0, num(r[4])), 0) * 100) / 100;
    return { cupo, avalEmail: normalizeEmailKey(filas[0][3]), cuantos: filas.length };
  }

  /** Lo que una socia tiene comprometido avalando a otras. */
  async function loQueAvala(groupId, email) {
    const gid = normalizeGroupKey(groupId);
    const correo = normalizeEmailKey(email);
    return Math.round((await readAll(SHEETS.avales))
      .filter((r) => normalizeGroupKey(r[1]) === gid
        && normalizeEmailKey(r[3]) === correo
        && (r[5] || '').toString().trim().toLowerCase() === 'aprobado')
      .reduce((a, r) => a + Math.max(0, num(r[4])), 0) * 100) / 100;
  }

  /** Lo que le queda libre a una socia para poder avalar a otra. */
  async function cupoLibreDe(groupId, email) {
    const reglas = await getReglas(groupId);
    const ahorro = await ahorroConfirmado(email, groupId);
    const comprometido = await loQueAvala(groupId, email);
    const activos = await contarPrestamosActivos(email, groupId);
    const bruto = Math.round(ahorro * reglas.topePrestamoFactorAhorro * 100) / 100;
    return Math.max(0, Math.round(
      (bruto - comprometido - (activos.saldoTotal || 0)) * 100) / 100);
  }

  app.get('/api/gob/avales', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!groupId) return res.status(400).json({ success: false, message: 'Falta groupId.' });
      if (!(await assertGroupMember(req, res, groupId))) return;
      const filas = (await readAll(SHEETS.avales))
        .filter((r) => normalizeGroupKey(r[1]) === groupId);
      res.json({
        success: true,
        avales: filas.map((r) => ({
          avalId: r[0], email: normalizeEmailKey(r[2]), avalEmail: normalizeEmailKey(r[3]),
          cupo: Math.max(0, num(r[4])), estado: (r[5] || '').toString().toLowerCase(),
          acuerdoId: r[7] || '', creadoEn: r[9] || '', motivo: r[12] || '',
        })).sort((a, b) => String(b.creadoEn).localeCompare(String(a.creadoEn))),
      });
    } catch (e) {
      console.error('[GOB avales]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al leer los avales.' });
    }
  });

  /** Lleva un aval a la asamblea. */
  app.post('/api/gob/aval/proponer', bloquear((r) => `aval:${normalizeGroupKey(r.body && r.body.groupId)}`), async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.body?.groupId);
      const rol = await requireLider(req, res, groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;

      const email = normalizeEmailKey(req.body?.email);
      const avalEmail = normalizeEmailKey(req.body?.avalEmail);
      const cupo = Math.round(num(req.body?.cupo) * 100) / 100;
      const motivo = (req.body?.motivo || '').toString().trim();

      if (!email || !avalEmail) {
        return res.status(400).json({ success: false, message: 'Falta decir a quien se avala y quien avala.' });
      }
      if (email === avalEmail) {
        return res.status(400).json({
          success: false, motivo: 'se_avala_sola',
          message: 'Nadie se avala a si misma: el aval es la firma de OTRA socia.',
        });
      }
      if (!(cupo > 0)) {
        return res.status(400).json({ success: false, message: 'Di de cuanto es el aval.' });
      }
      if (motivo.length < 10) {
        return res.status(400).json({
          success: false, motivo: 'falta_motivo',
          message: 'Escribe por que se avala: es lo que va a leer la asamblea antes de votar.',
        });
      }
      if (!(await getUserGroupRole(email, groupId))) {
        return res.status(404).json({ success: false, message: 'Quien recibe el aval no es socia del grupo.' });
      }
      if (!(await getUserGroupRole(avalEmail, groupId))) {
        return res.status(404).json({ success: false, message: 'Quien avala no es socia del grupo.' });
      }

      // Avalar con lo que no se tiene es una firma sin respaldo.
      const libre = await cupoLibreDe(groupId, avalEmail);
      if (cupo > libre + 0.005) {
        return res.status(409).json({
          success: false,
          motivo: 'aval_sin_respaldo',
          cupoLibre: libre,
          message: `${avalEmail} solo tiene $${libre.toFixed(2)} de cupo libre, asi que no puede `
            + `avalar $${cupo.toFixed(2)}. Un aval sin respaldo es una firma que no vale nada el `
            + 'dia que haya que cobrarla.',
        });
      }

      const asamblea = await getAsamblea((req.body?.asambleaId || '').toString().trim());
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      if (normalizeGroupKey(asamblea.groupId) !== groupId) {
        return res.status(403).json({ success: false, message: 'Esa asamblea es de otro grupo.' });
      }
      if (!['programada', 'abierta'].includes(asamblea.estado)) {
        return res.status(409).json({ success: false, message: 'La asamblea ya no admite nuevos puntos.' });
      }

      const avalId = newId('aval');
      const acuerdoId = newId('acu');
      await appendRow(SHEETS.acuerdos, [
        acuerdoId, asamblea.asambleaId, groupId, 'aval',
        sanitizeCell(`Aval de ${avalEmail} para que ${email} pueda pedir hasta `
          + `$${cupo.toFixed(2)}`, 200),
        sanitizeCell(`${motivo}\n\nSi se aprueba, ${email} suma $${cupo.toFixed(2)} a su cupo, y `
          + `${avalEmail} pierde esa misma cantidad del suyo mientras el aval siga vivo. `
          + `Hoy ${avalEmail} tiene $${libre.toFixed(2)} de cupo libre.`, 2000),
        JSON.stringify({ avalId, email, avalEmail, cupo }),
        'abierto', req.user.email, nowIso(), '', '', 0, 0, 0,
      ]);
      await appendRow(SHEETS.avales, [
        avalId, groupId, email, avalEmail, cupo, 'propuesto',
        asamblea.asambleaId, acuerdoId, req.user.email, nowIso(), '', '',
        sanitizeCell(motivo, 300),
      ]);
      await logGob(groupId, req.user.email, 'aval_propuesto', avalId,
        `${avalEmail} avala ${cupo} a ${email}`);

      res.status(201).json({ success: true, avalId, acuerdoId, cupoLibreDelAval: libre });
    } catch (e) {
      console.error('[GOB aval proponer]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al someter el aval.' });
    }
  });

  /** Activa el aval que la asamblea aprobo. */
  app.post('/api/gob/aval/:id/aplicar', bloquear((r) => `aval:${r.params.id}`), async (req, res) => {
    try {
      const aval = await getAval(req.params.id);
      if (!aval) return res.status(404).json({ success: false, message: 'Aval no encontrado.' });
      const rol = await requireLider(req, res, aval.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      if (aval.estado !== 'propuesto') {
        return res.status(409).json({ success: false, message: `Este aval ya esta "${aval.estado}".` });
      }
      const chk = await acuerdoAprobadoValido(aval.groupId, aval.acuerdoId, 'aval');
      if (!chk.valido) {
        return res.status(409).json({
          success: false,
          message: 'El aval solo vale con el acuerdo de asamblea aprobado.',
          detalle: chk.motivo,
        });
      }

      const fila = aval._row.slice();
      while (fila.length < SHEETS.avales.headers.length) fila.push('');
      fila[5] = 'aprobado';
      fila[10] = req.user.email;
      fila[11] = nowIso();
      await updateRow(SHEETS.avales, aval._index, fila);
      await marcarAcuerdoEjecutado(aval.acuerdoId);
      await logGob(aval.groupId, req.user.email, 'aval_aprobado', aval.avalId, `${aval.cupo}`);

      res.json({
        success: true,
        estado: 'aprobado',
        message: `${aval.email} suma $${aval.cupo.toFixed(2)} a su cupo. Mientras el aval siga `
          + `vivo, ${aval.avalEmail} tiene esa misma cantidad menos del suyo.`,
      });
    } catch (e) {
      console.error('[GOB aval aplicar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al aplicar el aval.' });
    }
  });

  /** Libera el aval: la avalada no debe nada y quien avalo recupera su cupo. */
  app.post('/api/gob/aval/:id/liberar', bloquear((r) => `aval:${r.params.id}`), async (req, res) => {
    try {
      const aval = await getAval(req.params.id);
      if (!aval) return res.status(404).json({ success: false, message: 'Aval no encontrado.' });
      const rol = await requireLider(req, res, aval.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      if (aval.estado !== 'aprobado') {
        return res.status(409).json({ success: false, message: `Este aval esta "${aval.estado}".` });
      }

      // No se libera a quien todavia debe: es justo cuando el aval sirve.
      const activos = await contarPrestamosActivos(aval.email, aval.groupId);
      if (activos.cantidad > 0) {
        return res.status(409).json({
          success: false,
          motivo: 'todavia_debe',
          saldo: activos.saldoTotal,
          message: `${aval.email} todavia debe $${Number(activos.saldoTotal || 0).toFixed(2)}. `
            + 'El aval se libera cuando termine de pagar: hasta entonces es lo que respalda '
            + 'ese prestamo.',
        });
      }

      const fila = aval._row.slice();
      while (fila.length < SHEETS.avales.headers.length) fila.push('');
      fila[5] = 'liberado';
      fila[10] = req.user.email;
      fila[11] = nowIso();
      await updateRow(SHEETS.avales, aval._index, fila);
      await logGob(aval.groupId, req.user.email, 'aval_liberado', aval.avalId, '');

      res.json({
        success: true,
        estado: 'liberado',
        message: `${aval.avalEmail} recupera los $${aval.cupo.toFixed(2)} de su cupo.`,
      });
    } catch (e) {
      console.error('[GOB aval liberar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al liberar el aval.' });
    }
  });

  // =========================================================================
  //  CERRAR EL GRUPO REPARTIENDOLO TODO
  //
  //  Un banco comunal se arma por un ciclo y al final se liquida: cada una se
  //  lleva su ahorro, sus acciones y las utilidades que le tocan. Lo unico que
  //  habia era el borrado del administrador de la plataforma, que no reparte
  //  nada y ademas borra el historial.
  // =========================================================================

  async function getCierreGrupo(cierreId) {
    const id = (cierreId || '').toString().trim();
    if (!id) return null;
    const filas = await readAll(SHEETS.cierreGrupo);
    const i = filas.findIndex((r) => (r[0] || '').toString().trim() === id);
    if (i < 0) return null;
    const r = filas[i];
    return {
      cierreId: r[0], groupId: normalizeGroupKey(r[1]),
      estado: (r[2] || 'borrador').toString().trim().toLowerCase(),
      creadoPor: r[3], creadoEn: r[4], asambleaId: r[5], acuerdoId: r[6],
      aplicadoEn: r[7], aplicadoPor: r[8],
      socias: num(r[9]), totalDevuelto: num(r[10]),
      detalle: (() => { try { return JSON.parse(r[11] || '[]'); } catch (e) { return []; } })(),
      nota: r[12] || '',
      _index: i, _row: r,
    };
  }

  /** Lo que impide cerrar el grupo ahora mismo, dicho con nombre y cifra. */
  async function loQueFaltaParaCerrar(groupId) {
    const gid = normalizeGroupKey(groupId);
    const problemas = [];

    const sheetsClient = await getSheetsClient();
    const [loansResp, paysResp] = await Promise.all([
      sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'Loans!A2:K',
      }),
      sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O',
      }),
    ]);
    const vivos = prestamosDelGrupo(loansResp.data.values || [], paysResp.data.values || [], gid)
      .filter((x) => x.pagado < x.total - 0.005)
      .filter((x) => {
        const fila = (loansResp.data.values || [])
          .find((r) => (r[0] || '').toString().trim() === x.loanId) || [];
        return ['aprobado', 'approved', 'activo']
          .includes((fila[7] || '').toString().trim().toLowerCase());
      });
    if (vivos.length > 0) {
      problemas.push({
        motivo: 'prestamos_vivos',
        cuantos: vivos.length,
        importe: Math.round(vivos.reduce((a, x) => a + (x.total - x.pagado), 0) * 100) / 100,
        quienes: vivos.map((x) => x.userEmail),
        texto: `Hay ${vivos.length} prestamo(s) sin terminar de pagar, por `
          + `$${(Math.round(vivos.reduce((a, x) => a + (x.total - x.pagado), 0) * 100) / 100).toFixed(2)}. `
          + 'Ese dinero esta fuera de la caja: hasta que vuelva, o la asamblea lo condone, '
          + 'no se puede repartir lo que no esta.',
      });
    }

    const salidasAbiertas = (await readAll(SHEETS.salidas))
      .filter((r) => normalizeGroupKey(r[1]) === gid
        && ['solicitada', 'calculada', 'propuesta']
          .includes((r[3] || '').toString().trim().toLowerCase()));
    if (salidasAbiertas.length > 0) {
      problemas.push({
        motivo: 'salidas_abiertas',
        cuantos: salidasAbiertas.length,
        quienes: salidasAbiertas.map((r) => normalizeEmailKey(r[2])),
        texto: `Hay ${salidasAbiertas.length} salida(s) a medias. Terminalas o descartalas: `
          + 'si no, la misma socia cobraria dos veces.',
      });
    }

    const cierresAbiertos = (await readAll(SHEETS.cierres))
      .filter((r) => normalizeGroupKey(r[1]) === gid
        && ['borrador', 'propuesto'].includes((r[2] || '').toString().trim().toLowerCase()));
    if (cierresAbiertos.length > 0) {
      problemas.push({
        motivo: 'reparto_abierto',
        cuantos: cierresAbiertos.length,
        texto: 'Hay un reparto de utilidades sin terminar. Aplicalo o descartalo antes de '
          + 'cerrar el grupo: el cierre ya reparte lo que queda.',
      });
    }

    return problemas;
  }

  /** Como esta el cierre del grupo, si es que hay alguno. */
  app.get('/api/gob/grupo/cierre', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!groupId) return res.status(400).json({ success: false, message: 'Falta groupId.' });
      // El cierre es de todas: cualquier socia puede ver como va.
      if (!(await assertGroupMember(req, res, groupId))) return;

      const filas = (await readAll(SHEETS.cierreGrupo))
        .filter((r) => normalizeGroupKey(r[1]) === groupId);
      const abierto = filas.find((r) => ['borrador', 'propuesto']
        .includes((r[2] || '').toString().trim().toLowerCase()));
      const aplicado = filas.find((r) => (r[2] || '').toString().trim().toLowerCase() === 'aplicado');

      const conDetalle = async (fila) => (fila ? getCierreGrupo(fila[0]) : null);
      res.json({
        success: true,
        abierto: await conDetalle(abierto),
        aplicado: await conDetalle(aplicado),
        bloqueos: aplicado ? [] : await loQueFaltaParaCerrar(groupId),
      });
    } catch (e) {
      console.error('[GOB cierre grupo estado]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al leer el cierre del grupo.' });
    }
  });

  /** Calcula y CONGELA lo que le toca a cada socia si el grupo se cierra. */
  app.post('/api/gob/grupo/cierre/calcular', bloquear((r) => `cierregrupo:${normalizeGroupKey(r.body && r.body.groupId)}`), async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.body?.groupId);

      // Primero: si ya se cerro, se dice. Al cerrar, todos los vinculos quedan
      // 'retirada', asi que la comprobacion de cargo respondia "accion reservada
      // a presidente" y no habia forma de entender que el grupo ya no existe.
      const yaHay = (await readAll(SHEETS.cierreGrupo))
        .filter((r) => normalizeGroupKey(r[1]) === groupId);
      if (yaHay.some((r) => (r[2] || '').toString().trim().toLowerCase() === 'aplicado')) {
        return res.status(409).json({
          success: false, motivo: 'ya_cerrado',
          message: 'Este grupo ya se cerro y se repartio.',
        });
      }

      // Disolver el grupo es la decision mas grande que se puede tomar: la
      // propone la presidencia, no la tesoreria.
      const rol = await requireLider(req, res, groupId, new Set(['presidente']));
      if (!rol) return;
      const abierto = yaHay.find((r) => ['borrador', 'propuesto']
        .includes((r[2] || '').toString().trim().toLowerCase()));
      if (abierto) {
        return res.status(409).json({
          success: false, motivo: 'ya_calculado',
          cierreId: abierto[0],
          message: `Ya hay un cierre "${(abierto[2] || '').toLowerCase()}" en marcha. `
            + 'Sometelo a la asamblea, aplicalo o descartalo.',
        });
      }

      const bloqueos = await loQueFaltaParaCerrar(groupId);
      if (bloqueos.length > 0) {
        return res.status(409).json({
          success: false, motivo: 'faltan_cosas', bloqueos,
          message: bloqueos.map((b) => b.texto).join(' '),
        });
      }

      const socias = await miembrosActivos(groupId);
      if (socias.length === 0) {
        return res.status(409).json({
          success: false,
          message: 'Este grupo no tiene socias activas: no hay nada que repartir.',
        });
      }

      // Lo de cada una, con la MISMA cuenta que la salida individual.
      const detalle = [];
      for (const m of socias) {
        const liq = await calcularLiquidacion(groupId, m.email);
        detalle.push({
          email: m.email,
          ahorro: liq.ahorro,
          accionesValor: liq.accionesValor,
          accionesUnidades: liq.accionesUnidades,
          valores: liq.valores,
          utilidades: liq.utilidades,
          total: liq.total,
        });
      }
      const totalDevuelto = Math.round(
        detalle.reduce((a, x) => a + x.total, 0) * 100) / 100;

      const cierreId = newId('cgr');
      await appendRow(SHEETS.cierreGrupo, [
        cierreId, groupId, 'borrador', req.user.email, nowIso(), '', '', '', '',
        detalle.length, totalDevuelto, JSON.stringify(detalle),
        sanitizeCell(req.body?.nota || '', 200),
      ]);
      await logGob(groupId, req.user.email, 'cierre_grupo_calculado', cierreId,
        `${detalle.length} socias, ${totalDevuelto}`);

      res.status(201).json({
        success: true, cierreId, estado: 'borrador',
        socias: detalle.length, totalDevuelto, detalle,
        message: `Calculado: ${detalle.length} socias y $${totalDevuelto.toFixed(2)} a devolver. `
          + 'Nada se ha movido todavia: hay que llevarlo a la asamblea.',
      });
    } catch (e) {
      console.error('[GOB cierre grupo calcular]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al calcular el cierre del grupo.' });
    }
  });

  /** Lleva el cierre a una asamblea. */
  app.post('/api/gob/grupo/cierre/:id/proponer', bloquear((r) => `cierregrupo:${r.params.id}`), async (req, res) => {
    try {
      const cierre = await getCierreGrupo(req.params.id);
      if (!cierre) return res.status(404).json({ success: false, message: 'Cierre no encontrado.' });
      const rol = await requireLider(req, res, cierre.groupId, new Set(['presidente']));
      if (!rol) return;
      if (cierre.estado !== 'borrador') {
        return res.status(409).json({ success: false, message: `El cierre ya esta "${cierre.estado}".` });
      }

      const asamblea = await getAsamblea((req.body?.asambleaId || '').toString().trim());
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      if (normalizeGroupKey(asamblea.groupId) !== cierre.groupId) {
        return res.status(403).json({ success: false, message: 'Esa asamblea es de otro grupo.' });
      }
      if (!['programada', 'abierta'].includes(asamblea.estado)) {
        return res.status(409).json({ success: false, message: 'La asamblea ya no admite nuevos puntos.' });
      }

      const acuerdoId = newId('acu');
      await appendRow(SHEETS.acuerdos, [
        acuerdoId, asamblea.asambleaId, cierre.groupId, 'cierre_grupo',
        sanitizeCell(`Cerrar el grupo y repartir $${cierre.totalDevuelto.toFixed(2)} `
          + `entre ${cierre.socias} socias`, 200),
        sanitizeCell('Se devuelve a cada socia su ahorro, sus acciones y las utilidades que le '
          + 'tocan, y el grupo deja de operar. No se borra nada: el historial se conserva '
          + 'entero. Es la decision mas grande que puede tomar el grupo, y no tiene vuelta '
          + 'atras una vez pagada.', 2000),
        JSON.stringify({ cierreId: cierre.cierreId, total: cierre.totalDevuelto }),
        'abierto', req.user.email, nowIso(), '', '', 0, 0, 0,
      ]);

      const row = cierre._row.slice();
      while (row.length < SHEETS.cierreGrupo.headers.length) row.push('');
      row[2] = 'propuesto'; row[5] = asamblea.asambleaId; row[6] = acuerdoId;
      await updateRow(SHEETS.cierreGrupo, cierre._index, row);
      await logGob(cierre.groupId, req.user.email, 'cierre_grupo_propuesto', cierre.cierreId, acuerdoId);

      res.json({ success: true, acuerdoId, asambleaId: asamblea.asambleaId, estado: 'propuesto' });
    } catch (e) {
      console.error('[GOB cierre grupo proponer]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al someter el cierre.' });
    }
  });

  /** Paga a todas y cierra el grupo. Solo con el acuerdo aprobado. */
  app.post('/api/gob/grupo/cierre/:id/aplicar', bloquear((r) => `cierregrupo:${r.params.id}`), async (req, res) => {
    try {
      const cierre = await getCierreGrupo(req.params.id);
      if (!cierre) return res.status(404).json({ success: false, message: 'Cierre no encontrado.' });
      // Igual que arriba: si ya se pago, se dice eso y no "no eres presidenta",
      // que es lo que sale cuando el propio cierre retiro todos los vinculos.
      if (cierre.estado === 'aplicado') {
        return res.status(409).json({ success: false, message: 'Este grupo ya se cerro.' });
      }
      const rol = await requireLider(req, res, cierre.groupId, new Set(['presidente']));
      if (!rol) return;
      if (cierre.estado !== 'propuesto') {
        return res.status(409).json({ success: false, message: 'Primero somete el cierre a una asamblea.' });
      }
      const chk = await acuerdoAprobadoValido(cierre.groupId, cierre.acuerdoId, 'cierre_grupo');
      if (!chk.valido) {
        return res.status(409).json({
          success: false,
          message: 'El grupo solo se cierra con el acuerdo de asamblea aprobado.',
          detalle: chk.motivo,
        });
      }

      // Entre la votacion y el pago pudo entrar un aporte o aprobarse un
      // comprobante: se paga lo que se voto, o no se paga.
      const ahora = [];
      for (const x of cierre.detalle) {
        ahora.push(await calcularLiquidacion(cierre.groupId, x.email));
      }
      const cambiadas = cierre.detalle.filter((x, i) => ['ahorro', 'accionesValor', 'utilidades']
        .some((k) => Math.abs(Number(ahora[i][k]) - Number(x[k])) > 0.005));
      if (cambiadas.length > 0) {
        return res.status(409).json({
          success: false,
          motivo: 'cuentas_cambiadas',
          quienes: cambiadas.map((x) => x.email),
          message: `Las cuentas de ${cambiadas.length} socia(s) cambiaron desde la votacion. `
            + 'Vuelve a calcular el cierre y sometelo otra vez, para que se pague lo que la '
            + 'asamblea aprueba.',
        });
      }

      // Cada socia se paga como una salida: mismas filas, mismos identificadores
      // y el mismo descuento en el reparto siguiente.
      const fecha = nowIso();
      const pagadas = [];
      for (const x of cierre.detalle) {
        const salidaId = `${cierre.cierreId}_${x.email.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
        await appendRow(SHEETS.salidas, [
          salidaId, cierre.groupId, x.email, 'aplicada', fecha, fecha, req.user.email,
          cierre.asambleaId, cierre.acuerdoId, fecha, mesActualDelReparto(),
          x.ahorro, x.accionesValor, x.accionesUnidades, x.utilidades, x.total,
          JSON.stringify(x.valores || []),
          `Cierre del grupo ${cierre.cierreId}`,
        ]);
        const escrito = await escribirLiquidacion({
          salidaId,
          groupId: cierre.groupId,
          email: x.email,
          ahorro: x.ahorro,
          utilidades: x.utilidades,
          valores: x.valores,
        }, req.user.email);
        pagadas.push({ email: x.email, total: x.total, yaEstaba: escrito.yaEstaba });
      }

      // El grupo deja de operar. No se borra: el historial es la prueba de todo
      // lo que paso, y en un proyecto de investigacion es lo que hay que guardar.
      await marcarGrupoCerrado(cierre.groupId, req.user.email);

      const row = cierre._row.slice();
      while (row.length < SHEETS.cierreGrupo.headers.length) row.push('');
      row[2] = 'aplicado'; row[7] = fecha; row[8] = req.user.email;
      await updateRow(SHEETS.cierreGrupo, cierre._index, row);
      await marcarAcuerdoEjecutado(cierre.acuerdoId);
      await logGob(cierre.groupId, req.user.email, 'cierre_grupo_aplicado', cierre.cierreId,
        `${pagadas.length} socias, ${cierre.totalDevuelto}`);

      res.json({
        success: true,
        estado: 'aplicado',
        socias: pagadas.length,
        totalDevuelto: cierre.totalDevuelto,
        pagadas,
        message: `El grupo queda cerrado. Se devolvieron $${cierre.totalDevuelto.toFixed(2)} `
          + `entre ${pagadas.length} socias. El historial se conserva entero: se puede seguir `
          + 'consultando todo lo que paso.',
      });
    } catch (e) {
      console.error('[GOB cierre grupo aplicar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al cerrar el grupo.' });
    }
  });

  /** Descarta un cierre que todavia no se pago. */
  app.post('/api/gob/grupo/cierre/:id/descartar', bloquear((r) => `cierregrupo:${r.params.id}`), async (req, res) => {
    try {
      const cierre = await getCierreGrupo(req.params.id);
      if (!cierre) return res.status(404).json({ success: false, message: 'Cierre no encontrado.' });
      const rol = await requireLider(req, res, cierre.groupId, new Set(['presidente']));
      if (!rol) return;
      if (cierre.estado === 'aplicado') {
        return res.status(409).json({
          success: false,
          message: 'El grupo ya se cerro y se pago: eso no se deshace desde aqui.',
        });
      }
      const row = cierre._row.slice();
      while (row.length < SHEETS.cierreGrupo.headers.length) row.push('');
      row[2] = 'descartado';
      await updateRow(SHEETS.cierreGrupo, cierre._index, row);
      await logGob(cierre.groupId, req.user.email, 'cierre_grupo_descartado', cierre.cierreId, '');
      res.json({ success: true, estado: 'descartado' });
    } catch (e) {
      console.error('[GOB cierre grupo descartar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al descartar el cierre.' });
    }
  });

  /** Marca el grupo como cerrado en la hoja Groups (columna L = Status). */
  async function marcarGrupoCerrado(groupId, actor) {
    const gid = normalizeGroupKey(groupId);
    const sheetsClient = await getSheetsClient();
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: 'Groups!A2:R',
    });
    const filas = resp.data.values || [];
    const i = filas.findIndex((r) => normalizeGroupKey(r[0]) === gid);
    if (i < 0) return false;
    await actualizarFilaPorClave(sheetsClient, {
      spreadsheetId: SPREADSHEET_ID,
      hoja: 'Groups',
      ultimaColumna: 'L',
      desdeColumna: 'L',
      indice: i,
      claveCol: 0,
      clave: gid,
      valueInputOption: 'USER_ENTERED',
      construir: () => ['cerrado'],
    });
    await logGob(gid, actor, 'grupo_cerrado', gid, '');
    return true;
  }

  // =========================================================================
  //  GASTOS Y MULTAS
  //
  //  El acuerdo existia y no movia un centavo: se aprobaba un gasto de $35 y el
  //  patrimonio seguia igual. Aqui el acuerdo aprobado SI se aplica.
  // =========================================================================

  const TIPOS_CAJA = new Set(['gasto', 'multa']);

  async function getMovCaja(movId) {
    const id = (movId || '').toString().trim();
    if (!id) return null;
    const filas = await readAll(SHEETS.caja);
    const i = filas.findIndex((r) => (r[0] || '').toString().trim() === id);
    if (i < 0) return null;
    const r = filas[i];
    return {
      movId: id,
      groupId: normalizeGroupKey(r[1]),
      tipo: (r[2] || '').toString().trim().toLowerCase(),
      email: normalizeEmailKey(r[3]),
      concepto: r[4] || '',
      importe: num(r[5]),
      estado: (r[6] || 'propuesto').toString().trim().toLowerCase(),
      asambleaId: r[7] || '', acuerdoId: r[8] || '',
      creadoPor: r[9] || '', creadoEn: r[10] || '',
      resueltoPor: r[11] || '', resueltoEn: r[12] || '', nota: r[13] || '',
      _index: i, _row: r,
    };
  }

  /** Lo que el grupo ya gasto y lo que ya cobro en multas, aplicado de verdad. */
  async function cajaDelGrupo(groupId) {
    const gid = normalizeGroupKey(groupId);
    const filas = (await readAll(SHEETS.caja)).filter((r) => normalizeGroupKey(r[1]) === gid);
    const cent = (x) => Math.round(x * 100) / 100;
    const suma = (tipo, estados) => cent(filas
      .filter((r) => (r[2] || '').toString().trim().toLowerCase() === tipo
        && estados.includes((r[6] || '').toString().trim().toLowerCase()))
      .reduce((a, r) => a + Math.max(0, num(r[5])), 0));
    return {
      // Un gasto aprobado y aplicado ya salio de la caja.
      gastos: suma('gasto', ['aplicado']),
      // Una multa solo suma cuando la socia la paga de verdad.
      multasCobradas: suma('multa', ['cobrada']),
      multasPendientes: suma('multa', ['aplicado']),
      filas,
    };
  }

  /** Multas que una socia debe y todavia no ha pagado. */
  async function multasPendientesDe(groupId, email) {
    const gid = normalizeGroupKey(groupId);
    const correo = normalizeEmailKey(email);
    return (await readAll(SHEETS.caja))
      .filter((r) => normalizeGroupKey(r[1]) === gid
        && (r[2] || '').toString().trim().toLowerCase() === 'multa'
        && normalizeEmailKey(r[3]) === correo
        && (r[6] || '').toString().trim().toLowerCase() === 'aplicado')
      .map((r) => ({
        movId: r[0], concepto: r[4] || '',
        importe: Math.max(0, num(r[5])), desde: r[12] || r[10] || '',
      }));
  }

  app.get('/api/gob/caja', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!groupId) return res.status(400).json({ success: false, message: 'Falta groupId.' });
      // Lo que el grupo gasta es de todas: cualquier socia puede mirarlo.
      if (!(await assertGroupMember(req, res, groupId))) return;
      const caja = await cajaDelGrupo(groupId);
      res.json({
        success: true,
        resumen: {
          gastos: caja.gastos,
          multasCobradas: caja.multasCobradas,
          multasPendientes: caja.multasPendientes,
        },
        movimientos: caja.filas.map((r) => ({
          movId: r[0], tipo: r[2], email: r[3], concepto: r[4], importe: num(r[5]),
          estado: (r[6] || 'propuesto').toString().toLowerCase(),
          acuerdoId: r[8] || '', creadoPor: r[9] || '', creadoEn: r[10] || '',
          resueltoEn: r[12] || '',
        })).sort((a, b) => String(b.creadoEn).localeCompare(String(a.creadoEn))),
      });
    } catch (e) {
      console.error('[GOB caja]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al leer los gastos del grupo.' });
    }
  });

  /** Propone un gasto o una multa a la asamblea. */
  app.post('/api/gob/caja/proponer', bloquear((r) => `caja:${normalizeGroupKey(r.body && r.body.groupId)}`), async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.body?.groupId);
      const rol = await requireLider(req, res, groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;

      const tipo = (req.body?.tipo || '').toString().trim().toLowerCase();
      if (!TIPOS_CAJA.has(tipo)) {
        return res.status(400).json({ success: false, message: 'Tipo invalido: gasto o multa.' });
      }
      const importe = Math.round(num(req.body?.importe) * 100) / 100;
      if (!(importe > 0)) {
        return res.status(400).json({ success: false, message: 'El importe tiene que ser mayor que cero.' });
      }
      const concepto = (req.body?.concepto || '').toString().trim();
      if (concepto.length < 5) {
        return res.status(400).json({
          success: false,
          motivo: 'falta_concepto',
          message: 'Escribe en que se gasta o por que es la multa: es lo que va a leer la '
            + 'asamblea y lo que queda en el acta.',
        });
      }

      let correo = '';
      if (tipo === 'multa') {
        correo = normalizeEmailKey(req.body?.email);
        if (!correo) {
          return res.status(400).json({ success: false, message: 'Di a quien se le pone la multa.' });
        }
        const suRol = await getUserGroupRole(correo, groupId);
        if (!suRol) {
          return res.status(404).json({ success: false, message: 'Esa persona no es socia del grupo.' });
        }
      }

      const asamblea = await getAsamblea((req.body?.asambleaId || '').toString().trim());
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      if (normalizeGroupKey(asamblea.groupId) !== groupId) {
        return res.status(403).json({ success: false, message: 'Esa asamblea es de otro grupo.' });
      }
      if (!['programada', 'abierta'].includes(asamblea.estado)) {
        return res.status(409).json({ success: false, message: 'La asamblea ya no admite nuevos puntos.' });
      }

      const movId = newId('caja');
      const acuerdoId = newId('acu');
      await appendRow(SHEETS.acuerdos, [
        acuerdoId, asamblea.asambleaId, groupId, tipo === 'gasto' ? 'gasto' : 'sancion',
        sanitizeCell(tipo === 'gasto'
          ? `Gasto del grupo: ${concepto} ($${importe.toFixed(2)})`
          : `Multa a ${correo}: ${concepto} ($${importe.toFixed(2)})`, 200),
        sanitizeCell(tipo === 'gasto'
          ? `Sale de lo que el grupo ha ganado, antes de repartir: si se aprueba, hay `
            + `$${importe.toFixed(2)} menos que repartir entre todas.`
          : `Si se aprueba, ${correo} debera $${importe.toFixed(2)} al grupo. Le aparecera en `
            + 'lo que tiene que llevar a la reunion, y cuando la pague entrara a la caja y se '
            + 'repartira entre todas.', 2000),
        JSON.stringify({ movId, tipo, importe, email: correo }),
        'abierto', req.user.email, nowIso(), '', '', 0, 0, 0,
      ]);
      await appendRow(SHEETS.caja, [
        movId, groupId, tipo, correo, sanitizeCell(concepto, 200), importe, 'propuesto',
        asamblea.asambleaId, acuerdoId, req.user.email, nowIso(), '', '',
        sanitizeCell(req.body?.nota || '', 200),
      ]);
      await logGob(groupId, req.user.email, 'caja_propuesta', movId, `${tipo} ${importe}`);

      res.status(201).json({ success: true, movId, acuerdoId, asambleaId: asamblea.asambleaId });
    } catch (e) {
      console.error('[GOB caja proponer]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al someter el movimiento.' });
    }
  });

  /** Aplica el gasto o la multa que la asamblea aprobo. */
  app.post('/api/gob/caja/:movId/aplicar', bloquear((r) => `caja:${r.params.movId}`), async (req, res) => {
    try {
      const mov = await getMovCaja(req.params.movId);
      if (!mov) return res.status(404).json({ success: false, message: 'Movimiento no encontrado.' });
      const rol = await requireLider(req, res, mov.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      if (mov.estado !== 'propuesto') {
        return res.status(409).json({ success: false, message: `Este movimiento ya esta "${mov.estado}".` });
      }
      const chk = await acuerdoAprobadoValido(mov.groupId, mov.acuerdoId,
        mov.tipo === 'gasto' ? 'gasto' : 'sancion');
      if (!chk.valido) {
        return res.status(409).json({
          success: false,
          message: 'Esto solo se aplica con el acuerdo de asamblea aprobado.',
          detalle: chk.motivo,
        });
      }

      const fila = mov._row.slice();
      while (fila.length < SHEETS.caja.headers.length) fila.push('');
      fila[6] = 'aplicado';
      fila[11] = req.user.email;
      fila[12] = nowIso();
      await updateRow(SHEETS.caja, mov._index, fila);
      await marcarAcuerdoEjecutado(mov.acuerdoId);
      await logGob(mov.groupId, req.user.email, 'caja_aplicada', mov.movId,
        `${mov.tipo} ${mov.importe}`);

      res.json({
        success: true,
        estado: 'aplicado',
        message: mov.tipo === 'gasto'
          ? `El gasto de $${mov.importe.toFixed(2)} sale de lo que el grupo ha ganado: hay esa `
            + 'cantidad menos que repartir.'
          : `${mov.email} debe $${mov.importe.toFixed(2)} al grupo. Le aparecera en lo que tiene `
            + 'que llevar a la reunion; cuando la pague, entrara a la caja.',
      });
    } catch (e) {
      console.error('[GOB caja aplicar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al aplicar el movimiento.' });
    }
  });

  /**
   * RETIRAR UNA PROPUESTA QUE SE LLEVO A LA ASAMBLEA POR ERROR.
   *
   * Falta medida, no supuesta. Una presidenta que propone el lote de saldos con
   * 9999 en vez de 99 y se da cuenta ANTES de que nadie vote no tenia salida:
   *
   *   POST /api/gob/acuerdos/<id>/anular          -> 409 "lote_colgando"
   *   POST /api/gob/apertura/lote/<id>/descartar  -> 404 (no existia)
   *   POST /api/gob/apertura/lote/<id>/proponer   -> 409 'El lote ya esta "propuesto"'
   *   POST /api/gob/apertura/lote/<id>/aplicar    -> 409 (el acuerdo no esta aprobado)
   *
   * Las cuatro puertas cerradas a la vez. Para salir habia que hacer que la
   * asamblea VOTARA EN CONTRA de una cifra que nadie defendia -- dejando en el
   * acta un rechazo que nunca ocurrio -- o editar la hoja a mano.
   *
   * En caja y en aval no habia atasco pero si un fantasma: anular el punto
   * funcionaba y el movimiento se quedaba 'propuesto' para siempre en la
   * pantalla del grupo, sosteniendo un gasto que ya nadie iba a aplicar.
   *
   * En prestamo no hay nada que retirar: `proponer` no escribe fila, solo el
   * punto de asamblea, y anularlo lo resuelve entero (comprobado).
   *
   * LA REGLA, UNA SOLA PARA TODO: retirar el punto retira lo que colgaba de el,
   * mientras nadie haya votado y nada se haya ejecutado. Si ya hay votos, la
   * propuesta se retira pero EL PUNTO SE QUEDA: es una deliberacion de verdad y
   * el acta no se maquilla. Y si el dinero ya se movio, no se retira nada: para
   * eso estan revertir el aporte, liberar el aval o el punto que revoca al
   * anterior.
   */
  async function retirarPuntoSiNadieVoto(acuerdoId, actor, motivo) {
    const id = (acuerdoId || '').toString().trim();
    if (!id) return { retirado: false, motivo: 'sin_punto' };
    const ac = await getAcuerdo(id);
    if (!ac) return { retirado: false, motivo: 'sin_punto' };
    if (!['abierto', 'sin_resolver'].includes(ac.estado)) {
      return { retirado: false, motivo: 'ya_decidido', estado: ac.estado };
    }
    const votos = (await readAll(SHEETS.votos))
      .filter((v) => (v[0] || '').toString().trim() === ac.acuerdoId);
    if (votos.length > 0) return { retirado: false, motivo: 'ya_hay_votos', votos: votos.length };

    const row = ac._row.slice();
    while (row.length < SHEETS.acuerdos.headers.length) row.push('');
    row[5] = sanitizeCell(`[RETIRADO por ${actor}: ${motivo}]\n${ac.descripcion || ''}`, 2000);
    row[7] = 'anulado';
    row[10] = nowIso();
    await updateRow(SHEETS.acuerdos, ac._index, row);
    await logGob(ac.groupId, actor, 'acuerdo_anulado', ac.acuerdoId,
      `retirado junto con su propuesta | ${motivo}`);
    return { retirado: true };
  }

  /** El motivo es obligatorio: queda en el acta y en la bitacora del grupo. */
  function motivoDeRetiro(req, res, que) {
    const motivo = (req.body?.motivo || '').toString().trim();
    // Un solo caracter basta, igual que en anular: lo que importa es que quede
    // algo escrito en la bitacora y que las dos acciones se comporten igual.
    if (!motivo) {
      res.status(400).json({
        success: false,
        message: `Escribe por qué se retira ${que}. Queda en la bitácora del grupo.`,
      });
      return null;
    }
    return motivo;
  }

  /**
   * Retira el lote de saldos iniciales. Un lote YA APLICADO no se retira: los
   * saldos estan en la libreta de cada socia y quitarlos de aqui no los devuelve
   * (para corregir uno suelto esta la bandeja de aportes).
   */
  app.post('/api/gob/apertura/lote/:id/descartar', bloquear((r) => `lote:${r.params.id}`), async (req, res) => {
    try {
      const lote = await getLote(req.params.id);
      if (!lote) return res.status(404).json({ success: false, message: 'Lote no encontrado.' });
      const rol = await requireLider(req, res, lote.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      const motivo = motivoDeRetiro(req, res, 'este lote');
      if (!motivo) return;

      if (lote.estado === 'aplicado') {
        return res.status(409).json({
          success: false,
          motivo: 'ya_aplicado',
          message: 'Los saldos de este lote ya están cargados en la libreta de cada socia. '
            + 'Retirar el papel no los descarga. Si una cifra quedó mal, corrígela desde la '
            + 'bandeja de aportes del grupo.',
        });
      }
      if (lote.estado === 'descartado') {
        return res.status(409).json({ success: false, message: 'Este lote ya estaba retirado.' });
      }

      const punto = await retirarPuntoSiNadieVoto(lote.acuerdoId, req.user.email, motivo);

      const row = lote._row.slice();
      while (row.length < SHEETS.lotes.headers.length) row.push('');
      row[2] = 'descartado';
      row[12] = sanitizeCell(`[RETIRADO por ${req.user.email}: ${motivo}]`, 500);
      await updateRow(SHEETS.lotes, lote._index, row);

      await logGob(lote.groupId, req.user.email, 'lote_apertura_descartado', lote.loteId, motivo);
      res.json({
        success: true,
        estado: 'descartado',
        puntoRetirado: punto.retirado,
        message: punto.retirado
          ? 'Lote retirado, y el punto sale de la asamblea. Puedes armar otro con las cifras corregidas.'
          : (punto.motivo === 'ya_hay_votos'
            ? 'Lote retirado. El punto se queda en el acta porque ya había votos: la asamblea deliberó.'
            : 'Lote retirado. Puedes armar otro con las cifras corregidas.'),
      });
    } catch (e) {
      console.error('[GOB lote descartar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al retirar el lote.' });
    }
  });

  /**
   * Retira un gasto o una multa que se llevo a la asamblea por error. Uno ya
   * aplicado si movio dinero: para deshacerlo se propone el movimiento inverso.
   */
  app.post('/api/gob/caja/:movId/descartar', bloquear((r) => `caja:${r.params.movId}`), async (req, res) => {
    try {
      const mov = await getMovCaja(req.params.movId);
      if (!mov) return res.status(404).json({ success: false, message: 'Movimiento no encontrado.' });
      const rol = await requireLider(req, res, mov.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      const motivo = motivoDeRetiro(req, res, 'este movimiento');
      if (!motivo) return;

      if (mov.estado === 'aplicado') {
        return res.status(409).json({
          success: false,
          motivo: 'ya_aplicado',
          message: 'Este movimiento ya salió de la caja del grupo. Retirar el papel no devuelve '
            + 'el dinero: para deshacerlo, propone en asamblea el movimiento contrario.',
        });
      }
      if (mov.estado === 'descartado') {
        return res.status(409).json({ success: false, message: 'Este movimiento ya estaba retirado.' });
      }

      const punto = await retirarPuntoSiNadieVoto(mov.acuerdoId, req.user.email, motivo);

      const row = mov._row.slice();
      while (row.length < SHEETS.caja.headers.length) row.push('');
      row[6] = 'descartado';
      row[11] = req.user.email;
      row[12] = nowIso();
      row[13] = sanitizeCell(`[RETIRADO: ${motivo}]`, 500);
      await updateRow(SHEETS.caja, mov._index, row);

      await logGob(mov.groupId, req.user.email, 'caja_movimiento_descartado', mov.movId, motivo);
      res.json({
        success: true,
        estado: 'descartado',
        puntoRetirado: punto.retirado,
        message: punto.retirado
          ? 'Movimiento retirado, y el punto sale de la asamblea.'
          : 'Movimiento retirado.',
      });
    } catch (e) {
      console.error('[GOB caja descartar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al retirar el movimiento.' });
    }
  });

  /**
   * Retira un aval propuesto. Uno ya APROBADO no se retira por aqui: esta dando
   * cupo de verdad y quitarlo es "liberar", que ademas comprueba que el prestamo
   * que sostiene ya este pagado.
   */
  app.post('/api/gob/aval/:id/descartar', bloquear((r) => `aval:${r.params.id}`), async (req, res) => {
    try {
      const aval = await getAval(req.params.id);
      if (!aval) return res.status(404).json({ success: false, message: 'Aval no encontrado.' });
      const rol = await requireLider(req, res, aval.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      const motivo = motivoDeRetiro(req, res, 'este aval');
      if (!motivo) return;

      if (aval.estado === 'aprobado') {
        return res.status(409).json({
          success: false,
          motivo: 'ya_aprobado',
          message: 'Este aval ya está dando cupo. Para quitarlo se usa "liberar", que comprueba '
            + 'antes que el préstamo que sostiene esté pagado.',
        });
      }
      if (['descartado', 'liberado'].includes(aval.estado)) {
        return res.status(409).json({ success: false, message: `Este aval ya está "${aval.estado}".` });
      }

      const punto = await retirarPuntoSiNadieVoto(aval.acuerdoId, req.user.email, motivo);

      const row = aval._row.slice();
      while (row.length < SHEETS.avales.headers.length) row.push('');
      row[5] = 'descartado';
      row[10] = req.user.email;
      row[11] = nowIso();
      row[12] = sanitizeCell(`[RETIRADO: ${motivo}]`, 500);
      await updateRow(SHEETS.avales, aval._index, row);

      await logGob(aval.groupId, req.user.email, 'aval_descartado', aval.avalId, motivo);
      res.json({
        success: true,
        estado: 'descartado',
        puntoRetirado: punto.retirado,
        message: punto.retirado
          ? 'Aval retirado, y el punto sale de la asamblea.'
          : 'Aval retirado.',
      });
    } catch (e) {
      console.error('[GOB aval descartar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al retirar el aval.' });
    }
  });

  /** La tesoreria confirma que la socia pago la multa. */
  app.post('/api/gob/caja/:movId/cobrar', bloquear((r) => `caja:${r.params.movId}`), async (req, res) => {
    try {
      const mov = await getMovCaja(req.params.movId);
      if (!mov) return res.status(404).json({ success: false, message: 'Movimiento no encontrado.' });
      const rol = await requireLider(req, res, mov.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      if (mov.tipo !== 'multa') {
        return res.status(409).json({ success: false, message: 'Solo las multas se cobran.' });
      }
      if (mov.estado !== 'aplicado') {
        return res.status(409).json({
          success: false,
          message: mov.estado === 'cobrada'
            ? 'Esta multa ya esta cobrada.'
            : 'La asamblea todavia no ha aprobado esta multa.',
        });
      }
      // Quien debe la multa no firma que la pago.
      if (mov.email === normalizeEmailKey(req.user.email)) {
        return res.status(403).json({
          success: false,
          motivo: 'es_tu_multa',
          message: 'Es tu propia multa: el cobro lo confirma otra persona de la junta.',
        });
      }

      const fila = mov._row.slice();
      while (fila.length < SHEETS.caja.headers.length) fila.push('');
      fila[6] = 'cobrada';
      fila[11] = req.user.email;
      fila[12] = nowIso();
      await updateRow(SHEETS.caja, mov._index, fila);
      await logGob(mov.groupId, req.user.email, 'caja_multa_cobrada', mov.movId, `${mov.importe}`);

      res.json({
        success: true,
        estado: 'cobrada',
        message: `Cobrados $${mov.importe.toFixed(2)}. Entran a la caja del grupo y se reparten `
          + 'entre todas en el proximo reparto.',
      });
    } catch (e) {
      console.error('[GOB caja cobrar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al cobrar la multa.' });
    }
  });

  // =========================================================================
  //  LA CARTERA DEL GRUPO Y LO QUE SE PUEDE HACER CON UN PRESTAMO
  //
  //  Un prestamo solo podia nacer y pagarse. Todo lo demas daba 404, y son
  //  cosas que pasan en cualquier banco comunal: la socia se queda sin trabajo
  //  y pide mas plazo, el grupo perdona una parte por una desgracia, alguien
  //  registro un prestamo que nunca se entrego. Se hace por el carril que da
  //  legitimidad: la directiva propone, la ASAMBLEA vota, y solo con el acuerdo
  //  aprobado se toca el dinero.
  //
  //  La unica excepcion es la mora: no es una decision, es aplicar lo que el
  //  grupo ya escribio en su reglamento. Aun asi queda escrita y con firma.
  // =========================================================================

  const HOJA_LOANS = 'Loans!A2:K';

  /** Todos los prestamos del grupo, con su fila y su indice para poder escribir. */
  async function filasDePrestamos(groupId) {
    const sheetsClient = await getSheetsClient();
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: HOJA_LOANS,
    });
    return (resp.data.values || [])
      .map((r, i) => ({ fila: r, indice: i }))
      .filter((x) => !groupId || normalizeGroupKey(x.fila[2]) === normalizeGroupKey(groupId));
  }

  async function buscarPrestamo(loanId) {
    const id = (loanId || '').toString().trim();
    if (!id) return null;
    const todos = await filasDePrestamos('');
    const x = todos.find((f) => (f.fila[0] || '').toString().trim() === id);
    if (!x) return null;
    const r = x.fila;
    return {
      loanId: id,
      email: normalizeEmailKey(r[1]),
      groupId: normalizeGroupKey(r[2]),
      principal: num(r[3]),
      inicio: (r[4] || '').toString().slice(0, 10),
      vence: (r[5] || '').toString().slice(0, 10),
      tasa: num(r[6]),
      estado: (r[7] || '').toString().trim().toLowerCase(),
      plazo: Math.max(0, Math.trunc(num(r[8]))),
      // El total PACTADO. La mora va aparte para que el cuadro de cuotas no se
      // rehaga cada vez que se carga un recargo.
      total: num(r[9]) || num(r[3]),
      // Nunca negativa: un `-50` escrito a mano en la hoja bajaba la deuda de
      // $112 a $62 sin que nadie lo aprobara.
      moraCargada: Math.max(0, num(r[10])),
      _indice: x.indice,
      _fila: r,
    };
  }

  /** Los pagos aprobados de un prestamo, con su fecha. */
  async function pagosDePrestamo(loanId) {
    const sheetsClient = await getSheetsClient();
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O',
    });
    return (resp.data.values || [])
      .filter((r) => (r[2] || '').toString().trim() === (loanId || '').toString().trim())
      .filter((r) => ['approved', 'aprobado'].includes((r[6] || '').toString().trim().toLowerCase()))
      .map((r) => ({ fecha: (r[4] || '').toString().slice(0, 10), monto: num(r[3]) }));
  }

  const VIVO = new Set(['aprobado', 'approved', 'activo']);

  /** La foto completa de un prestamo: cuadro de cuotas, mora y saldo. */
  async function fotoDelPrestamo(pr, reglas, hoy = new Date()) {
    const pagos = await pagosDePrestamo(pr.loanId);
    const pagado = Math.round(pagos.reduce((a, x) => a + x.monto, 0) * 100) / 100;
    const cuadro = cuadroDeCuotas(
      { total: pr.total, term: pr.plazo, startDate: pr.inicio }, pagos, hoy);
    const mora = moraAcumulada(cuadro, reglas, hoy);
    const debe = Math.round((pr.total + pr.moraCargada) * 100) / 100;
    return {
      ...pr,
      pagado,
      // Lo que debe: lo pactado mas los recargos que se le cargaron.
      debe,
      saldo: Math.max(0, Math.round((debe - pagado) * 100) / 100),
      cuotas: cuadro.cuotas,
      resumen: cuadro.resumen,
      // Lo devengado hasta hoy, menos lo que ya se le cargo: es lo que queda
      // por cargar. Sin restar lo cargado, cada carga inflaba la siguiente.
      mora: {
        ...mora,
        cargada: pr.moraCargada,
        porCargar: Math.max(0, Math.round((mora.total - pr.moraCargada) * 100) / 100),
      },
      vivo: VIVO.has(pr.estado) && pagado < debe - 0.005,
    };
  }

  /**
   * La cartera del grupo: quien debe, cuanto y desde cuando.
   *
   * Es lo que la tesoreria necesita tener delante en la reunion, y lo que no
   * existia en ninguna pantalla: hasta ahora la unica forma de saber quien
   * estaba atrasada era preguntarle a cada socia.
   */
  app.get('/api/gob/cartera', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      const rol = await requireLider(req, res, groupId, ROLES_LIDER);
      if (!rol) return;

      const reglas = await getReglas(groupId);
      const hoy = new Date();
      const filas = await filasDePrestamos(groupId);
      const cent = (x) => Math.round(x * 100) / 100;

      // Un solo barrido de LoanPayments para todo el grupo: leerlo una vez por
      // prestamo agotaba la cuota de la hoja en un grupo con diez creditos.
      const sheetsClient = await getSheetsClient();
      const pagosResp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O',
      });
      const porPrestamo = {};
      const enRevision = {};
      for (const r of (pagosResp.data.values || [])) {
        const lid = (r[2] || '').toString().trim();
        if (!lid) continue;
        const estado = (r[6] || '').toString().trim().toLowerCase();
        if (['approved', 'aprobado'].includes(estado)) {
          (porPrestamo[lid] = porPrestamo[lid] || []).push({
            fecha: (r[4] || '').toString().slice(0, 10), monto: num(r[3]),
          });
        } else if (['pending_approval', 'pending', 'pendiente'].includes(estado)) {
          enRevision[lid] = cent((enRevision[lid] || 0) + num(r[3]));
        }
      }

      const nombres = await (async () => {
        const r = await sheetsClient.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID, range: 'Users!A2:B',
        });
        const m = {};
        for (const u of (r.data.values || [])) m[normalizeEmailKey(u[1])] = (u[0] || '').toString().trim();
        return m;
      })();

      const cartera = filas.map((x) => {
        const r = x.fila;
        const loanId = (r[0] || '').toString().trim();
        const correo = normalizeEmailKey(r[1]);
        const total = num(r[9]) || num(r[3]);
        const moraCargada = Math.max(0, num(r[10]));
        const debe = cent(total + moraCargada);
        const plazo = Math.max(0, Math.trunc(num(r[8])));
        const pagos = porPrestamo[loanId] || [];
        const pagado = cent(pagos.reduce((a, y) => a + y.monto, 0));
        const cuadro = cuadroDeCuotas(
          { total, term: plazo, startDate: (r[4] || '').toString().slice(0, 10) }, pagos, hoy);
        const mora = moraAcumulada(cuadro, reglas, hoy);
        const estado = (r[7] || '').toString().trim().toLowerCase();
        return {
          loanId,
          email: correo,
          nombre: nombres[correo] || correo.split('@')[0],
          estado,
          capital: num(r[3]),
          total,
          debe,
          plazo,
          inicio: (r[4] || '').toString().slice(0, 10),
          pagado,
          saldo: Math.max(0, cent(debe - pagado)),
          enRevision: enRevision[loanId] || 0,
          cuotasPagadas: cuadro.resumen.cuotasPagadas,
          cuotasVencidas: cuadro.resumen.cuotasVencidas,
          aPagarAhora: cuadro.resumen.aPagarAhora,
          proximaCuota: cuadro.resumen.proximaCuota,
          moraCargada,
          moraPorCargar: Math.max(0, cent(mora.total - moraCargada)),
          mora: mora.total,
          vivo: VIVO.has(estado) && pagado < debe - 0.005,
        };
      });

      const vivos = cartera.filter((x) => x.vivo);
      // Primero quien mas atrasada esta: es el orden en que se pasa lista.
      vivos.sort((a, b) => (b.cuotasVencidas - a.cuotasVencidas) || (b.saldo - a.saldo));

      res.json({
        success: true,
        reglas: {
          moraPorcentajeMensual: reglas.moraPorcentajeMensual,
          diasDeGracia: reglas.diasDeGracia,
        },
        resumen: {
          prestamosVivos: vivos.length,
          prestamada: cent(vivos.reduce((a, x) => a + x.debe, 0)),
          porCobrar: cent(vivos.reduce((a, x) => a + x.saldo, 0)),
          vencidoHoy: cent(vivos.reduce((a, x) => a + x.aPagarAhora, 0)),
          moraAcumulada: cent(vivos.reduce((a, x) => a + x.mora, 0)),
          sociasAtrasadas: vivos.filter((x) => x.cuotasVencidas > 0).length,
        },
        vivos,
        cerrados: cartera.filter((x) => !x.vivo),
      });
    } catch (e) {
      console.error('[GOB cartera]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al leer la cartera del grupo.' });
    }
  });

  /** La ficha de un prestamo: su cuadro, su mora y todo lo que se le hizo. */
  app.get('/api/gob/prestamo/:loanId', async (req, res) => {
    try {
      const pr = await buscarPrestamo(req.params.loanId);
      if (!pr) return res.status(404).json({ success: false, message: 'Prestamo no encontrado.' });
      if (!(await assertGroupMember(req, res, pr.groupId))) return;
      // Su propio prestamo, o la directiva: los saldos ajenos no son de todos.
      if (pr.email !== normalizeEmailKey(req.user.email)
        && !esLider(await getUserGroupRole(req.user.email, pr.groupId))) {
        return res.status(403).json({ success: false, message: 'Solo puedes ver tu propio prestamo.' });
      }
      const reglas = await getReglas(pr.groupId);
      const foto = await fotoDelPrestamo(pr, reglas);
      const movs = (await readAll(SHEETS.prestamoMovs))
        .filter((r) => (r[2] || '').toString().trim() === pr.loanId)
        .map((r) => ({
          movId: r[0], tipo: r[4], importe: num(r[5]),
          totalAntes: num(r[6]), totalDespues: num(r[7]),
          plazoAntes: num(r[8]), plazoDespues: num(r[9]),
          venceAntes: r[10] || '', venceDespues: r[11] || '',
          estadoAntes: r[12] || '', estadoDespues: r[13] || '',
          acuerdoId: r[14] || '', actor: r[15] || '', fecha: r[16] || '', motivo: r[17] || '',
        }))
        .sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));

      delete foto._fila; delete foto._indice;
      res.json({ success: true, prestamo: foto, movimientos: movs });
    } catch (e) {
      console.error('[GOB prestamo ficha]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al leer el prestamo.' });
    }
  });

  /** Escribe el movimiento y deja el prestamo como queda. */
  async function aplicarMovimiento({
    pr, tipo, importe, nuevoTotal, nuevaMora, nuevoPlazo, nuevoInicio, nuevoVence, nuevoEstado,
    acuerdoId, actor, motivo, movId,
  }) {
    const fila = pr._fila.slice();
    while (fila.length < 11) fila.push('');
    const cent = (x) => Math.round((Number(x) || 0) * 100) / 100;
    // Lo que DEBIA, no solo lo pactado: con la mora en su propia columna, un
    // movimiento de mora dejaba las dos cifras iguales y no se entendia nada.
    const antes = {
      debe: cent(pr.total + pr.moraCargada),
      plazo: pr.plazo,
      vence: pr.vence,
      estado: pr.estado,
    };
    const debeDespues = cent(
      (nuevoTotal !== undefined ? nuevoTotal : pr.total)
      + (nuevaMora !== undefined ? nuevaMora : pr.moraCargada));
    if (nuevoInicio !== undefined) fila[4] = nuevoInicio;
    if (nuevoVence !== undefined) fila[5] = nuevoVence;
    if (nuevoEstado !== undefined) fila[7] = nuevoEstado;
    if (nuevoPlazo !== undefined) fila[8] = nuevoPlazo;
    if (nuevoTotal !== undefined) fila[9] = nuevoTotal;
    if (nuevaMora !== undefined) fila[10] = nuevaMora;

    // Por identificador, no por numero de fila: si alguien borra una fila de mas
    // arriba entre la lectura y la escritura, se reescribia el prestamo de otra.
    const sheetsClient = await getSheetsClient();
    await actualizarFilaPorClave(sheetsClient, {
      spreadsheetId: SPREADSHEET_ID,
      hoja: 'Loans',
      ultimaColumna: 'K',
      desdeColumna: 'A',
      indice: pr._indice,
      claveCol: 0,
      clave: pr.loanId,
      construir: () => fila.slice(0, 11),
    });

    await appendRow(SHEETS.prestamoMovs, [
      movId || newId('pmov'), pr.groupId, pr.loanId, pr.email, tipo,
      cent(importe),
      antes.debe, debeDespues,
      antes.plazo, nuevoPlazo !== undefined ? nuevoPlazo : antes.plazo,
      antes.vence, nuevoVence !== undefined ? nuevoVence : antes.vence,
      antes.estado, nuevoEstado !== undefined ? nuevoEstado : antes.estado,
      acuerdoId || '', actor, nowIso(), sanitizeCell(motivo || '', 300),
    ]);
    return antes;
  }

  /**
   * La tesoreria aplica la mora devengada.
   *
   * No es una decision de asamblea: es aplicar lo que el grupo ya escribio en
   * su reglamento. Pero se aplica UNA VEZ POR MES y con firma, para que no se
   * pueda cargar dos veces lo mismo pulsando dos veces el boton.
   */
  app.post('/api/gob/prestamo/:loanId/mora', bloquear((r) => `pmov:${r.params.loanId}`), async (req, res) => {
    try {
      const pr = await buscarPrestamo(req.params.loanId);
      if (!pr) return res.status(404).json({ success: false, message: 'Prestamo no encontrado.' });
      const rol = await requireLider(req, res, pr.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      if (!VIVO.has(pr.estado)) {
        return res.status(409).json({
          success: false,
          message: `Este prestamo esta "${pr.estado}": no se le puede cargar mora.`,
        });
      }
      // Nadie se aplica mora a si misma, ni se la perdona: es el mismo principio
      // que el de no aprobar el comprobante de la propia deuda.
      if (pr.email === normalizeEmailKey(req.user.email)) {
        return res.status(403).json({
          success: false,
          motivo: 'es_tu_deuda',
          message: 'Es tu propio prestamo, asi que la mora la aplica otra persona de la junta.',
        });
      }

      const reglas = await getReglas(pr.groupId);
      if (!(reglas.moraPorcentajeMensual > 0)) {
        return res.status(409).json({
          success: false,
          motivo: 'sin_mora_acordada',
          message: 'El grupo no ha acordado ningun recargo por mora. Se fija en el reglamento, '
            + 'y subirlo necesita acuerdo de asamblea porque encarece prestamos ya dados.',
        });
      }

      const foto = await fotoDelPrestamo(pr, reglas);
      const porCargar = foto.mora.porCargar;

      if (!(porCargar > 0.004)) {
        return res.status(409).json({
          success: false,
          motivo: 'nada_que_cargar',
          moraDevengada: foto.mora.total,
          yaCargado: pr.moraCargada,
          message: pr.moraCargada > 0
            ? 'La mora devengada hasta hoy ya esta cargada en este prestamo.'
            : 'Este prestamo no tiene dias de mora todavia.',
        });
      }

      const nuevaMora = Math.round((pr.moraCargada + porCargar) * 100) / 100;
      const debeAntes = Math.round((pr.total + pr.moraCargada) * 100) / 100;
      const debeDespues = Math.round((pr.total + nuevaMora) * 100) / 100;
      await aplicarMovimiento({
        pr, tipo: 'mora', importe: porCargar, nuevaMora,
        actor: req.user.email,
        motivo: `${reglas.moraPorcentajeMensual}% mensual sobre lo vencido, `
          + `${reglas.diasDeGracia} dia(s) de gracia`,
      });
      await logGob(pr.groupId, req.user.email, 'prestamo_mora', pr.loanId,
        `${porCargar} de mora: ${debeAntes} -> ${debeDespues}`);

      res.json({
        success: true,
        cargado: porCargar,
        moraTotal: nuevaMora,
        totalAntes: debeAntes,
        totalDespues: debeDespues,
        detalle: foto.mora.detalle,
        message: `Se cargaron $${porCargar.toFixed(2)} de mora. La deuda pasa de `
          + `$${debeAntes.toFixed(2)} a $${debeDespues.toFixed(2)}.`,
      });
    } catch (e) {
      console.error('[GOB prestamo mora]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al cargar la mora.' });
    }
  });

  /**
   * Lleva a la asamblea lo que se quiere hacer con un prestamo.
   *
   * Condonar, reprogramar, refinanciar o anular mueven dinero que es de todas,
   * asi que no los firma la tesoreria: se proponen, se votan y despues se
   * aplican. Es el mismo camino que el reparto de utilidades y la salida de una
   * socia, que ya funcionan asi.
   */
  app.post('/api/gob/prestamo/:loanId/proponer', bloquear((r) => `pmov:${r.params.loanId}`), async (req, res) => {
    try {
      const pr = await buscarPrestamo(req.params.loanId);
      if (!pr) return res.status(404).json({ success: false, message: 'Prestamo no encontrado.' });
      const rol = await requireLider(req, res, pr.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;

      const tipo = (req.body?.tipo || '').toString().trim().toLowerCase();
      if (!MOVS_PRESTAMO.has(tipo)) {
        return res.status(400).json({
          success: false,
          message: `Movimiento invalido. Validos: ${[...MOVS_PRESTAMO].join(', ')}.`,
        });
      }
      const motivo = (req.body?.motivo || '').toString().trim();
      if (motivo.length < 10) {
        return res.status(400).json({
          success: false,
          motivo: 'falta_motivo',
          message: 'Escribe el motivo con sus palabras: es lo que va a leer la asamblea antes '
            + 'de votar, y lo que quedara en el acta.',
        });
      }

      const reglas = await getReglas(pr.groupId);
      const foto = await fotoDelPrestamo(pr, reglas);
      const importe = Math.round((num(req.body?.importe)) * 100) / 100;
      const plazoNuevo = Math.max(0, Math.trunc(num(req.body?.plazoNuevo)));

      // Lo que cada movimiento exige, comprobado ANTES de gastarle el tiempo a
      // la asamblea en votar algo que despues no se va a poder aplicar.
      if (tipo === 'condonacion') {
        if (!(importe > 0)) {
          return res.status(400).json({ success: false, message: 'Di cuanto se condona.' });
        }
        if (importe > foto.saldo + 0.005) {
          return res.status(400).json({
            success: false,
            motivo: 'importe_excede',
            message: `No se pueden condonar $${importe.toFixed(2)}: la deuda que queda es `
              + `$${foto.saldo.toFixed(2)}.`,
          });
        }
      }
      if (['reprogramacion', 'refinanciacion'].includes(tipo)) {
        if (!(plazoNuevo >= 1 && plazoNuevo <= 60)) {
          return res.status(400).json({
            success: false,
            message: 'El plazo nuevo tiene que estar entre 1 y 60 meses.',
          });
        }
        if (!(foto.saldo > 0)) {
          return res.status(409).json({
            success: false,
            message: 'Este prestamo ya esta saldado: no hay nada que reprogramar.',
          });
        }
      }
      if (tipo === 'anulacion' && foto.pagado > 0.004) {
        return res.status(409).json({
          success: false,
          motivo: 'ya_tiene_pagos',
          message: `Este prestamo ya tiene $${foto.pagado.toFixed(2)} pagados, asi que no se `
            + 'puede anular como si nunca hubiera existido. Si el grupo quiere borrar lo que '
            + 'queda, es una condonacion.',
        });
      }
      if (!VIVO.has(pr.estado)) {
        return res.status(409).json({
          success: false,
          message: `Este prestamo esta "${pr.estado}": ya no admite movimientos.`,
        });
      }

      const asamblea = await getAsamblea((req.body?.asambleaId || '').toString().trim());
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      if (normalizeGroupKey(asamblea.groupId) !== pr.groupId) {
        return res.status(403).json({ success: false, message: 'Esa asamblea es de otro grupo.' });
      }
      if (!['programada', 'abierta'].includes(asamblea.estado)) {
        return res.status(409).json({ success: false, message: 'La asamblea ya no admite nuevos puntos.' });
      }

      // La cuenta que va a ver la asamblea, hecha ahora y guardada con el punto:
      // si se recalcula al aplicar y sale otra, se para y se vuelve a votar.
      const propuesta = calcularMovimiento(tipo, foto, { importe, plazoNuevo, tasa: pr.tasa });

      const titulo = {
        condonacion: `Condonar $${importe.toFixed(2)} del prestamo de ${pr.email}`,
        reprogramacion: `Reprogramar a ${plazoNuevo} meses el prestamo de ${pr.email}`,
        refinanciacion: `Refinanciar a ${plazoNuevo} meses el prestamo de ${pr.email}`,
        anulacion: `Anular el prestamo de ${pr.email} (nunca se entrego)`,
      }[tipo];

      const acuerdoId = newId('acu');
      await appendRow(SHEETS.acuerdos, [
        acuerdoId, asamblea.asambleaId, pr.groupId, 'movimiento_prestamo',
        sanitizeCell(titulo, 200),
        sanitizeCell(`${motivo}\n\nHoy debe $${foto.saldo.toFixed(2)} de $${pr.total.toFixed(2)}`
          + ` (${foto.resumen.cuotasVencidas} cuota(s) vencida(s)).`
          + ` ${propuesta.explicacion}`, 2000),
        JSON.stringify({ loanId: pr.loanId, tipo, importe, plazoNuevo, propuesta }),
        'abierto', req.user.email, nowIso(), '', '', 0, 0, 0,
      ]);
      await logGob(pr.groupId, req.user.email, 'prestamo_movimiento_propuesto', pr.loanId,
        `${tipo} -> ${acuerdoId}`);

      res.status(201).json({
        success: true, acuerdoId, asambleaId: asamblea.asambleaId, tipo, propuesta,
      });
    } catch (e) {
      console.error('[GOB prestamo proponer]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al someter el movimiento.' });
    }
  });

  /**
   * Que queda despues del movimiento. Se calcula igual al proponer y al
   * aplicar, para poder comparar y no pagar algo distinto de lo votado.
   */
  function calcularMovimiento(tipo, foto, { importe, plazoNuevo, tasa }) {
    const cent = (x) => Math.round(x * 100) / 100;
    if (tipo === 'condonacion') {
      // Se perdona primero el recargo por retraso y despues lo pactado: es el
      // orden que tiene sentido explicar en la asamblea.
      const deMora = Math.min(cent(importe), foto.moraCargada);
      const dePactado = cent(importe - deMora);
      const nuevaMora = cent(foto.moraCargada - deMora);
      const nuevoTotal = cent(foto.total - dePactado);
      const nuevoSaldo = Math.max(0, cent(nuevoTotal + nuevaMora - foto.pagado));
      return {
        nuevoTotal,
        nuevaMora,
        nuevoSaldo,
        explicacion: `Se le perdonan $${cent(importe).toFixed(2)}`
          + (deMora > 0 ? ` ($${deMora.toFixed(2)} de mora)` : '')
          + `: la deuda pasa de $${foto.saldo.toFixed(2)} a $${nuevoSaldo.toFixed(2)}. `
          + 'Ese dinero sale de la caja de todas.',
      };
    }
    if (tipo === 'anulacion') {
      return {
        nuevoTotal: 0,
        nuevaMora: 0,
        nuevoSaldo: 0,
        explicacion: 'El prestamo se da por no entregado: deja de figurar como deuda y el '
          + 'capital vuelve a estar disponible.',
      };
    }
    // Reprogramar y refinanciar: el calendario arranca de nuevo desde hoy.
    const d = new Date();
    const inicio = { a: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    const saldo = foto.saldo;
    if (tipo === 'reprogramacion') {
      // Mismo dinero, mas meses: las cuotas bajan y no se cobra interes nuevo.
      return {
        nuevoTotal: foto.total,
        nuevaMora: foto.moraCargada,
        nuevoSaldo: saldo,
        nuevoInicio: formatear(inicio),
        nuevoVence: formatear(sumarMeses(inicio, plazoNuevo)),
        cuotaNueva: cent(saldo / plazoNuevo),
        explicacion: `Se le dan ${plazoNuevo} meses mas desde hoy para los $${saldo.toFixed(2)} `
          + `que debe, sin cobrarle mas interes: la cuota queda en $${cent(saldo / plazoNuevo).toFixed(2)}.`,
      };
    }
    // Refinanciar: se vuelve a prestar el saldo, con interes nuevo por el plazo.
    const interes = cent(saldo * (Number(tasa) || 0) / 100 * plazoNuevo);
    const nuevoTotal = cent(foto.pagado + saldo + interes - foto.moraCargada);
    return {
      nuevoTotal,
      nuevaMora: foto.moraCargada,
      nuevoSaldo: cent(saldo + interes),
      nuevoInicio: formatear(inicio),
      nuevoVence: formatear(sumarMeses(inicio, plazoNuevo)),
      cuotaNueva: cent((saldo + interes) / plazoNuevo),
      explicacion: `Se le vuelve a prestar el saldo de $${saldo.toFixed(2)} por ${plazoNuevo} `
        + `meses al ${Number(tasa) || 0}% mensual: pagara $${interes.toFixed(2)} de interes nuevo `
        + `y la cuota queda en $${cent((saldo + interes) / plazoNuevo).toFixed(2)}. `
        + 'Ese interes es ganancia del grupo.',
    };
  }

  /** Aplica el movimiento que la asamblea ya aprobo. */
  app.post('/api/gob/prestamo/:loanId/aplicar', bloquear((r) => `pmov:${r.params.loanId}`), async (req, res) => {
    try {
      const pr = await buscarPrestamo(req.params.loanId);
      if (!pr) return res.status(404).json({ success: false, message: 'Prestamo no encontrado.' });
      const rol = await requireLider(req, res, pr.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;

      const acuerdoId = (req.body?.acuerdoId || '').toString().trim();
      const chk = await acuerdoAprobadoValido(pr.groupId, acuerdoId, 'movimiento_prestamo');
      if (!chk.valido) {
        return res.status(409).json({
          success: false,
          message: 'Esto solo se aplica con el acuerdo de asamblea aprobado.',
          detalle: chk.motivo,
        });
      }
      if (chk.acuerdo.estado === 'ejecutado') {
        return res.status(409).json({ success: false, message: 'Ese acuerdo ya se ejecuto.' });
      }

      // `getAcuerdo` ya lo devuelve parseado: volver a parsearlo daba
      // JSON.parse('[object Object]'), que revienta, y el catch dejaba el
      // payload vacio -- asi que TODO acuerdo parecia "de otro prestamo".
      const payload = (chk.acuerdo.payload && typeof chk.acuerdo.payload === 'object')
        ? chk.acuerdo.payload : {};
      if ((payload.loanId || '') !== pr.loanId) {
        return res.status(409).json({
          success: false,
          message: 'Ese acuerdo es de otro prestamo.',
        });
      }
      const tipo = (payload.tipo || '').toString();
      if (!MOVS_PRESTAMO.has(tipo)) {
        return res.status(409).json({ success: false, message: 'El acuerdo no dice que hacer.' });
      }

      const reglas = await getReglas(pr.groupId);
      const foto = await fotoDelPrestamo(pr, reglas);
      const ahora = calcularMovimiento(tipo, foto, {
        importe: num(payload.importe), plazoNuevo: Math.trunc(num(payload.plazoNuevo)), tasa: pr.tasa,
      });
      const votado = payload.propuesta || {};

      // Entre la votacion y el pago pudo entrar un comprobante: si las cuentas
      // cambiaron, no se aplica a ciegas lo que ya no es cierto.
      if (Math.abs(Number(votado.nuevoTotal || 0) - ahora.nuevoTotal) > 0.005) {
        return res.status(409).json({
          success: false,
          motivo: 'cuentas_cambiadas',
          votado: votado.nuevoTotal,
          ahora: ahora.nuevoTotal,
          message: 'Las cuentas de este prestamo cambiaron despues de la votacion (entro un '
            + 'pago, o se cargo mora). Vuelve a calcularlo y sometelo otra vez, para que la '
            + 'asamblea apruebe la cifra que de verdad se va a aplicar.',
        });
      }

      const comun = {
        pr, tipo, acuerdoId, actor: req.user.email,
        motivo: chk.acuerdo.titulo || tipo,
      };
      if (tipo === 'condonacion') {
        await aplicarMovimiento({
          ...comun, importe: num(payload.importe),
          nuevoTotal: ahora.nuevoTotal, nuevaMora: ahora.nuevaMora,
          nuevoEstado: ahora.nuevoSaldo <= 0.004 ? 'pagado' : pr.estado,
        });
      } else if (tipo === 'anulacion') {
        await aplicarMovimiento({
          ...comun, importe: foto.debe, nuevoTotal: 0, nuevaMora: 0, nuevoEstado: 'anulado',
        });
      } else {
        await aplicarMovimiento({
          ...comun,
          importe: ahora.nuevoSaldo,
          nuevoTotal: ahora.nuevoTotal,
          nuevaMora: ahora.nuevaMora,
          nuevoPlazo: Math.trunc(num(payload.plazoNuevo)),
          nuevoInicio: ahora.nuevoInicio,
          nuevoVence: ahora.nuevoVence,
        });
      }

      await marcarAcuerdoEjecutado(acuerdoId);
      await logGob(pr.groupId, req.user.email, 'prestamo_movimiento_aplicado', pr.loanId,
        `${tipo}: ${pr.total} -> ${ahora.nuevoTotal}`);

      res.json({
        success: true, tipo, acuerdoId,
        totalAntes: pr.total, totalDespues: ahora.nuevoTotal,
        saldoDespues: ahora.nuevoSaldo,
        message: ahora.explicacion,
      });
    } catch (e) {
      console.error('[GOB prestamo aplicar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al aplicar el movimiento.' });
    }
  });

  // =========================================================================
  //  LO QUE ME TOCA ESTE CICLO
  //
  //  Lo primero que una socia quiere saber al abrir la app es cuando es la
  //  proxima reunion y cuanto tiene que llevar. Estaba repartido en tres sitios
  //  y ninguno lo decia junto: la cuota del prestamo en el perfil, el aporte
  //  minimo guardado en el reglamento sin que nadie lo recordara, y la "proxima
  //  asamblea" inventada por el navegador sumando un mes al ultimo movimiento.
  // =========================================================================

  /**
   * La proxima asamblea del grupo.
   *
   * Si hay una convocada de verdad (programada o abierta), esa. Si no, se
   * estima con el dia que el grupo acordo reunirse, y se dice que es una
   * estimacion: no es lo mismo una fecha acordada que una cuenta del calendario.
   */
  async function proximaAsambleaDe(groupId, reglas, hoy = new Date()) {
    const g = normalizeGroupKey(groupId);
    const hoyStr = formatear({ a: hoy.getFullYear(), m: hoy.getMonth() + 1, d: hoy.getDate() });

    const convocadas = (await readAll(SHEETS.asambleas))
      .filter((r) => normalizeGroupKey(r[1]) === g)
      .filter((r) => ['programada', 'abierta'].includes((r[5] || '').toString().trim().toLowerCase()))
      .map((r) => ({
        asambleaId: (r[0] || '').toString().trim(),
        titulo: r[2] || 'Asamblea',
        fecha: (r[3] || '').toString().slice(0, 10),
        modalidad: r[4] || '',
        estado: (r[5] || '').toString().trim().toLowerCase(),
      }))
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.fecha))
      .sort((a, b) => a.fecha.localeCompare(b.fecha));

    // La que viene; si todas quedaron atras, la ultima sin cerrar, porque una
    // asamblea abierta y vencida sigue siendo la que hay que atender.
    const queViene = convocadas.find((x) => x.fecha >= hoyStr);
    if (queViene) return { ...queViene, convocada: true, estimada: false, yaPaso: false };
    // La ultima quedo atras y sigue sin cerrarse: se devuelve, porque hay que
    // atenderla, pero marcada, para que no sirva de corte de lo que se lleva.
    const atrasada = convocadas[convocadas.length - 1];
    if (atrasada) return { ...atrasada, convocada: true, estimada: false, yaPaso: true };

    // Ninguna convocada: se estima con el dia que el grupo acordo. Nunca con
    // `setMonth`, que desborda: el 31 de enero mas un mes daba el 3 de marzo.
    if (!reglas.diaDeAsamblea) {
      return { convocada: false, estimada: false, yaPaso: false, fecha: '', titulo: '', estado: '' };
    }
    const dia = Math.max(1, Math.min(28, reglas.diaDeAsamblea));
    let cuando = { a: hoy.getFullYear(), m: hoy.getMonth() + 1, d: dia };
    if (formatear(cuando) < hoyStr) cuando = sumarMeses(cuando, 1);
    return {
      convocada: false, estimada: true, yaPaso: false, fecha: formatear(cuando),
      titulo: 'Reunion del mes', estado: '',
    };
  }

  /**
   * Lo que una socia tiene que llevar a la proxima reunion.
   *
   * Todo lo del CICLO EN CURSO, que es el mes: lo que le falta del aporte
   * minimo, las acciones que el grupo acordo que compre, y la cuota del
   * prestamo que le vence antes de la reunion.
   */
  app.get('/api/gob/mi-compromiso', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!groupId) return res.status(400).json({ success: false, message: 'Falta groupId.' });
      if (!(await assertGroupMember(req, res, groupId))) return;

      // Estrictamente lo de quien pregunta. Esta seccion es el recordatorio
      // personal de cada socia -- lo suyo y nada mas -- asi que el correo sale
      // de la sesion y no se acepta por la direccion: ni siquiera la directiva
      // consulta aqui lo de otra. Para cobrar en la reunion la tesoreria tiene
      // su propio tablero, que es donde corresponde ver al grupo entero.
      const correo = normalizeEmailKey(req.user.email);

      const reglas = await getReglas(groupId);
      const hoy = new Date();
      const ciclo = mesActualDelReparto(hoy);
      const proxima = await proximaAsambleaDe(groupId, reglas, hoy);
      const cent = (x) => Math.round(x * 100) / 100;

      // --- El aporte de este ciclo -----------------------------------------
      const savRows = await leerSavings();
      const delCiclo = savRows.filter((r) => normalizeEmailKey(r[SAV.email]) === correo
        && normalizeGroupKey(r[SAV.group]) === groupId
        && !['utilidad', 'retiro_salida'].includes(
          (r[SAV.type] || '').toString().trim().toLowerCase())
        && mesDelReparto(r[SAV.date]) === ciclo);
      const aporteConfirmado = cent(delCiclo.filter((r) => aporteCuenta(r[SAV.estado]))
        .reduce((acc, r) => acc + num(r[SAV.amount]), 0));
      const aportePendiente = cent(delCiclo
        .filter((r) => estadoAporte(r[SAV.estado]) === 'pendiente')
        .reduce((acc, r) => acc + num(r[SAV.amount]), 0));
      // Lo pendiente de confirmar YA ESTA ENTREGADO: cobrarselo otra vez seria
      // hacerla pagar dos veces por el retraso de la tesoreria.
      const faltaAporte = cent(Math.max(0,
        reglas.aporteMinimo - aporteConfirmado - aportePendiente));

      // --- Las acciones de este ciclo --------------------------------------
      const accRows = await leerAcciones();
      const accCiclo = accRows.filter((r) => normalizeEmailKey(r[ACC.email]) === correo
        && normalizeGroupKey(r[ACC.group]) === groupId
        && mesDelReparto(r[ACC.date]) === ciclo);
      const accionesCompradas = accCiclo
        .filter((r) => aporteCuenta(r[ACC.estado]) || estadoAporte(r[ACC.estado]) === 'pendiente')
        .reduce((acc, r) => acc + num(r[ACC.shares]), 0);
      const faltanAcciones = Math.max(0, reglas.accionesMinimasPorMes - accionesCompradas);
      const cfg = await configuracionDelGrupo(groupId);
      const valorAccion = cfg.valorConfigurado ? cfg.valorAccion : 0;
      const aPagarAcciones = cent(faltanAcciones * valorAccion);

      // --- La cuota del prestamo -------------------------------------------
      const sheetsClient = await getSheetsClient();
      const [loansResp, paysResp] = await Promise.all([
        sheetsClient.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID, range: 'Loans!A2:K',
        }),
        sheetsClient.spreadsheets.values.get({
          spreadsheetId: SPREADSHEET_ID, range: 'LoanPayments!A2:O',
        }),
      ]);
      const loansRows = loansResp.data.values || [];
      const vivos = new Set(loansRows
        .filter((r) => ['aprobado', 'approved', 'activo'].includes(
          (r[7] || '').toString().trim().toLowerCase()))
        .map((r) => (r[0] || '').toString().trim()));
      // Una solicitud que aun no aprobo la asamblea no es una deuda: cobrarla
      // en la reunion seria pedirle plata por un prestamo que no le dieron.
      const suyos = prestamosDelGrupo(loansRows, paysResp.data.values || [], groupId)
        .filter((x) => x.userEmail === correo && vivos.has(x.loanId))
        .filter((x) => x.pagado < x.total - 0.005);

      // Hasta cuando se mira. Con reunion convocada, hasta ese dia. Sin ella,
      // hasta el FIN DEL MES en curso, que es el ciclo de un banco comunal:
      // cortando en "hoy", a una socia con la cuota venciendo el 10 se le decia
      // el dia 6 que estaba al dia, y todo grupo nuevo esta en ese caso porque
      // el dia de reunion no viene acordado de fabrica.
      const finDeMes = formatear({
        a: hoy.getFullYear(),
        m: hoy.getMonth() + 1,
        d: diasDelMes(hoy.getFullYear(), hoy.getMonth() + 1),
      });
      const corte = (proxima.fecha && !proxima.yaPaso) ? proxima.fecha : finDeMes;
      const prestamos = suyos.map((pr) => {
        const fila = loansRows.find((r) => (r[0] || '').toString().trim() === pr.loanId) || [];
        const cuadro = cuadroDeCuotas(
          { total: pr.total, term: Number(fila[8] || 0), startDate: pr.inicio },
          pr.pagos.map((x) => ({ fecha: x.fecha, monto: x.monto })), hoy);
        // Lo exigible EN LA REUNION, no hoy: si la asamblea es el 15 y la cuota
        // vence el 10, se lleva; si vence el 20, todavia no.
        const enLaReunion = cent(cuadro.cuotas
          .filter((c) => c.pendiente > 0 && c.vence <= corte)
          .reduce((acc, c) => acc + c.pendiente, 0));
        // El recargo que lleva devengado por el retraso. Es un calculo, no un
        // cobro: lo que se cobra son los cargos que aplica la tesoreria. Pero
        // ella tiene que verlo venir antes de que se lo carguen.
        const mora = moraAcumulada(cuadro, reglas, hoy);
        return {
          loanId: pr.loanId,
          saldo: cent(Math.max(0, pr.total + Math.max(0, num(fila[10])) - pr.pagado)),
          cuotasVencidas: cuadro.resumen.cuotasVencidas,
          vencido: cent(cuadro.resumen.aPagarAhora),
          aPagar: enLaReunion,
          mora: mora.total,
          proximaCuota: cuadro.resumen.proximaCuota,
        };
      });
      const aPagarPrestamos = cent(prestamos.reduce((acc, x) => acc + x.aPagar, 0));
      const cuotasVencidas = prestamos.reduce((acc, x) => acc + x.cuotasVencidas, 0);
      const moraTotal = cent(prestamos.reduce((acc, x) => acc + (x.mora || 0), 0));

      // Las multas que la asamblea le puso y todavia no ha pagado: es dinero
      // que tiene que llevar a la reunion, igual que el ahorro y la cuota.
      const multas = await multasPendientesDe(groupId, correo);
      const multasTotal = cent(multas.reduce((acc, x) => acc + x.importe, 0));

      const total = cent(faltaAporte + aPagarAcciones + aPagarPrestamos + moraTotal + multasTotal);

      // --- Una frase que se entienda ---------------------------------------
      const trozos = [];
      if (faltaAporte > 0) trozos.push(`$${faltaAporte.toFixed(2)} de ahorro`);
      if (aPagarAcciones > 0) {
        trozos.push(`$${aPagarAcciones.toFixed(2)} de ${faltanAcciones} `
          + `${faltanAcciones === 1 ? 'accion' : 'acciones'}`);
      }
      if (aPagarPrestamos > 0) {
        trozos.push(`$${aPagarPrestamos.toFixed(2)} de tu prestamo`);
      }
      if (moraTotal > 0) {
        trozos.push(`$${moraTotal.toFixed(2)} de mora por el retraso`);
      }
      if (multasTotal > 0) {
        trozos.push(`$${multasTotal.toFixed(2)} de `
          + `${multas.length === 1 ? 'una multa' : `${multas.length} multas`}`);
      }
      const cuando = (proxima.fecha && !proxima.yaPaso)
        ? (proxima.convocada ? `el ${proxima.fecha}` : `alrededor del ${proxima.fecha}`)
        : 'la proxima reunion';
      // Nunca "estas al dia" con una deuda viva. Antes, con $224 pendientes y la
      // cuota a cuatro dias, la pantalla ponia un tic verde y decia que no debia
      // nada. Si no toca poner nada ESTE ciclo pero el prestamo sigue abierto,
      // se dice cual es la proxima cuota y cuando vence.
      const proximaDelPrestamo = prestamos
        .map((x) => x.proximaCuota).filter(Boolean)
        .sort((a, b) => String(a.vence).localeCompare(String(b.vence)))[0] || null;
      const saldoVivo = cent(prestamos.reduce((acc, x) => acc + x.saldo, 0));

      let mensaje;
      if (trozos.length > 0) {
        mensaje = `Para ${cuando} te toca llevar $${total.toFixed(2)}: ${trozos.join(', ')}.`;
      } else if (faltanAcciones > 0) {
        mensaje = 'Te faltan acciones por comprar, pero el grupo todavia no fijo cuanto vale cada una.';
      } else if (saldoVivo > 0) {
        mensaje = proximaDelPrestamo
          ? `Este mes no tienes nada que poner. Te queda un prestamo de $${saldoVivo.toFixed(2)}: `
            + `la proxima cuota es de $${Number(proximaDelPrestamo.importe).toFixed(2)} y vence el `
            + `${proximaDelPrestamo.vence}.`
          : `Este mes no tienes nada que poner. Te queda un prestamo de $${saldoVivo.toFixed(2)}.`;
      } else {
        mensaje = 'Estas al dia con el grupo. No tienes nada pendiente este mes.';
      }

      res.json({
        success: true,
        ciclo,
        email: correo,
        proximaAsamblea: proxima,
        aporte: {
          minimo: cent(reglas.aporteMinimo),
          confirmado: aporteConfirmado,
          porConfirmar: aportePendiente,
          falta: faltaAporte,
        },
        acciones: {
          minimasPorMes: reglas.accionesMinimasPorMes,
          compradas: accionesCompradas,
          faltan: faltanAcciones,
          valorAccion,
          aPagar: aPagarAcciones,
        },
        multas: {
          pendientes: multas.length,
          total: multasTotal,
          detalle: multas,
        },
        prestamos: {
          activos: prestamos.length,
          cuotasVencidas,
          aPagar: aPagarPrestamos,
          mora: moraTotal,
          saldo: saldoVivo,
          proximaCuota: proximaDelPrestamo,
          detalle: prestamos,
        },
        total,
        mensaje,
      });
    } catch (e) {
      console.error('[GOB mi-compromiso]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al calcular lo que te toca.' });
    }
  });

  // =========================================================================
  //  SALIDA DE UNA SOCIA, CON LIQUIDACION
  //
  //  Antes, salir del grupo borraba la fila del vinculo y ya. Medido: una socia
  //  puso $210, le tocaban $2,78 de utilidades, cobro $0,00, y sus $210
  //  siguieron sumando en el patrimonio del grupo. Ahora la salida sigue el
  //  mismo camino que el reparto: se calcula y se congela, se lleva a asamblea,
  //  se vota, y solo con el acuerdo aprobado se le paga.
  // =========================================================================

  /** Lee una salida por su id, con la fila y el indice para poder actualizarla. */
  /**
   * ESCRIBE una liquidacion: le abona sus utilidades, le devuelve su ahorro y
   * sus acciones, y le da de baja el vinculo.
   *
   * Vive aparte porque la usan dos caminos: la salida de una socia y el cierre
   * del grupo entero, que es lo mismo repetido por cada socia. Con el codigo
   * duplicado, dentro de seis meses las dos versiones dirian cosas distintas
   * sobre el mismo dinero.
   *
   * Los identificadores salen de la salida (`salsav_<id>`, `salacc_<id>_<valor>`),
   * asi que aplicarla dos veces no duplica nada: se detecta y se avisa.
   */
  async function escribirLiquidacion(salida, actor) {
    const sheetsClient = await getSheetsClient();
    const fecha = nowIso();
    const dia = fecha.split('T')[0];

    const movAhorro = `salsav_${salida.salidaId}`;
    const yaEscrito = (await leerSavings())
      .some((r) => (r[SAV.movId] || '').toString().trim() === movAhorro);
    if (yaEscrito) return { yaEstaba: true };

    const savRows = [];
    // Las utilidades primero, para que se vea que se le abonaron, y el egreso
    // total despues. Asi su libreta cuenta la historia completa.
    if (salida.utilidades > 0) {
      savRows.push([
        salida.email, salida.groupId, salida.utilidades, dia, 'utilidad',
        `Utilidades hasta su salida (salida ${salida.salidaId})`,
        'confirmado', actor, actor, fecha,
        `salut_${salida.salidaId}`, '',
      ]);
    }
    const devuelto = Math.round((salida.ahorro + salida.utilidades) * 100) / 100;
    if (devuelto > 0) {
      savRows.push([
        salida.email, salida.groupId, -devuelto, dia, 'retiro_salida',
        `Devolucion por salida del grupo (salida ${salida.salidaId})`,
        'confirmado', actor, actor, fecha, movAhorro, '',
      ]);
    }
    if (savRows.length > 0) {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: `Savings!A:${SAVINGS_LAST_COL}`,
        valueInputOption: 'RAW', requestBody: { values: savRows },
      });
    }

    // Las acciones, una fila negativa por cada precio distinto
    const accRows = (salida.valores || [])
      .filter((v) => Number(v.unidades) > 0)
      .map((v) => [
        salida.email, salida.groupId, dia, -Number(v.unidades), Number(v.valor), 0, fecha,
        'confirmado', actor, actor, fecha,
        `salacc_${salida.salidaId}_${Number(v.valor).toFixed(2)}`,
        `Devolucion por salida del grupo (salida ${salida.salidaId})`,
      ]);
    if (accRows.length > 0) {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID, range: `Acciones!A:${ACCIONES_LAST_COL}`,
        valueInputOption: 'RAW', requestBody: { values: accRows },
      });
    }

    // Y el vinculo se marca, no se borra: su historial es la prueba del
    // proyecto y sin el no se puede reconstruir nada.
    await conBloqueo('hoja:UserGroupLinks', async () => {
      const enlaces = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: 'UserGroupLinks!A2:F',
      });
      const filas = enlaces.data.values || [];
      const i = filas.findIndex((r) => normalizeEmailKey(r[0]) === salida.email
        && normalizeGroupKey(r[1]) === salida.groupId);
      if (i >= 0) {
        await actualizarFilaPorClave(sheetsClient, {
          spreadsheetId: SPREADSHEET_ID,
          hoja: 'UserGroupLinks',
          ultimaColumna: 'F',
          indice: i,
          clave: `${salida.email} en ${salida.groupId}`,
          esLaFila: (fila) => !!fila && normalizeEmailKey(fila[0]) === salida.email
            && normalizeGroupKey(fila[1]) === salida.groupId,
          valueInputOption: 'USER_ENTERED',
          construir: (fila) => {
            const copia = (fila || []).slice();
            while (copia.length < 6) copia.push('');
            copia[3] = 'member';   // deja cualquier cargo al salir
            copia[4] = 'retirada';
            return copia;
          },
        });
      }
    });
    return { yaEstaba: false, fecha };
  }

  async function getSalida(salidaId) {
    const id = (salidaId || '').toString().trim();
    if (!id) return null;
    const filas = await readAll(SHEETS.salidas);
    const i = filas.findIndex((r) => (r[0] || '').toString().trim() === id);
    if (i < 0) return null;
    const r = filas[i];
    return {
      salidaId: r[0], groupId: normalizeGroupKey(r[1]), email: normalizeEmailKey(r[2]),
      estado: (r[3] || 'solicitada').toString().trim().toLowerCase(),
      solicitadaEn: r[4], calculadaEn: r[5], calculadaPor: r[6],
      asambleaId: r[7], acuerdoId: r[8], aplicadaEn: r[9], mesSalida: r[10],
      ahorro: num(r[11]), accionesValor: num(r[12]), accionesUnidades: num(r[13]),
      utilidades: num(r[14]), total: num(r[15]),
      valores: (() => { try { return JSON.parse(r[16] || '[]'); } catch (e) { return []; } })(),
      nota: r[17] || '',
      _index: i, _row: r,
    };
  }

  /** La salida sin terminar de una persona en un grupo, si la hay. */
  async function salidaAbiertaDe(groupId, email) {
    const g = normalizeGroupKey(groupId);
    const e = normalizeEmailKey(email);
    const filas = await readAll(SHEETS.salidas);
    const r = filas.find((x) => normalizeGroupKey(x[1]) === g && normalizeEmailKey(x[2]) === e
      && ['solicitada', 'borrador', 'propuesta'].includes((x[3] || '').toString().trim().toLowerCase()));
    return r ? getSalida(r[0]) : null;
  }

  /**
   * Lo que le corresponde a una socia si se va hoy.
   *
   * Su ahorro confirmado, sus acciones (con el desglose por precio, porque el
   * grupo puede haber cambiado el valor de la accion por el camino) y su parte
   * de las utilidades de los meses que siguen ABIERTOS. Los meses ya cerrados no
   * se tocan: eso ya se lo cobro en su momento.
   */
  async function calcularLiquidacion(groupId, email) {
    const g = normalizeGroupKey(groupId);
    const correo = normalizeEmailKey(email);
    const reglas = await getReglas(g);
    const calc = await calcularReparto(g, reglas.baseReparto);

    const [savRows, accRows] = await Promise.all([leerSavings(), leerAcciones()]);
    const cent = (x) => Math.round(x * 100) / 100;

    const ahorro = cent(savRows
      .filter((r) => normalizeEmailKey(r[SAV.email]) === correo
        && normalizeGroupKey(r[SAV.group]) === g && aporteCuenta(r[SAV.estado]))
      .reduce((acc, r) => acc + num(r[SAV.amount]), 0));

    // Las acciones se devuelven agrupadas POR SU PRECIO: una fila negativa por
    // cada valor distinto, porque el grupo pudo cambiar cuanto vale la accion.
    const porValor = {};
    accRows
      .filter((r) => normalizeEmailKey(r[ACC.email]) === correo
        && normalizeGroupKey(r[ACC.group]) === g && aporteCuenta(r[ACC.estado]))
      .forEach((r) => {
        const valor = num(r[ACC.value]);
        const clave = valor.toFixed(2);
        porValor[clave] = cent((porValor[clave] || 0) + num(r[ACC.shares]));
      });
    const valores = Object.entries(porValor)
      .filter(([, unidades]) => unidades > 0)
      .map(([valor, unidades]) => ({ valor: Number(valor), unidades }));
    const accionesUnidades = cent(valores.reduce((acc, v) => acc + v.unidades, 0));
    const accionesValor = cent(valores.reduce((acc, v) => acc + v.unidades * v.valor, 0));

    const mio = (calc.reparto || []).find((x) => x.email === correo) || {};
    const utilidades = cent(Math.max(0, num(mio.utilidad)));

    return {
      groupId: g,
      email: correo,
      mesSalida: mesActualDelReparto(),
      ahorro,
      accionesValor,
      accionesUnidades,
      valores,
      utilidades,
      total: cent(ahorro + accionesValor + utilidades),
      base: calc.base,
    };
  }

  /** Las salidas de un grupo, de la mas nueva a la mas vieja. */
  app.get('/api/gob/salidas', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!groupId) return res.status(400).json({ success: false, message: 'Falta groupId.' });
      if (!(await assertGroupMember(req, res, groupId))) return;
      const soyLider = esLider(await getUserGroupRole(req.user.email, groupId));
      const filas = (await readAll(SHEETS.salidas))
        .filter((r) => normalizeGroupKey(r[1]) === groupId)
        // Quien no es de la directiva solo ve la suya: cuanto cobra cada socia
        // al irse no es asunto de las demas hasta que llega a la asamblea.
        .filter((r) => soyLider || normalizeEmailKey(r[2]) === req.user.email)
        .map((r) => ({
          salidaId: r[0], email: normalizeEmailKey(r[2]),
          estado: (r[3] || 'solicitada').toString().trim().toLowerCase(),
          solicitadaEn: r[4], mesSalida: r[10],
          ahorro: num(r[11]), accionesValor: num(r[12]), accionesUnidades: num(r[13]),
          utilidades: num(r[14]), total: num(r[15]),
          asambleaId: r[7], acuerdoId: r[8], aplicadaEn: r[9], nota: r[17] || '',
        }))
        .reverse();
      res.json({ success: true, salidas: filas, soyLider });
    } catch (e) {
      console.error('[GOB salidas]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al listar las salidas.' });
    }
  });

  /** Lo que le tocaria a una socia si se fuera hoy, sin congelar nada. */
  app.get('/api/gob/salida/estimacion', async (req, res) => {
    try {
      const groupId = normalizeGroupKey(req.query.groupId);
      if (!groupId) return res.status(400).json({ success: false, message: 'Falta groupId.' });
      if (!(await assertGroupMember(req, res, groupId))) return;
      const correo = normalizeEmailKey(req.query.email) || req.user.email;
      if (correo !== req.user.email
        && !esLider(await getUserGroupRole(req.user.email, groupId))) {
        return res.status(403).json({ success: false, message: 'Solo puedes ver tu propia salida.' });
      }
      res.json({ success: true, ...(await calcularLiquidacion(groupId, correo)) });
    } catch (e) {
      console.error('[GOB salida estimacion]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al calcular la liquidacion.' });
    }
  });

  /** La tesoreria calcula y CONGELA lo que se le va a pagar. */
  app.post('/api/gob/salida/:id/calcular', bloquear((r) => `salida:${r.params.id}`), async (req, res) => {
    try {
      const salida = await getSalida(req.params.id);
      if (!salida) return res.status(404).json({ success: false, message: 'Salida no encontrada.' });
      const rol = await requireLider(req, res, salida.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      if (!['solicitada', 'borrador'].includes(salida.estado)) {
        return res.status(409).json({
          success: false,
          message: `Esta salida ya esta "${salida.estado}" y sus cuentas no se vuelven a tocar.`,
        });
      }
      // Con un prestamo vivo no se liquida: la deuda quedaria incobrable.
      const activos = await contarPrestamosActivos(salida.email, salida.groupId);
      if (activos.cantidad > 0) {
        return res.status(409).json({
          success: false,
          codigo: 'PRESTAMO_VIVO',
          message: 'Esta socia todavia tiene un prestamo por pagar. Primero se salda la deuda.',
        });
      }

      const calc = await calcularLiquidacion(salida.groupId, salida.email);
      const row = salida._row.slice();
      while (row.length < SHEETS.salidas.headers.length) row.push('');
      row[3] = 'borrador';
      row[5] = nowIso();
      row[6] = req.user.email;
      row[10] = calc.mesSalida;
      row[11] = calc.ahorro;
      row[12] = calc.accionesValor;
      row[13] = calc.accionesUnidades;
      row[14] = calc.utilidades;
      row[15] = calc.total;
      row[16] = JSON.stringify(calc.valores);
      await updateRow(SHEETS.salidas, salida._index, row);

      await logGob(salida.groupId, req.user.email, 'salida_calculada', salida.salidaId,
        `${salida.email}: ahorro ${calc.ahorro}, acciones ${calc.accionesValor}, utilidades ${calc.utilidades}`);
      res.json({ success: true, salidaId: salida.salidaId, estado: 'borrador', ...calc });
    } catch (e) {
      console.error('[GOB salida calcular]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al calcular la liquidacion.' });
    }
  });

  /** Se lleva a una asamblea, como el reparto. */
  app.post('/api/gob/salida/:id/proponer', bloquear((r) => `salida:${r.params.id}`), async (req, res) => {
    try {
      const salida = await getSalida(req.params.id);
      if (!salida) return res.status(404).json({ success: false, message: 'Salida no encontrada.' });
      const rol = await requireLider(req, res, salida.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;
      if (salida.estado !== 'borrador') {
        return res.status(409).json({
          success: false,
          message: salida.estado === 'solicitada'
            ? 'Primero hay que calcular lo que le corresponde.'
            : `La salida ya esta "${salida.estado}".`,
        });
      }

      const asamblea = await getAsamblea((req.body?.asambleaId || '').toString().trim());
      if (!asamblea) return res.status(404).json({ success: false, message: 'Asamblea no encontrada.' });
      if (normalizeGroupKey(asamblea.groupId) !== salida.groupId) {
        return res.status(403).json({ success: false, message: 'Esa asamblea es de otro grupo.' });
      }
      if (!['programada', 'abierta'].includes(asamblea.estado)) {
        return res.status(409).json({ success: false, message: 'La asamblea ya no admite nuevos puntos.' });
      }

      const acuerdoId = newId('acu');
      await appendRow(SHEETS.acuerdos, [
        acuerdoId, asamblea.asambleaId, salida.groupId, 'salida_socia',
        sanitizeCell(`Salida de ${salida.email}: se le devuelven $${salida.total.toFixed(2)}`, 200),
        sanitizeCell(`Ahorro $${salida.ahorro.toFixed(2)}, acciones $${salida.accionesValor.toFixed(2)} `
          + `(${salida.accionesUnidades}), utilidades $${salida.utilidades.toFixed(2)}. `
          + `Salida ${salida.salidaId}.`, 2000),
        JSON.stringify({ salidaId: salida.salidaId }),
        'abierto', req.user.email, nowIso(), '', '', 0, 0, 0,
      ]);

      const row = salida._row.slice();
      while (row.length < SHEETS.salidas.headers.length) row.push('');
      row[3] = 'propuesta'; row[7] = asamblea.asambleaId; row[8] = acuerdoId;
      await updateRow(SHEETS.salidas, salida._index, row);

      await logGob(salida.groupId, req.user.email, 'salida_propuesta', salida.salidaId, acuerdoId);
      res.json({ success: true, acuerdoId, asambleaId: asamblea.asambleaId, estado: 'propuesta' });
    } catch (e) {
      console.error('[GOB salida proponer]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al someter la salida.' });
    }
  });

  /**
   * Con el acuerdo aprobado, se le paga y se le da de baja.
   *
   * Los identificadores de los movimientos salen de la salida, no del reloj:
   * aplicar dos veces no duplica el egreso. Es el mismo fallo que ya paso con la
   * apertura de saldos, donde una socia paso de $500 a $1.000 sin depositar nada.
   */
  app.post('/api/gob/salida/:id/aplicar', bloquear((r) => `salida:${r.params.id}`), async (req, res) => {
    try {
      const salida = await getSalida(req.params.id);
      if (!salida) return res.status(404).json({ success: false, message: 'Salida no encontrada.' });
      const rol = await requireLider(req, res, salida.groupId, new Set(['presidente', 'tesorero']));
      if (!rol) return;

      if (salida.estado === 'aplicada') {
        return res.status(409).json({ success: false, message: 'Esta salida ya se pago.' });
      }
      if (salida.estado !== 'propuesta') {
        return res.status(409).json({ success: false, message: 'Primero somete la salida a una asamblea.' });
      }
      const chk = await acuerdoAprobadoValido(salida.groupId, salida.acuerdoId, 'salida_socia');
      if (!chk.valido) {
        return res.status(409).json({
          success: false,
          message: 'La salida solo se paga con el acuerdo de asamblea aprobado.',
          detalle: chk.motivo,
        });
      }

      // Se paga lo que se VOTO. Si entre la asamblea y el pago cambiaron sus
      // cuentas (un aporte confirmado tarde, un comprobante aprobado despues),
      // se para: la asamblea aprobo una cifra concreta.
      const ahora = await calcularLiquidacion(salida.groupId, salida.email);
      const difiere = ['ahorro', 'accionesValor', 'accionesUnidades', 'utilidades']
        .filter((k) => Math.abs(ahora[k] - salida[k]) > 0.005);
      if (difiere.length > 0) {
        return res.status(409).json({
          success: false,
          motivo: 'cuentas_cambiadas',
          message: 'Sus cuentas cambiaron desde que la asamblea aprobo la salida '
            + `(${difiere.join(', ')}). Vuelve a calcularla y a someterla, para que se le `
            + 'pague lo que el grupo aprueba.',
          aprobado: { ahorro: salida.ahorro, acciones: salida.accionesValor, utilidades: salida.utilidades },
          ahora: { ahorro: ahora.ahorro, acciones: ahora.accionesValor, utilidades: ahora.utilidades },
        });
      }

      const activos = await contarPrestamosActivos(salida.email, salida.groupId);
      if (activos.cantidad > 0) {
        return res.status(409).json({
          success: false, codigo: 'PRESTAMO_VIVO',
          message: 'Le quedo un prestamo vivo. No se puede liquidar con deuda pendiente.',
        });
      }

      const escrito = await escribirLiquidacion(salida, req.user.email);
      if (escrito.yaEstaba) {
        return res.status(409).json({
          success: false, motivo: 'ya_pagada',
          message: 'Esta salida ya se pago. Recarga la pantalla.',
        });
      }

      const row = salida._row.slice();
      while (row.length < SHEETS.salidas.headers.length) row.push('');
      row[3] = 'aplicada'; row[9] = escrito.fecha;
      await updateRow(SHEETS.salidas, salida._index, row);

      await logGob(salida.groupId, req.user.email, 'salida_aplicada', salida.salidaId,
        `${salida.email} cobro ${salida.total} (ahorro ${salida.ahorro}, acciones `
        + `${salida.accionesValor}, utilidades ${salida.utilidades})`);

      res.json({
        success: true,
        estado: 'aplicada',
        pagado: salida.total,
        detalle: {
          ahorro: salida.ahorro,
          acciones: salida.accionesValor,
          unidades: salida.accionesUnidades,
          utilidades: salida.utilidades,
        },
      });
    } catch (e) {
      console.error('[GOB salida aplicar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al pagar la salida.' });
    }
  });

  /** Se descarta una salida que todavia no llego a la asamblea. */
  app.post('/api/gob/salida/:id/descartar', bloquear((r) => `salida:${r.params.id}`), async (req, res) => {
    try {
      const salida = await getSalida(req.params.id);
      if (!salida) return res.status(404).json({ success: false, message: 'Salida no encontrada.' });
      const esSuya = salida.email === req.user.email;
      if (!esSuya) {
        const rol = await requireLider(req, res, salida.groupId, new Set(['presidente', 'tesorero']));
        if (!rol) return;
      } else if (!(await assertGroupMember(req, res, salida.groupId))) return;

      if (salida.estado === 'aplicada') {
        return res.status(409).json({ success: false, message: 'Esta salida ya se pago.' });
      }
      // Una salida que la asamblea ya aprobo no se cancela con una sola firma:
      // hay que anular su acuerdo en la asamblea.
      if (salida.estado === 'propuesta') {
        const chk = await acuerdoAprobadoValido(salida.groupId, salida.acuerdoId, 'salida_socia');
        if (chk.valido) {
          return res.status(409).json({
            success: false,
            message: 'La asamblea ya aprobo esta salida. Para deshacerla hay que anular el '
              + 'acuerdo en la asamblea, no cancelarla desde aqui.',
          });
        }
      }

      const row = salida._row.slice();
      while (row.length < SHEETS.salidas.headers.length) row.push('');
      row[3] = 'descartada';
      row[17] = sanitizeCell(req.body?.motivo || '', 200);
      await updateRow(SHEETS.salidas, salida._index, row);
      await logGob(salida.groupId, req.user.email, 'salida_descartada', salida.salidaId,
        req.body?.motivo || '');
      res.json({ success: true, estado: 'descartada' });
    } catch (e) {
      console.error('[GOB salida descartar]', e);
      if (responderSiEsCuota(res, e)) return;
      res.status(500).json({ success: false, message: 'Error al descartar la salida.' });
    }
  });

  return {
    getReglas,
    ahorroConfirmado,
    miembrosActivos,
    estadoAporte,
    aporteCuenta,
    newId,
    SHEETS,
    logGob,
    mesCerradoDelGrupo,
    avalVigenteDe,
    loQueAvala,
    getSalida,
    salidaAbiertaDe,
    calcularLiquidacion,
    crearSalida: async (groupId, email) => {
      const salidaId = newId('sal');
      await appendRow(SHEETS.salidas, [
        salidaId, normalizeGroupKey(groupId), normalizeEmailKey(email), 'solicitada',
        nowIso(), '', '', '', '', '', '', 0, 0, 0, 0, 0, '[]', '',
      ]);
      return salidaId;
    },
  };
};
