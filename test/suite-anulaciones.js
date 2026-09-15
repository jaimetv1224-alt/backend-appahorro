/**
 * SUITE 29 - Deshacer lo que se reviso mal.
 *
 * Dos cosas no tenian marcha atras, y las dos pasan de verdad en un grupo:
 *
 *   - Un comprobante aprobado por error. `/api/approve-payment` respondia 409
 *     "ya fue aprobado... No se puede volver a procesar". Medido: un comprobante
 *     de $120 aprobado cuando la socia solo habia depositado $60 dejo el saldo
 *     del prestamo en $0,00, y desde la app no habia forma de corregirlo.
 *   - Un punto de asamblea que nadie ha decidido todavia. La propia app decia
 *     "anula el punto y vuelve a proponerlo" y ese endpoint no existia.
 *
 * Y hay un caso que NO se puede deshacer, con una razon de dinero: si el interes
 * de ese comprobante ya salio en un cierre aplicado, el motor de reparto no sabe
 * restar. Medido con el motor real: cinco socias con $100, prestamo de $100 a
 * devolver por $120, comprobante de $120 aprobado por error y cierre de marzo
 * aplicado ($20 repartidos, $4 a cada una). Al corregirlo a $60 y cobrar la
 * segunda cuota real, el grupo habia ganado $20 y ya habia pagado $20, pero el
 * reparto ofrecia OTROS $10. La caja quedaba $10 corta. Por eso se para.
 */

const { PNG_PRUEBA, hoyLocal, seedWorkbook, get, post, postArchivo, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();

/** Prestamo con sus pagos, tal cual quedan en la hoja. */
function prestamo(id, email, grupo, principal, total, inicio, pagos) {
  fake.ensureSheet('Loans').grid.push([
    id, email, grupo, principal, inicio, new Date().toISOString(), 2, 'aprobado', 6, total,
  ]);
  (pagos || []).forEach(([pagoId, monto, fecha, estado]) => fake.ensureSheet('LoanPayments').grid.push([
    pagoId, email, id, monto, fecha, 'cuota', estado || 'approved',
    '', '', '', '', new Date().toISOString(), 'teso@juntago.test', new Date().toISOString(), '',
  ]));
}

const acciones = (email, grupo, cantidad, fecha) => fake.ensureSheet('Acciones').grid.push([
  email, grupo, fecha, cantidad, 10, 2, new Date().toISOString(),
  'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(),
  `acc_${Math.random().toString(36).slice(2, 8)}`, '',
]);

module.exports = async function run() {
  const G_SHEETS = require('../governance').SHEETS;
  const { HOJA, CABECERA } = require('../accesos');
  const hoja = require('../hoja');
  const preparar = () => {
    seedWorkbook();
    Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
    fake.seedSheet(HOJA, [CABECERA]);
    hoja.invalidarTodo();
  };

  // ===================================================================
  t.section('ANU 1. Un comprobante aprobado por error vuelve a la bandeja');
  // ===================================================================
  preparar();
  const e = await baseScenario({ groupId: 'GANU' });
  prestamo('LN_1', e.users.socio1.email, 'GANU', 100, 120, '2026-01-05',
    [['PAGO_MALO', 120, '2026-03-15', 'approved']]);
  hoja.invalidarTodo();

  const saldoDe = async () => Number(((await get(
    `/api/obtener-prestamos?groupId=GANU&userEmail=${e.users.socio1.email}`,
    e.tokens.socio1)).body?.loans || [])[0]?.remainingBalance);
  t.near('el prestamo consta saldado por el comprobante de $120', await saldoDe(), 0, 0.01);

  const sinMotivo = await post('/api/gob/pagos/revertir',
    { paymentId: 'PAGO_MALO' }, e.tokens.presi);
  t.status('sin motivo no se deshace nada', sinMotivo, 400);
  t.check('y se pide el motivo', /por qu/i.test(sinMotivo.body?.message || ''), sinMotivo.body?.message);

  const laTesoreria = await post('/api/gob/pagos/revertir',
    { paymentId: 'PAGO_MALO', motivo: 'deposito $60, no $120' }, e.tokens.teso);
  t.status('la tesoreria no deshace su propia revision', laTesoreria, 403);

  const deshecho = await post('/api/gob/pagos/revertir',
    { paymentId: 'PAGO_MALO', motivo: 'la socia deposito $60, no $120' }, e.tokens.presi);
  t.status('la presidencia si puede deshacerlo', deshecho, 200);

  hoja.invalidarTodo();
  t.near('el saldo vuelve a los $120 completos', await saldoDe(), 120, 0.01);

  const fila = (fake.dumpSheet('LoanPayments') || []).slice(1)
    .find((r) => (r[0] || '') === 'PAGO_MALO');
  t.eq('el comprobante vuelve a estar por revisar',
    (fila?.[6] || '').toString().toLowerCase(), 'pending_approval');

  const bandeja = await get('/api/pending-payments?groupId=GANU', e.tokens.teso);
  t.check('y aparece otra vez en la bandeja de la tesoreria',
    (bandeja.body?.payments || []).some((x) => x.paymentId === 'PAGO_MALO'),
    JSON.stringify((bandeja.body?.payments || []).map((x) => x.paymentId)));

  const bitacora = (fake.dumpSheet('GobernanzaLog') || []).slice(1);
  t.check('queda el motivo en la bitacora del grupo',
    bitacora.some((r) => (r[5] || '').includes('deposito $60')),
    JSON.stringify(bitacora.map((r) => r[5]).slice(-3)));

  // ===================================================================
  t.section('ANU 2. Quien lo devolvio no lo vuelve a resolver');
  // ===================================================================
  const mismaMano = await post('/api/approve-payment',
    { paymentId: 'PAGO_MALO', action: 'approve' }, e.tokens.presi);
  t.status('quien lo devolvio a revision no puede aprobarlo el mismo', mismaMano, 403);
  t.status('pero la tesoreria si',
    await post('/api/approve-payment',
      { paymentId: 'PAGO_MALO', action: 'reject' }, e.tokens.teso), 200);

  // ===================================================================
  t.section('ANU 3. Si el interes ya se repartio, no se deshace');
  // ===================================================================
  preparar();
  const f = await baseScenario({ groupId: 'GREP' });
  ['presi', 'teso', 'secre', 'socio1', 'socio2']
    .forEach((q) => acciones(f.users[q].email, 'GREP', 10, '2026-01-10'));
  prestamo('LN_2', f.users.socio1.email, 'GREP', 100, 120, '2026-01-05',
    [['PAGO_REPARTIDO', 120, '2026-03-15', 'approved']]);
  hoja.invalidarTodo();

  const cierre = await post('/api/gob/utilidades/cierre', { groupId: 'GREP' }, f.tokens.presi);
  t.status('se cierra marzo', cierre, 201);
  const filaCierre = fake.ensureSheet('CierresUtilidades').grid
    .find((r) => (r[0] || '') === cierre.body?.cierreId);
  if (filaCierre) filaCierre[2] = 'aplicado';
  hoja.invalidarTodo();

  const yaRepartido = await post('/api/gob/pagos/revertir',
    { paymentId: 'PAGO_REPARTIDO', motivo: 'me equivoque de importe' }, f.tokens.presi);
  t.status('con el interes ya repartido, no se deshace', yaRepartido, 409);
  t.check('y se explica por que, sin jerga',
    /repart/i.test(yaRepartido.body?.message || ''), yaRepartido.body?.message);

  const siguePagado = (fake.dumpSheet('LoanPayments') || []).slice(1)
    .find((r) => (r[0] || '') === 'PAGO_REPARTIDO');
  t.eq('el comprobante se queda como estaba',
    (siguePagado?.[6] || '').toString().toLowerCase(), 'approved');

  // ===================================================================
  t.section('ANU 4. Un punto de asamblea que nadie ha decidido se anula');
  // ===================================================================
  preparar();
  const g = await baseScenario({ groupId: 'GACU' });
  const asa = await post('/api/gob/asambleas',
    { groupId: 'GACU', titulo: 'Asamblea', fechaProgramada: hoy(), modalidad: 'presencial' },
    g.tokens.presi);
  const asambleaId = asa.body?.asambleaId;
  await post(`/api/gob/asambleas/${asambleaId}/asistencia`, {
    groupId: 'GACU',
    registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
      .map((q) => ({ email: g.users[q].email, estado: 'presente' })),
  }, g.tokens.secre);
  await post(`/api/gob/asambleas/${asambleaId}/estado`,
    { estado: 'abierta', groupId: 'GACU' }, g.tokens.presi);

  const acu = await post(`/api/gob/asambleas/${asambleaId}/acuerdos`, {
    groupId: 'GACU', titulo: 'Punto mal redactado',
    contenido: 'Este punto se escribio mal y hay que volver a proponerlo.',
  }, g.tokens.secre);
  t.statusIn('se crea el punto', acu, [200, 201]);
  const acuerdoId = acu.body?.acuerdoId;

  await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { groupId: 'GACU', voto: 'favor' }, g.tokens.presi);

  const sinMotivo2 = await post(`/api/gob/acuerdos/${acuerdoId}/anular`, { groupId: 'GACU' }, g.tokens.presi);
  t.status('anular sin motivo no vale', sinMotivo2, 400);

  const porUnSocio = await post(`/api/gob/acuerdos/${acuerdoId}/anular`,
    { groupId: 'GACU', motivo: 'esta mal escrito' }, g.tokens.socio1);
  t.status('un socio raso no anula puntos de la asamblea', porUnSocio, 403);

  const anulado = await post(`/api/gob/acuerdos/${acuerdoId}/anular`,
    { groupId: 'GACU', motivo: 'el titulo esta mal, se vuelve a proponer' }, g.tokens.presi);
  t.status('la directiva si lo anula', anulado, 200);

  const filaAcu = (fake.dumpSheet('Acuerdos') || []).slice(1)
    .find((r) => (r[0] || '') === acuerdoId);
  t.eq('el punto queda anulado', (filaAcu?.[7] || '').toString().toLowerCase(), 'anulado');

  t.status('y ya no admite votos',
    await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { groupId: 'GACU', voto: 'favor' }, g.tokens.teso),
    409);

  // Los votos de un punto anulado dejan de bloquear la asistencia: era la salida
  // que la propia app recomendaba y no desbloqueaba nada.
  const asistencia = await post(`/api/gob/asambleas/${asambleaId}/asistencia`, {
    groupId: 'GACU',
    registros: ['presi', 'teso', 'secre', 'socio1']
      .map((q) => ({ email: g.users[q].email, estado: 'presente' })),
  }, g.tokens.secre);
  t.statusIn('y la asistencia se puede volver a tocar', asistencia, [200, 201]);

  // ===================================================================
  t.section('ANU 5. Un punto ya votado y resuelto no se borra de un plumazo');
  // ===================================================================
  const acu2 = await post(`/api/gob/asambleas/${asambleaId}/acuerdos`, {
    groupId: 'GACU', titulo: 'Punto de verdad',
    contenido: 'Este si se decide en la asamblea.',
  }, g.tokens.secre);
  const acuerdo2 = acu2.body?.acuerdoId;
  for (const q of ['presi', 'teso', 'secre', 'socio1']) {
    await post(`/api/gob/acuerdos/${acuerdo2}/votar`, { groupId: 'GACU', voto: 'favor' }, g.tokens[q]);
  }
  const resuelto = (fake.dumpSheet('Acuerdos') || []).slice(1)
    .find((r) => (r[0] || '') === acuerdo2);
  t.check('el punto quedo decidido por la asamblea',
    ['aprobado', 'rechazado'].includes((resuelto?.[7] || '').toString().toLowerCase()),
    `estado: ${resuelto?.[7]}`);

  const borrarLoVotado = await post(`/api/gob/acuerdos/${acuerdo2}/anular`,
    { groupId: 'GACU', motivo: 'ya no me gusta' }, g.tokens.presi);
  t.status('una sola firma no borra lo que voto la asamblea', borrarLoVotado, 409);

  // ===================================================================
  t.section('ANU 6. La bandeja deja ver tambien los ya revisados');
  // ===================================================================
  // Sin esto, las pestanas "Aprobados" y "Rechazados" salian vacias y la
  // presidencia no tenia por donde ver el numero de un comprobante aprobado por
  // error para poder devolverlo.
  preparar();
  const h = await baseScenario({ groupId: 'GBAN' });
  prestamo('LN_3', h.users.socio1.email, 'GBAN', 300, 336, hoy(), [
    ['P_APROBADO', 50, hoy(), 'approved'],
    ['P_RECHAZADO', 20, hoy(), 'rejected'],
    ['P_PENDIENTE', 30, hoy(), 'pending_approval'],
  ]);
  hoja.invalidarTodo();

  const ids = async (estado) => ((await get(
    `/api/pending-payments?groupId=GBAN${estado ? `&estado=${estado}` : ''}`,
    h.tokens.teso)).body?.payments || []).map((x) => x.paymentId);

  t.eq('por defecto salen los que faltan por revisar',
    JSON.stringify(await ids()), JSON.stringify(['P_PENDIENTE']));
  t.eq('con estado=approved salen los aprobados',
    JSON.stringify(await ids('approved')), JSON.stringify(['P_APROBADO']));
  t.eq('con estado=rejected, los rechazados',
    JSON.stringify(await ids('rejected')), JSON.stringify(['P_RECHAZADO']));
  t.eq('y con estado=all, los tres', (await ids('all')).length, 3);
  t.status('un estado inventado se rechaza',
    await get('/api/pending-payments?groupId=GBAN&estado=loquesea', h.tokens.teso), 400);
};
