/**
 * Cuadro de cuotas de un prestamo: cuanto toca pagar cada mes, que se ha
 * pagado ya y que queda.
 *
 * La app sabia el total y el saldo, pero no repartia el prestamo en meses, asi
 * que nadie podia ver "voy por la cuota 3 de 6" ni saber cuanto le toca este
 * mes. Aqui se arma ese cuadro.
 *
 * Reglas:
 *  - El total (capital + interes) se reparte en cuotas iguales. La ultima
 *    absorbe los centavos del redondeo, para que la suma cuadre exactamente.
 *  - Los pagos aprobados se aplican a la cuota mas antigua sin cubrir, y lo que
 *    sobra pasa a la siguiente. Asi, quien paga dos meses de una vez ve las dos
 *    cuotas saldadas, y quien paga de mas va adelantando.
 *  - Una cuota puede quedar a medias: se marca cuanto le falta.
 *
 * No depende de Google Sheets ni de Express: se puede probar sola.
 */

'use strict';

const centavos = (n) => Math.round((Number(n) || 0) * 100) / 100;

// --------------------------------------------------------------------------
// Fechas de CALENDARIO, no instantes.
//
// `new Date('2026-01-31')` se interpreta como medianoche UTC; en Ecuador eso
// cae el 30 de enero, y al volver a formatear con toISOString() el desfase se
// suma otra vez. El resultado eran vencimientos corridos un dia y cuotas
// marcadas como vencidas antes de tiempo. Aqui una fecha son tres numeros.
// --------------------------------------------------------------------------

/** 'AAAA-MM-DD' o ISO -> { a, m, d }. Devuelve null si no se entiende. */
function partesDeFecha(valor) {
  if (!valor) return null;
  const texto = valor instanceof Date
    ? `${valor.getFullYear()}-${String(valor.getMonth() + 1).padStart(2, '0')}-${String(valor.getDate()).padStart(2, '0')}`
    : String(valor).trim();
  const m = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const a = Number(m[1]); const mes = Number(m[2]); const dia = Number(m[3]);
  if (!(a > 0) || mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  return { a, m: mes, d: dia };
}

const formatear = ({ a, m, d }) =>
  `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/** Dias que tiene un mes concreto, contando los bisiestos. */
function diasDelMes(a, m) {
  return [31, (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0 ? 29 : 28,
    31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

/** Hoy, en el calendario de quien usa la app (no en UTC). */
function hoyLocal(referencia) {
  const d = referencia instanceof Date ? referencia : new Date();
  return { a: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
}

/**
 * Suma meses a una fecha de calendario, sin desbordar: el 31 de enero mas un
 * mes es el 28 de febrero (o el 29 en bisiesto), no el 3 de marzo.
 */
function sumarMeses(fecha, meses) {
  const p = fecha && fecha.a ? fecha : partesDeFecha(fecha);
  if (!p) return null;
  const total = (p.a * 12) + (p.m - 1) + Number(meses || 0);
  const a = Math.floor(total / 12);
  const m = (total % 12) + 1;
  return { a, m, d: Math.min(p.d, diasDelMes(a, m)) };
}

/**
 * @param {object} prestamo  { total, term, startDate }
 * @param {Array}  pagos     [{ fecha, monto }] solo los APROBADOS
 * @param {Date}   hoy       para poder fijar la fecha en las pruebas
 */
function cuadroDeCuotas(prestamo, pagos = [], hoy = new Date()) {
  const total = centavos(prestamo && prestamo.total);
  const plazo = Math.max(0, Math.trunc(Number(prestamo && prestamo.term) || 0));
  const inicio = partesDeFecha(prestamo && prestamo.startDate);

  if (!(total > 0) || plazo <= 0 || !inicio) {
    return {
      cuotas: [],
      resumen: {
        total, plazo, valorCuota: 0, pagado: 0, saldo: total,
        cuotasPagadas: 0, cuotasVencidas: 0, proximaCuota: null,
        aPagarAhora: 0, aFavor: 0,
      },
    };
  }

  // Cuota pareja; la ultima recoge la diferencia de redondeo
  const cuotaBase = centavos(total / plazo);
  const cuotas = [];
  for (let i = 1; i <= plazo; i += 1) {
    const importe = i === plazo
      ? centavos(total - cuotaBase * (plazo - 1))
      : cuotaBase;
    cuotas.push({
      numero: i,
      vence: formatear(sumarMeses(inicio, i)),
      importe,
      pagado: 0,
      pendiente: importe,
      estado: 'pendiente',
      cubiertaEl: null,
    });
  }

  // Los pagos, del mas antiguo al mas nuevo, van tapando cuotas por orden
  // `pagos` puede llegar nulo si el prestamo no tiene ninguno todavia
  const ordenados = (Array.isArray(pagos) ? [...pagos] : [])
    .map((p) => ({ fecha: p.fecha || '', monto: centavos(p.monto) }))
    .filter((p) => p.monto > 0)
    .sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)));

  let sobrante = 0;              // dinero pagado que excede todas las cuotas
  let pagadoTotal = 0;
  for (const pago of ordenados) {
    pagadoTotal = centavos(pagadoTotal + pago.monto);
    let resto = pago.monto;
    for (const c of cuotas) {
      if (resto <= 0) break;
      if (c.pendiente <= 0) continue;
      const aplica = Math.min(resto, c.pendiente);
      c.pagado = centavos(c.pagado + aplica);
      c.pendiente = centavos(c.importe - c.pagado);
      resto = centavos(resto - aplica);
      if (c.pendiente <= 0) c.cubiertaEl = pago.fecha ? String(pago.fecha).split('T')[0] : null;
    }
    if (resto > 0) sobrante = centavos(sobrante + resto);
  }

  // Estado de cada cuota, ya con los pagos aplicados
  // El calendario de quien mira, no el de Greenwich: si no, una cuota que vence
  // hoy sale como vencida desde las 19:00 del dia anterior.
  const hoyIso = formatear(hoyLocal(hoy));
  let cuotasPagadas = 0;
  let cuotasVencidas = 0;
  let proxima = null;
  for (const c of cuotas) {
    if (c.pendiente <= 0) {
      c.estado = 'pagada';
      cuotasPagadas += 1;
    } else if (c.vence < hoyIso) {
      c.estado = c.pagado > 0 ? 'parcial_vencida' : 'vencida';
      cuotasVencidas += 1;
      if (!proxima) proxima = c;
    } else {
      c.estado = c.pagado > 0 ? 'parcial' : 'pendiente';
      if (!proxima) proxima = c;
    }
  }

  // Lo exigible hoy: todo lo vencido sin cubrir, mas la cuota del mes en curso
  const aPagarAhora = centavos(cuotas
    .filter((c) => c.pendiente > 0 && c.vence <= hoyIso)
    .reduce((s, c) => s + c.pendiente, 0));

  return {
    cuotas,
    resumen: {
      total,
      plazo,
      valorCuota: cuotaBase,
      pagado: centavos(Math.min(pagadoTotal, total)),
      saldo: centavos(Math.max(0, total - pagadoTotal)),
      cuotasPagadas,
      cuotasVencidas,
      proximaCuota: proxima
        ? { numero: proxima.numero, vence: proxima.vence, importe: proxima.pendiente }
        : null,
      aPagarAhora,
      aFavor: sobrante,          // pago de mas: queda a favor de la persona
    },
  };
}

/** Una fecha de calendario a numero de dias, para restar sin husos horarios. */
function enDias(fecha) {
  const p = fecha && fecha.a ? fecha : partesDeFecha(fecha);
  if (!p) return null;
  return Math.floor(Date.UTC(p.a, p.m - 1, p.d) / 86400000);
}

/**
 * Lo que se ha recargado por pagar tarde, hasta una fecha.
 *
 * @param {object} cuadro   lo que devuelve `cuadroDeCuotas`
 * @param {object} reglas   { moraPorcentajeMensual, diasDeGracia }
 * @param {Date}   hoy      para poder fijar la fecha en las pruebas
 *
 * Devuelve el total y el desglose por cuota, para poder explicarle a la socia
 * de donde sale cada centavo: "la cuota 2 lleva 45 dias de retraso".
 */
function moraAcumulada(cuadro, reglas = {}, hoy = new Date()) {
  const tasaMensual = Math.max(0, Number(reglas.moraPorcentajeMensual) || 0);
  const gracia = Math.max(0, Math.trunc(Number(reglas.diasDeGracia) || 0));
  const vacio = { total: 0, tasaMensual, diasDeGracia: gracia, detalle: [] };
  if (!(tasaMensual > 0) || !cuadro || !Array.isArray(cuadro.cuotas)) return vacio;

  const hoyDias = enDias(hoyLocal(hoy));
  if (hoyDias === null) return vacio;
  // 30 dias por mes: es como lo cuenta un banco comunal cuando dice "2% al mes".
  const porDia = tasaMensual / 100 / 30;

  const detalle = [];
  let total = 0;
  for (const c of cuadro.cuotas) {
    if (!(c.pendiente > 0)) continue;              // saldada: no arrastra mora
    const vence = enDias(c.vence);
    if (vence === null) continue;
    const diasTarde = hoyDias - vence - gracia;
    if (diasTarde <= 0) continue;
    const cargo = centavos(c.pendiente * porDia * diasTarde);
    if (!(cargo > 0)) continue;
    total = centavos(total + cargo);
    detalle.push({
      numero: c.numero, vence: c.vence, pendiente: c.pendiente,
      diasTarde, cargo,
    });
  }
  return { total, tasaMensual, diasDeGracia: gracia, detalle };
}

module.exports = {
  cuadroDeCuotas, moraAcumulada, sumarMeses, partesDeFecha, formatear, diasDelMes,
};
