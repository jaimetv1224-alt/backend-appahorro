/**
 * SUITE 39 - Retirar lo que se llevo a la asamblea por error.
 *
 * Sale de un atasco medido, no supuesto. La presidenta arma el lote de saldos
 * iniciales, teclea 9999 donde iban 99, lo propone, y se da cuenta ANTES de que
 * nadie vote. Las cuatro puertas estaban cerradas a la vez:
 *
 *   anular el punto     -> 409 "este punto sostiene el lote"
 *   descartar el lote   -> 404 (el endpoint no existia)
 *   volver a proponerlo -> 409 'el lote ya esta "propuesto"'
 *   aplicarlo           -> 409 (el acuerdo no esta aprobado)
 *
 * Para salir habia que hacer que la asamblea VOTARA EN CONTRA de una cifra que
 * nadie defendia -- dejando en el acta un rechazo que nunca ocurrio -- o editar
 * la hoja a mano.
 *
 * En caja y en aval no habia atasco pero si un fantasma: anular el punto
 * funcionaba y el movimiento se quedaba 'propuesto' para siempre en la pantalla
 * del grupo. En prestamo no habia nada roto: `proponer` no escribe fila.
 *
 * Lo que se fija aqui: que exista salida, que la salida NO mueva dinero, que lo
 * ya ejecutado siga sin poder borrarse, y que si la asamblea llego a votar el
 * punto se quede en el acta.
 */

const {
  hoyLocal, seedWorkbook, get, post, fake,
} = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();

const ahorro = (email, grupo, monto, fecha) => fake.ensureSheet('Savings').grid.push([
  email, grupo, monto, fecha, 'mensual', 'aporte', 'confirmado',
  'a@a.test', 'b@b.test', new Date().toISOString(),
  `sav_${Math.random().toString(36).slice(2, 8)}`, '',
]);

module.exports = async function run() {
  const G_SHEETS = require('../governance').SHEETS;
  const { HOJA, CABECERA } = require('../accesos');
  const hoja = require('../hoja');

  const preparar = () => {
    seedWorkbook();
    Object.values(G_SHEETS).forEach((d) => fake.seedSheet(d.name, [d.headers]));
    fake.seedSheet(HOJA, [CABECERA]);
    hoja.invalidarTodo();
  };

  async function asambleaAbierta(e, G, titulo) {
    const asa = await post('/api/gob/asambleas', {
      groupId: G, titulo: titulo || 'Asamblea', fechaProgramada: hoy(), modalidad: 'presencial',
    }, e.tokens.presi);
    const id = asa.body && asa.body.asambleaId;
    await post(`/api/gob/asambleas/${id}/asistencia`, {
      groupId: G,
      registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
        .map((q) => ({ email: e.users[q].email, estado: 'presente' })),
    }, e.tokens.secre);
    await post(`/api/gob/asambleas/${id}/estado`, { estado: 'abierta', groupId: G }, e.tokens.presi);
    return id;
  }

  async function votar(e, G, acuerdoId, voto) {
    for (const q of ['presi', 'teso', 'secre', 'socio1', 'socio2']) {
      await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { groupId: G, voto }, e.tokens[q]);
    }
    hoja.invalidarTodo();
  }

  const estadoDelLote = async (e, G, loteId) => {
    const r = await get(`/api/gob/apertura/lotes?groupId=${G}`, e.tokens.presi);
    const l = ((r.body && r.body.lotes) || []).find((x) => x.loteId === loteId);
    return l ? l.estado : '(no aparece)';
  };

  // ===================================================================
  t.section('RET 1. El lote propuesto por error tiene salida');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'RT1' });
  let G = 'RT1';
  let asambleaId = await asambleaAbierta(e, G);
  let lote = await post('/api/gob/apertura/lote', {
    groupId: G, filas: [{ email: e.users.socio1.email, ahorro: 9999, acciones: 0 }],
  }, e.tokens.presi);
  let loteId = lote.body && lote.body.loteId;
  let prop = await post(`/api/gob/apertura/lote/${loteId}/proponer`,
    { groupId: G, asambleaId }, e.tokens.presi);
  t.status('la presidenta lo lleva a la asamblea', prop, 200);

  let anular = await post(`/api/gob/acuerdos/${prop.body.acuerdoId}/anular`,
    { groupId: G, motivo: 'me equivoque, son 99 no 9999' }, e.tokens.presi);
  t.status('se da cuenta antes de votar y retira el punto', anular, 200);
  t.check('y el lote se retira con el',
    ((anular.body && anular.body.retirados) || []).some((x) => x.que === 'lote'),
    JSON.stringify(anular.body && anular.body.retirados));
  t.eq('el lote queda descartado', await estadoDelLote(e, G, loteId), 'descartado');

  hoja.invalidarTodo();
  let aplicar = await post(`/api/gob/apertura/lote/${loteId}/aplicar`, { groupId: G }, e.tokens.presi);
  t.status('y ya no se puede aplicar', aplicar, 409);

  // Y puede armar otro con la cifra buena, y llevarlo a la misma asamblea.
  let lote2 = await post('/api/gob/apertura/lote', {
    groupId: G, filas: [{ email: e.users.socio1.email, ahorro: 99, acciones: 0 }],
  }, e.tokens.presi);
  t.status('arma otro con la cifra corregida', lote2, 201);
  let prop2 = await post(`/api/gob/apertura/lote/${lote2.body.loteId}/proponer`,
    { groupId: G, asambleaId }, e.tokens.presi);
  t.status('y lo vuelve a llevar a la misma asamblea', prop2, 200);

  // ===================================================================
  t.section('RET 2. Tambien se retira el lote directamente');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'RT2' });
  G = 'RT2';
  asambleaId = await asambleaAbierta(e, G);
  lote = await post('/api/gob/apertura/lote', {
    groupId: G, filas: [{ email: e.users.socio1.email, ahorro: 500, acciones: 0 }],
  }, e.tokens.presi);
  loteId = lote.body.loteId;
  prop = await post(`/api/gob/apertura/lote/${loteId}/proponer`,
    { groupId: G, asambleaId }, e.tokens.presi);
  await votar(e, G, prop.body.acuerdoId, 'contra');

  let sinMotivo = await post(`/api/gob/apertura/lote/${loteId}/descartar`,
    { groupId: G }, e.tokens.presi);
  t.status('sin escribir por que, no se retira', sinMotivo, 400);

  let deUnSocio = await post(`/api/gob/apertura/lote/${loteId}/descartar`,
    { groupId: G, motivo: 'no me gusta' }, e.tokens.socio1);
  t.status('y un socio raso tampoco puede retirarlo', deUnSocio, 403);

  let retirar = await post(`/api/gob/apertura/lote/${loteId}/descartar`,
    { groupId: G, motivo: 'la asamblea lo rechazo' }, e.tokens.presi);
  t.status('la presidencia si, con su motivo', retirar, 200);
  t.eq('queda descartado', await estadoDelLote(e, G, loteId), 'descartado');
  t.eq('el punto NO se toca: la asamblea ya habia votado',
    retirar.body && retirar.body.puntoRetirado, false);

  let dosVeces = await post(`/api/gob/apertura/lote/${loteId}/descartar`,
    { groupId: G, motivo: 'otra vez' }, e.tokens.presi);
  t.status('y no se retira dos veces', dosVeces, 409);

  // ===================================================================
  t.section('RET 3. Un lote ya aplicado no se retira');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'RT3' });
  G = 'RT3';
  asambleaId = await asambleaAbierta(e, G);
  lote = await post('/api/gob/apertura/lote', {
    groupId: G, filas: [{ email: e.users.socio1.email, ahorro: 120, acciones: 0 }],
  }, e.tokens.presi);
  loteId = lote.body.loteId;
  prop = await post(`/api/gob/apertura/lote/${loteId}/proponer`,
    { groupId: G, asambleaId }, e.tokens.presi);
  await votar(e, G, prop.body.acuerdoId, 'favor');
  aplicar = await post(`/api/gob/apertura/lote/${loteId}/aplicar`, { groupId: G }, e.tokens.presi);
  t.status('la asamblea aprueba y se cargan los saldos', aplicar, 200);
  hoja.invalidarTodo();

  retirar = await post(`/api/gob/apertura/lote/${loteId}/descartar`,
    { groupId: G, motivo: 'ahora me arrepiento' }, e.tokens.presi);
  t.status('retirarlo despues se rechaza', retirar, 409);
  t.eq('con su motivo', retirar.body && retirar.body.motivo, 'ya_aplicado');
  t.check('y se dice donde se corrige de verdad',
    /bandeja de aportes/i.test((retirar.body && retirar.body.message) || ''),
    (retirar.body && retirar.body.message) || '');

  anular = await post(`/api/gob/acuerdos/${prop.body.acuerdoId}/anular`,
    { groupId: G, motivo: 'borrar el acta' }, e.tokens.presi);
  t.status('y el acta de una decision ejecutada tampoco se borra', anular, 409);

  // ===================================================================
  t.section('RET 4. El gasto propuesto por error no deja fantasma');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'RT4' });
  G = 'RT4';
  ['socio1', 'socio2'].forEach((q) => ahorro(e.users[q].email, G, 200, '2026-01-10'));
  hoja.invalidarTodo();
  asambleaId = await asambleaAbierta(e, G);

  const antes = await get(`/api/gob/caja?groupId=${G}`, e.tokens.presi);
  const gastosAntes = Number((antes.body && antes.body.resumen && antes.body.resumen.gastos) || 0);

  let mov = await post('/api/gob/caja/proponer', {
    groupId: G, tipo: 'gasto', importe: 500, concepto: 'me equivoque de cifra', asambleaId,
  }, e.tokens.presi);
  t.status('se propone un gasto con la cifra mal', mov, 201);

  anular = await post(`/api/gob/acuerdos/${mov.body.acuerdoId}/anular`,
    { groupId: G, motivo: 'eran 5 no 500' }, e.tokens.presi);
  t.status('se retira el punto', anular, 200);
  t.check('y el movimiento se va con el',
    ((anular.body && anular.body.retirados) || []).some((x) => x.que === 'movimiento de caja'),
    JSON.stringify(anular.body && anular.body.retirados));

  hoja.invalidarTodo();
  const caja = await get(`/api/gob/caja?groupId=${G}`, e.tokens.presi);
  const elMov = ((caja.body && caja.body.movimientos) || []).find((x) => x.movId === mov.body.movId);
  t.eq('en la pantalla de caja queda como retirado', elMov && elMov.estado, 'descartado');
  t.near('y la caja del grupo no se movio ni un centavo',
    Number((caja.body && caja.body.resumen && caja.body.resumen.gastos) || 0), gastosAntes, 0.001);

  aplicar = await post(`/api/gob/caja/${mov.body.movId}/aplicar`, { groupId: G }, e.tokens.presi);
  t.status('y ya no se puede aplicar', aplicar, 409);

  // ===================================================================
  t.section('RET 5. Un gasto ya pagado no se borra: se propone el contrario');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'RT5' });
  G = 'RT5';
  ['socio1', 'socio2'].forEach((q) => ahorro(e.users[q].email, G, 200, '2026-01-10'));
  hoja.invalidarTodo();
  asambleaId = await asambleaAbierta(e, G);
  mov = await post('/api/gob/caja/proponer', {
    groupId: G, tipo: 'gasto', importe: 30, concepto: 'cuadernos del grupo', asambleaId,
  }, e.tokens.presi);
  await votar(e, G, mov.body.acuerdoId, 'favor');
  aplicar = await post(`/api/gob/caja/${mov.body.movId}/aplicar`, { groupId: G }, e.tokens.presi);
  t.status('la asamblea lo aprueba y el dinero sale', aplicar, 200);
  hoja.invalidarTodo();

  retirar = await post(`/api/gob/caja/${mov.body.movId}/descartar`,
    { groupId: G, motivo: 'me arrepenti' }, e.tokens.presi);
  t.status('retirarlo despues se rechaza', retirar, 409);
  t.check('y se explica que hay que proponer el movimiento contrario',
    /contrario/i.test((retirar.body && retirar.body.message) || ''),
    (retirar.body && retirar.body.message) || '');

  // ===================================================================
  t.section('RET 6. El aval propuesto se retira; el aprobado se libera');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'RT6' });
  G = 'RT6';
  ahorro(e.users.socio1.email, G, 600, '2026-01-10');
  hoja.invalidarTodo();
  asambleaId = await asambleaAbierta(e, G);

  let aval = await post('/api/gob/aval/proponer', {
    groupId: G, email: e.users.socio2.email, avalEmail: e.users.socio1.email,
    cupo: 400, motivo: 'me equivoque de cifra', asambleaId,
  }, e.tokens.presi);
  t.status('se propone un aval con la cifra mal', aval, 201);

  retirar = await post(`/api/gob/aval/${aval.body.avalId}/descartar`,
    { groupId: G, motivo: 'eran 40 no 400' }, e.tokens.presi);
  t.status('se retira antes de votar', retirar, 200);
  t.eq('y el punto sale de la asamblea con el',
    retirar.body && retirar.body.puntoRetirado, true);

  hoja.invalidarTodo();
  // El cupo no se mira en una cifra: se mide pidiendo el prestamo. socio2 no
  // tiene ahorro, asi que sin aval su cupo es cero.
  let pide = await post('/api/registrar-solicitud', {
    tipo: 'prestamo',
    data: { Monto: 40, Detalles: 'Plazo: 6', Group: G },
  }, e.tokens.socio2);
  t.status('con el aval retirado, no le alcanza para pedir $40', pide, 409);
  t.check('y se le dice cuanto es su cupo',
    /cupo|ahorro/i.test((pide.body && pide.body.message) || ''),
    (pide.body && pide.body.message) || '');

  // Ahora uno de verdad: propuesto, votado y aprobado.
  asambleaId = await asambleaAbierta(e, G, 'Segunda');
  aval = await post('/api/gob/aval/proponer', {
    groupId: G, email: e.users.socio2.email, avalEmail: e.users.socio1.email,
    cupo: 40, motivo: 'recien entra al grupo', asambleaId,
  }, e.tokens.presi);
  await votar(e, G, aval.body.acuerdoId, 'favor');
  const aplicarAval = await post(`/api/gob/aval/${aval.body.avalId}/aplicar`,
    { groupId: G }, e.tokens.presi);
  t.status('la asamblea aprueba el aval bueno', aplicarAval, 200);
  hoja.invalidarTodo();

  pide = await post('/api/registrar-solicitud', {
    tipo: 'prestamo',
    data: { Monto: 40, Detalles: 'Plazo: 6', Group: G },
  }, e.tokens.socio2);
  t.status('con el aval aprobado, ahora si puede pedir esos $40', pide, 201);

  retirar = await post(`/api/gob/aval/${aval.body.avalId}/descartar`,
    { groupId: G, motivo: 'quiero quitarlo' }, e.tokens.presi);
  t.status('un aval que ya da cupo no se retira', retirar, 409);
  t.check('se manda a liberar, que comprueba el prestamo',
    /liberar/i.test((retirar.body && retirar.body.message) || ''),
    (retirar.body && retirar.body.message) || '');

  // ===================================================================
  t.section('RET 7. En prestamos no hay nada colgando que retirar');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'RT7' });
  G = 'RT7';
  ahorro(e.users.socio1.email, G, 400, '2026-01-10');
  fake.ensureSheet('Loans').grid.push(
    ['LRT7', e.users.socio1.email, G, 200, '2026-02-01', '', 2, 'aprobado', 6, 224, 0]);
  hoja.invalidarTodo();
  asambleaId = await asambleaAbierta(e, G);

  const movPre = await post('/api/gob/prestamo/LRT7/proponer', {
    groupId: G, tipo: 'condonacion', importe: 200, motivo: 'me equivoque', asambleaId,
  }, e.tokens.presi);
  t.status('se propone condonar de mas', movPre, 201);

  let ficha = await get(`/api/gob/prestamo/LRT7?groupId=${G}`, e.tokens.presi);
  t.eq('proponer no escribe ningun movimiento todavia',
    ((ficha.body && ficha.body.movimientos) || []).length, 0);

  anular = await post(`/api/gob/acuerdos/${movPre.body.acuerdoId}/anular`,
    { groupId: G, motivo: 'eran 20 no 200' }, e.tokens.presi);
  t.status('anular el punto lo resuelve entero', anular, 200);
  t.eq('y no hay nada que retirar con el',
    ((anular.body && anular.body.retirados) || []).length, 0);

  hoja.invalidarTodo();
  aplicar = await post('/api/gob/prestamo/LRT7/aplicar',
    { groupId: G, movId: movPre.body.movId }, e.tokens.presi);
  t.status('y ya no se puede aplicar', aplicar, 409);
  ficha = await get(`/api/gob/prestamo/LRT7?groupId=${G}`, e.tokens.presi);
  t.near('la deuda de la socia sigue intacta',
    Number((ficha.body && ficha.body.prestamo && ficha.body.prestamo.saldo) || 0), 224, 0.01);

  // ===================================================================
  t.section('RET 8. Lo retirado no cuenta en ninguna cifra del grupo');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'RT8' });
  G = 'RT8';
  ['socio1', 'socio2'].forEach((q) => ahorro(e.users[q].email, G, 250, '2026-01-10'));
  hoja.invalidarTodo();
  asambleaId = await asambleaAbierta(e, G);

  const tableroAntes = await get(`/api/gob/tablero?groupId=${G}`, e.tokens.presi);
  const patrimonioAntes = Number((tableroAntes.body && tableroAntes.body.patrimonio) || 0);

  // Una multa y un gasto, los dos retirados.
  const multa = await post('/api/gob/caja/proponer', {
    groupId: G, tipo: 'multa', importe: 15, concepto: 'atraso', email: e.users.socio2.email, asambleaId,
  }, e.tokens.presi);
  await post(`/api/gob/acuerdos/${multa.body.acuerdoId}/anular`,
    { groupId: G, motivo: 'no era ella' }, e.tokens.presi);
  const gasto = await post('/api/gob/caja/proponer', {
    groupId: G, tipo: 'gasto', importe: 90, concepto: 'error', asambleaId,
  }, e.tokens.presi);
  await post(`/api/gob/acuerdos/${gasto.body.acuerdoId}/anular`,
    { groupId: G, motivo: 'error de tecleo' }, e.tokens.presi);
  hoja.invalidarTodo();

  const tablero = await get(`/api/gob/tablero?groupId=${G}`, e.tokens.presi);
  t.near('el patrimonio del grupo no se movio',
    Number((tablero.body && tablero.body.patrimonio) || 0), patrimonioAntes, 0.01);

  const compromiso = await get(`/api/gob/mi-compromiso?groupId=${G}`, e.tokens.socio2);
  const multasDeElla = (compromiso.body && compromiso.body.multas) || {};
  t.eq('y a la socia no le queda ninguna multa que pagar', multasDeElla.pendientes, 0);
  t.near('ni un centavo que deba por multas', Number(multasDeElla.total || 0), 0, 0.001);

  // ===================================================================
  t.section('RET 9. Dos manos a la vez sobre la misma propuesta');
  // ===================================================================
  // `aplicar` toma el candado del objeto (`lote:<id>`) y `anular` el del punto
  // (`acuerdo:<id>`): son llaves DISTINTAS, y una de las dos mueve dinero. Lo
  // que sostiene la coherencia no es el candado sino que cada handler relee el
  // estado antes de escribir. Esto lo comprueba con cinco latencias distintas,
  // porque con una sola tirada se pasa por suerte.
  const tiradas = [];
  for (let i = 0; i < 5; i += 1) {
    preparar();
    const ee = await baseScenario({ groupId: `RC${i}` });
    const GG = `RC${i}`;
    const asa = await asambleaAbierta(ee, GG);
    const lt = await post('/api/gob/apertura/lote',
      { groupId: GG, filas: [{ email: ee.users.socio1.email, ahorro: 250, acciones: 0 }] },
      ee.tokens.presi);
    const pr = await post(`/api/gob/apertura/lote/${lt.body.loteId}/proponer`,
      { groupId: GG, asambleaId: asa }, ee.tokens.presi);
    await votar(ee, GG, pr.body.acuerdoId, 'favor');
    const antes = fake.ensureSheet('Savings').grid.filter((x) => (x[1] || '') === GG).length;

    fake.store.latencyMs = 6 + i * 4;
    await Promise.all([
      post(`/api/gob/apertura/lote/${lt.body.loteId}/aplicar`, { groupId: GG }, ee.tokens.presi),
      post(`/api/gob/acuerdos/${pr.body.acuerdoId}/anular`,
        { groupId: GG, motivo: 'lo retiro a la vez' }, ee.tokens.presi),
    ]);
    fake.store.latencyMs = 0;
    hoja.invalidarTodo();

    const ls = await get(`/api/gob/apertura/lotes?groupId=${GG}`, ee.tokens.presi);
    const est = ((ls.body && ls.body.lotes) || []).find((x) => x.loteId === lt.body.loteId)?.estado;
    const nuevas = fake.ensureSheet('Savings').grid.filter((x) => (x[1] || '') === GG).length - antes;
    // O se aplico y hay saldos, o no se aplico y no hay ninguno. Nunca a medias.
    tiradas.push((est === 'aplicado' && nuevas > 0) || (est !== 'aplicado' && nuevas === 0));
  }
  t.eq('con cinco latencias distintas, nunca queda dinero huerfano',
    tiradas.filter(Boolean).length, 5);

  // ===================================================================
  t.section('RET 10. Quien puede retirar, y quien no');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'RT10' });
  G = 'RT10';
  asambleaId = await asambleaAbierta(e, G);
  lote = await post('/api/gob/apertura/lote', {
    groupId: G, filas: [{ email: e.users.socio1.email, ahorro: 100, acciones: 0 }],
  }, e.tokens.presi);
  loteId = lote.body.loteId;
  await post(`/api/gob/apertura/lote/${loteId}/proponer`, { groupId: G, asambleaId }, e.tokens.presi);

  const sinSesion = await post(`/api/gob/apertura/lote/${loteId}/descartar`,
    { groupId: G, motivo: 'sin sesion' }, null);
  t.status('sin sesion no se retira nada', sinSesion, 401);

  // El administrador de la plataforma evalua el uso; no gobierna grupos ajenos.
  const elAdmin = await post(`/api/gob/apertura/lote/${loteId}/descartar`,
    { groupId: G, motivo: 'soy el admin' }, e.tokens.admin);
  t.status('el administrador de la plataforma tampoco', elAdmin, 403);

  for (const [ruta, que] of [
    ['/api/gob/apertura/lote/lote_inventado/descartar', 'un lote'],
    ['/api/gob/caja/mov_inventado/descartar', 'un movimiento'],
    ['/api/gob/aval/aval_inventado/descartar', 'un aval'],
  ]) {
    const r2 = await post(ruta, { groupId: G, motivo: 'a ver' }, e.tokens.presi);
    t.status(`${que} que no existe responde 404`, r2, 404);
  }

  // Un motivo enorme no revienta la hoja: se guarda recortado.
  const gigante = await post(`/api/gob/apertura/lote/${loteId}/descartar`,
    { groupId: G, motivo: 'x'.repeat(9000) }, e.tokens.presi);
  t.status('un motivo de 9.000 caracteres no rompe nada', gigante, 200);
  const filaLote = fake.ensureSheet(G_SHEETS.lotes.name).grid.find((x) => (x[0] || '') === loteId);
  t.check('y se guarda recortado', ((filaLote && filaLote[12]) || '').length <= 500,
    `largo ${((filaLote && filaLote[12]) || '').length}`);

  // ===================================================================
  t.section('RET 11. Una formula en el motivo no se ejecuta en la hoja');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'RT11' });
  G = 'RT11';
  asambleaId = await asambleaAbierta(e, G);
  lote = await post('/api/gob/apertura/lote', {
    groupId: G, filas: [{ email: e.users.socio1.email, ahorro: 100, acciones: 0 }],
  }, e.tokens.presi);
  loteId = lote.body.loteId;
  await post(`/api/gob/apertura/lote/${loteId}/proponer`, { groupId: G, asambleaId }, e.tokens.presi);
  await post(`/api/gob/apertura/lote/${loteId}/descartar`,
    { groupId: G, motivo: '=IMPORTXML("http://malo.test","//x")' }, e.tokens.presi);

  const fl = fake.ensureSheet(G_SHEETS.lotes.name).grid.find((x) => (x[0] || '') === loteId);
  t.check('la celda de la nota no empieza por = (Sheets no la evalua)',
    !/^[=+\-@]/.test(((fl && fl[12]) || '')), (fl && fl[12] || '').slice(0, 40));
  const enLog = fake.ensureSheet(G_SHEETS.log.name).grid
    .filter((x) => (x[3] || '').includes('lote_apertura_descartado'))
    .map((x) => (x[5] || ''));
  t.check('y en la bitacora va con el apostrofo delante',
    enLog.length > 0 && enLog.every((x) => !/^[=+\-@]/.test(x)), enLog.join(' | ').slice(0, 60));
};