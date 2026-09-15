/**
 * SUITE 36 - Cerrar el grupo, y avalar a quien todavia no tiene ahorro.
 *
 * Dos cosas que un banco comunal hace y la app no permitia:
 *
 *   CERRAR EL GRUPO. Un banco comunal se arma por un ciclo y al final se
 *   liquida: cada una se lleva su ahorro, sus acciones y las utilidades que le
 *   tocan. Lo unico parecido era el borrado del administrador de la PLATAFORMA,
 *   que no reparte un centavo y ademas borra el historial.
 *
 *   AVALAR. El cupo era rigido -- ahorro por el factor -- sin excepcion. Quien
 *   recien entra no tiene ahorro, no tiene cupo, y es justamente a quien un
 *   banco comunal presta: con la firma de una companera que responde.
 *
 * Lo que se fija: que nadie cobre dos veces, que el grupo cerrado deje de
 * admitir movimientos, que no se cierre con dinero fuera de la caja, y que
 * avalar cueste cupo de verdad a quien pone la firma.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();

const acciones = (email, grupo, cantidad, fecha) => fake.ensureSheet('Acciones').grid.push([
  email, grupo, fecha, cantidad, 10, 2, new Date().toISOString(),
  'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(),
  `acc_${Math.random().toString(36).slice(2, 8)}`, '',
]);

const ahorro = (email, grupo, monto, fecha) => fake.ensureSheet('Savings').grid.push([
  email, grupo, monto, fecha, 'mensual', 'aporte', 'confirmado',
  'a@a.test', 'b@b.test', new Date().toISOString(),
  `sav_${Math.random().toString(36).slice(2, 8)}`, '',
]);

function prestamo(id, email, grupo, principal, total, inicio, pagos) {
  fake.ensureSheet('Loans').grid.push([
    id, email, grupo, principal, inicio, '', 2, 'aprobado', 6, total,
  ]);
  (pagos || []).forEach(([monto, fecha], i) => fake.ensureSheet('LoanPayments').grid.push([
    `${id}_P${i}`, email, id, monto, fecha, 'cuota', 'approved',
    '', '', '', '', new Date().toISOString(), 'teso@juntago.test', new Date().toISOString(), '',
  ]));
}

/** Lo que la hoja Savings tiene abonado/retirado por una socia en el grupo. */
const movimientos = (grupo, email, tipo) => fake.ensureSheet('Savings').grid
  .filter((r) => (r[1] || '') === grupo && (r[0] || '') === email
    && (!tipo || (r[4] || '') === tipo));

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

  /** Convoca, abre y vota a favor un acuerdo ya creado. */
  async function votarAFavor(e, G, acuerdoId, asambleaId) {
    for (const q of ['presi', 'teso', 'secre', 'socio1', 'socio2']) {
      await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { groupId: G, voto: 'favor' }, e.tokens[q]);
    }
    hoja.invalidarTodo();
    return asambleaId;
  }

  async function asambleaAbierta(e, G) {
    const asa = await post('/api/gob/asambleas',
      { groupId: G, titulo: 'Asamblea', fechaProgramada: hoy(), modalidad: 'presencial' },
      e.tokens.presi);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/asistencia`, {
      groupId: G,
      registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
        .map((q) => ({ email: e.users[q].email, estado: 'presente' })),
    }, e.tokens.secre);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/estado`,
      { estado: 'abierta', groupId: G }, e.tokens.presi);
    return asa.body?.asambleaId;
  }

  // ===================================================================
  t.section('CGR 1. No se cierra un grupo con dinero fuera de la caja');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'GZ1' });
  let G = 'GZ1';
  ['socio1', 'socio2'].forEach((q) => ahorro(e.users[q].email, G, 100, '2026-01-10'));
  prestamo('LZ_1', e.users.socio1.email, G, 200, 224, '2026-03-01', [[100, '2026-04-10']]);
  hoja.invalidarTodo();

  let estado = await get(`/api/gob/grupo/cierre?groupId=${G}`, e.tokens.presi);
  t.status('cualquier socia puede ver como va el cierre', estado, 200);
  t.eq('todavia no hay ninguno', estado.body?.abierto, null);
  t.eq('y se dice que hay un prestamo sin pagar',
    (estado.body?.bloqueos || [])[0]?.motivo, 'prestamos_vivos');

  const conDeuda = await post('/api/gob/grupo/cierre/calcular', { groupId: G }, e.tokens.presi);
  t.status('calcular el cierre se rechaza', conDeuda, 409);
  t.eq('con su motivo', conDeuda.body?.motivo, 'faltan_cosas');
  t.check('y se explica que ese dinero esta fuera',
    /fuera de la caja/i.test(conDeuda.body?.message || ''), conDeuda.body?.message);

  const deLaTesorera = await post('/api/gob/grupo/cierre/calcular', { groupId: G }, e.tokens.teso);
  t.status('y disolver el grupo no lo propone la tesoreria', deLaTesorera, 403);

  // ===================================================================
  t.section('CGR 2. Cada socia cobra lo suyo, al centavo');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GZ2' });
  G = 'GZ2';
  // Tres socias con capital distinto y un prestamo ya saldado que dejo $24.
  ahorro(e.users.socio1.email, G, 300, '2026-01-10');
  acciones(e.users.socio1.email, G, 10, '2026-01-10');          // 300 + 100 = 400
  ahorro(e.users.socio2.email, G, 200, '2026-01-10');           // 200
  acciones(e.users.presi.email, G, 20, '2026-01-10');           // 200
  prestamo('LZ_2', e.users.socio2.email, G, 200, 224, '2026-02-01', [[224, '2026-04-15']]);
  hoja.invalidarTodo();

  const calc = await post('/api/gob/grupo/cierre/calcular', { groupId: G }, e.tokens.presi);
  t.status('la presidencia calcula el cierre', calc, 201);
  t.eq('con las cinco socias del grupo', calc.body?.socias, 5);

  const rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  const ganado = Number(rep.body?.ganancia?.total || 0);
  t.near('el grupo gano $24 de intereses', ganado, 24, 0.01);
  const capital = 400 + 200 + 200;
  t.near('lo que se devuelve es el capital mas lo ganado',
    calc.body?.totalDevuelto, capital + ganado, 0.02);

  const antesDePagar = movimientos(G, e.users.socio1.email, 'retiro_salida').length;
  t.eq('mientras no se vote, nadie ha cobrado nada', antesDePagar, 0);

  const sinAsamblea = await post(`/api/gob/grupo/cierre/${calc.body?.cierreId}/aplicar`,
    {}, e.tokens.presi);
  t.status('y no se puede pagar sin pasar por la asamblea', sinAsamblea, 409);

  // ===================================================================
  t.section('CGR 3. Con el acuerdo aprobado, se paga y el grupo queda cerrado');
  // ===================================================================
  const asambleaId = await asambleaAbierta(e, G);
  const prop = await post(`/api/gob/grupo/cierre/${calc.body?.cierreId}/proponer`,
    { asambleaId }, e.tokens.presi);
  t.status('se somete a la asamblea', prop, 200);
  await votarAFavor(e, G, prop.body?.acuerdoId, asambleaId);

  const apl = await post(`/api/gob/grupo/cierre/${calc.body?.cierreId}/aplicar`, {}, e.tokens.presi);
  t.status('y se aplica', apl, 200);
  t.eq('pagando a las cinco socias', apl.body?.socias, 5);
  hoja.invalidarTodo();

  const suRetiro = movimientos(G, e.users.socio1.email, 'retiro_salida');
  t.eq('a la socia se le escribe su devolucion', suRetiro.length, 1);
  t.check('por su ahorro mas sus utilidades',
    Number(suRetiro[0][2]) < 0 && Math.abs(Number(suRetiro[0][2])) >= 300,
    JSON.stringify(suRetiro[0]));
  const susAcciones = fake.ensureSheet('Acciones').grid
    .filter((r) => (r[1] || '') === G && (r[0] || '') === e.users.socio1.email
      && Number(r[3]) < 0);
  t.eq('y se le devuelven sus acciones', susAcciones.length, 1);

  const filaGrupo = fake.ensureSheet('Groups').grid.find((r) => (r[0] || '') === G) || [];
  t.eq('el grupo queda cerrado', (filaGrupo[11] || '').toString().toLowerCase(), 'cerrado');

  const enlaces = fake.ensureSheet('UserGroupLinks').grid
    .filter((r) => (r[1] || '') === G && (r[4] || '') !== 'retirada');
  t.eq('y ninguna socia queda activa', enlaces.length, 0);

  t.check('el historial NO se borra: los movimientos siguen ahi',
    movimientos(G, e.users.socio1.email).length >= 2,
    `${movimientos(G, e.users.socio1.email).length} filas`);

  // ===================================================================
  t.section('CGR 4. Un grupo cerrado ya no admite movimientos ni se cierra dos veces');
  // ===================================================================
  const otraVez = await post('/api/gob/grupo/cierre/calcular', { groupId: G }, e.tokens.presi);
  t.status('no se vuelve a cerrar', otraVez, 409);
  t.eq('con su motivo', otraVez.body?.motivo, 'ya_cerrado');

  const aporte = await post('/api/savings',
    { groupId: G, tipo: 'ahorro', monto: 50, descripcion: 'x' }, e.tokens.socio1);
  t.status('y no entra un aporte a una caja que ya se repartio', aporte, 409);
  t.eq('con su motivo', aporte.body?.motivo, 'grupo_dado_de_baja');

  const dosVeces = await post(`/api/gob/grupo/cierre/${calc.body?.cierreId}/aplicar`,
    {}, e.tokens.presi);
  t.status('aplicar el mismo cierre dos veces no paga dos veces', dosVeces, 409);
  t.eq('sigue habiendo una sola devolucion por socia',
    movimientos(G, e.users.socio1.email, 'retiro_salida').length, 1);

  // ===================================================================
  t.section('CGR 5. Un cierre a medias se puede descartar');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GZ5' });
  G = 'GZ5';
  ahorro(e.users.socio1.email, G, 100, '2026-01-10');
  hoja.invalidarTodo();

  const borrador = await post('/api/gob/grupo/cierre/calcular', { groupId: G }, e.tokens.presi);
  t.status('se calcula', borrador, 201);
  const repetido = await post('/api/gob/grupo/cierre/calcular', { groupId: G }, e.tokens.presi);
  t.status('no se calculan dos a la vez', repetido, 409);
  t.eq('con su motivo', repetido.body?.motivo, 'ya_calculado');

  const desc = await post(`/api/gob/grupo/cierre/${borrador.body?.cierreId}/descartar`,
    {}, e.tokens.presi);
  t.status('se descarta', desc, 200);
  hoja.invalidarTodo();
  const nuevo = await post('/api/gob/grupo/cierre/calcular', { groupId: G }, e.tokens.presi);
  t.status('y se puede volver a calcular', nuevo, 201);

  const filaG5 = fake.ensureSheet('Groups').grid.find((r) => (r[0] || '') === G) || [];
  t.check('el grupo sigue abierto mientras no se pague',
    (filaG5[11] || '').toString().toLowerCase() !== 'cerrado', filaG5[11]);

  // ===================================================================
  t.section('CGR 6. Avalar a quien todavia no tiene ahorro');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GZ6' });
  G = 'GZ6';
  ahorro(e.users.socio2.email, G, 300, '2026-01-10');   // la que avala
  hoja.invalidarTodo();

  // socio1 acaba de entrar: sin ahorro no hay cupo.
  let cupo = await get(`/api/mi-cupo?groupId=${G}`, e.tokens.socio1);
  t.near('la socia nueva no tiene cupo', cupo.body?.disponible, 0, 0.01);

  const asa6 = await asambleaAbierta(e, G);
  const solaSe = await post('/api/gob/aval/proponer', {
    groupId: G, email: e.users.socio1.email, avalEmail: e.users.socio1.email,
    cupo: 100, motivo: 'quiero avalarme yo misma para poder pedir', asambleaId: asa6,
  }, e.tokens.presi);
  t.status('nadie se avala a si misma', solaSe, 400);
  t.eq('con su motivo', solaSe.body?.motivo, 'se_avala_sola');

  const sinRespaldo = await post('/api/gob/aval/proponer', {
    groupId: G, email: e.users.socio1.email, avalEmail: e.users.secre.email,
    cupo: 500, motivo: 'la secretaria responde por la socia nueva', asambleaId: asa6,
  }, e.tokens.presi);
  t.status('no se avala con lo que no se tiene', sinRespaldo, 409);
  t.eq('con su motivo', sinRespaldo.body?.motivo, 'aval_sin_respaldo');
  t.near('y se dice cuanto tiene libre de verdad', sinRespaldo.body?.cupoLibre, 0, 0.01);

  const propAval = await post('/api/gob/aval/proponer', {
    groupId: G, email: e.users.socio1.email, avalEmail: e.users.socio2.email,
    cupo: 300, motivo: 'responde por ella para que pueda arrancar su negocio', asambleaId: asa6,
  }, e.tokens.presi);
  t.status('con respaldo si se propone', propAval, 201);
  t.near('la avaladora tenia $900 de cupo libre', propAval.body?.cupoLibreDelAval, 900, 0.01);

  const sinVotar = await post(`/api/gob/aval/${propAval.body?.avalId}/aplicar`, {}, e.tokens.presi);
  t.status('sin votarlo no vale', sinVotar, 409);
  hoja.invalidarTodo();
  cupo = await get(`/api/mi-cupo?groupId=${G}`, e.tokens.socio1);
  t.near('y la socia sigue sin cupo', cupo.body?.disponible, 0, 0.01);

  // ===================================================================
  t.section('CGR 7. Aprobado el aval, ella suma cupo y la avaladora lo pierde');
  // ===================================================================
  await votarAFavor(e, G, propAval.body?.acuerdoId, asa6);
  const aplAval = await post(`/api/gob/aval/${propAval.body?.avalId}/aplicar`, {}, e.tokens.presi);
  t.status('se aplica', aplAval, 200);
  hoja.invalidarTodo();

  cupo = await get(`/api/mi-cupo?groupId=${G}`, e.tokens.socio1);
  t.near('la socia nueva ya puede pedir $300', cupo.body?.disponible, 300, 0.01);
  t.near('y se dice de quien es el aval', cupo.body?.avalRecibido?.cupo, 300, 0.01);

  const deLaAvaladora = await get(`/api/mi-cupo?groupId=${G}`, e.tokens.socio2);
  t.near('a la avaladora le baja el cupo en esa cantidad',
    deLaAvaladora.body?.disponible, 600, 0.01);
  t.near('y se dice cuanto tiene comprometido avalando',
    deLaAvaladora.body?.cupoComprometidoAvalando, 300, 0.01);

  const pide = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 280, Group: G, Detalles: 'Plazo: 6' },
  }, e.tokens.socio1);
  t.statusIn('y con el aval ya puede pedir', pide, [200, 201]);

  const pideDeMas = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 5000, Group: G, Detalles: 'Plazo: 6' },
  }, e.tokens.socio1);
  t.status('pero no por encima del aval', pideDeMas, 409);

  // ===================================================================
  t.section('CGR 8. El aval no se libera mientras ella deba');
  // ===================================================================
  prestamo('LZ_8', e.users.socio1.email, G, 280, 313.6, hoy(), []);
  hoja.invalidarTodo();

  const pronto = await post(`/api/gob/aval/${propAval.body?.avalId}/liberar`, {}, e.tokens.teso);
  t.status('con deuda viva no se libera', pronto, 409);
  t.eq('con su motivo', pronto.body?.motivo, 'todavia_debe');

  fake.ensureSheet('LoanPayments').grid.push([
    'LZ_8_P0', e.users.socio1.email, 'LZ_8', 313.6, hoy(), 'cuota', 'approved',
    '', '', '', '', new Date().toISOString(), 'teso@juntago.test', new Date().toISOString(), '',
  ]);
  hoja.invalidarTodo();

  const libera = await post(`/api/gob/aval/${propAval.body?.avalId}/liberar`, {}, e.tokens.teso);
  t.status('pagada la deuda, si se libera', libera, 200);
  hoja.invalidarTodo();

  const recuperado = await get(`/api/mi-cupo?groupId=${G}`, e.tokens.socio2);
  t.near('la avaladora recupera su cupo entero', recuperado.body?.disponible, 900, 0.01);
  t.near('sin nada comprometido', recuperado.body?.cupoComprometidoAvalando, 0, 0.01);

  const lista = await get(`/api/gob/avales?groupId=${G}`, e.tokens.socio1);
  t.status('cualquier socia puede ver los avales del grupo', lista, 200);
  t.eq('y queda registrado', (lista.body?.avales || [])[0]?.estado, 'liberado');

  // ===================================================================
  t.section('CGR 9. El historial de un grupo cerrado se sigue consultando');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GZ9' });
  G = 'GZ9';
  ahorro(e.users.socio1.email, G, 250, '2026-01-10');
  acciones(e.users.socio1.email, G, 5, '2026-01-10');
  hoja.invalidarTodo();

  const c9 = await post('/api/gob/grupo/cierre/calcular', { groupId: G }, e.tokens.presi);
  const a9 = await asambleaAbierta(e, G);
  const p9 = await post(`/api/gob/grupo/cierre/${c9.body?.cierreId}/proponer`,
    { asambleaId: a9 }, e.tokens.presi);
  await votarAFavor(e, G, p9.body?.acuerdoId, a9);
  await post(`/api/gob/grupo/cierre/${c9.body?.cierreId}/aplicar`, {}, e.tokens.presi);
  hoja.invalidarTodo();

  // Prometimos que el historial se conserva entero. Guardarlo en un sitio al
  // que nadie puede entrar no es conservarlo.
  const historial = await get(`/api/obtener-ahorros?groupId=${G}&userEmail=${e.users.socio1.email}`,
    e.tokens.socio1);
  t.status('la socia sigue viendo sus movimientos', historial, 200);
  const tablero = await get(`/api/gob/tablero?groupId=${G}`, e.tokens.presi);
  t.status('y la presidenta el tablero del grupo cerrado', tablero, 200);
  const cierreVisto = await get(`/api/gob/grupo/cierre?groupId=${G}`, e.tokens.socio1);
  t.status('con el cierre a la vista', cierreVisto, 200);
  t.check('marcado como aplicado', !!cierreVisto.body?.aplicado,
    JSON.stringify(cierreVisto.body?.aplicado || null));

  // Pero escribir, no: y se dice que el grupo esta cerrado, no "no perteneces".
  const intento = await post('/api/savings',
    { groupId: G, tipo: 'ahorro', monto: 20, descripcion: 'x' }, e.tokens.socio1);
  t.status('escribir se corta', intento, 409);
  t.eq('con su motivo', intento.body?.motivo, 'grupo_dado_de_baja');
  t.check('y se dice que puede seguir consultando',
    /seguir consultando/i.test(intento.body?.message || ''), intento.body?.message);

  // Y quien nunca estuvo en el grupo sigue sin ver nada.
  const nunca = await get(`/api/gob/grupo/cierre?groupId=${G}`, e.tokens.ajeno);
  t.status('quien nunca estuvo no entra', nunca, 403);
};
