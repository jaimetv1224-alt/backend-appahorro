/**
 * Indicadores para evaluar la plataforma.
 *
 * La pregunta que hay que poder responder al final del piloto es: ¿sirvio de
 * algo? Para eso no basta con contar usuarios. Hacen falta tres cosas:
 *
 *   1. ADOPCION: cuanta gente que se registro llego a usarla de verdad, y
 *      cuanta la sigue usando semanas despues.
 *   2. TIEMPOS: cuanto tarda el grupo en confirmar un aporte, en resolver un
 *      prestamo, en revisar un comprobante. Es el indicador mas util para
 *      contrastar contra el cuaderno de papel, donde todo esperaba a la
 *      reunion mensual.
 *   3. SALUD DEL GRUPO: que porcentaje de aportes se confirma, cuantos
 *      prestamos van al dia, cuanta gente asiste y vota en las asambleas.
 *
 * Todo se calcula aqui, sin tocar Google Sheets ni Express, para poder
 * comprobarlo con numeros hechos a mano.
 *
 * Sobre la MEDIANA: se informa junto a la media a proposito. Con pocos casos,
 * un solo retraso de tres semanas dispara la media y hace parecer que el grupo
 * es lento cuando casi todo se resuelve en horas. La mediana no se deja
 * arrastrar por ese caso, y para un informe hay que enseñar las dos.
 */

'use strict';

const HORA = 3600 * 1000;
const DIA = 24 * HORA;

const cent = (n) => Math.round((Number(n) || 0) * 100) / 100;
// Un porcentaje se queda entre 0 y 100 pase lo que pase. Un acta con mas votos
// que asistentes (porque no se registro bien la asistencia) daba un 225 % de
// participacion, y una cifra asi en un informe lo invalida entero.
const pct = (parte, total) => (total > 0
  ? Math.min(100, Math.max(0, Math.round((parte / total) * 1000) / 10))
  : 0);

/** Fecha valida o null. Las hojas traen de todo. */
function fecha(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Estadistica de una lista de duraciones en horas.
 * Se devuelve n siempre: un indicador sin saber sobre cuantos casos se calculo
 * no se puede interpretar ni defender en un informe.
 */
function estadistica(horas = []) {
  const v = (horas || []).filter((h) => Number.isFinite(h) && h >= 0).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, media: null, mediana: null, min: null, max: null, p90: null };
  const suma = v.reduce((s, x) => s + x, 0);
  const mitad = Math.floor(v.length / 2);
  return {
    n: v.length,
    media: cent(suma / v.length),
    mediana: cent(v.length % 2 ? v[mitad] : (v[mitad - 1] + v[mitad]) / 2),
    min: cent(v[0]),
    max: cent(v[v.length - 1]),
    p90: cent(v[Math.min(v.length - 1, Math.ceil(v.length * 0.9) - 1)]),
  };
}

/** Horas entre dos momentos, o null si falta alguno o van al reves. */
function horasEntre(desde, hasta) {
  const a = fecha(desde);
  const b = fecha(hasta);
  if (!a || !b) return null;
  const h = (b.getTime() - a.getTime()) / HORA;
  return h >= 0 ? h : null;
}

// ---------------------------------------------------------------------------
// 1. ADOPCION
// ---------------------------------------------------------------------------

/**
 * @param {Array} personas  [{ email, alta }]
 * @param {Object} accesosPorPersona  { email: [{ fecha }] }
 * @param {Date}  ahora
 */
function adopcion(personas = [], accesosPorPersona = {}, ahora = new Date()) {
  const hoy = ahora.getTime();
  const gente = (personas || []).filter((p) => p && p.email);
  const total = gente.length;

  const conAcceso = gente.filter((p) => (accesosPorPersona[p.email] || []).length > 0);

  // Una entrada fechada en el futuro no es actividad reciente: es un reloj mal
  // puesto o una celda editada a mano. Se tolera un dia de desajuste, no mas;
  // sin eso, una fila del ano 3000 hacia figurar a esa persona como activa
  // esta semana para siempre.
  const activosEn = (dias) => gente.filter((p) => (accesosPorPersona[p.email] || [])
    .some((a) => {
      const f = fecha(a.fecha);
      if (!f) return false;
      const desde = hoy - f.getTime();
      return desde >= -DIA && desde <= dias * DIA;
    })).length;

  // Cuanto tarda alguien en entrar por primera vez desde que se registro
  const horasHastaPrimerAcceso = gente.map((p) => {
    const acc = (accesosPorPersona[p.email] || [])
      .map((a) => fecha(a.fecha)).filter(Boolean).sort((a, b) => a - b);
    return acc.length ? horasEntre(p.alta, acc[0].toISOString()) : null;
  }).filter((h) => h !== null);

  // Retencion: de los que llegaron a entrar, cuantos seguian entrando despues
  const retenidos = (dias) => {
    const candidatos = conAcceso.filter((p) => {
      const primer = (accesosPorPersona[p.email] || [])
        .map((a) => fecha(a.fecha)).filter(Boolean).sort((a, b) => a - b)[0];
      // Solo cuenta quien tuvo tiempo de volver
      return primer && hoy - primer.getTime() >= dias * DIA;
    });
    if (candidatos.length === 0) return { base: 0, volvieron: 0, pct: null };
    const volvieron = candidatos.filter((p) => {
      const acc = (accesosPorPersona[p.email] || [])
        .map((a) => fecha(a.fecha)).filter(Boolean).sort((a, b) => a - b);
      const primer = acc[0];
      return acc.some((f) => f.getTime() - primer.getTime() >= dias * DIA);
    }).length;
    return { base: candidatos.length, volvieron, pct: pct(volvieron, candidatos.length) };
  };

  // Solo las entradas de quien pertenece a la lista que se esta midiendo. Si se
  // pasan los accesos de todo el mundo para medir un grupo, las de quien ya se
  // salio no pueden inflar el promedio del grupo.
  const entradas = gente.reduce((s, p) => s + (accesosPorPersona[p.email] || []).length, 0);

  return {
    registradas: total,
    activaron: conAcceso.length,
    tasaActivacion: pct(conAcceso.length, total),
    nuncaEntraron: total - conAcceso.length,
    activosUltimos7: activosEn(7),
    activosUltimos30: activosEn(30),
    entradasTotales: entradas,
    entradasPorPersonaActiva: conAcceso.length
      ? cent(entradas / conAcceso.length) : 0,
    horasHastaPrimerAcceso: estadistica(horasHastaPrimerAcceso),
    retencion7: retenidos(7),
    retencion30: retenidos(30),
  };
}

// ---------------------------------------------------------------------------
// 2. TIEMPOS DE RESPUESTA
// ---------------------------------------------------------------------------

/**
 * Cuanto tarda el grupo en resolver cada cosa. Es el indicador que permite
 * contrastar con el cuaderno: alli todo esperaba a la reunion mensual.
 *
 * @param {Object} eventos  { aportes: [{creado, resuelto, estado}], ... }
 */
function tiemposDeRespuesta(eventos = {}) {
  // Estar resuelto y saber CUANDO se resolvio son dos cosas distintas. Una
  // solicitud aprobada hace meses, de la que no quedo registrada la hora de la
  // decision, esta resuelta: lo unico que pasa es que no entra en el tiempo
  // medio. Contarla como pendiente seria decir que alguien sigue esperando.
  const bloque = (nombre, lista) => {
    const l = lista || [];
    const cerrados = l.filter((x) => (x.cerrado === undefined ? !!x.resuelto : !!x.cerrado));
    const horas = estadistica(l
      .map((x) => horasEntre(x.creado, x.resuelto))
      .filter((h) => h !== null));
    return {
      nombre,
      total: l.length,
      resueltos: cerrados.length,
      pendientes: l.length - cerrados.length,
      // Resueltos de los que no se pudo medir el tiempo, para que se vea sobre
      // cuantos casos se calculo de verdad la mediana
      sinFecha: Math.max(0, cerrados.length - horas.n),
      horas,
    };
  };

  const partes = [
    bloque('confirmar un aporte', eventos.aportes),
    bloque('resolver un prestamo', eventos.prestamos),
    bloque('revisar un comprobante', eventos.comprobantes),
    bloque('celebrar una asamblea', eventos.asambleas),
  ];

  // Un solo numero para comparar grupos entre si. Se juntan TODAS las esperas
  // reales y se saca la mediana de ese monton: "la mitad de las cosas se
  // resuelven en menos de X horas". Promediar las medianas de los cuatro
  // procesos daria un numero que no le paso a nadie.
  const todas = [
    ...(eventos.aportes || []), ...(eventos.prestamos || []),
    ...(eventos.comprobantes || []), ...(eventos.asambleas || []),
  ].map((x) => horasEntre(x.creado, x.resuelto)).filter((h) => h !== null);

  // Y el proceso mas lento, que es por donde hay que empezar a mejorar
  const conDato = partes.filter((p) => p.horas.n > 0);
  const peor = conDato.length
    ? conDato.reduce((a, b) => (b.horas.mediana > a.horas.mediana ? b : a))
    : null;

  const global = estadistica(todas);
  return {
    partes,
    global,
    medianaGeneral: global.mediana,
    peorProceso: peor ? { nombre: peor.nombre, mediana: peor.horas.mediana, n: peor.horas.n } : null,
    pendientesTotales: partes.reduce((s, p) => s + p.pendientes, 0),
  };
}

// ---------------------------------------------------------------------------
// 3. SALUD DEL GRUPO
// ---------------------------------------------------------------------------

/**
 * @param {Object} datos {
 *   aportes:[{estado}], prestamos:[{estado, alDia}],
 *   asambleas:[{presentes, miembros, estado}], votos:[{emitidos, presentes}]
 * }
 */
function saludDelGrupo(datos = {}) {
  const aportes = datos.aportes || [];
  const confirmados = aportes.filter((a) => a.estado === 'confirmado').length;
  const rechazados = aportes.filter((a) => a.estado === 'rechazado').length;
  const pendientes = aportes.filter((a) => a.estado === 'pendiente').length;

  const prestamos = datos.prestamos || [];
  const alDia = prestamos.filter((p) => p.alDia === true).length;
  const atrasados = prestamos.filter((p) => p.alDia === false).length;

  const asambleas = (datos.asambleas || []).filter((a) => Number(a.miembros) > 0);
  const asistencias = asambleas.map((a) => pct(Number(a.presentes) || 0, Number(a.miembros)));
  const mediaAsistencia = asistencias.length
    ? cent(asistencias.reduce((s, x) => s + x, 0) / asistencias.length) : null;

  const votos = datos.votos || [];
  const participacionVoto = votos.length
    ? cent(votos.map((v) => pct(Number(v.emitidos) || 0, Number(v.presentes) || 0))
      .reduce((s, x) => s + x, 0) / votos.length) : null;

  return {
    aportes: {
      total: aportes.length,
      confirmados,
      rechazados,
      pendientes,
      tasaConfirmacion: pct(confirmados, aportes.length),
      tasaRechazo: pct(rechazados, aportes.length),
    },
    prestamos: {
      total: prestamos.length,
      alDia,
      atrasados,
      tasaAlDia: pct(alDia, alDia + atrasados),
    },
    asambleas: {
      celebradas: asambleas.length,
      asistenciaMedia: mediaAsistencia,
      participacionEnVotos: participacionVoto,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. UNA NOTA POR GRUPO, PARA PODER COMPARARLOS
// ---------------------------------------------------------------------------

/**
 * Resume la salud de un grupo en un numero de 0 a 100, para ordenarlos y ver
 * de un vistazo cuales van bien y cuales necesitan acompañamiento.
 *
 * Es una nota orientativa, no una medida cientifica: sirve para priorizar a
 * quien visitar, no para concluir nada por si sola. Por eso se devuelve
 * siempre con su desglose, para poder mirar de donde sale.
 */
// Peso minimo de conceptos calculables para que la nota se pueda publicar.
// 35 (solo uso) no llega: hace falta el uso mas alguna actividad real.
const COBERTURA_MINIMA = 50;

function notaDelGrupo({ adopcion: ad, tiempos, salud } = {}) {
  const partes = [];
  // Ningun concepto puede valer mas de 100 ni menos de 0, venga como venga
  const acotar = (v) => Math.min(100, Math.max(0, Number(v) || 0));

  // Cuanta de su gente lo usa (35 %)
  if (ad && ad.registradas > 0) {
    partes.push({ concepto: 'uso', peso: 35, valor: acotar(ad.tasaActivacion) });
  }
  // Con que rapidez resuelve (25 %): 24 h o menos es lo mejor, una semana es 0
  if (tiempos && tiempos.medianaGeneral !== null) {
    const h = tiempos.medianaGeneral;
    const v = h <= 24 ? 100 : h >= 168 ? 0 : Math.round(100 - ((h - 24) / (168 - 24)) * 100);
    partes.push({ concepto: 'rapidez', peso: 25, valor: acotar(v) });
  }
  // Que sus aportes se confirmen (20 %)
  if (salud && salud.aportes && salud.aportes.total > 0) {
    partes.push({ concepto: 'aportes confirmados', peso: 20, valor: acotar(salud.aportes.tasaConfirmacion) });
  }
  // Que sus prestamos vayan al dia (10 %)
  if (salud && salud.prestamos && (salud.prestamos.alDia + salud.prestamos.atrasados) > 0) {
    partes.push({ concepto: 'prestamos al dia', peso: 10, valor: acotar(salud.prestamos.tasaAlDia) });
  }
  // Que la gente asista a las asambleas (10 %)
  if (salud && salud.asambleas && salud.asambleas.asistenciaMedia !== null) {
    partes.push({ concepto: 'asistencia', peso: 10, valor: acotar(salud.asambleas.asistenciaMedia) });
  }

  const pesoTotal = partes.reduce((s, p) => s + p.peso, 0);

  // Un grupo del que solo se sabe que alguien entro una vez NO puede sacar 100.
  // Con menos de la mitad de los conceptos el numero no significa nada, y en un
  // informe se leeria como "este grupo va perfecto" cuando lo cierto es que no
  // hizo nada. En ese caso no hay nota: hay una explicacion.
  if (pesoTotal < COBERTURA_MINIMA) {
    return {
      nota: null,
      partes,
      cobertura: pct(pesoTotal, 100),
      motivo: partes.length === 0
        ? 'Todavia no hay actividad que permita calcularla.'
        : 'Hay muy poca actividad todavia; con estos datos la nota enganaria.',
    };
  }

  const nota = Math.min(100, Math.max(0,
    Math.round(partes.reduce((s, p) => s + p.valor * p.peso, 0) / pesoTotal)));
  return {
    nota,
    partes,
    cobertura: pct(pesoTotal, 100),   // sobre cuanto del total se pudo calcular
    motivo: pesoTotal < 100
      ? 'Faltan datos de algunos conceptos; la nota se calculo con los disponibles.'
      : '',
  };
}

module.exports = {
  estadistica, horasEntre, adopcion, tiemposDeRespuesta, saludDelGrupo, notaDelGrupo, pct, cent,
};
