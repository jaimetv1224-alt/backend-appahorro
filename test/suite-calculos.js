/**
 * SUITE 7 - CALCULOS Y LIMITES: que los numeros sean exactos y que los topes
 * se respeten justo en el borde.
 *
 * Aqui no se prueba "que la pantalla abra", se prueba que 300 a 6 meses al 2%
 * den 336 y no 335,99; que un socio con $100 de ahorro no pueda pedir $300,01
 * con un cupo de 3x; y que dos solicitudes aprobadas no burlen el limite de
 * prestamos activos.
 */

const { hoyLocal, PNG_PRUEBA, seedWorkbook, get, post, fake, anotar } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function seedAhorro(email, groupId, monto) {
  fake.ensureSheet('Savings').grid.push([
    email, groupId, monto, '2026-01-15', 'mensual', 'saldo previo',
    'confirmado', 'teso@juntago.test', 'presi@juntago.test', new Date().toISOString(),
    `seed_${Math.random().toString(36).slice(2, 9)}`, '',
  ]);
}

/** Crea una solicitud y la aprueba por votacion. Devuelve la fila de Loans. */
async function prestamoAprobado(ctx, monto, plazo, tokenSocio) {
  await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: monto, Detalles: `Plazo: ${plazo}`, Group: ctx.groupId },
  }, tokenSocio);
  const filas = fake.dumpSheet('SolicitudesPrestamos') || [];
  const id = filas[filas.length - 1][0];
  await post('/api/registrar-voto', { solicitudId: id, tipo: 'prestamo', grupoId: ctx.groupId, decision: 'aprobado' }, ctx.tokens.presi);
  await post('/api/registrar-voto', { solicitudId: id, tipo: 'prestamo', grupoId: ctx.groupId, decision: 'aprobado' }, ctx.tokens.teso);
  return { id, fila: (fake.dumpSheet('Loans') || []).find((r) => r[0] === id) };
}

module.exports = async function run() {
  // ===================================================================
  t.section('CALC 1. Interes simple mensual del prestamo');
  // ===================================================================
  seedWorkbook();
  const e1 = await baseScenario(); // grupo al 2% mensual, accion $10
  seedAhorro(e1.users.socio1.email, e1.groupId, 5000);
  await post('/api/gob/reglas', { groupId: e1.groupId, maxPrestamosActivos: 9 }, e1.tokens.presi);

  const casos = [
    [300, 6, 336],        // 300 * (1 + 0,02*6)
    [100, 1, 102],        // un solo mes
    [1000, 12, 1240],     // 1000 * 1,24
    [137.37, 3, 145.61],  // 137,37 * 1,06 = 145,6122 -> 145,61
    [0.05, 1, 0.05],      // centavos: 0,05 * 1,02 = 0,051 -> 0,05
  ];
  for (const [monto, plazo, esperado] of casos) {
    const { fila } = await prestamoAprobado(e1, monto, plazo, e1.tokens.socio1);
    t.eq(`${monto} a ${plazo} mes(es) al 2% = ${esperado}`, r2(fila?.[9]), esperado);
    t.eq(`  ...y el principal se guarda intacto (${monto})`, r2(fila?.[3]), r2(monto));
    t.eq(`  ...y el plazo tambien (${plazo})`, Number(fila?.[8]), plazo);
  }

  // ===================================================================
  t.section('CALC 2. Saldo del prestamo tras los pagos');
  // ===================================================================
  seedWorkbook();
  const e2 = await baseScenario();
  seedAhorro(e2.users.socio1.email, e2.groupId, 1000);
  const { id: loanId } = await prestamoAprobado(e2, 300, 6, e2.tokens.socio1);

  const { BASE } = require('./harness');
  const pagar = async (monto) => {
    const form = new FormData();
    form.append('loanId', loanId);
    form.append('amount', String(monto));
    form.append('userEmail', e2.users.socio1.email);
    form.append('groupId', e2.groupId);
    form.append('paymentDate', hoyLocal());
    form.append('paymentImage', new Blob([PNG_PRUEBA], { type: 'image/png' }), 'c.png');
    anotar('POST', '/api/upload-payment');
    const res = await fetch(`${BASE}/api/upload-payment`, {
      method: 'POST', headers: { Authorization: `Bearer ${e2.tokens.socio1}` }, body: form,
    });
    const texto = await res.text();
    let cuerpo = null; try { cuerpo = JSON.parse(texto); } catch (e) { cuerpo = null; }
    return { status: res.status, body: cuerpo };
  };
  const saldoDelSocio = async () => {
    const r = await get(`/api/obtener-prestamos?groupId=${e2.groupId}&userEmail=${e2.users.socio1.email}`, e2.tokens.socio1);
    return r2((r.body?.loans || []).find((l) => l.loanId === loanId)?.remainingBalance);
  };
  const aprobarUltimoPago = async () => {
    const pagos = (fake.dumpSheet('LoanPayments') || []).slice(1).filter((r) => (r[2] || '') === loanId);
    const ultimo = pagos[pagos.length - 1];
    return post('/api/approve-payment', { paymentId: ultimo[0], action: 'approve' }, e2.tokens.presi);
  };

  t.eq('el saldo arranca en 336', await saldoDelSocio(), 336);

  t.statusIn('el socio sube un pago de 100.55', await pagar(100.55), [200, 201]);
  t.eq('el saldo NO baja mientras el pago no se apruebe', await saldoDelSocio(), 336);
  t.status('la presidencia aprueba el pago', await aprobarUltimoPago(), 200);
  t.eq('ahora el saldo es 235.45 (336 - 100.55)', await saldoDelSocio(), 235.45);

  t.statusIn('sube un segundo pago de 235.45 (el saldo exacto)', await pagar(235.45), [200, 201]);
  await aprobarUltimoPago();
  t.eq('el prestamo queda en 0, sin centavos colgando', await saldoDelSocio(), 0);

  const excedido = await pagar(0.01);
  t.status('un centavo mas se rechaza', excedido, 400);

  // ===================================================================
  t.section('CALC 3. Cupo de credito, justo en el borde');
  // ===================================================================
  seedWorkbook();
  const e3 = await baseScenario();
  seedAhorro(e3.users.socio1.email, e3.groupId, 100);
  // cupo por defecto = 3x = 300 exactos

  const justo = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 300, Detalles: 'Plazo: 6', Group: e3.groupId },
  }, e3.tokens.socio1);
  t.status('300 (exactamente el cupo) se acepta', justo, 201);

  seedWorkbook();
  const e3b = await baseScenario();
  seedAhorro(e3b.users.socio1.email, e3b.groupId, 100);
  const pasado = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 300.01, Detalles: 'Plazo: 6', Group: e3b.groupId },
  }, e3b.tokens.socio1);
  t.status('300.01 (un centavo mas) se rechaza', pasado, 409);
  t.eq('el cupo informado es exactamente 300', r2(pasado.body?.cupoMaximo), 300);
  t.eq('y el ahorro considerado es 100', r2(pasado.body?.ahorroConfirmado), 100);

  // El ahorro PENDIENTE no da cupo
  await post('/api/savings', { groupId: e3b.groupId, tipo: 'extra', monto: 900 }, e3b.tokens.socio1);
  const conPendiente = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 400, Detalles: 'Plazo: 6', Group: e3b.groupId },
  }, e3b.tokens.socio1);
  t.status('un ahorro sin confirmar NO amplia el cupo', conPendiente, 409);
  t.eq('el cupo sigue siendo 300', r2(conPendiente.body?.cupoMaximo), 300);

  // ===================================================================
  t.section('CALC 4. Limite de prestamos activos');
  // ===================================================================
  seedWorkbook();
  const e4 = await baseScenario();
  seedAhorro(e4.users.socio1.email, e4.groupId, 1000);

  const p1 = await prestamoAprobado(e4, 100, 3, e4.tokens.socio1);
  t.check('el primer prestamo se crea', !!p1.fila, JSON.stringify(p1.fila));

  const segundo = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 3', Group: e4.groupId },
  }, e4.tokens.socio1);
  t.status('con un prestamo activo no se admite otra solicitud', segundo, 409);
  t.eq('...con el codigo correcto', segundo.body?.codigo, 'MAX_PRESTAMOS_ACTIVOS');

  // Una solicitud SIN RESOLVER cuenta igual que un prestamo dado: es dinero
  // comprometido. Antes se podian dejar dos o tres vivas a la vez ocupando el
  // cupo del grupo entero hasta que alguien votara.
  seedWorkbook();
  const e5 = await baseScenario();
  seedAhorro(e5.users.socio1.email, e5.groupId, 1000);
  const s1 = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 3', Group: e5.groupId },
  }, e5.tokens.socio1);
  const s2 = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 3', Group: e5.groupId },
  }, e5.tokens.socio1);
  t.status('la primera solicitud entra', s1, 201);
  t.status('la segunda ya no: la primera sigue esperando respuesta', s2, 409);
  t.eq('con su codigo', s2.body?.codigo, 'MAX_PRESTAMOS_ACTIVOS');
  t.eq('y se dice que hay una esperando', s2.body?.solicitudesPendientes, 1);
  t.check('el mensaje explica que se puede retirar',
    /retira la que ya no quieras/i.test(s2.body?.message || ''), s2.body?.message);

  // Y retirando la primera se puede volver a pedir: no queda atrapada.
  const idPrimera = ((fake.dumpSheet('SolicitudesPrestamos') || []).slice(1)[0] || [])[0];
  const retiro = await post('/api/retirar-solicitud',
    { tipo: 'prestamo', id: idPrimera }, e5.tokens.socio1);
  t.status('la socia retira la primera', retiro, 200);
  const s3 = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 150, Detalles: 'Plazo: 3', Group: e5.groupId },
  }, e5.tokens.socio1);
  t.status('y ya puede pedir otra', s3, 201);

  // Aprobar las dos (la retirada y la nueva) no puede dejar dos prestamos vivos.
  const solicitudes = (fake.dumpSheet('SolicitudesPrestamos') || []).slice(1);
  for (const fila of solicitudes) {
    const id = fila[0];
    await post('/api/registrar-voto', { solicitudId: id, tipo: 'prestamo', grupoId: e5.groupId, decision: 'aprobado' }, e5.tokens.presi);
    await post('/api/registrar-voto', { solicitudId: id, tipo: 'prestamo', grupoId: e5.groupId, decision: 'aprobado' }, e5.tokens.teso);
  }
  const activos = (fake.dumpSheet('Loans') || []).slice(1)
    .filter((r) => (r[1] || '') === e5.users.socio1.email);
  t.eq('aprobar las dos NO puede dejar 2 prestamos activos con el limite en 1', activos.length, 1);

  // ===================================================================
  t.section('CALC 5. Utilidades de las acciones');
  // ===================================================================
  seedWorkbook();
  const e6 = await baseScenario(); // valor accion 10, interes 2%
  const compra = await post('/api/registrar-acciones',
    { groupId: e6.groupId, date: '2026-03-05', shares: 25, shareValue: 10, interestRate: 2 }, e6.tokens.socio1);
  await post('/api/gob/aportes/resolver',
    { groupId: e6.groupId, tipo: 'accion', movId: compra.body?.movId, accion: 'confirmar' }, e6.tokens.teso);

  // Tener acciones NO genera utilidades por si solo. El grupo reparte lo que
  // COBRO en intereses de prestamos; antes este endpoint devolvia
  // `acciones x valor x tasa`, un rendimiento garantizado que no existe, y el
  // socio veia $5 aunque el grupo no hubiera prestado un centavo.
  const util = await get(`/api/obtener-utilidades?groupId=${e6.groupId}&userEmail=${e6.users.socio1.email}`, e6.tokens.socio1);
  t.status('se pueden consultar las utilidades', util, 200);
  t.eq('sin prestamos cobrados, no hay utilidades que mostrar',
    util.body?.utilities?.length, 0);
  t.eq('y el total es cero, no una promesa', util.body?.total, 0);
  t.eq('se dice de donde sale la cifra', util.body?.fuente, 'repartos_abonados');

  // Cuando el grupo SI reparte, ahi aparece
  fake.ensureSheet('Savings').grid.push([
    e6.users.socio1.email, e6.groupId, 7.5, '2026-04-01', 'utilidad',
    'Reparto del ciclo', 'confirmado', e6.tokens ? 'presi@juntago.test' : '', '', '', 'utisav_x', '',
  ]);
  const util2 = await get(`/api/obtener-utilidades?groupId=${e6.groupId}&userEmail=${e6.users.socio1.email}`, e6.tokens.socio1);
  t.eq('tras un reparto real, aparece la linea', util2.body?.utilities?.length, 1);
  t.near('con el importe que de verdad se abono', util2.body?.total, 7.5, 0.01);

  const completo = await get(`/api/savings/complete?email=${e6.users.socio1.email}&groupId=${e6.groupId}`, e6.tokens.socio1);
  t.eq('el capital en acciones es 250', r2(completo.body?.data?.totalAcciones), 250);
  // El patrimonio es ahorros + acciones, y nada mas. Las utilidades ya
  // repartidas se abonan COMO ahorro, asi que sumarlas otra vez las contaria
  // dos veces: es el doble conteo que hacia que $500 en acciones mas $50
  // repartidos aparecieran como $590.
  t.eq('el patrimonio = ahorros + acciones, sin contar dos veces lo repartido',
    r2(completo.body?.data?.totalPatrimonio),
    r2(Number(completo.body?.data?.totalAhorros) + Number(completo.body?.data?.totalAcciones)));

  // ===================================================================
  t.section('CALC 6. Decimales que suelen romper las sumas');
  // ===================================================================
  seedWorkbook();
  const e7 = await baseScenario();
  const montos = [0.1, 0.2, 33.33, 33.33, 33.34, 0.05, 19.99];
  for (const m of montos) {
    const r = await post('/api/savings', { groupId: e7.groupId, tipo: 'extra', monto: m }, e7.tokens.socio1);
    await post('/api/gob/aportes/resolver',
      { groupId: e7.groupId, tipo: 'ahorro', movId: r.body?.movId, accion: 'confirmar' }, e7.tokens.teso);
  }
  const esperado = r2(montos.reduce((s, m) => s + m, 0)); // 120,31
  const totalSocio = await get(`/api/savings/complete?email=${e7.users.socio1.email}&groupId=${e7.groupId}`, e7.tokens.socio1);
  t.eq(`la suma de ${montos.join(' + ')} da ${esperado}`, r2(totalSocio.body?.data?.totalAhorros), esperado);

  const tablero = await get(`/api/gob/tablero?groupId=${e7.groupId}`, e7.tokens.presi);
  t.eq('el tablero del grupo da el mismo total', r2(tablero.body?.aportes?.ahorroConfirmado), esperado);
  const resumenAdmin = await get('/api/admin/resumen', e7.tokens.admin);
  t.eq('el resumen del admin tambien', r2(resumenAdmin.body?.resumen?.totalAhorros), esperado);

  // Con la hoja devolviendo coma decimal (locale es-EC) el resultado no cambia
  fake.store.localeDecimalComma = true;
  const conComa = await get(`/api/savings/complete?email=${e7.users.socio1.email}&groupId=${e7.groupId}`, e7.tokens.socio1);
  t.eq('el mismo total leyendo "120,31" en vez de 120.31', r2(conComa.body?.data?.totalAhorros), esperado);
  fake.store.localeDecimalComma = false;

  // ===================================================================
  t.section('CALC 7. Valores absurdos rechazados');
  // ===================================================================
  seedWorkbook();
  const e8 = await baseScenario();
  seedAhorro(e8.users.socio1.email, e8.groupId, 1000);

  const invalidos = [
    ['cero', 0], ['negativo', -50], ['texto', 'mucho'],
    ['infinito', 1e309], ['gigantesco', 999999999999],
  ];
  for (const [nombre, valor] of invalidos) {
    const r = await post('/api/savings', { groupId: e8.groupId, tipo: 'extra', monto: valor }, e8.tokens.socio1);
    t.statusIn(`ahorro ${nombre} rechazado`, r, [400]);
  }
  for (const [nombre, valor] of invalidos) {
    const r = await post('/api/registrar-solicitud', {
      tipo: 'prestamo', data: { Monto: valor, Detalles: 'Plazo: 3', Group: e8.groupId },
    }, e8.tokens.socio1);
    t.statusIn(`prestamo ${nombre} rechazado`, r, [400, 409]);
  }
  t.statusIn('acciones fraccionarias negativas rechazadas',
    await post('/api/registrar-acciones',
      { groupId: e8.groupId, date: '2026-08-01', shares: -3, shareValue: 10, interestRate: 2 }, e8.tokens.socio1), [400]);
  t.statusIn('valor de accion distinto del que fijo el grupo, rechazado',
    await post('/api/registrar-acciones',
      { groupId: e8.groupId, date: '2026-08-01', shares: 3, shareValue: 0, interestRate: 2 }, e8.tokens.socio1), [409]);

  // Y lo que de verdad importa: la fila guardada lleva SIEMPRE la cifra del
  // grupo, no la que llego en la peticion.
  await post('/api/registrar-acciones',
    { groupId: e8.groupId, date: '2026-08-01', shares: 3 }, e8.tokens.socio1);
  const ultimaAcc = (fake.dumpSheet('Acciones') || []).slice(-1)[0] || [];
  t.near('se graba el valor de accion del grupo', Number(ultimaAcc[4]), 10, 0.001);
  t.near('y el interes del grupo', Number(ultimaAcc[5]), 2, 0.001);

  const trasBasura = await get(`/api/savings/complete?email=${e8.users.socio1.email}&groupId=${e8.groupId}`, e8.tokens.socio1);
  t.eq('nada de eso ensucio el patrimonio', r2(trasBasura.body?.data?.totalAhorros), 1000);

  // ===================================================================
  t.section('CALC 8. Adelanto: sale dinero y el saldo baja');
  // ===================================================================
  seedWorkbook();
  const e9 = await baseScenario();
  seedAhorro(e9.users.socio1.email, e9.groupId, 400);

  const solAdel = await post('/api/registrar-solicitud', {
    tipo: 'adelanto', data: { Monto: 150, Detalles: 'Adelanto contra mi ahorro', Group: e9.groupId },
  }, e9.tokens.socio1);
  t.status('el socio solicita un adelanto de 150', solAdel, 201);
  const filasAdel = fake.dumpSheet('SolicitudesAdelantos') || [];
  const adelId = filasAdel[filasAdel.length - 1][0];

  await post('/api/registrar-voto', { solicitudId: adelId, tipo: 'adelanto', grupoId: e9.groupId, decision: 'aprobado' }, e9.tokens.presi);
  await post('/api/registrar-voto', { solicitudId: adelId, tipo: 'adelanto', grupoId: e9.groupId, decision: 'aprobado' }, e9.tokens.teso);

  const trasAdelanto = await get(`/api/savings/complete?email=${e9.users.socio1.email}&groupId=${e9.groupId}`, e9.tokens.socio1);
  t.eq('el ahorro baja de 400 a 250', r2(trasAdelanto.body?.data?.totalAhorros), 250);

  const tabAdel = await get(`/api/gob/tablero?groupId=${e9.groupId}`, e9.tokens.presi);
  t.eq('el tablero del grupo refleja la salida', r2(tabAdel.body?.aportes?.ahorroConfirmado), 250);

  // Un adelanto por encima del ahorro no puede dejar el saldo en negativo
  const solGrande = await post('/api/registrar-solicitud', {
    tipo: 'adelanto', data: { Monto: 5000, Detalles: 'Adelanto imposible', Group: e9.groupId },
  }, e9.tokens.socio1);
  t.status('se registra la solicitud excesiva', solGrande, 201);
  const filasAdel2 = fake.dumpSheet('SolicitudesAdelantos') || [];
  const adelId2 = filasAdel2[filasAdel2.length - 1][0];
  await post('/api/registrar-voto', { solicitudId: adelId2, tipo: 'adelanto', grupoId: e9.groupId, decision: 'aprobado' }, e9.tokens.presi);
  await post('/api/registrar-voto', { solicitudId: adelId2, tipo: 'adelanto', grupoId: e9.groupId, decision: 'aprobado' }, e9.tokens.teso);

  const trasImposible = await get(`/api/savings/complete?email=${e9.users.socio1.email}&groupId=${e9.groupId}`, e9.tokens.socio1);
  t.eq('el ahorro NUNCA queda en negativo', r2(trasImposible.body?.data?.totalAhorros), 250);

  // La solicitud no puede quedar "aprobada" sin efecto: se cierra como rechazada
  // con el motivo, para que el socio y la junta sepan que paso.
  const filaImposible = (fake.dumpSheet('SolicitudesAdelantos') || []).find((r) => r[0] === adelId2);
  t.eq('la solicitud imposible queda RECHAZADA, no aprobada', filaImposible?.[5], 'rechazado');
  t.check('y el motivo queda escrito en la solicitud',
    (filaImposible?.[7] || '').toString().includes('No aplicada'),
    `detalles: ${filaImposible?.[7]}`);
};
