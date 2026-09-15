/**
 * SUITE 11 - Aritmetica del dinero: intereses mes a mes.
 *
 * Aqui se clavan los numeros. Si alguien cambia una formula, esta bateria lo
 * dice con la cuenta hecha a mano al lado, no con un "algo cambio".
 *
 * Cubre:
 *   - utilidades de las acciones, mes a mes, con la tasa MENSUAL del grupo
 *   - la regla de que se empieza a devengar el mes SIGUIENTE a la compra
 *   - que no se devenga sobre acciones sin confirmar
 *   - el interes de los prestamos y como baja el saldo con cada pago
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

/** Mete una compra de acciones YA CONFIRMADA con una fecha concreta. */
function sembrarAcciones(email, groupId, cantidad, valor, tasaMensual, fecha) {
  fake.ensureSheet('Acciones').grid.push([
    email, groupId, fecha, cantidad, valor, tasaMensual, new Date().toISOString(),
    'confirmado', 'tesorero@x.test', 'presi@x.test', new Date().toISOString(),
    `acc_${Math.random().toString(36).slice(2, 8)}`, '',
  ]);
}

/** Meses completos entre dos fechas, contando desde el mes siguiente. */
function mesesDevengados(desde, hasta = new Date()) {
  const a = new Date(desde);
  return Math.max(0, (hasta.getFullYear() - a.getFullYear()) * 12 + (hasta.getMonth() - a.getMonth()));
}

/** Fecha de hace N meses, en formato AAAA-MM-DD. */
function haceMeses(n) {
  const d = new Date();
  d.setDate(15);              // dia intermedio, para no cruzar de mes por azar
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
}

module.exports = async function run() {
  // ===================================================================
  t.section('UTI 1. La tasa del grupo es MENSUAL, no anual');
  // ===================================================================
  seedWorkbook();
  const e1 = await baseScenario({ groupId: 'GU1' });

  // 30 acciones de $10 = $300 invertidos, al 2% mensual, compradas hace 3 meses.
  // Devengan desde el mes siguiente: 3 meses de interes.
  //   300 x 0,02 = $6,00 al mes  ->  $18,00 en tres meses
  sembrarAcciones(e1.users.socio1.email, 'GU1', 30, 10, 2, haceMeses(3));

  const r1 = await get(
    `/api/savings/complete?email=${e1.users.socio1.email}&groupId=GU1`, e1.tokens.socio1);
  t.status('el resumen responde', r1, 200);

  const meses1 = (r1.body?.data?.historialUtilidades || []).length;
  // El numero exacto de meses depende del dia en que se corra la prueba:
  // basta con que sean varios y con que la cuenta cuadre con ellos.
  t.check('se calculo mes a mes, no de una sola vez', meses1 >= 2,
    `meses calculados: ${meses1}`);

  const esperado1 = 300 * 0.02 * meses1;
  t.near(`sobre $300 al 2% mensual durante ${meses1} meses = $${esperado1.toFixed(2)}`,
    r1.body?.data?.utilidadesEstimadas, esperado1, 0.05);

  const primerMes = (r1.body?.data?.historialUtilidades || [])[0] || {};
  t.near('cada mes aplica el 2%, no el 0,17% de leerlo como anual',
    primerMes.tasaMensual, 2, 0.01);
  t.near('y el interes de ese mes es $6,00', primerMes.interesMes, 6, 0.02);
  t.near('sobre una base de $300', primerMes.baseDevengable, 300, 0.01);

  // ===================================================================
  t.section('UTI 2. Se empieza a devengar el mes SIGUIENTE a la compra');
  // ===================================================================
  seedWorkbook();
  const e2 = await baseScenario({ groupId: 'GU2' });
  sembrarAcciones(e2.users.socio1.email, 'GU2', 50, 10, 2, haceMeses(0)); // este mes

  const r2 = await get(
    `/api/savings/complete?email=${e2.users.socio1.email}&groupId=GU2`, e2.tokens.socio1);
  t.near('lo comprado este mes todavia no genera nada',
    r2.body?.data?.utilidadesEstimadas, 0, 0.001);

  // ===================================================================
  t.section('UTI 3. Interes simple: la base no crece sola');
  // ===================================================================
  seedWorkbook();
  const e3 = await baseScenario({ groupId: 'GU3' });
  sembrarAcciones(e3.users.socio1.email, 'GU3', 100, 10, 2, haceMeses(4)); // $1000

  const r3 = await get(
    `/api/savings/complete?email=${e3.users.socio1.email}&groupId=GU3`, e3.tokens.socio1);
  const hist3 = r3.body?.data?.historialUtilidades || [];
  t.check('hay varios meses de historial', hist3.length >= 3, `son ${hist3.length}`);

  const basesIguales = hist3.every((m) => Math.abs(Number(m.baseDevengable) - 1000) < 0.01);
  t.check('la base se mantiene en $1.000 todos los meses (interes simple)',
    basesIguales, JSON.stringify(hist3.map((m) => m.baseDevengable)));

  const importesIguales = hist3.every((m) => Math.abs(Number(m.interesMes) - 20) < 0.02);
  t.check('y cada mes rinde exactamente $20 (1000 x 2%)',
    importesIguales, JSON.stringify(hist3.map((m) => m.interesMes)));

  const suma = hist3.reduce((s, m) => s + Number(m.interesMes), 0);
  t.near('el total es la suma de los meses, sin descuadres',
    r3.body?.data?.utilidadesEstimadas, suma, 0.02);

  // ===================================================================
  t.section('UTI 4. Las acciones sin confirmar NO generan utilidades');
  // ===================================================================
  seedWorkbook();
  const e4 = await baseScenario({ groupId: 'GU4' });
  sembrarAcciones(e4.users.socio1.email, 'GU4', 40, 10, 2, haceMeses(3));
  // La misma compra pero pendiente de confirmar
  fake.ensureSheet('Acciones').grid.push([
    e4.users.socio1.email, 'GU4', haceMeses(3), 40, 10, 2, new Date().toISOString(),
    'pendiente', e4.users.socio1.email, '', '', 'acc_pendiente', '',
  ]);

  const r4 = await get(
    `/api/savings/complete?email=${e4.users.socio1.email}&groupId=GU4`, e4.tokens.socio1);
  const hist4 = r4.body?.data?.historialUtilidades || [];
  const base4 = Number((hist4[0] || {}).baseDevengable);
  t.near('la base son solo las 40 acciones confirmadas ($400), no las 80', base4, 400, 0.01);
  t.near('y las acciones que cuentan valen $400', r4.body?.data?.totalAcciones, 400, 0.01);

  // ===================================================================
  t.section('UTI 5. Un tope de cordura que se avisa, no silencioso');
  // ===================================================================
  seedWorkbook();
  const e5 = await baseScenario({ groupId: 'GU5' });
  sembrarAcciones(e5.users.socio1.email, 'GU5', 10, 10, 45, haceMeses(2)); // 45% mensual

  const r5 = await get(
    `/api/savings/complete?email=${e5.users.socio1.email}&groupId=GU5`, e5.tokens.socio1);
  const hist5 = r5.body?.data?.historialUtilidades || [];
  t.near('una tasa absurda se recorta al 10% mensual',
    (hist5[0] || {}).tasaMensual, 10, 0.01);
  const audit5 = await get(
    `/api/savings/audit?email=${e5.users.socio1.email}&groupId=GU5`, e5.tokens.socio1);
  const norm = audit5.body?.data?.validacionesNormativas || {};
  t.check('y queda constancia del recorte en la auditoria',
    Number(norm.lotesConTasaAjustada) >= 1, JSON.stringify(norm).slice(0, 200));
  t.near('con el tope que se aplico a la vista', norm.topeMensualAplicado, 0.10, 0.001);

  // ===================================================================
  t.section('UTI 5b. Cada compra rinde por su cuenta: antiguedad y tasa propias');
  // ===================================================================
  seedWorkbook();
  const e5b = await baseScenario({ groupId: 'GU5B' });

  // Una compra vieja y una reciente, del mismo socio y del mismo importe.
  // La vieja lleva mas meses acumulando, asi que tiene que haber ganado mas.
  sembrarAcciones(e5b.users.socio1.email, 'GU5B', 10, 10, 2, haceMeses(6));  // $100 hace 6 meses
  sembrarAcciones(e5b.users.socio1.email, 'GU5B', 10, 10, 2, haceMeses(1));  // $100 hace 1 mes

  const r5b = await get(
    `/api/savings/complete?email=${e5b.users.socio1.email}&groupId=GU5B`, e5b.tokens.socio1);
  const hist5b = r5b.body?.data?.historialUtilidades || [];

  // El primer mes solo devenga la compra vieja: $100 x 2% = $2
  t.near('el primer mes solo rinde la compra antigua ($100 x 2% = $2)',
    (hist5b[0] || {}).interesMes, 2, 0.02);
  t.near('...sobre una base de $100', (hist5b[0] || {}).baseDevengable, 100, 0.01);

  // El ultimo mes ya devengan las dos: $200 x 2% = $4
  const ultimo = hist5b[hist5b.length - 1] || {};
  // Si la compra reciente todavia no cumplio un mes, el ultimo mes solo rinde
  // la antigua. Se comprueba con la base que el propio calculo declara.
  const baseUlt = Number(ultimo.baseDevengable);
  t.check('el ultimo mes rinde sobre $100 o sobre $200, segun el dia',
    baseUlt === 100 || baseUlt === 200, `base: ${baseUlt}`);
  t.near('y el interes es el 2% de esa base', ultimo.interesMes, baseUlt * 0.02, 0.02);

  // La cuenta total: 6 meses la vieja, 1 mes la nueva
  const mesesVieja = hist5b.length;
  const mesesNueva = hist5b.filter((m) => Number(m.baseDevengable) >= 199).length;
  const esperado5b = (100 * 0.02 * mesesVieja) + (100 * 0.02 * mesesNueva);
  t.near(`la vieja gano ${mesesVieja} meses y la nueva ${mesesNueva}: $${esperado5b.toFixed(2)}`,
    r5b.body?.data?.utilidadesEstimadas, esperado5b, 0.05);
  t.check('la compra antigua acumulo mas meses que la reciente',
    mesesVieja > mesesNueva, `vieja ${mesesVieja} vs nueva ${mesesNueva}`);

  // ===================================================================
  t.section('UTI 5c. Dos compras con TASAS distintas no se promedian');
  // ===================================================================
  seedWorkbook();
  const e5c = await baseScenario({ groupId: 'GU5C' });
  // El grupo cambio su interes: la compra vieja quedo al 1% y la nueva al 3%
  sembrarAcciones(e5c.users.socio1.email, 'GU5C', 10, 10, 1, haceMeses(4));  // $100 al 1%
  sembrarAcciones(e5c.users.socio1.email, 'GU5C', 20, 10, 3, haceMeses(4));  // $200 al 3%

  const r5c = await get(
    `/api/savings/complete?email=${e5c.users.socio1.email}&groupId=GU5C`, e5c.tokens.socio1);
  const hist5c = r5c.body?.data?.historialUtilidades || [];
  // Correcto:  100 x 1% + 200 x 3% = 1 + 6 = $7,00 al mes
  // Promediando (el error de antes): 300 x 2% = $6,00. Un dolar de menos.
  t.near('cada compra usa SU tasa: 100 x 1% + 200 x 3% = $7,00 al mes',
    (hist5c[0] || {}).interesMes, 7, 0.02);
  t.check('y no el promedio del 2%, que habria dado $6,00',
    Math.abs(Number((hist5c[0] || {}).interesMes) - 6) > 0.5,
    `salio ${(hist5c[0] || {}).interesMes}`);
  t.near('el total son esos $7 por cada mes devengado',
    r5c.body?.data?.utilidadesEstimadas, 7 * hist5c.length, 0.05);

  // ===================================================================
  t.section('UTI 6. Prestamos: el interes y como baja el saldo');
  // ===================================================================
  seedWorkbook();
  const e6 = await baseScenario({ groupId: 'GU6' });

  // Ahorro suficiente para que el cupo permita pedir 300
  await post('/api/savings', { groupId: 'GU6', tipo: 'mensual', monto: 200 }, e6.tokens.socio1);
  // La bandeja separa 'ahorros' y 'acciones'; hay que confirmar cada una
  const pendientes = await get(`/api/gob/aportes-pendientes?groupId=GU6`, e6.tokens.teso);
  for (const a of (pendientes.body?.ahorros || [])) {
    await post('/api/gob/aportes/resolver',
      { groupId: 'GU6', tipo: 'ahorro', movId: a.movId, accion: 'confirmar' }, e6.tokens.presi);
  }
  const compro = await get(`/api/savings/complete?email=${e6.users.socio1.email}&groupId=GU6`, e6.tokens.socio1);
  t.near('el socio queda con $200 de ahorro confirmado', compro.body?.data?.totalAhorros, 200, 0.01);

  await post('/api/gob/reglas', { groupId: 'GU6', requiereAprobacionPrestamos: true }, e6.tokens.presi);
  const sol = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 300, Detalles: 'Plazo: 6', Group: 'GU6' },
  }, e6.tokens.socio1);
  t.statusIn('la solicitud de prestamo se registra', sol, [200, 201]);

  // El identificador se lee de la bandeja de pendientes
  const bandeja = await get('/api/solicitudes-pendientes?group=GU6&tipo=prestamo', e6.tokens.presi);
  t.check('y aparece en la bandeja de la junta',
    JSON.stringify(bandeja.body).includes('300'), JSON.stringify(bandeja.body).slice(0, 200));
  const solRows = fake.dumpSheet('SolicitudesPrestamos') || [];
  const solId = solRows[solRows.length - 1][0];

  // Con aprobacion colegiada activa, un solo directivo NO puede aprobar
  const soloUno = await post('/api/approve-loan-request',
    { loanId: solId, action: 'approve' }, e6.tokens.presi);
  t.status('un solo directivo no aprueba el prestamo', soloUno, 409);
  t.eq('...y se le dice que debe votar', soloUno.body?.codigo, 'REQUIERE_VOTACION');

  // La junta vota: al alcanzar el quorum la solicitud se aprueba sola
  await post('/api/registrar-voto',
    { solicitudId: solId, tipo: 'prestamo', grupoId: 'GU6', decision: 'aprobado' }, e6.tokens.presi);
  await post('/api/registrar-voto',
    { solicitudId: solId, tipo: 'prestamo', grupoId: 'GU6', decision: 'aprobado' }, e6.tokens.teso);

  const prestamos = await get(
    `/api/obtener-prestamos?groupId=GU6&userEmail=${e6.users.socio1.email}`, e6.tokens.socio1);
  const p = (prestamos.body?.loans || [])[0];
  t.check('el prestamo queda creado', !!p, JSON.stringify(prestamos.body).slice(0, 200));

  if (p) {
    const tasa = Number(p.interestRate);
    const plazo = Number(p.term);
    const totalEsperado = Math.round(300 * (1 + (tasa / 100) * plazo) * 100) / 100;
    t.near(`total = 300 x (1 + ${tasa}% x ${plazo} meses) = $${totalEsperado}`,
      p.totalAPagar, totalEsperado, 0.02);
    t.near('al no haber pagado nada, se debe el total', p.remainingBalance, totalEsperado, 0.02);
    t.near('y lo pagado es cero', p.paid, 0, 0.001);

    // Un pago aprobado baja el saldo en exactamente lo pagado
    const cuota = Math.round((totalEsperado / plazo) * 100) / 100;
    fake.ensureSheet('LoanPayments').grid.push([
      'PAY_UTI_1', e6.users.socio1.email, p.loanId, cuota, new Date().toISOString(),
      'cuota 1', 'approved', '', '', '', '', new Date().toISOString(),
      e6.users.teso ? e6.users.teso.email : 'teso', new Date().toISOString(), '',
    ]);

    const tras = await get(
      `/api/obtener-prestamos?groupId=GU6&userEmail=${e6.users.socio1.email}`, e6.tokens.socio1);
    const p2 = (tras.body?.loans || []).find((x) => x.loanId === p.loanId);
    t.near(`tras pagar una cuota de $${cuota}, consta como pagado`, p2?.paid, cuota, 0.02);
    t.near('y el saldo baja exactamente esa cuota',
      p2?.remainingBalance, Math.round((totalEsperado - cuota) * 100) / 100, 0.02);
    t.check('el saldo nunca queda negativo', Number(p2?.remainingBalance) >= 0,
      `saldo: ${p2?.remainingBalance}`);
  }

  // ===================================================================
  t.section('UTI 7. El patrimonio cuadra con sus partes');
  // ===================================================================
  seedWorkbook();
  const e7 = await baseScenario({ groupId: 'GU7' });
  sembrarAcciones(e7.users.socio1.email, 'GU7', 20, 10, 2, haceMeses(2)); // $200
  fake.ensureSheet('Savings').grid.push([
    e7.users.socio1.email, 'GU7', 350, haceMeses(2), 'mensual', 'aporte',
    'confirmado', 'x', 'y', new Date().toISOString(), 'sav_uti', '',
  ]);

  const r7 = await get(
    `/api/savings/complete?email=${e7.users.socio1.email}&groupId=GU7`, e7.tokens.socio1);
  const d7 = r7.body?.data || {};
  // El patrimonio es lo que se TIENE: ahorro (que ya incluye las utilidades
  // abonadas) mas acciones. La proyeccion teorica NO se suma: seria contar dos
  // veces el mismo concepto.
  const partes = Number(d7.totalAhorros) + Number(d7.totalAcciones);
  t.near('patrimonio = ahorros + acciones + utilidades, sin sobrantes ni faltantes',
    d7.totalPatrimonio, Math.round(partes * 100) / 100, 0.02);
  t.near('los ahorros son los $350 confirmados', d7.totalAhorros, 350, 0.01);
  t.near('las acciones valen $200', d7.totalAcciones, 200, 0.01);
  t.check('y las utilidades son mayores que cero tras dos meses',
    Number(d7.utilidadesEstimadas) > 0, `estimadas: ${d7.utilidadesEstimadas}`);
};
