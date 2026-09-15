/**
 * SUITE 22 - Un grupo que arranca sin tesoreria.
 *
 * El control interno dice "quien registra un aporte no lo confirma". Es la
 * regla correcta y no se toca. El problema era que en un grupo con UN SOLO
 * directivo esa regla no protege de nada: no hay segunda firma posible, y el
 * aporte de esa persona se quedaba pendiente para siempre. No se podia
 * confirmar, ni rechazar, ni revertir; y apagar la regla tampoco liberaba lo
 * que ya estaba atrapado.
 *
 * La solucion que se comprueba aqui: la regla se aplica cuando de verdad hay
 * alguien mas que pueda firmar.
 *   - Presidenta sola -> su aporte nace confirmado, y la fila dice por que.
 *   - Aporte de un socio -> sigue necesitando la firma de la presidenta.
 *   - En cuanto hay tesoreria -> vuelve a hacer falta la segunda firma, para
 *     todos, incluida la presidenta.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario, seedUser, seedGroup, seedLink, login } = require('./scenario');
const t = require('./runner');

const SAV_ESTADO = 6;
const SAV_REGISTRO = 7;
const SAV_RESUELTO = 8;
const SAV_NOTA = 11;

module.exports = async function run() {
  seedWorkbook();
  const G_SHEETS = require('../governance').SHEETS;
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  const { HOJA, CABECERA } = require('../accesos');
  fake.seedSheet(HOJA, [CABECERA]);

  const hoy = hoyLocal();
  const presi = seedUser({ nombre: 'Presidenta Sola', email: 'sola@juntago.test' });
  const socia = seedUser({ nombre: 'Socia Nueva', email: 'socia@juntago.test' });
  const teso = seedUser({ nombre: 'Tesorera Luego', email: 'tesorera@juntago.test' });
  seedGroup({ id: 'GSOLO', nombre: 'Grupo recien nacido', presidente: presi.email });
  seedLink(presi.email, 'GSOLO', 'presidente');
  seedLink(socia.email, 'GSOLO', 'member');

  const tk = {
    presi: await login(presi.email),
    socia: await login(socia.email),
    teso: await login(teso.email),
  };

  const filasDe = (correo) => (fake.dumpSheet('Savings') || []).slice(1)
    .filter((r) => (r[1] || '') === 'GSOLO' && (r[0] || '') === correo);

  // ===================================================================
  t.section('SOLO 1. El grupo nace exigiendo aprobacion de aportes');
  // ===================================================================
  const reglas = await get('/api/gob/reglas?groupId=GSOLO', tk.presi);
  t.status('se puede leer el reglamento', reglas, 200);
  t.eq('y por defecto los aportes se aprueban',
    reglas.body?.reglas?.requiereAprobacionAportes ?? reglas.body?.requiereAprobacionAportes, true);
  t.eq('el grupo tiene un solo directivo', 1,
    (fake.dumpSheet('UserGroupLinks') || []).slice(1)
      .filter((v) => (v[1] || '') === 'GSOLO'
        && ['presidente', 'tesorero', 'secretario'].includes((v[3] || '').toLowerCase())).length);

  // ===================================================================
  t.section('SOLO 2. El aporte de la presidenta NO se queda atrapado');
  // ===================================================================
  const suyo = await post('/api/registrar-ahorros',
    { groupId: 'GSOLO', date: hoy, amount: 100 }, tk.presi);
  t.statusIn('la presidenta registra su ahorro', suyo, [200, 201]);
  t.eq('y nace confirmado, porque no hay nadie mas que pueda firmarlo',
    suyo.body?.estado, 'confirmado');
  t.eq('se dice el motivo, para que la app lo pueda explicar',
    suyo.body?.motivo, 'sin_tesoreria');
  t.check('y el aviso menciona la tesoreria',
    /tesoreria/i.test(suyo.body?.aviso || ''), JSON.stringify(suyo.body));

  const filaPresi = filasDe(presi.email)[0] || [];
  t.eq('en la hoja queda como confirmado', (filaPresi[SAV_ESTADO] || '').toLowerCase(), 'confirmado');
  t.eq('lo registro ella', (filaPresi[SAV_REGISTRO] || ''), presi.email);
  t.eq('y consta que lo resolvio ella misma, sin ocultarlo',
    (filaPresi[SAV_RESUELTO] || ''), presi.email);
  t.check('la fila deja escrito que fue sin segunda firma',
    /sin segunda firma/i.test(filaPresi[SAV_NOTA] || ''), `nota: "${filaPresi[SAV_NOTA]}"`);

  t.check('el ahorro cuenta en el patrimonio del grupo',
    ((await get('/api/savings/complete?groupId=GSOLO', tk.presi)).body?.data?.totalAhorros || 0) >= 100,
    'no aparece en el patrimonio');

  // ===================================================================
  t.section('SOLO 3. El aporte de un socio SI necesita la firma');
  // ===================================================================
  const deLaSocia = await post('/api/registrar-ahorros',
    { groupId: 'GSOLO', date: hoy, amount: 50 }, tk.socia);
  t.statusIn('la socia registra su ahorro', deLaSocia, [200, 201]);
  t.eq('y queda pendiente: aqui el control si sirve', deLaSocia.body?.estado, 'pendiente');
  t.eq('sin motivo de excepcion', deLaSocia.body?.motivo || '', '');

  t.status('la socia no puede confirmarse su propio aporte',
    await post('/api/gob/aportes/resolver',
      { groupId: 'GSOLO', tipo: 'ahorro', movId: deLaSocia.body?.movId, accion: 'confirmar' }, tk.socia), 403);
  t.statusIn('la presidenta si lo confirma',
    await post('/api/gob/aportes/resolver',
      { groupId: 'GSOLO', tipo: 'ahorro', movId: deLaSocia.body?.movId, accion: 'confirmar' }, tk.presi), [200, 201]);

  // ===================================================================
  t.section('SOLO 4. En cuanto hay tesoreria, vuelve la segunda firma');
  // ===================================================================
  t.statusIn('la presidenta invita a la tesorera',
    await post('/api/invitar-miembro',
      { groupId: 'GSOLO', email: teso.email, role: 'tesorero' }, tk.presi), [200, 201]);
  const inv = await get('/api/mis-invitaciones', tk.teso);
  const invId = (inv.body?.invitaciones || [])[0]?.invitationId
    || (inv.body?.invitaciones || [])[0]?.InvitationID;
  t.statusIn('la tesorera acepta',
    await post('/api/responder-invitacion', { invitationId: invId, accion: 'aceptar' }, tk.teso), [200, 201]);

  const segundoSuyo = await post('/api/registrar-ahorros',
    { groupId: 'GSOLO', date: hoy, amount: 70 }, tk.presi);
  t.eq('ahora el aporte de la presidenta SI queda pendiente', segundoSuyo.body?.estado, 'pendiente');
  t.eq('ya no hay excepcion que valga', segundoSuyo.body?.motivo || '', '');
  t.status('y ella no puede firmarlo',
    await post('/api/gob/aportes/resolver',
      { groupId: 'GSOLO', tipo: 'ahorro', movId: segundoSuyo.body?.movId, accion: 'confirmar' }, tk.presi), 403);
  t.statusIn('lo firma la tesoreria, que es de lo que se trataba',
    await post('/api/gob/aportes/resolver',
      { groupId: 'GSOLO', tipo: 'ahorro', movId: segundoSuyo.body?.movId, accion: 'confirmar' }, tk.teso), [200, 201]);

  // ===================================================================
  t.section('SOLO 5. Apagar la regla libera lo que quedo esperando');
  // ===================================================================
  seedWorkbook();
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  fake.seedSheet(HOJA, [CABECERA]);
  const e = await baseScenario({ groupId: 'GLIB' });

  // El reglamento tiene que EXISTIR antes: la primera vez que se guarda no hay
  // nada que relajar, asi que no pide acuerdo. Se deja escrito con la
  // aprobacion encendida, que es el valor por defecto.
  t.statusIn('la presidencia deja escrito el reglamento',
    await post('/api/gob/reglas',
      { groupId: 'GLIB', requiereAprobacionAportes: true, aporteMinimo: 1 }, e.tokens.presi), [200, 201]);

  const a1 = await post('/api/registrar-ahorros', { groupId: 'GLIB', date: hoy, amount: 30 }, e.tokens.socio1);
  const a2 = await post('/api/registrar-ahorros', { groupId: 'GLIB', date: hoy, amount: 40 }, e.tokens.socio2);
  t.eq('los dos aportes quedan pendientes', a1.body?.estado, 'pendiente');
  t.eq('el segundo tambien', a2.body?.estado, 'pendiente');

  // Apagar la regla relaja el control: hace falta acuerdo de asamblea
  const sinAcuerdo = await post('/api/gob/reglas',
    { groupId: 'GLIB', requiereAprobacionAportes: false }, e.tokens.presi);
  t.status('apagar la aprobacion exige acuerdo de asamblea', sinAcuerdo, 409);

  const asa = await post('/api/gob/asambleas',
    { groupId: 'GLIB', titulo: 'Cambio de reglas', fechaProgramada: hoy, modalidad: 'presencial' }, e.tokens.presi);
  await post(`/api/gob/asambleas/${asa.body?.asambleaId}/asistencia`, {
    groupId: 'GLIB',
    registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
      .map((q) => ({ email: e.users[q].email, estado: 'presente' })),
  }, e.tokens.secre);
  await post(`/api/gob/asambleas/${asa.body?.asambleaId}/estado`,
    { estado: 'abierta', groupId: 'GLIB' }, e.tokens.presi);
  const acu = await post(`/api/gob/asambleas/${asa.body?.asambleaId}/acuerdos`,
    { groupId: 'GLIB', tipo: 'cambio_reglas', titulo: 'Quitar la aprobacion de aportes' }, e.tokens.presi);
  for (const q of ['presi', 'teso', 'secre', 'socio1', 'socio2']) {
    await post(`/api/gob/acuerdos/${acu.body?.acuerdoId}/votar`, { groupId: 'GLIB', voto: 'favor' }, e.tokens[q]);
  }

  const conAcuerdo = await post('/api/gob/reglas',
    { groupId: 'GLIB', requiereAprobacionAportes: false, acuerdoId: acu.body?.acuerdoId }, e.tokens.presi);
  t.statusIn('con el acuerdo aprobado si se puede apagar', conAcuerdo, [200, 201]);
  t.eq('y los dos aportes que esperaban quedan liberados', conAcuerdo.body?.aportesLiberados, 2);

  const pendientesTras = (fake.dumpSheet('Savings') || []).slice(1)
    .filter((r) => (r[1] || '') === 'GLIB' && (r[SAV_ESTADO] || '').toLowerCase() === 'pendiente');
  t.eq('ya no queda ninguno colgado', pendientesTras.length, 0);

  const liberada = (fake.dumpSheet('Savings') || []).slice(1)
    .find((r) => (r[1] || '') === 'GLIB');
  t.check('y la fila explica por que se confirmo',
    /apagar la aprobacion/i.test(liberada?.[SAV_NOTA] || ''), `nota: "${liberada?.[SAV_NOTA]}"`);

  // ===================================================================
  t.section('SOLO 6. Invitar a quien no tiene cuenta lo dice claro');
  // ===================================================================
  const sinCuenta = await post('/api/invitar-miembro',
    { groupId: 'GLIB', email: 'nadie@todavia.test', role: 'member' }, e.tokens.presi);
  t.status('se rechaza', sinCuenta, 404);
  t.eq('con un motivo que la app puede usar', sinCuenta.body?.motivo, 'sin_cuenta');
  t.check('y un mensaje que dice que hacer',
    /no existe una cuenta/i.test(sinCuenta.body?.message || '')
    && /crear su cuenta/i.test(sinCuenta.body?.message || ''),
    JSON.stringify(sinCuenta.body));
  t.check('el mensaje repite el correo, para descartar un error de tecleo',
    (sinCuenta.body?.message || '').includes('nadie@todavia.test'), sinCuenta.body?.message);
};
