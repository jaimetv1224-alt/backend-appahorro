/**
 * Reparto de utilidades entre los socios.
 *
 * El grupo gana dinero cobrando intereses por los prestamos. Ese dinero es del
 * grupo, y al cierre se reparte entre quienes pusieron el capital, en
 * proporcion a lo que cada quien aporto.
 *
 * Antes el sistema abonaba a cada socio un porcentaje sobre sus acciones sin
 * mirar lo que el grupo habia ganado. Si el grupo tenia prestada la mitad del
 * capital, repartia mas de lo que entro: dinero que no existe.
 *
 * Aqui se hace al reves, que es como funciona una caja comunal:
 *   1. Se suma lo que el grupo GANO de verdad en intereses cobrados, MES A MES.
 *   2. Se mira cuanto tenia puesto cada socio EN CADA UNO DE ESOS MESES.
 *   3. Se reparte lo ganado en cada mes entre quienes ya estaban, al centavo.
 *
 * El paso 2 es el que faltaba. Repartiendo sobre la foto de HOY, una socia que
 * entra en septiembre cobra su parte de los intereses de marzo, que se pagaron
 * con el dinero de las demas. Medido en un grupo de prueba: la que entro el
 * ultimo mes se llevaba el 23% de lo ganado en los seis meses anteriores.
 *
 * Regla de participacion: se participa de lo ganado en el mes en que ya se
 * tenia el dinero puesto, y de los siguientes. Quien compra acciones en agosto
 * participa de agosto en adelante, no de julio. Se cuenta el mes de entrada
 * entero (y no desde el mes siguiente) porque estos grupos trabajan por ciclos
 * mensuales: con la regla estricta, el primer mes de vida de un grupo no
 * repartiria nada y el dinero quedaria colgado.
 *
 * No depende de Google Sheets ni de Express: se puede probar sola.
 */

'use strict';

const { partesDeFecha } = require('./cuotas');

const centavos = (n) => Math.round((Number(n) || 0) * 100) / 100;

const BASES = new Set(['acciones', 'ahorros', 'ambos']);

// --------------------------------------------------------------------------
// FECHAS
//
// Nunca se pasa por UTC para sacar el mes. `new Date('2026-09-30T20:00:00')` en
// Ecuador (UTC-5) da el 1 de octubre en UTC: un pago del 30 de septiembre se
// contaria como ganancia de octubre y lo cobrarian los que entraron en octubre.
// --------------------------------------------------------------------------

/** Un mes solo vale si es un mes de verdad, de un ano en el que puede haber un grupo. */
function mesValido(anio, mes) {
  return Number.isInteger(anio) && Number.isInteger(mes)
    && anio >= 1990 && anio <= 2100 && mes >= 1 && mes <= 12;
}

const arma = (anio, mes) => (mesValido(anio, mes)
  ? `${anio}-${String(mes).padStart(2, '0')}` : '');

/**
 * Una celda con formato de fecha de Excel guarda un NUMERO de dias desde el
 * 30 de diciembre de 1899. Es lo que sale al dar formato a la columna, y llega
 * a la app como 45000 a secas.
 */
function deSerialDeExcel(n) {
  const dias = Number(n);
  if (!Number.isFinite(dias) || dias < 1 || dias > 80000) return '';
  const d = new Date(Date.UTC(1899, 11, 30) + Math.trunc(dias) * 86400000);
  return arma(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

/**
 * Cualquier fecha razonable -> 'AAAA-MM'. Devuelve '' si no se entiende.
 *
 * Devolver '' es importante: en el reparto, una fecha vacia significa "ya estaba
 * puesto desde siempre", que es lo prudente. Antes un numero de serie de Excel
 * daba el ano 45000, posterior a cualquier mes real, y esa socia quedaba fuera
 * de TODOS los repartos sin que nadie lo notara.
 */
function mesDe(fecha) {
  if (fecha === null || fecha === undefined || fecha === '') return '';

  // Un numero suelto es un serial de Excel, no un ano
  if (typeof fecha === 'number' || /^\d{1,6}(\.\d+)?$/.test(String(fecha).trim())) {
    return deSerialDeExcel(fecha);
  }

  const partes = partesDeFecha(fecha);
  if (partes) return arma(partes.a, partes.m);

  const texto = String(fecha).trim();
  // 'AAAA-MM' a secas
  const corto = texto.match(/^(\d{4})-(\d{1,2})$/);
  if (corto) return arma(Number(corto[1]), Number(corto[2]));
  // 'DD/MM/AAAA', que es como lo escribe la gente en la hoja
  const barras = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (barras) {
    const a = Number(barras[3]);
    const uno = Number(barras[1]);
    const dos = Number(barras[2]);
    // Si el segundo numero no puede ser un mes, la fecha venia al reves
    const mes = dos >= 1 && dos <= 12 ? dos : uno;
    return arma(a, mes);
  }

  const d = new Date(texto);
  if (Number.isNaN(d.getTime())) return '';
  // Componentes LOCALES, no UTC, por lo dicho arriba
  return arma(d.getFullYear(), d.getMonth() + 1);
}

/** Lista de meses 'AAAA-MM' entre dos, ambos incluidos. */
function mesesEntre(desde, hasta) {
  const salida = [];
  const a = mesDe(desde);
  const b = mesDe(hasta);
  if (!a || !b || a > b) return salida;
  let [anio, mes] = a.split('-').map(Number);
  const [anioFin, mesFin] = b.split('-').map(Number);
  while (anio < anioFin || (anio === anioFin && mes <= mesFin)) {
    salida.push(`${anio}-${String(mes).padStart(2, '0')}`);
    mes += 1;
    if (mes > 12) { mes = 1; anio += 1; }
  }
  return salida;
}

/** El mes en curso, en hora local del servidor. */
const mesActual = (hoy = new Date()) => (
  `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}`);

// --------------------------------------------------------------------------
// REPARTIR CENTAVOS
// --------------------------------------------------------------------------

/**
 * Parte un importe entre varios pesos, en CENTAVOS ENTEROS, sin perder ni
 * inventar un centavo.
 *
 * Con coma flotante, 19 * 0,12 * 100 da 227,99999999999997 y truncar dejaba 227
 * en vez de 228: la socia perdia un centavo por un error de representacion.
 *
 * Lo que sobra del truncado se reparte por el METODO DEL MAYOR RESTO, el mismo
 * que se usa para repartir escanos: se lo lleva quien mas cerca estaba de
 * ganarlo. Antes se le daba a quien mas capital tenia, asi que el redondeo
 * favorecia siempre a los grandes.
 *
 * @param {number} total    importe a repartir
 * @param {Array}  pesos    [{ clave, peso }]
 * @returns {Map} clave -> importe en dolares
 */
function repartirCentavos(total, pesos = []) {
  const salida = new Map();
  const lista = (Array.isArray(pesos) ? pesos : [])
    .map((p) => ({ clave: p.clave, peso: Math.max(0, Number(p.peso) || 0) }));
  const sumaPesos = lista.reduce((s, p) => s + p.peso, 0);
  const totalCentavos = Math.round((Number(total) || 0) * 100);
  lista.forEach((p) => salida.set(p.clave, 0));
  if (totalCentavos <= 0 || sumaPesos <= 0) return salida;

  const conResto = lista.map((p) => {
    const exacto = (totalCentavos * p.peso) / sumaPesos;
    const entero = Math.floor(exacto);
    return { ...p, cent: entero, resto: exacto - entero };
  });

  let sobrante = totalCentavos - conResto.reduce((s, p) => s + p.cent, 0);
  const porResto = [...conResto].sort((a, b) => (
    b.resto - a.resto
    || b.peso - a.peso
    || String(a.clave).localeCompare(String(b.clave))
  ));
  let i = 0;
  while (sobrante > 0 && porResto.length > 0) {
    porResto[i % porResto.length].cent += 1;
    sobrante -= 1;
    i += 1;
  }

  conResto.forEach((p) => salida.set(p.clave, p.cent / 100));
  return salida;
}

// --------------------------------------------------------------------------
// LO QUE EL GRUPO GANO
// --------------------------------------------------------------------------

/**
 * Interes que un prestamo ya le dejo al grupo.
 *
 * Cada cuota lleva la misma proporcion de capital y de interes, asi que el
 * interes cobrado va en proporcion a lo devuelto. Solo cuenta el dinero que de
 * verdad entro: los pagos aprobados.
 *
 * @param {object} prestamo { principal, total, pagado }
 */
function interesCobrado(prestamo) {
  const principal = centavos(prestamo && prestamo.principal);
  const total = centavos(prestamo && prestamo.total);
  const pagado = centavos(prestamo && prestamo.pagado);
  if (!(total > 0) || !(principal >= 0) || total < principal) return 0;
  const interesTotal = centavos(total - principal);
  if (interesTotal <= 0 || pagado <= 0) return 0;
  const proporcion = Math.min(1, pagado / total);
  return centavos(interesTotal * proporcion);
}

/** Lo que el grupo ha ganado, sumando todos sus prestamos. */
function gananciaDelGrupo(prestamos = []) {
  const lista = Array.isArray(prestamos) ? prestamos : [];
  const detalle = lista.map((p) => ({
    loanId: p.loanId || '',
    userEmail: p.userEmail || '',
    principal: centavos(p.principal),
    total: centavos(p.total),
    pagado: centavos(p.pagado),
    interesGanado: interesCobrado(p),
  }));
  return {
    detalle,
    total: centavos(detalle.reduce((s, d) => s + d.interesGanado, 0)),
  };
}

/**
 * Lo que el grupo gano CADA MES, por los intereses efectivamente cobrados.
 *
 * NINGUN PAGO SE DESCARTA POR NO TRAER FECHA. La version anterior de este
 * calculo hacia `continue` cuando un pago venia sin fecha, y el interes de ese
 * pago desaparecia: medido, un prestamo de $1.000 devuelto por $1.120 con dos
 * pagos de $560, uno fechado y otro no, declaraba $60 ganados en vez de $120.
 * La mitad del dinero del grupo se esfumaba por una celda vacia.
 *
 * Ahora la fecha se busca en cadena: fecha del pago, fecha en que se registro,
 * fecha en que se aprobo, mes en que arranco el prestamo. Si no hay ninguna, el
 * interes se imputa al mes en curso, que es lo mas cercano a "acaba de entrar",
 * y queda contado en `sinFechaPropia` para que se pueda revisar.
 *
 * @param {Array} prestamos [{ principal, total, inicio, pagos: [{ monto, fecha,
 *                creado, revisado }] }]  Solo pagos APROBADOS.
 * @returns {Object} { porMes: { 'AAAA-MM': ganado }, total, sinFechaPropia, pagosSinFecha }
 */
function gananciaPorMes(prestamos = [], hoy = new Date()) {
  const porMes = {};
  let total = 0;
  let sinFechaPropia = 0;
  let pagosSinFecha = 0;
  const ahora = mesActual(hoy);

  for (const p of Array.isArray(prestamos) ? prestamos : []) {
    const principal = centavos(p && p.principal);
    const totalPactado = centavos(p && p.total) || principal;
    if (!(totalPactado > 0)) continue;

    // Que parte de cada dolar pagado es interes
    const porcionInteres = Math.max(0, (totalPactado - principal) / totalPactado);
    if (porcionInteres <= 0) continue;

    const mesDelPrestamo = mesDe(p && p.inicio);

    let cobrado = 0;
    for (const pago of (Array.isArray(p.pagos) ? p.pagos : [])) {
      const monto = centavos(pago && pago.monto);
      if (!(monto > 0)) continue;
      // No se reconoce mas interes del pactado, aunque alguien pague de mas
      const aplicable = Math.max(0, Math.min(monto, totalPactado - cobrado));
      if (aplicable <= 0) continue;
      cobrado = centavos(cobrado + aplicable);

      const interes = centavos(aplicable * porcionInteres);
      if (interes <= 0) continue;

      const propia = mesDe(pago.fecha);
      const mes = propia
        || mesDe(pago.creado)
        || mesDe(pago.revisado)
        || mesDelPrestamo
        || ahora;
      if (!propia) {
        sinFechaPropia = centavos(sinFechaPropia + interes);
        pagosSinFecha += 1;
      }
      porMes[mes] = centavos((porMes[mes] || 0) + interes);
      total = centavos(total + interes);
    }
  }

  return { porMes, total, sinFechaPropia, pagosSinFecha };
}

// --------------------------------------------------------------------------
// LO QUE CADA SOCIO TENIA PUESTO
// --------------------------------------------------------------------------

/**
 * Cuanto tenia puesto cada socio en un mes dado.
 *
 * @param {Array}  participaciones [{ email, monto, desde }]
 *                 'desde' es la fecha en que entro ese dinero.
 * @param {string} mes  'AAAA-MM'
 * @returns {Object} { email: monto }
 */
function participacionEnElMes(participaciones = [], mes) {
  const salida = {};
  for (const p of Array.isArray(participaciones) ? participaciones : []) {
    const email = (p && p.email ? p.email : '').toString().trim().toLowerCase();
    const monto = centavos(p && p.monto);
    if (!email || !(monto > 0)) continue;
    // (la fecha se interpreta abajo; si no se entiende, cuenta desde siempre)
    // Participa del mes en que entro su dinero y de los siguientes. Sin fecha,
    // se cuenta desde siempre: es dinero que ya estaba antes de que la app
    // empezara a anotar fechas, no dinero recien llegado.
    const entro = mesDe(p.desde);
    if (entro && entro > mes) continue;
    salida[email] = centavos((salida[email] || 0) + monto);
  }
  return salida;
}

// --------------------------------------------------------------------------
// EL REPARTO
// --------------------------------------------------------------------------

/**
 * Reparto mes a mes: cada mes se reparte entre quienes ya tenian dinero puesto.
 *
 * @param {Object} opciones
 *   prestamos       [{ principal, total, inicio, pagos }]
 *   participaciones [{ email, monto, desde }]  ya valoradas en dinero
 *   base            'acciones' | 'ahorros' | 'ambos'  (informativo)
 * @returns {Object}
 *   { base, ganadoTotal, repartidoTotal, sinReparto, porMes, porMiembro, aviso }
 */
function repartoMesAMes({ prestamos = [], participaciones = [], base = 'acciones' } = {}, hoy = new Date()) {
  const ganancia = gananciaPorMes(prestamos, hoy);
  const meses = Object.keys(ganancia.porMes).sort();

  // Aportes con una fecha que no se entiende: cuentan desde siempre (lo
  // prudente), pero hay que decirlo, porque puede favorecer a esa persona.
  const conFechaRara = (Array.isArray(participaciones) ? participaciones : [])
    .filter((p) => p && p.desde && !mesDe(p.desde));

  const porMes = [];
  const porMiembro = {};
  let repartidoTotal = 0;
  let sinReparto = 0;

  for (const mes of meses) {
    const ganado = centavos(ganancia.porMes[mes]);
    if (!(ganado > 0)) continue;

    const partes = participacionEnElMes(participaciones, mes);
    const totalPartes = centavos(Object.values(partes).reduce((s, v) => s + v, 0));

    if (!(totalPartes > 0)) {
      // Nadie tenia nada puesto ese mes: no hay a quien repartir. Se informa,
      // para que no parezca que el dinero se evaporo.
      porMes.push({ mes, ganado, base: 0, reparto: [], sinReparto: ganado });
      sinReparto = centavos(sinReparto + ganado);
      continue;
    }

    const trozos = repartirCentavos(ganado,
      Object.entries(partes).map(([email, monto]) => ({ clave: email, peso: monto })));

    const reparto = Object.entries(partes)
      .map(([email, monto]) => ({
        email,
        participacion: monto,
        porcentaje: Math.round((monto / totalPartes) * 10000) / 100,
        importe: trozos.get(email) || 0,
      }))
      .sort((a, b) => b.participacion - a.participacion || a.email.localeCompare(b.email));

    for (const r of reparto) {
      porMiembro[r.email] = centavos((porMiembro[r.email] || 0) + r.importe);
    }
    repartidoTotal = centavos(repartidoTotal + ganado);
    porMes.push({ mes, ganado, base: totalPartes, reparto, sinReparto: 0 });
  }

  const avisos = [];
  if (ganancia.pagosSinFecha > 0) {
    avisos.push(`${ganancia.pagosSinFecha} pago(s) no traen fecha propia `
      + `($${ganancia.sinFechaPropia.toFixed(2)} de interes). Se imputaron por la fecha de `
      + 'registro, de aprobacion o del prestamo.');
  }
  if (conFechaRara.length > 0) {
    const quienes = [...new Set(conFechaRara.map((p) => p.email))].slice(0, 5).join(', ');
    avisos.push(`${conFechaRara.length} aporte(s) tienen una fecha que no se entiende `
      + `(${quienes}). Se cuentan desde el principio; revisa el formato de la columna de `
      + 'fecha en la hoja de calculo.');
  }
  const aviso = avisos.join(' ');

  return {
    base,
    ganadoTotal: ganancia.total,
    repartidoTotal,
    sinReparto,
    sinFechaPropia: ganancia.sinFechaPropia,
    pagosSinFecha: ganancia.pagosSinFecha,
    aviso,
    porMes,
    porMiembro,
  };
}

/** Lo que le toca a una persona, con su desglose mes a mes. */
function utilidadesDe(email, reparto) {
  const clave = (email || '').toString().trim().toLowerCase();
  const meses = ((reparto && reparto.porMes) || [])
    .map((m) => {
      const mio = (m.reparto || []).find((r) => r.email === clave);
      if (!mio) return null;
      return {
        fecha: m.mes,
        ganadoPorElGrupo: m.ganado,
        miParticipacion: mio.participacion,
        baseDelGrupo: m.base,
        porcentaje: mio.porcentaje,
        interesMes: mio.importe,
      };
    })
    .filter(Boolean);

  return {
    total: centavos(((reparto && reparto.porMiembro) || {})[clave] || 0),
    meses,
  };
}

/**
 * Reparte una ganancia entre los socios, en proporcion a lo que cada uno puso.
 *
 * Es el reparto PLANO, sobre la foto de hoy. Se usa cuando ya se sabe cuanto le
 * toca a cada quien y solo hay que partir un importe (por ejemplo, el saldo
 * pendiente tras descontar los cierres anteriores).
 *
 * @param {number} ganancia        lo que hay que repartir
 * @param {Array}  participaciones [{ email, acciones, ahorro }]
 * @param {string} base            'acciones' | 'ahorros' | 'ambos'
 */
function repartirUtilidades(ganancia, participaciones = [], base = 'acciones') {
  const aRepartir = centavos(ganancia);
  const criterio = BASES.has(base) ? base : 'acciones';
  const gente = (Array.isArray(participaciones) ? participaciones : []).map((p) => {
    const acciones = centavos(p.acciones);
    const ahorro = centavos(p.ahorro);
    let participacion = 0;
    if (criterio === 'acciones') participacion = acciones;
    else if (criterio === 'ahorros') participacion = ahorro;
    else participacion = centavos(acciones + ahorro);
    // `peso` permite repartir por un criterio distinto del capital: al descontar
    // cierres anteriores, lo que manda es lo que a cada quien le falta cobrar.
    const peso = p.peso === undefined || p.peso === null
      ? Math.max(0, participacion) : Math.max(0, centavos(p.peso));
    return {
      email: (p.email || '').toString().trim().toLowerCase(),
      acciones,
      ahorro,
      participacion: Math.max(0, participacion),
      peso,
    };
  });

  const totalParticipacion = centavos(gente.reduce((s, p) => s + p.participacion, 0));
  const totalPeso = centavos(gente.reduce((s, p) => s + p.peso, 0));

  // Sin ganancia o sin capital puesto no hay nada que repartir
  if (aRepartir <= 0 || totalPeso <= 0) {
    return {
      base: criterio,
      ganancia: aRepartir,
      totalParticipacion,
      reparto: gente.map((p) => ({
        email: p.email,
        acciones: p.acciones,
        ahorro: p.ahorro,
        participacion: p.participacion,
        proporcion: 0,
        utilidad: 0,
      })),
      repartido: 0,
      sinRepartir: aRepartir,
      motivo: aRepartir <= 0
        ? 'El grupo todavia no ha cobrado intereses.'
        : 'Nadie tiene capital puesto segun la base elegida.',
    };
  }

  const trozos = repartirCentavos(aRepartir,
    gente.map((p, i) => ({ clave: `${i}|${p.email}`, peso: p.peso })));

  const reparto = gente.map((p, i) => ({
    email: p.email,
    acciones: p.acciones,
    ahorro: p.ahorro,
    participacion: p.participacion,
    proporcion: Math.round((p.peso / totalPeso) * 10000) / 10000,
    utilidad: trozos.get(`${i}|${p.email}`) || 0,
  }));

  const repartido = centavos(reparto.reduce((s, p) => s + p.utilidad, 0));
  return {
    base: criterio,
    ganancia: aRepartir,
    totalParticipacion,
    reparto,
    repartido,
    sinRepartir: centavos(aRepartir - repartido),
    motivo: '',
  };
}

module.exports = {
  repartirUtilidades,
  gananciaDelGrupo,
  interesCobrado,
  BASES,
  // Reparto mes a mes
  repartoMesAMes,
  gananciaPorMes,
  participacionEnElMes,
  utilidadesDe,
  repartirCentavos,
  mesDe,
  mesesEntre,
};
