/**
 * SUITE 6 - CONCURRENCIA: dos personas (o dos clics) actuando a la vez sobre el
 * mismo dinero.
 *
 * Google Sheets no tiene transacciones ni bloqueos: todo el codigo hace
 * "leer -> decidir -> escribir". Si dos peticiones entran en esa ventana, las
 * dos leen el estado viejo y las dos escriben. En un sistema de dinero eso
 * significa prestamos duplicados, saldos de apertura cargados dos veces o un
 * quorum alcanzado por una sola persona votando dos veces.
 *
 * Estas pruebas corren con latencia simulada para que la ventana exista de
 * verdad, como pasaria contra la API real.
 */

const { seedWorkbook, get, post, fake, anotar } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const LATENCIA = 12; // ms por llamada a la "hoja": abre la ventana de carrera

function seedAhorroConfirmado(email, groupId, monto) {
  fake.ensureSheet('Savings').grid.push([
    email, groupId, monto, '2026-01-15', 'mensual', 'saldo previo',
    'confirmado', 'teso@juntago.test', 'presi@juntago.test', new Date().toISOString(),
    `seed_${Math.random().toString(36).slice(2, 8)}`, '',
  ]);
}

/** Lanza la misma peticion N veces EN PARALELO. */
function enParalelo(veces, hacer) {
  return Promise.all(Array.from({ length: veces }, (_, i) => hacer(i)));
}

const conteo = (resultados, codigo) => resultados.filter((r) => r.status === codigo).length;

module.exports = async function run() {
  seedWorkbook();
  const { users, tokens, groupId } = await baseScenario();
  seedAhorroConfirmado(users.socio1.email, groupId, 600);
  seedAhorroConfirmado(users.socio2.email, groupId, 600);

  // ===================================================================
  t.section('CONC 1. Doble clic al confirmar un aporte');
  // ===================================================================
  const decl = await post('/api/savings', { groupId, tipo: 'mensual', monto: 90 }, tokens.socio1);
  const mov = decl.body?.movId;

  fake.store.latencyMs = LATENCIA;
  const dobles = await enParalelo(3, () => post('/api/gob/aportes/resolver',
    { groupId, tipo: 'ahorro', movId: mov, accion: 'confirmar' }, tokens.teso));
  fake.store.latencyMs = 0;

  t.eq('solo una confirmacion prospera', conteo(dobles, 200), 1);
  t.eq('las otras dos se rechazan con 409', conteo(dobles, 409), 2);

  const completo = await get(`/api/savings/complete?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  t.eq('el ahorro subio 90 una sola vez (600 + 90)', Math.round(completo.body?.data?.totalAhorros * 100) / 100, 690);

  // ===================================================================
  t.section('CONC 2. Un lider votando dos veces a la vez');
  // ===================================================================
  const sol = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 200, Detalles: 'Plazo: 4', Group: groupId },
  }, tokens.socio2);
  t.status('el socio registra la solicitud', sol, 201);
  const filas = fake.dumpSheet('SolicitudesPrestamos') || [];
  const solId = filas[filas.length - 1][0];

  fake.store.latencyMs = LATENCIA;
  const votosDobles = await enParalelo(3, () => post('/api/registrar-voto',
    { solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tokens.presi));
  fake.store.latencyMs = 0;

  t.eq('solo se registra UN voto de esa persona', conteo(votosDobles, 201), 1);
  const votos = await get(`/api/votos-solicitud?solicitudId=${solId}`, tokens.presi);
  t.eq('la hoja de votos tiene una sola fila suya', votos.body?.votos?.length, 1);

  const estado = (fake.dumpSheet('SolicitudesPrestamos') || []).find((r) => r[0] === solId)?.[5];
  t.eq('con un solo votante la solicitud NO alcanza quorum', estado, 'pendiente');
  t.eq('y no se creo ningun prestamo',
    (fake.dumpSheet('Loans') || []).slice(1).filter((r) => r[0] === solId).length, 0);

  // El segundo lider completa el quorum
  t.status('el tesorero emite el segundo voto',
    await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tokens.teso), 201);
  t.eq('ahora si se crea el prestamo, una sola vez',
    (fake.dumpSheet('Loans') || []).slice(1).filter((r) => r[0] === solId).length, 1);

  // ===================================================================
  t.section('CONC 3. Dos gestores aprobando el mismo prestamo a la vez');
  // ===================================================================
  await post('/api/gob/reglas', { groupId, requiereAprobacionPrestamos: false }, tokens.presi);
  const sol2 = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 150, Detalles: 'Plazo: 3', Group: groupId },
  }, tokens.socio1);
  t.status('otro socio registra su solicitud', sol2, 201);
  const filas2 = fake.dumpSheet('SolicitudesPrestamos') || [];
  const solId2 = filas2[filas2.length - 1][0];

  fake.store.latencyMs = LATENCIA;
  const aprobDobles = await Promise.all([
    post('/api/approve-loan-request', { loanId: solId2, action: 'approve' }, tokens.presi),
    post('/api/approve-loan-request', { loanId: solId2, action: 'approve' }, tokens.teso),
    post('/api/approve-loan-request', { loanId: solId2, action: 'approve' }, tokens.presi),
  ]);
  fake.store.latencyMs = 0;

  t.eq('solo una aprobacion prospera', conteo(aprobDobles, 200), 1);
  t.eq('el prestamo existe una sola vez en Loans',
    (fake.dumpSheet('Loans') || []).slice(1).filter((r) => r[0] === solId2).length, 1);
  const transDelPrestamo = (fake.dumpSheet('Transactions') || []).slice(1)
    .filter((r) => (r[4] || '').toString().includes('restamo'));
  t.eq('tampoco se duplica la transaccion del desembolso', transDelPrestamo.length, 2); // uno por cada prestamo aprobado

  // ===================================================================
  t.section('CONC 4. Aplicar el lote de apertura dos veces a la vez');
  // ===================================================================
  seedWorkbook();
  const e2 = await baseScenario();

  const lote = await post('/api/gob/apertura/lote', {
    groupId: e2.groupId,
    filas: [
      { email: e2.users.socio1.email, ahorro: 300, acciones: 10, valorAccion: 10 },
      { email: e2.users.socio2.email, ahorro: 500, acciones: 20, valorAccion: 10, deuda: 100, plazoDeuda: 4 },
    ],
  }, e2.tokens.teso);
  t.status('el tesorero crea el lote', lote, 201);
  const loteId = lote.body?.loteId;

  const asm = await post('/api/gob/asambleas', {
    groupId: e2.groupId, titulo: 'Apertura', fechaProgramada: '2026-09-10',
  }, e2.tokens.presi);
  const asambleaId = asm.body?.asambleaId;
  await post(`/api/gob/asambleas/${asambleaId}/asistencia`, {
    registros: [
      { email: e2.users.presi.email, estado: 'presente' },
      { email: e2.users.teso.email, estado: 'presente' },
      { email: e2.users.secre.email, estado: 'presente' },
    ],
  }, e2.tokens.secre);
  await post(`/api/gob/asambleas/${asambleaId}/estado`, { estado: 'abierta' }, e2.tokens.presi);
  const prop = await post(`/api/gob/apertura/lote/${loteId}/proponer`, { asambleaId }, e2.tokens.teso);
  const acuerdoId = prop.body?.acuerdoId;
  await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, e2.tokens.presi);
  await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, e2.tokens.teso);

  fake.store.latencyMs = LATENCIA;
  const aplicaciones = await Promise.all([
    post(`/api/gob/apertura/lote/${loteId}/aplicar`, {}, e2.tokens.teso),
    post(`/api/gob/apertura/lote/${loteId}/aplicar`, {}, e2.tokens.presi),
    post(`/api/gob/apertura/lote/${loteId}/aplicar`, {}, e2.tokens.teso),
  ]);
  fake.store.latencyMs = 0;

  t.eq('el lote se aplica una sola vez', conteo(aplicaciones, 200), 1);
  t.eq('las otras dos devuelven 409', conteo(aplicaciones, 409), 2);

  const filasSav = (fake.dumpSheet('Savings') || []).slice(1)
    .filter((r) => (r[4] || '') === 'saldo_inicial');
  t.eq('se cargaron 2 ahorros de apertura, no 4 ni 6', filasSav.length, 2);
  const filasAcc = (fake.dumpSheet('Acciones') || []).slice(1)
    .filter((r) => (r[11] || '').toString().startsWith('apacc_'));
  t.eq('se cargaron 2 paquetes de acciones', filasAcc.length, 2);
  const filasLoans = (fake.dumpSheet('Loans') || []).slice(1)
    .filter((r) => (r[0] || '').toString().startsWith('aploan_'));
  t.eq('se cargo 1 sola deuda', filasLoans.length, 1);

  const socio2 = await get(`/api/savings/complete?email=${e2.users.socio2.email}&groupId=${e2.groupId}`, e2.tokens.socio2);
  t.eq('el socio recibe exactamente 500 de ahorro (no 1000 ni 1500)',
    Math.round(socio2.body?.data?.totalAhorros * 100) / 100, 500);
  t.eq('y exactamente 200 en acciones (20 x 10)',
    Math.round(socio2.body?.data?.totalAcciones * 100) / 100, 200);

  // ===================================================================
  t.section('CONC 5. Dos votos simultaneos de la misma persona en un acuerdo');
  // ===================================================================
  const acu = await post(`/api/gob/asambleas/${asambleaId}/acuerdos`, {
    tipo: 'gasto', titulo: 'Compra de utiles',
  }, e2.tokens.secre);
  const acuerdo2 = acu.body?.acuerdoId;

  fake.store.latencyMs = LATENCIA;
  const votosAcuerdo = await enParalelo(3, () =>
    post(`/api/gob/acuerdos/${acuerdo2}/votar`, { voto: 'favor' }, e2.tokens.secre));
  fake.store.latencyMs = 0;

  t.eq('solo se acepta un voto', conteo(votosAcuerdo, 201), 1);
  const det = await get(`/api/gob/asambleas/${asambleaId}`, e2.tokens.presi);
  const elAcuerdo = (det.body?.acuerdos || []).find((a) => a.acuerdoId === acuerdo2);
  t.eq('el acuerdo registra un unico voto', elAcuerdo?.votos?.length, 1);
  t.eq('el conteo a favor es 1, no 3', elAcuerdo?.aFavor, 1);

  // ===================================================================
  t.section('CONC 6. Superar el limite de presidencias en paralelo');
  // ===================================================================
  seedWorkbook();
  const e3 = await baseScenario();

  fake.store.latencyMs = LATENCIA;
  const grupos = await enParalelo(3, (i) => post('/api/crear-grupo-en-sheet',
    { GroupName: `Grupo paralelo ${i}`, ValorAccion: 10, PorcentajeInteresMensual: 2 }, e3.tokens.socio1));
  fake.store.latencyMs = 0;

  const creados = grupos.filter((r) => r.status === 201 || r.status === 200).length;
  t.check('no se pueden crear mas de 2 presidencias activas', creados <= 2,
    `grupos creados de golpe: ${creados} (respuestas: ${grupos.map((g) => g.status).join(', ')})`);

  const links = (fake.dumpSheet('UserGroupLinks') || []).slice(1)
    .filter((r) => (r[0] || '') === e3.users.socio1.email && (r[3] || '') === 'presidente');
  t.check('la hoja no tiene mas de 2 presidencias suyas', links.length <= 2, `presidencias en la hoja: ${links.length}`);

  // ===================================================================
  t.section('CONC 7. Dos invitaciones simultaneas al mismo cargo');
  // ===================================================================
  seedWorkbook();
  const e4 = await baseScenario({ leaders: 1 }); // solo presidenta: tesoreria libre

  fake.store.latencyMs = LATENCIA;
  const invitaciones = await Promise.all([
    post('/api/invitar-miembro', { groupId: e4.groupId, email: e4.users.teso.email, role: 'tesorero' }, e4.tokens.presi),
    post('/api/invitar-miembro', { groupId: e4.groupId, email: e4.users.secre.email, role: 'tesorero' }, e4.tokens.presi),
  ]);
  fake.store.latencyMs = 0;
  t.check('se pueden emitir dos invitaciones al mismo cargo (se resuelve al aceptar)',
    invitaciones.every((r) => [201, 409].includes(r.status)),
    invitaciones.map((r) => r.status).join(', '));

  // Ambos aceptan a la vez: solo uno puede quedar de tesorero
  const ids = [];
  for (const tk of [e4.tokens.teso, e4.tokens.secre]) {
    const mis = await get('/api/mis-invitaciones', tk);
    ids.push(mis.body?.invitaciones?.[0]?.invitationId);
  }
  fake.store.latencyMs = LATENCIA;
  await Promise.all([
    ids[0] ? post('/api/responder-invitacion', { invitationId: ids[0], accion: 'aceptar' }, e4.tokens.teso) : Promise.resolve({}),
    ids[1] ? post('/api/responder-invitacion', { invitationId: ids[1], accion: 'aceptar' }, e4.tokens.secre) : Promise.resolve({}),
  ]);
  fake.store.latencyMs = 0;

  const tesoreros = (fake.dumpSheet('UserGroupLinks') || []).slice(1)
    .filter((r) => (r[1] || '') === e4.groupId && (r[3] || '') === 'tesorero'
      && (r[4] || 'activo').toLowerCase() !== 'inactivo');
  t.eq('el grupo termina con UN solo tesorero', tesoreros.length, 1);

  // ===================================================================
  t.section('CONC 8. Pagos simultaneos que superarian el saldo');
  // ===================================================================
  seedWorkbook();
  const e5 = await baseScenario();
  seedAhorroConfirmado(e5.users.socio1.email, e5.groupId, 400);
  await post('/api/gob/reglas', { groupId: e5.groupId, requiereAprobacionPrestamos: false }, e5.tokens.presi);

  const solPago = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 2', Group: e5.groupId },
  }, e5.tokens.socio1);
  t.status('se registra la solicitud de prestamo', solPago, 201);
  const fp = fake.dumpSheet('SolicitudesPrestamos') || [];
  const loanId = fp[fp.length - 1][0];
  await post('/api/approve-loan-request', { loanId, action: 'approve' }, e5.tokens.presi);

  const saldoTotal = Number((fake.dumpSheet('Loans') || []).find((r) => r[0] === loanId)?.[9]);
  t.near('el total a pagar es 104 (100 a 2 meses al 2%)', saldoTotal, 104);

  // Dos pagos de 80 en paralelo suman 160 > 104: el sistema no debe aceptar ambos
  const { BASE } = require('./harness');
  const subir = async (monto) => {
    const form = new FormData();
    form.append('loanId', loanId);
    form.append('amount', String(monto));
    form.append('userEmail', e5.users.socio1.email);
    form.append('groupId', e5.groupId);
    form.append('paymentDate', '2026-08-20');
    form.append('paymentImage', new Blob([Buffer.from('x')], { type: 'image/png' }), 'c.png');
    anotar('POST', '/api/upload-payment');
    const res = await fetch(`${BASE}/api/upload-payment`, {
      method: 'POST', headers: { Authorization: `Bearer ${e5.tokens.socio1}` }, body: form,
    });
    return { status: res.status };
  };

  fake.store.latencyMs = LATENCIA;
  const pagos = await Promise.all([subir(80), subir(80)]);
  fake.store.latencyMs = 0;

  const aceptados = pagos.filter((p) => p.status === 200 || p.status === 201).length;
  t.check('no se aceptan dos pagos que juntos superan la deuda', aceptados <= 1,
    `pagos aceptados: ${aceptados} (respuestas ${pagos.map((p) => p.status).join(', ')})`);

  const filasPago = (fake.dumpSheet('LoanPayments') || []).slice(1).filter((r) => (r[2] || '') === loanId);
  const sumaPagos = filasPago.reduce((s, r) => s + Number(r[3] || 0), 0);
  t.check('la suma de los pagos registrados no supera la deuda', sumaPagos <= saldoTotal + 0.01,
    `suma pagada ${sumaPagos} vs deuda ${saldoTotal}`);
};
