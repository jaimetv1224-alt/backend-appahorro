/**
 * Cuanto del funcionamiento del grupo se ha pasado de verdad a la app.
 *
 * Los indicadores de metricas.js dicen si la plataforma se usa y si responde
 * rapido. Este modulo responde a otra cosa, que es la pregunta del proyecto:
 * ¿que procesos del banco comunal siguen en el cuaderno y cuales ya viven aqui?
 *
 * Se mide de tres formas, porque una sola no basta:
 *
 *   1. UNA ESCALERA de nueve hitos. Cada uno es un proceso concreto del grupo
 *      que o esta en la app o no lo esta. No es una opinion: cada hito tiene la
 *      fecha del dia en que ocurrio por primera vez.
 *   2. EL TRASPASO del papel: si el grupo cargo sus saldos de apertura, cuando,
 *      y cuanto trajo. Es el momento exacto de la migracion.
 *   3. LA EVOLUCION mes a mes, para poder dibujar la curva y no solo una foto.
 *
 * Un aviso que importa para el informe: la escalera mide COBERTURA (que
 * procesos entraron), no INTENSIDAD (que parte de cada proceso entro). Un grupo
 * que registro un solo prestamo y otro que registro treinta marcan el mismo
 * hito. Por eso cada hito viaja con su cuenta, y la intensidad se lee en la
 * serie mensual.
 */

'use strict';

const DIA = 24 * 3600 * 1000;

const pct = (parte, total) => (total > 0
  ? Math.min(100, Math.max(0, Math.round((parte / total) * 1000) / 10))
  : 0);

function fecha(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Solo el dia, para que todas las fechas de la escalera se lean igual. */
function soloDia(v) {
  const f = fecha(v);
  return f ? f.toISOString().slice(0, 10) : null;
}

/** La mas antigua de una lista de fechas, en formato AAAA-MM-DD. */
function primeraFecha(valores = []) {
  const f = (valores || []).map(fecha).filter(Boolean).sort((a, b) => a - b)[0];
  return f ? f.toISOString().slice(0, 10) : null;
}

// ---------------------------------------------------------------------------
// 1. LA ESCALERA
// ---------------------------------------------------------------------------

/**
 * Los nueve hitos, en el orden en que un grupo suele alcanzarlos. El orden
 * importa: sirve para decir "lo siguiente que le falta a este grupo es X".
 */
const HITOS = [
  {
    clave: 'existe',
    titulo: 'El grupo está creado en la app',
    ayuda: 'Con su nombre, su valor de acción y su porcentaje de interés.',
  },
  {
    clave: 'entraron',
    titulo: 'La mitad del grupo ha entrado al menos una vez',
    ayuda: 'Tener cuenta no es usarla. Este es el primer paso real.',
  },
  {
    clave: 'aportes',
    titulo: 'Los aportes se registran en la app',
    ayuda: 'Ahorros o compra de acciones anotados aquí y no solo en el cuaderno.',
  },
  {
    clave: 'confirmacion',
    titulo: 'La tesorería confirma los aportes en la app',
    ayuda: 'Quien registra no confirma: es el control interno funcionando.',
  },
  {
    clave: 'prestamos',
    titulo: 'Los préstamos se piden y se resuelven en la app',
    ayuda: 'Con la solicitud, el voto de la directiva y el cuadro de cuotas.',
  },
  {
    clave: 'comprobantes',
    titulo: 'Los pagos se respaldan con comprobante',
    ayuda: 'La foto del depósito queda guardada y alguien la revisa.',
  },
  {
    clave: 'asambleas',
    titulo: 'Las asambleas quedan registradas con su asistencia',
    ayuda: 'Convocatoria, quién asistió y qué se trató.',
  },
  {
    clave: 'acuerdos',
    titulo: 'Los acuerdos se votan y quedan en acta',
    ayuda: 'Lo que se decide queda escrito y con los votos contados.',
  },
  {
    clave: 'reparto',
    titulo: 'El reparto de utilidades se hace en la app',
    ayuda: 'El cierre del ciclo: lo que ganó el grupo, repartido y abonado.',
  },
];

/**
 * @param {Object} datos  un objeto por hito: { logrado, fecha, cuenta, detalle }
 * @returns escalera con el porcentaje y el siguiente paso pendiente
 */
function escalera(datos = {}) {
  const hitos = HITOS.map((h) => {
    const d = datos[h.clave] || {};
    return {
      clave: h.clave,
      titulo: h.titulo,
      ayuda: h.ayuda,
      logrado: !!d.logrado,
      desde: soloDia(d.fecha),
      cuenta: Number(d.cuenta) || 0,
      detalle: d.detalle || '',
    };
  });

  const logrados = hitos.filter((h) => h.logrado);
  const siguiente = hitos.find((h) => !h.logrado) || null;

  return {
    hitos,
    logrados: logrados.length,
    total: hitos.length,
    pct: pct(logrados.length, hitos.length),
    // El primero que falta, en el orden natural: es lo que hay que acompañar
    siguiente: siguiente
      ? { clave: siguiente.clave, titulo: siguiente.titulo, ayuda: siguiente.ayuda }
      : null,
    // Cuando empezo a digitalizarse de verdad (primer hito de proceso)
    desde: primeraFecha(hitos
      .filter((h) => h.logrado && h.clave !== 'existe')
      .map((h) => h.desde)),
  };
}

// ---------------------------------------------------------------------------
// 2. EL TRASPASO DEL PAPEL
// ---------------------------------------------------------------------------

/**
 * Si el grupo cargo sus saldos de apertura, ese es el dia en que dejo el
 * cuaderno. Un grupo que empezo directamente aqui no tiene traspaso, y eso no
 * es un defecto: hay que distinguirlo de uno que no lo ha hecho todavia.
 *
 * @param {Array} lotes  filas de LotesApertura ya del grupo
 * @param {Object} contexto  { tuvoActividadAntes }
 */
function traspaso(lotes = [], contexto = {}, ahora = new Date()) {
  const aplicados = (lotes || [])
    .filter((l) => l && (l.estado || '').toString().toLowerCase() === 'aplicado')
    .sort((a, b) => String(a.aplicadoEn || '').localeCompare(String(b.aplicadoEn || '')));

  if (aplicados.length === 0) {
    return {
      hecho: false,
      fecha: null,
      diasDesde: null,
      motivo: contexto.tuvoActividadAntes
        ? 'El grupo trabaja en la app pero no cargó sus saldos anteriores.'
        : 'Todavía no ha traído lo que tenía en papel.',
      totales: null,
      lotes: 0,
    };
  }

  const suma = (campo) => Math.round(aplicados
    .reduce((s, l) => s + (Number(l[campo]) || 0), 0) * 100) / 100;
  const f = fecha(aplicados[0].aplicadoEn);

  return {
    hecho: true,
    fecha: f ? f.toISOString() : null,
    diasDesde: f ? Math.max(0, Math.floor((ahora.getTime() - f.getTime()) / DIA)) : null,
    motivo: '',
    totales: {
      ahorro: suma('totalAhorro'),
      acciones: suma('totalAcciones'),
      deuda: suma('totalDeuda'),
      miembros: aplicados.reduce((s, l) => s + (Number(l.miembros) || 0), 0),
    },
    lotes: aplicados.length,
  };
}

// ---------------------------------------------------------------------------
// 3. LA EVOLUCION MES A MES
// ---------------------------------------------------------------------------

const TIPOS = ['entradas', 'aportes', 'prestamos', 'comprobantes', 'asambleas'];

/**
 * Agrupa la actividad por mes para poder dibujar la curva.
 *
 * @param {Array} eventos  [{ fecha, tipo }] con tipo dentro de TIPOS
 * @param {Number} meses   cuantos meses hacia atras devolver (0 = todos)
 */
function serieMensual(eventos = [], meses = 12, ahora = new Date()) {
  const cubos = {};
  for (const e of (eventos || [])) {
    const f = fecha(e && e.fecha);
    if (!f || !TIPOS.includes(e.tipo)) continue;
    const mes = f.toISOString().slice(0, 7);
    if (!cubos[mes]) {
      cubos[mes] = { mes, total: 0 };
      TIPOS.forEach((x) => { cubos[mes][x] = 0; });
    }
    cubos[mes][e.tipo] += 1;
    cubos[mes].total += 1;
  }

  // Los meses sin actividad tambien salen: un hueco en la curva es informacion
  const lista = Object.values(cubos).sort((a, b) => a.mes.localeCompare(b.mes));
  if (lista.length === 0) return [];

  // Todo el recorrido en UTC. Mezclar getMonth() (hora local) con Date.UTC
  // desplazaba la curva un mes entero en Ecuador (UTC-5): el mes de junio
  // aparecia como mayo, porque el 1 de junio a medianoche UTC aqui son las
  // 19:00 del 31 de mayo.
  const mesUTC = (a, m) => Date.UTC(a, m, 1);
  const finMes = mesUTC(ahora.getUTCFullYear(), ahora.getUTCMonth());
  const primero = Date.parse(`${lista[0].mes}-01T00:00:00Z`);
  const desde = meses > 0
    ? mesUTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - (meses - 1))
    : primero;
  const arranque = Math.max(desde, primero);

  const salida = [];
  const cursor = new Date(arranque);
  const tope = new Date(finMes);
  while (cursor <= tope) {
    const mes = cursor.toISOString().slice(0, 7);
    if (cubos[mes]) salida.push(cubos[mes]);
    else {
      const vacio = { mes, total: 0 };
      TIPOS.forEach((x) => { vacio[x] = 0; });
      salida.push(vacio);
    }
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return salida;
}

/**
 * Compara los ultimos meses con los anteriores. Sirve para decir si el grupo
 * va a mas o a menos, que es lo que no se ve en una foto fija.
 */
function tendencia(serie = [], ventana = 3) {
  const s = (serie || []).filter((x) => x && typeof x.total === 'number');
  if (s.length < ventana * 2) {
    return {
      hayDatos: false,
      motivo: `Hacen falta al menos ${ventana * 2} meses para comparar.`,
      reciente: null,
      anterior: null,
      cambioPct: null,
    };
  }
  const media = (trozo) => Math.round((trozo.reduce((a, b) => a + b.total, 0) / trozo.length) * 10) / 10;
  const reciente = media(s.slice(-ventana));
  const anterior = media(s.slice(-ventana * 2, -ventana));
  const cambio = anterior > 0
    ? Math.round(((reciente - anterior) / anterior) * 1000) / 10
    : (reciente > 0 ? null : 0);
  return {
    hayDatos: true,
    motivo: '',
    reciente,
    anterior,
    // null = antes no habia nada con que comparar; no es un crecimiento infinito
    cambioPct: cambio,
    sentido: cambio === null ? 'arranque' : cambio > 10 ? 'sube' : cambio < -10 ? 'baja' : 'estable',
  };
}

module.exports = {
  HITOS, TIPOS, escalera, traspaso, serieMensual, tendencia, primeraFecha, soloDia, pct,
};
