/**
 * SUITE 10 - Traspaso completo desde el papel (o desde otra plataforma).
 *
 * Un grupo que lleva anos en un cuaderno no trae solo ahorros: trae prestamos
 * con SU interes, con los meses que ya se pagaron, y utilidades que ya se
 * habian repartido. Antes la apertura solo aceptaba ahorro, acciones y un saldo
 * de deuda a interes cero, asi que el prestamo heredado entraba mal.
 *
 * Aqui se comprueba que todo eso entra con sus cifras reales y que sigue sin
 * poder aplicarse sin el acuerdo de la asamblea.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

/** Deja una asamblea abierta con los tres directivos presentes. */
async function asambleaAbierta({ groupId, tokens, users }) {
  const conv = await post('/api/gob/asambleas', {
    groupId, titulo: 'Apertura de saldos', fechaProgramada: '2026-09-15', modalidad: 'presencial',
  }, tokens.presi);
  const asambleaId = conv.body?.asambleaId;
  // La asistencia se manda en bloque, en 'registros'. Con 5 miembros el quorum
  // por defecto es 3, asi que se marcan 4 presentes.
  await post(`/api/gob/asambleas/${asambleaId}/asistencia`, {
    registros: [
      { email: users.presi.email, estado: 'presente' },
      { email: users.teso.email, estado: 'presente' },
      { email: users.secre.email, estado: 'presente' },
      { email: users.socio1.email, estado: 'presente' },
      { email: users.socio2.email, estado: 'ausente' },
    ],
  }, tokens.secre);
  await post(`/api/gob/asambleas/${asambleaId}/estado`, { estado: 'abierta' }, tokens.presi);
  return asambleaId;
}

/** Somete el lote, lo vota la directiva y lo aplica. */
async function aprobarYAplicar({ loteId, asambleaId, tokens }) {
  const prop = await post(`/api/gob/apertura/lote/${loteId}/proponer`, { asambleaId }, tokens.teso);
  const acuerdoId = prop.body?.acuerdoId;
  await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, tokens.presi);
  await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, tokens.teso);
  await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, tokens.secre);
  return post(`/api/gob/apertura/lote/${loteId}/aplicar`, {}, tokens.teso);
}

module.exports = async function run() {
  seedWorkbook();
  const { users, tokens, groupId } = await baseScenario();

  // ===================================================================
  t.section('APE 1. Validacion de las cifras que trae el cuaderno');
  // ===================================================================
  t.status('un interes de deuda negativo no pasa',
    await post('/api/gob/apertura/lote', {
      groupId, filas: [{ email: users.socio1.email, deuda: 100, plazoDeuda: 6, interesDeuda: -1 }],
    }, tokens.teso), 400);

  t.status('un interes mensual imposible (mas del 100%) no pasa',
    await post('/api/gob/apertura/lote', {
      groupId, filas: [{ email: users.socio1.email, deuda: 100, plazoDeuda: 6, interesDeuda: 150 }],
    }, tokens.teso), 400);

  const masMeses = await post('/api/gob/apertura/lote', {
    groupId, filas: [{ email: users.socio1.email, deuda: 100, plazoDeuda: 6, mesesPagados: 9 }],
  }, tokens.teso);
  t.status('no se pueden haber pagado mas meses que el plazo', masMeses, 400);
  t.check('y el mensaje explica por que',
    /meses pagados no pueden superar el plazo/i.test(masMeses.body?.message || ''),
    JSON.stringify(masMeses.body));

  t.status('unas utilidades negativas no pasan',
    await post('/api/gob/apertura/lote', {
      groupId, filas: [{ email: users.socio1.email, ahorro: 10, utilidades: -5 }],
    }, tokens.teso), 400);

  t.status('una fila SOLO con utilidades si es valida (el grupo repartia intereses)',
    await post('/api/gob/apertura/lote', {
      groupId, filas: [{ email: users.socio1.email, utilidades: 25 }],
    }, tokens.teso), 201);

  // ===================================================================
  t.section('APE 2. El prestamo heredado conserva su interes y sus meses');
  // ===================================================================
  seedWorkbook();
  const e2 = await baseScenario({ groupId: 'GAP' });
  const asambleaId = await asambleaAbierta(e2);

  const lote = await post('/api/gob/apertura/lote', {
    groupId: 'GAP',
    nota: 'Cuaderno cerrado al 31 de agosto',
    filas: [
      {
        email: e2.users.socio1.email,
        ahorro: 320, acciones: 12, valorAccion: 10,
        deuda: 400, plazoDeuda: 12, interesDeuda: 2, mesesPagados: 4,
        utilidades: 35.5, nota: 'Libreta 001',
      },
      {
        email: e2.users.socio2.email,
        ahorro: 280, acciones: 8, valorAccion: 10, utilidades: 18.25,
      },
    ],
  }, e2.tokens.teso);
  t.status('el tesorero arma el lote con todas las cifras', lote, 201);
  const loteId = lote.body?.loteId;

  const aplicar = await aprobarYAplicar({ loteId, asambleaId, tokens: e2.tokens });
  t.status('la asamblea lo aprueba y se aplica', aplicar, 200);
  t.eq('se cargo 1 deuda', aplicar.body?.aplicado?.deudas, 1);

  // --- la fila real escrita en Loans ---
  // Loans: A=LoanID B=Email C=Group D=Monto E=Inicio F=Vence G=Interes H=Estado I=Plazo J=Total
  const prestamos = (fake.dumpSheet('Loans') || []).slice(1)
    .filter((r) => (r[1] || '') === e2.users.socio1.email);
  t.eq('quedo un solo prestamo heredado', prestamos.length, 1);
  const p = prestamos[0] || [];
  t.near('con el monto del cuaderno', Number(p[3]), 400);
  t.near('con SU interes mensual, no cero', Number(p[6]), 2);
  t.eq('con su plazo pactado', Number(p[8]), 12);
  t.near('y el total calculado con ese interes (400 x (1 + 0,02 x 12) = 496)', Number(p[9]), 496);
  t.eq('nace ya aprobado, porque viene del cuaderno', (p[7] || '').toString(), 'aprobado');

  // Los 4 meses ya pagados corren la fecha de inicio hacia atras: si no, el
  // prestamo pareceria recien concedido y el vencimiento saldria 4 meses tarde.
  const inicio = new Date(p[4]);
  const vence = new Date(p[5]);
  const mesesAtras = Math.round((Date.now() - inicio.getTime()) / (30.44 * 24 * 3600 * 1000));
  t.check('la fecha de inicio refleja los 4 meses ya pagados',
    mesesAtras >= 3 && mesesAtras <= 5, `se calcularon ${mesesAtras} meses de antiguedad`);
  const duracion = Math.round((vence.getTime() - inicio.getTime()) / (30.44 * 24 * 3600 * 1000));
  t.check('y el vencimiento sigue a 12 meses del inicio',
    duracion >= 11 && duracion <= 13, `duracion calculada: ${duracion} meses`);

  // ===================================================================
  t.section('APE 3. Ahorros y utilidades quedan separados y confirmados');
  // ===================================================================
  const filasAhorro = (fake.dumpSheet('Savings') || []).slice(1)
    .filter((r) => (r[0] || '') === e2.users.socio1.email);
  const tipos = filasAhorro.map((r) => (r[4] || '').toString());
  t.check('el saldo inicial entra con su propio tipo', tipos.includes('saldo_inicial'), tipos.join(', '));
  t.check('las utilidades entran aparte, no mezcladas con los aportes',
    tipos.includes('utilidad'), tipos.join(', '));
  t.check('todo lo de apertura queda confirmado, no pendiente',
    filasAhorro.every((r) => (r[6] || '').toString() === 'confirmado'),
    filasAhorro.map((r) => r[6]).join(', '));

  const completo = await get(
    `/api/savings/complete?email=${e2.users.socio1.email}&groupId=GAP`, e2.tokens.socio1);
  t.near('el ahorro del socio suma el saldo y las utilidades (320 + 35,50)',
    completo.body?.data?.totalAhorros, 355.5);
  t.near('y las acciones valen 120 (12 x 10)', completo.body?.data?.totalAcciones, 120);
  t.near('nada queda pendiente de confirmar', completo.body?.data?.pendientes?.total, 0);

  // ===================================================================
  t.section('APE 4. Las cifras cuadran para todo el grupo');
  // ===================================================================
  const socio2 = await get(
    `/api/savings/complete?email=${e2.users.socio2.email}&groupId=GAP`, e2.tokens.socio2);
  t.near('el segundo socio trae 280 + 18,25 de utilidades', socio2.body?.data?.totalAhorros, 298.25);

  const prestamosSocio2 = (fake.dumpSheet('Loans') || []).slice(1)
    .filter((r) => (r[1] || '') === e2.users.socio2.email);
  t.eq('quien no debia nada no arrastra ningun prestamo', prestamosSocio2.length, 0);

  const prestamoSocio1 = await get(
    `/api/obtener-prestamos?groupId=GAP&userEmail=${e2.users.socio1.email}`, e2.tokens.socio1);
  t.status('el socio ve su prestamo heredado en la app', prestamoSocio1, 200);
  const suyo = (prestamoSocio1.body?.loans || [])[0];
  // 400 a 12 meses al 2% mensual = 496 en total, en cuotas de 41,33. Como ya
  // habia pagado 4 en el cuaderno, debe 496 - 4x41,33 = 330,68.
  // Antes esta prueba exigia 496: daba por bueno que los meses ya pagados se
  // perdieran, y con eso el fallo estaba blindado en verde.
  t.near('el saldo descuenta las cuotas que ya habia pagado en el cuaderno',
    suyo?.remainingBalance, 330.68, 0.02);

  const pagosHeredados = (fake.dumpSheet('LoanPayments') || []).slice(1)
    .filter((r) => (r[1] || '') === e2.users.socio1.email);
  t.eq('quedaron registradas las 4 cuotas que ya habia pagado', pagosHeredados.length, 4);
  t.check('todas como aprobadas, para que cuenten en el cuadro',
    pagosHeredados.every((r) => (r[6] || '').toString().toLowerCase() === 'approved'),
    JSON.stringify(pagosHeredados.map((r) => r[6])));
  t.near('y suman lo que llevaba pagado',
    pagosHeredados.reduce((s2, r) => s2 + Number(r[3] || 0), 0), 165.32, 0.02);

  // El cuadro viene desplegado en el propio prestamo (ver /api/obtener-prestamos)
  const resHeredado = suyo?.resumen || {};
  t.eq('el cuadro dice 4 cuotas pagadas', resHeredado.cuotasPagadas, 4);
  t.eq('y ninguna vencida: no entra como moroso el primer dia', resHeredado.cuotasVencidas, 0);
  t.eq('no se le exige nada hoy', resHeredado.aPagarAhora, 0);
  t.eq('y la proxima cuota es la quinta', resHeredado.proximaCuota?.numero, 5);

  // --- Un prestamo del cuaderno YA SALDADO ---
  // Era el caso peor: entraba debiendo el total entero y con cinco cuotas
  // vencidas alguien que no debia nada.
  seedWorkbook();
  const G_SH = require('../governance').SHEETS;
  Object.values(G_SH).forEach((d) => fake.seedSheet(d.name, [d.headers]));
  const eSal = await baseScenario({ groupId: 'GSAL' });
  const hoySal = hoyLocal();
  const loteSal = await post('/api/gob/apertura/lote', {
    groupId: 'GSAL',
    filas: [{ email: eSal.users.socio1.email, deuda: 500, plazoDeuda: 6, interesDeuda: 2, mesesPagados: 6 }],
  }, eSal.tokens.presi);
  const asaSal = await post('/api/gob/asambleas',
    { groupId: 'GSAL', titulo: 'Apertura', fechaProgramada: hoySal, modalidad: 'presencial' }, eSal.tokens.presi);
  await post(`/api/gob/asambleas/${asaSal.body.asambleaId}/asistencia`, {
    groupId: 'GSAL',
    registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
      .map((q) => ({ email: eSal.users[q].email, estado: 'presente' })),
  }, eSal.tokens.secre);
  await post(`/api/gob/asambleas/${asaSal.body.asambleaId}/estado`,
    { estado: 'abierta', groupId: 'GSAL' }, eSal.tokens.presi);
  const propSal = await post(`/api/gob/apertura/lote/${loteSal.body.loteId}/proponer`,
    { groupId: 'GSAL', asambleaId: asaSal.body.asambleaId }, eSal.tokens.presi);
  for (const q of ['presi', 'teso', 'secre', 'socio1', 'socio2']) {
    await post(`/api/gob/acuerdos/${propSal.body.acuerdoId}/votar`, { groupId: 'GSAL', voto: 'favor' }, eSal.tokens[q]);
  }
  t.statusIn('se aplica el lote del prestamo ya saldado',
    await post(`/api/gob/apertura/lote/${loteSal.body.loteId}/aplicar`, {}, eSal.tokens.presi), [200, 201]);

  const prSal = await get(
    `/api/obtener-prestamos?groupId=GSAL&userEmail=${eSal.users.socio1.email}`, eSal.tokens.socio1);
  const saldado = (prSal.body?.loans || [])[0];
  t.near('quien ya termino de pagar no debe nada', saldado?.remainingBalance, 0, 0.02);
  t.eq('con las 6 cuotas dadas por pagadas', saldado?.resumen?.cuotasPagadas, 6);
  t.eq('ninguna vencida', saldado?.resumen?.cuotasVencidas, 0);
  t.eq('y sin proxima cuota', saldado?.resumen?.proximaCuota, null);

  // --- Una deuda sin plazo ya no se convierte en un prestamo a un mes ---
  const sinPlazo = await post('/api/gob/apertura/lote', {
    groupId: 'GSAL', filas: [{ email: eSal.users.socio2.email, deuda: 500 }],
  }, eSal.tokens.presi);
  t.status('una deuda sin plazo declarado se rechaza', sinPlazo, 400);
  t.check('y el mensaje pide el plazo',
    /plazo/i.test(sinPlazo.body?.message || ''), JSON.stringify(sinPlazo.body));

  // ===================================================================
  t.section('APE 5. Sigue haciendo falta el acuerdo de la asamblea');
  // ===================================================================
  seedWorkbook();
  const e3 = await baseScenario({ groupId: 'GAP2' });
  const lote3 = await post('/api/gob/apertura/lote', {
    groupId: 'GAP2',
    filas: [{ email: e3.users.socio1.email, deuda: 900, plazoDeuda: 10, interesDeuda: 3, mesesPagados: 2 }],
  }, e3.tokens.teso);
  t.status('se puede armar el lote', lote3, 201);

  t.status('pero no aplicarlo sin asamblea',
    await post(`/api/gob/apertura/lote/${lote3.body?.loteId}/aplicar`, {}, e3.tokens.teso), 409);
  t.eq('y no se escribio ningun prestamo',
    (fake.dumpSheet('Loans') || []).slice(1).filter((r) => (r[2] || '') === 'GAP2').length, 0);

  t.status('un socio raso tampoco puede armar el lote',
    await post('/api/gob/apertura/lote', {
      groupId: 'GAP2', filas: [{ email: e3.users.socio1.email, ahorro: 10 }],
    }, e3.tokens.socio1), 403);

  // ===================================================================
  t.section('APE 6. Un grupo recien creado, sin el valor de la accion fijado');
  // ===================================================================
  // Es el caso real: se crea el grupo sin poner cuanto vale la accion y, al
  // intentar comprar, el servidor devolvia un error tecnico que no decia que
  // hacer ni a quien acudir.
  // El grupo tiene que estar SIN CONFIGURAR de verdad. Antes bastaba con que el
  // cliente mandara un cero, porque el servidor se creia la cifra del cliente;
  // ahora la cifra sale del grupo, asi que hay que vaciar la celda.
  fake.ensureSheet('Groups').grid.forEach((fila) => {
    if ((fila[0] || '') === 'GAP2') { fila[15] = ''; fila[16] = ''; }
  });
  const sinValor = await post('/api/registrar-acciones', {
    groupId: 'GAP2', date: '2026-08-30', shares: 13,
  }, e3.tokens.socio1);
  t.status('comprar acciones sin valor fijado se rechaza', sinValor, 400);
  t.eq('y se identifica el motivo, para que la app pueda reaccionar',
    sinValor.body?.motivo, 'valor_accion_sin_configurar');
  t.check('el mensaje dice quien lo arregla y donde',
    /presidencia/i.test(sinValor.body?.error || '') && /reglamento del grupo/i.test(sinValor.body?.error || ''),
    JSON.stringify(sinValor.body));

  t.eq('no se escribio ninguna compra',
    (fake.dumpSheet('Acciones') || []).slice(1).filter((r) => (r[1] || '') === 'GAP2').length, 0);

  // Con el valor fijado, la misma compra procede
  t.statusIn('la presidencia fija el valor de la accion',
    await post('/api/actualizar-grupo-en-sheet',
      { GroupID: 'GAP2', ValorAccion: 10, PorcentajeInteresMensual: 2 }, e3.tokens.presi), [200, 201]);

  const conValor = await post('/api/registrar-acciones', {
    groupId: 'GAP2', date: '2026-08-30', shares: 13, shareValue: 10, interestRate: 2,
  }, e3.tokens.socio1);
  t.status('ahora si se puede comprar', conValor, 201);
  t.eq('y la compra nace pendiente de confirmacion, como cualquier aporte',
    conValor.body?.estado, 'pendiente');

  // Los otros dos mensajes tambien deben ser especificos, no uno generico
  const cantidadMala = await post('/api/registrar-acciones', {
    groupId: 'GAP2', date: '2026-08-30', shares: 0, shareValue: 10, interestRate: 2,
  }, e3.tokens.socio1);
  t.status('una cantidad de cero se rechaza', cantidadMala, 400);
  t.check('con un mensaje sobre la cantidad, no sobre el valor',
    /cantidad de acciones/i.test(cantidadMala.body?.error || ''), JSON.stringify(cantidadMala.body));
};
