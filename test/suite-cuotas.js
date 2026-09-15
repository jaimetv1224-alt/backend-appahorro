/**
 * SUITE 12 - El cuadro de cuotas de un prestamo.
 *
 * Comprueba, con la cuenta hecha a mano al lado:
 *   - que el total se reparte en cuotas iguales y la suma cuadra al centavo
 *   - que un pago tapa la cuota mas antigua y lo que sobra pasa a la siguiente
 *   - el caso que pidio el usuario: pagar dos meses de una sola vez
 *   - pagos a medias, pagos de mas, y cuotas vencidas
 */

const { cuadroDeCuotas } = require('../cuotas');
const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

/** Hoy en el calendario local, como 'AAAA-MM-DD'. */
function hoyLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Cuantas de esas cuotas ya vencieron hoy. Se cuenta, no se supone: si se
 *  fija a mano, la prueba falla sola al cambiar de mes. */
const vencidasHoy = (cuotas) => cuotas.filter((c) => c.vence < hoyLocal()).length;

/** Fecha de hace N meses, dia 10, en ISO corto. */
function haceMeses(n) {
  const d = new Date();
  d.setDate(10);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
}

module.exports = async function run() {
  // ===================================================================
  t.section('CUO 1. El reparto en cuotas cuadra al centavo');
  // ===================================================================
  // 336 a 6 meses = 56,00 por mes, exacto
  const c1 = cuadroDeCuotas({ total: 336, term: 6, startDate: haceMeses(0) });
  t.eq('salen 6 cuotas', c1.cuotas.length, 6);
  t.near('cada una de $56,00', c1.cuotas[0].importe, 56, 0.001);
  t.near('la suma de las cuotas es el total', c1.cuotas.reduce((s, c) => s + c.importe, 0), 336, 0.001);

  // 100 a 3 meses = 33,33 + 33,33 + 33,34
  const c2 = cuadroDeCuotas({ total: 100, term: 3, startDate: haceMeses(0) });
  t.near('con decimales feos, las dos primeras son $33,33', c2.cuotas[0].importe, 33.33, 0.001);
  t.near('y la ultima absorbe el centavo: $33,34', c2.cuotas[2].importe, 33.34, 0.001);
  t.near('la suma sigue siendo exactamente $100',
    c2.cuotas.reduce((s, c) => s + c.importe, 0), 100, 0.001);

  // ===================================================================
  t.section('CUO 2. Un pago tapa la cuota mas antigua');
  // ===================================================================
  const c3 = cuadroDeCuotas(
    { total: 600, term: 6, startDate: haceMeses(3) },          // $100 por mes
    [{ fecha: haceMeses(2), monto: 100 }],
  );
  t.eq('la primera cuota queda pagada', c3.cuotas[0].estado, 'pagada');
  t.near('...con sus $100', c3.cuotas[0].pagado, 100, 0.001);
  t.eq('la segunda sigue sin cubrir',
    c3.cuotas[1].estado, c3.cuotas[1].vence < hoyLocal() ? 'vencida' : 'pendiente');
  t.near('lo pagado en total son $100', c3.resumen.pagado, 100, 0.001);
  t.near('y el saldo baja a $500', c3.resumen.saldo, 500, 0.001);

  // ===================================================================
  t.section('CUO 3. Pagar DOS meses de una vez');
  // ===================================================================
  // Es el caso que hay que resolver: alguien pone $200 el primer mes
  const c4 = cuadroDeCuotas(
    { total: 600, term: 6, startDate: haceMeses(3) },
    [{ fecha: haceMeses(2), monto: 200 }],
  );
  t.eq('la cuota 1 queda pagada', c4.cuotas[0].estado, 'pagada');
  t.eq('y la cuota 2 tambien, con el sobrante del mismo pago', c4.cuotas[1].estado, 'pagada');
  t.eq('la cuota 3 sigue sin cubrir',
    c4.cuotas[2].estado, c4.cuotas[2].vence < hoyLocal() ? 'vencida' : 'pendiente');
  t.eq('van 2 cuotas saldadas', c4.resumen.cuotasPagadas, 2);
  t.eq('la proxima a pagar es la 3', c4.resumen.proximaCuota?.numero, 3);
  t.near('y el saldo es $400', c4.resumen.saldo, 400, 0.001);

  // ===================================================================
  t.section('CUO 4. Un pago a medias deja la cuota a medias');
  // ===================================================================
  const c5 = cuadroDeCuotas(
    { total: 600, term: 6, startDate: haceMeses(3) },
    [{ fecha: haceMeses(2), monto: 60 }],
  );
  t.eq('la cuota 1 queda a medias',
    c5.cuotas[0].estado, c5.cuotas[0].vence < hoyLocal() ? 'parcial_vencida' : 'parcial');
  t.near('con $60 puestos', c5.cuotas[0].pagado, 60, 0.001);
  t.near('y $40 por completar', c5.cuotas[0].pendiente, 40, 0.001);
  t.eq('ninguna cuota cuenta como pagada', c5.resumen.cuotasPagadas, 0);
  t.eq('la proxima sigue siendo la 1', c5.resumen.proximaCuota?.numero, 1);
  t.near('y de la 1 solo faltan $40', c5.resumen.proximaCuota?.importe, 40, 0.001);

  // Dos pagos que entre los dos completan la cuota
  const c6 = cuadroDeCuotas(
    { total: 600, term: 6, startDate: haceMeses(3) },
    [{ fecha: haceMeses(2), monto: 60 }, { fecha: haceMeses(1), monto: 40 }],
  );
  t.eq('con el segundo pago la cuota 1 se completa', c6.cuotas[0].estado, 'pagada');
  t.near('lo pagado suma $100', c6.resumen.pagado, 100, 0.001);

  // ===================================================================
  t.section('CUO 5. Pagar de mas queda a favor, no se pierde');
  // ===================================================================
  const c7 = cuadroDeCuotas(
    { total: 300, term: 3, startDate: haceMeses(1) },
    [{ fecha: haceMeses(0), monto: 350 }],
  );
  t.eq('las 3 cuotas quedan pagadas', c7.resumen.cuotasPagadas, 3);
  t.near('el saldo queda en cero', c7.resumen.saldo, 0, 0.001);
  t.near('y los $50 de mas constan a favor', c7.resumen.aFavor, 50, 0.001);
  t.check('no hay saldo negativo', c7.resumen.saldo >= 0, `saldo: ${c7.resumen.saldo}`);

  // ===================================================================
  t.section('CUO 6. Lo que hay que poner HOY');
  // ===================================================================
  // Prestamo de hace 3 meses, sin pagar nada: 3 cuotas vencidas
  const c8 = cuadroDeCuotas({ total: 600, term: 6, startDate: haceMeses(3) });
  // Cuantas han vencido depende del dia en que se corra la prueba: se cuenta.
  const nVencidas = vencidasHoy(c8.cuotas);
  t.eq(`las cuotas ya vencidas son ${nVencidas}`, c8.resumen.cuotasVencidas, nVencidas);
  t.check('y son al menos 2, con un prestamo de hace 3 meses', nVencidas >= 2, `${nVencidas}`);
  t.near(`lo exigible hoy son esas ${nVencidas} cuotas`,
    c8.resumen.aPagarAhora, nVencidas * 100, 0.001);

  // Recien concedido: todavia no vence nada
  const c9 = cuadroDeCuotas({ total: 600, term: 6, startDate: haceMeses(0) });
  t.eq('un prestamo de este mes no tiene cuotas vencidas', c9.resumen.cuotasVencidas, 0);
  t.near('y hoy no hay que poner nada', c9.resumen.aPagarAhora, 0, 0.001);
  t.eq('la proxima cuota es la 1', c9.resumen.proximaCuota?.numero, 1);

  // ===================================================================
  t.section('CUO 7. Datos incompletos no rompen nada');
  // ===================================================================
  const c10 = cuadroDeCuotas({ total: 0, term: 0, startDate: '' });
  t.eq('sin datos no hay cuotas', c10.cuotas.length, 0);
  t.eq('ni cuotas pagadas', c10.resumen.cuotasPagadas, 0);
  const c11 = cuadroDeCuotas({ total: 500, term: 5, startDate: 'no es una fecha' });
  t.eq('una fecha invalida tampoco rompe', c11.cuotas.length, 0);
  const c12 = cuadroDeCuotas({ total: 500, term: 5, startDate: haceMeses(1) }, null);
  t.eq('sin lista de pagos se asume que no hay ninguno', c12.resumen.pagado, 0);

  // ===================================================================
  t.section('CUO 8. El cuadro llega a la app con el prestamo');
  // ===================================================================
  seedWorkbook();
  const e = await baseScenario({ groupId: 'GCU' });

  // Prestamo heredado, para no depender de la votacion: $600 al 2% a 6 meses
  fake.ensureSheet('Loans').grid.push([
    'LN_CUO_1', e.users.socio1.email, 'GCU', 600, haceMeses(3),
    new Date().toISOString(), 2, 'aprobado', 6, 672,
  ]);
  // Un pago aprobado de $224: cubre las cuotas 1 y 2 ($112 cada una)
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_CUO_1', e.users.socio1.email, 'LN_CUO_1', 224, haceMeses(2),
    'dos meses juntos', 'approved', '', '', '', '', new Date().toISOString(),
    e.users.teso.email, new Date().toISOString(), '',
  ]);

  const r = await get(
    `/api/obtener-prestamos?groupId=GCU&userEmail=${e.users.socio1.email}`, e.tokens.socio1);
  t.status('el prestamo se consulta', r, 200);
  const p = (r.body?.loans || [])[0] || {};
  t.check('viene con su cuadro de cuotas', Array.isArray(p.cuotas) && p.cuotas.length === 6,
    `cuotas: ${p.cuotas ? p.cuotas.length : 'ninguna'}`);
  t.near('cada cuota son $112 (672 / 6)', p.cuotas?.[0]?.importe, 112, 0.01);
  t.eq('la cuota 1 consta pagada', p.cuotas?.[0]?.estado, 'pagada');
  t.eq('la cuota 2 tambien, del mismo pago', p.cuotas?.[1]?.estado, 'pagada');
  t.eq('la 3 sigue sin cubrir', p.cuotas?.[2]?.estado,
    (p.cuotas?.[2]?.vence || '') < hoyLocal() ? 'vencida' : 'pendiente');
  t.eq('van 2 de 6 cuotas', p.resumen?.cuotasPagadas, 2);
  t.near('el saldo es $448', p.resumen?.saldo, 448, 0.01);
  t.near('y coincide con el saldo que ya devolvia la app', p.remainingBalance, 448, 0.01);
  t.eq('la proxima cuota a pagar es la 3', p.resumen?.proximaCuota?.numero, 3);

  // Un pago RECHAZADO no debe contar
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_CUO_2', e.users.socio1.email, 'LN_CUO_1', 112, haceMeses(1),
    'rechazado', 'rejected', '', '', '', '', new Date().toISOString(), '', '', '',
  ]);
  const r2 = await get(
    `/api/obtener-prestamos?groupId=GCU&userEmail=${e.users.socio1.email}`, e.tokens.socio1);
  const p2 = (r2.body?.loans || [])[0] || {};
  t.eq('un comprobante rechazado no salda ninguna cuota', p2.resumen?.cuotasPagadas, 2);
  t.near('ni mueve el saldo', p2.resumen?.saldo, 448, 0.01);
};
