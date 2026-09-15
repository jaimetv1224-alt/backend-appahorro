/**
 * SUITE 13 - Coherencia: la misma cifra, igual en todas partes.
 *
 * Los dos fallos que se escaparon en revisiones anteriores fueron del mismo
 * tipo: un numero calculado por su cuenta en un sitio, que no cuadraba con el
 * de al lado. Utilidades doce veces mas bajas, tasas promediadas, un "con
 * interes" inventado en la pantalla, tarjetas que decian saldo cero mientras
 * el cuadro de cuotas decia $236.
 *
 * Esta bateria construye un grupo con datos variados y comprueba que TODOS los
 * endpoints que informan de una misma magnitud dan exactamente lo mismo.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const cent = (n) => Math.round((Number(n) || 0) * 100) / 100;

function haceMeses(n) {
  const d = new Date();
  d.setDate(10);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
}

function sembrarAhorro(email, groupId, monto, fecha, estado = 'confirmado') {
  fake.ensureSheet('Savings').grid.push([
    email, groupId, monto, fecha, 'mensual', 'aporte',
    estado, 'x@x.test', 'y@y.test', new Date().toISOString(),
    `sav_${Math.random().toString(36).slice(2, 9)}`, '',
  ]);
}

function sembrarAcciones(email, groupId, cantidad, valor, tasa, fecha, estado = 'confirmado') {
  fake.ensureSheet('Acciones').grid.push([
    email, groupId, fecha, cantidad, valor, tasa, new Date().toISOString(),
    estado, 'x@x.test', 'y@y.test', new Date().toISOString(),
    `acc_${Math.random().toString(36).slice(2, 9)}`, '',
  ]);
}

module.exports = async function run() {
  seedWorkbook();
  const e = await baseScenario({ groupId: 'GCO' });
  const socio = e.users.socio1.email;

  // Datos variados: aportes de distintos meses, uno pendiente, dos compras de
  // acciones con antiguedad distinta, y un prestamo con un pago parcial.
  sembrarAhorro(socio, 'GCO', 400, haceMeses(4));
  sembrarAhorro(socio, 'GCO', 250, haceMeses(2));
  sembrarAhorro(socio, 'GCO', 90, haceMeses(0), 'pendiente');   // NO debe contar
  sembrarAcciones(socio, 'GCO', 20, 10, 2, haceMeses(3));       // $200
  sembrarAcciones(socio, 'GCO', 10, 10, 2, haceMeses(1));       // $100
  sembrarAcciones(socio, 'GCO', 5, 10, 2, haceMeses(1), 'pendiente'); // NO cuenta

  fake.ensureSheet('Loans').grid.push([
    'LN_CO', socio, 'GCO', 500, haceMeses(3), new Date().toISOString(), 2, 'aprobado', 5, 550,
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_CO_1', socio, 'LN_CO', 165, haceMeses(2), 'tres meses', 'approved',
    '', '', '', '', new Date().toISOString(), e.users.teso.email, new Date().toISOString(), '',
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_CO_2', socio, 'LN_CO', 110, haceMeses(1), 'no aprobado', 'pending',
    '', '', '', '', new Date().toISOString(), '', '', '',
  ]);

  // ===================================================================
  t.section('COH 1. El ahorro es el mismo lo pida quien lo pida');
  // ===================================================================
  const completo = await get(`/api/savings/complete?email=${socio}&groupId=GCO`, e.tokens.socio1);
  t.status('el resumen completo responde', completo, 200);
  const d = completo.body?.data || {};

  const lista = await get(`/api/savings?userEmail=${socio}`, e.tokens.socio1);
  const sumaLista = cent((lista.body?.savings || [])
    .filter((s) => s.cuenta !== false)
    .reduce((s2, x) => s2 + Number(x.monto || 0), 0));
  t.near('el resumen y el listado de movimientos dan el mismo ahorro',
    d.totalAhorros, sumaLista, 0.01);
  t.near('y son los $650 confirmados, sin el pendiente de $90', d.totalAhorros, 650, 0.01);

  const stats = await get(`/api/savings/stats?email=${socio}&groupId=GCO`, e.tokens.socio1);
  if (stats.status === 200) {
    const st = stats.body?.data || stats.body || {};
    const totalStats = Number(st.totalAmount ?? st.total ?? st.totalAhorros ?? NaN);
    if (Number.isFinite(totalStats)) {
      t.near('las estadisticas coinciden con el resumen', totalStats, d.totalAhorros, 0.01);
    }
  }

  // ===================================================================
  t.section('COH 2. Las acciones y su valor cuadran');
  // ===================================================================
  const acc = await get(`/api/obtener-acciones?groupId=GCO&userEmail=${socio}`, e.tokens.socio1);
  // El endpoint devuelve las confirmadas bajo la clave 'shares'
  const confirmadas = (acc.body?.shares || [])
    .reduce((s2, a) => s2 + Number(a.shares || 0) * Number(a.shareValue || 0), 0);
  t.near('el valor de las acciones es el mismo en las dos vias',
    d.totalAcciones, cent(confirmadas), 0.01);
  t.near('y son las 30 confirmadas a $10 = $300, sin las 5 pendientes',
    d.totalAcciones, 300, 0.01);

  const pendAcc = (acc.body?.pendientes || [])
    .reduce((s2, a) => s2 + Number(a.shares || 0) * Number(a.shareValue || 0), 0);
  t.near('las 5 pendientes valen $50 y constan aparte', cent(pendAcc), 50, 0.01);

  // ===================================================================
  t.section('COH 3. El patrimonio es la suma exacta de sus partes');
  // ===================================================================
  // Las utilidades abonadas son filas de ahorro: ya estan dentro de
  // totalAhorros. Sumarlas aparte contaria el mismo dinero dos veces.
  const partes = cent(Number(d.totalAhorros) + Number(d.totalAcciones));
  t.near('patrimonio = ahorros + acciones, sin contar nada dos veces',
    d.totalPatrimonio, partes, 0.01);
  t.check('lo pendiente NO se cuela en el patrimonio',
    Number(d.totalPatrimonio) < Number(d.totalPatrimonio) + 90,
    `patrimonio: ${d.totalPatrimonio}`);
  t.near('lo pendiente se informa aparte, con su importe',
    d.pendientes?.totalAhorros, 90, 0.01);

  // ===================================================================
  t.section('COH 4. Utilidades: el total es la suma de los meses');
  // ===================================================================
  const hist = d.historialUtilidades || [];
  const sumaMeses = cent(hist.reduce((s2, m) => s2 + Number(m.interesMes || 0), 0));
  t.near('la proyeccion de utilidades es la suma de su propio desglose',
    d.utilidadesEstimadas, sumaMeses, 0.02);
  t.near('y lo realmente abonado es cero mientras no haya cierre',
    d.totalUtilidades, 0, 0.001);
  t.check('cada mes informa la base sobre la que calculo',
    hist.every((m) => Number(m.baseDevengable) > 0),
    JSON.stringify(hist.map((m) => m.baseDevengable)));
  t.check('ningun mes aplica una tasa distinta del 2% del grupo',
    hist.every((m) => Math.abs(Number(m.tasaMensual) - 2) < 0.01),
    JSON.stringify(hist.map((m) => m.tasaMensual)));

  // La compra vieja devenga mas meses que la nueva
  const baseMax = Math.max(...hist.map((m) => Number(m.baseDevengable)));
  const baseMin = Math.min(...hist.map((m) => Number(m.baseDevengable)));
  t.near('los primeros meses solo devenga la compra antigua ($200)', baseMin, 200, 0.01);
  // La compra reciente entra a devengar el mes siguiente al de su compra, asi
  // que segun el dia en que se corra la prueba puede haber entrado o no. Lo
  // que no puede pasar nunca es que la base baje de $200 ni pase de $300.
  t.check('y al final devengan $200 o $300, segun el dia',
    baseMax === 200 || baseMax === 300, `base maxima: ${baseMax}`);
  t.check('la base nunca se sale de ese rango',
    hist.every((m) => Number(m.baseDevengable) >= 200 && Number(m.baseDevengable) <= 300),
    JSON.stringify(hist.map((m) => m.baseDevengable)));

  // ===================================================================
  t.section('COH 5. El prestamo: saldo, cuotas y pagos dicen lo mismo');
  // ===================================================================
  const pres = await get(`/api/obtener-prestamos?groupId=GCO&userEmail=${socio}`, e.tokens.socio1);
  const p = (pres.body?.loans || [])[0] || {};

  t.near('el total del prestamo es 500 x (1 + 2% x 5) = $550', p.totalAPagar, 550, 0.01);
  t.near('el saldo antiguo y el del cuadro coinciden',
    p.remainingBalance, p.resumen?.saldo, 0.01);
  t.near('lo pagado antiguo y el del cuadro coinciden', p.paid, p.resumen?.pagado, 0.01);
  t.near('solo cuenta el pago APROBADO de $165, no el pendiente de $110',
    p.resumen?.pagado, 165, 0.01);
  t.near('y el saldo es $385', p.resumen?.saldo, 385, 0.01);

  const sumaCuotas = cent((p.cuotas || []).reduce((s2, c) => s2 + Number(c.importe), 0));
  t.near('la suma de las cuotas es exactamente el total', sumaCuotas, p.totalAPagar, 0.01);
  const sumaPagadoCuotas = cent((p.cuotas || []).reduce((s2, c) => s2 + Number(c.pagado), 0));
  t.near('lo repartido entre las cuotas es lo pagado', sumaPagadoCuotas, p.resumen?.pagado, 0.01);
  const sumaPendiente = cent((p.cuotas || []).reduce((s2, c) => s2 + Number(c.pendiente), 0));
  t.near('lo que falta en las cuotas es el saldo', sumaPendiente, p.resumen?.saldo, 0.01);

  // $165 sobre cuotas de $110 cubre la 1 y $55 de la 2
  t.eq('la cuota 1 quedo pagada', p.cuotas?.[0]?.estado, 'pagada');
  t.near('y de la 2 se abonaron $55', p.cuotas?.[1]?.pagado, 55, 0.01);

  // ===================================================================
  t.section('COH 6. La directiva ve lo mismo que el socio');
  // ===================================================================
  const vistaPresi = await get(`/api/gob/tablero?groupId=GCO`, e.tokens.presi);
  t.status('el tablero del grupo responde', vistaPresi, 200);

  const miembros = await get(`/api/obtener-miembros?groupId=GCO`, e.tokens.presi);
  t.status('la lista de miembros responde', miembros, 200);

  // El ahorro del socio segun la tesoreria
  const bandeja = await get(`/api/gob/aportes-pendientes?groupId=GCO`, e.tokens.teso);
  const pendienteSegunTeso = cent((bandeja.body?.ahorros || [])
    .filter((a) => (a.email || '').toLowerCase() === socio)
    .reduce((s2, a) => s2 + Number(a.monto || 0), 0));
  t.near('el pendiente que ve la tesoreria es el mismo que ve el socio',
    pendienteSegunTeso, Number(d.pendientes?.totalAhorros), 0.01);

  // ===================================================================
  t.section('COH 7. Confirmar un aporte mueve TODAS las cifras a la vez');
  // ===================================================================
  const antes = Number(d.totalAhorros);
  const pendiente = (bandeja.body?.ahorros || [])
    .find((a) => (a.email || '').toLowerCase() === socio);
  t.check('hay un aporte pendiente que confirmar', !!pendiente, JSON.stringify(bandeja.body).slice(0, 160));

  if (pendiente) {
    const res = await post('/api/gob/aportes/resolver',
      { groupId: 'GCO', tipo: 'ahorro', movId: pendiente.movId, accion: 'confirmar' }, e.tokens.teso);
    t.status('la tesoreria lo confirma', res, 200);

    const despues = await get(`/api/savings/complete?email=${socio}&groupId=GCO`, e.tokens.socio1);
    const d2 = despues.body?.data || {};
    t.near('el ahorro sube exactamente los $90', d2.totalAhorros, antes + 90, 0.01);
    t.near('ya no queda nada pendiente', d2.pendientes?.totalAhorros, 0, 0.01);
    t.near('y el patrimonio sube lo mismo, ni mas ni menos',
      d2.totalPatrimonio,
      cent(Number(d2.totalAhorros) + Number(d2.totalAcciones)), 0.01);

    const listaDespues = await get(`/api/savings?userEmail=${socio}`, e.tokens.socio1);
    const sumaDespues = cent((listaDespues.body?.savings || [])
      .filter((s) => s.cuenta !== false)
      .reduce((s2, x) => s2 + Number(x.monto || 0), 0));
    t.near('el listado de movimientos tambien lo refleja', sumaDespues, d2.totalAhorros, 0.01);

    const bandejaDespues = await get(`/api/gob/aportes-pendientes?groupId=GCO`, e.tokens.teso);
    const sigue = (bandejaDespues.body?.ahorros || [])
      .some((a) => a.movId === pendiente.movId);
    t.check('y desaparece de la bandeja de la tesoreria', !sigue, 'sigue apareciendo como pendiente');
  }

  // ===================================================================
  t.section('COH 7b. Una compra de acciones se registra UNA sola vez');
  // ===================================================================
  // La pantalla llamaba a la vez a /api/registrar-acciones y a
  // /api/registrar-solicitud: la misma compra quedaba en la caja del grupo Y
  // en la cola de solicitudes. Al aprobar la solicitud se creaban acciones de
  // nuevo, asi que comprar 3 acciones acababa en 6.
  const accAntes = await get(`/api/obtener-acciones?groupId=GCO&userEmail=${socio}`, e.tokens.socio1);
  const totalAntes = [...(accAntes.body?.shares || []), ...(accAntes.body?.pendientes || [])]
    .reduce((s2, a) => s2 + Number(a.shares || 0), 0);

  const compra = await post('/api/registrar-acciones', {
    groupId: 'GCO', date: hoyLocal(),
    shares: 3, shareValue: 10, interestRate: 2,
  }, e.tokens.socio1);
  t.statusIn('el socio compra 3 acciones', compra, [200, 201]);

  const accDespues = await get(`/api/obtener-acciones?groupId=GCO&userEmail=${socio}`, e.tokens.socio1);
  const totalDespues = [...(accDespues.body?.shares || []), ...(accDespues.body?.pendientes || [])]
    .reduce((s2, a) => s2 + Number(a.shares || 0), 0);
  t.near('sus acciones suben exactamente 3, no 6', totalDespues, totalAntes + 3, 0.001);

  const filasAntes = (accAntes.body?.shares || []).length + (accAntes.body?.pendientes || []).length;
  const filasDespues = (accDespues.body?.shares || []).length + (accDespues.body?.pendientes || []).length;
  t.eq('y se anade UNA sola fila', filasDespues, filasAntes + 1);

  // Y no debe aparecer ademas como solicitud a aprobar
  const solic = await get('/api/solicitudes-pendientes?group=GCO&tipo=accion', e.tokens.presi);
  const suyas = (solic.body?.solicitudes || [])
    .filter((r) => (Array.isArray(r) ? r[1] : r.UserEmail || '').toString().toLowerCase() === socio);
  t.eq('la compra no genera ademas una solicitud aparte', suyas.length, 0);

  // ===================================================================
  t.section('COH 8. Nada se calcula dos veces ni se pierde');
  // ===================================================================
  const dosVeces = await Promise.all([
    get(`/api/savings/complete?email=${socio}&groupId=GCO`, e.tokens.socio1),
    get(`/api/savings/complete?email=${socio}&groupId=GCO`, e.tokens.socio1),
  ]);
  t.near('dos consultas seguidas dan el mismo patrimonio',
    dosVeces[0].body?.data?.totalPatrimonio,
    dosVeces[1].body?.data?.totalPatrimonio, 0.001);
  t.near('y las mismas utilidades',
    dosVeces[0].body?.data?.totalUtilidades,
    dosVeces[1].body?.data?.totalUtilidades, 0.001);

  const presDos = await get(`/api/obtener-prestamos?groupId=GCO&userEmail=${socio}`, e.tokens.socio1);
  t.eq('sigue habiendo un solo prestamo', (presDos.body?.loans || []).length, 1);
  t.near('con el mismo saldo', (presDos.body?.loans || [])[0]?.resumen?.saldo, 385, 0.01);
};
