/**
 * SUITE 24 - Que el grupo se gobierne solo, y que las cuentas cuadren.
 *
 * Sale de una auditoria que monto un ciclo entero sin usar nunca el token de
 * administrador y comprobo 220 cifras a mano. Encontro tres formas de sacarle
 * dinero al grupo desde dentro:
 *
 *   - Un directivo pedia un prestamo y lo aprobaba el mismo. En un grupo con
 *     una sola directiva se llevaba la caja con su propia firma.
 *   - Se podia aplicar DOS veces el traspaso del cuaderno y el dinero de todo
 *     el grupo se duplicaba, sin forma de deshacerlo desde la app.
 *   - Un socio salia del grupo con su prestamo a medias y la deuda quedaba
 *     incobrable: despues ni el mismo podia pagarla.
 *
 * Y una cuarta cosa, mas callada: el reparto no daba a cada socia su cifra
 * exacta, y el centavo perdido por el redondeo iba siempre a quien mas tenia.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario, seedUser, seedGroup, seedLink, login } = require('./scenario');
const { repartirUtilidades } = require('../reparto');
const t = require('./runner');

/** Lo que le tocaria a cada quien si se pudieran partir los centavos. */
const idealDe = (ganancia, participaciones) => {
  const total = participaciones.reduce((s, x) => s + x, 0);
  return participaciones.map((x) => Math.round((ganancia * x / total) * 100) / 100);
};

module.exports = async function run() {
  const G_SHEETS = require('../governance').SHEETS;
  const { HOJA, CABECERA } = require('../accesos');
  const preparar = () => {
    seedWorkbook();
    Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
    fake.seedSheet(HOJA, [CABECERA]);
  };

  // ===================================================================
  t.section('AUT 1. Nadie firma su propio credito');
  // ===================================================================
  preparar();
  const hoy = hoyLocal();
  const e = await baseScenario({ groupId: 'GAU' });
  const G = 'GAU';

  // La tesoreria pide un prestamo
  await post('/api/registrar-ahorros', { groupId: G, date: hoy, amount: 200 }, e.tokens.teso);
  const movTeso = (fake.dumpSheet('Savings') || []).slice(-1)[0];
  await post('/api/gob/aportes/resolver',
    { groupId: G, tipo: 'ahorro', movId: movTeso[10], accion: 'confirmar' }, e.tokens.presi);

  await post('/api/registrar-solicitud',
    { tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 4', Group: G } }, e.tokens.teso);
  const sols = fake.dumpSheet('SolicitudesPrestamos') || [];
  const suSolicitud = sols[sols.length - 1][0];

  const autoVoto = await post('/api/registrar-voto',
    { solicitudId: suSolicitud, tipo: 'prestamo', grupoId: G, decision: 'aprobado' }, e.tokens.teso);
  t.status('la tesoreria no vota su propia solicitud', autoVoto, 403);
  t.eq('y se dice por que', autoVoto.body?.codigo, 'ES_TU_SOLICITUD');
  t.eq('no quedo ningun voto suyo registrado',
    (fake.dumpSheet('AprobacionesAsamblea') || []).slice(1)
      .filter((v) => (v[0] || '') === suSolicitud).length, 0);

  t.statusIn('la presidencia si puede votarla',
    await post('/api/registrar-voto',
      { solicitudId: suSolicitud, tipo: 'prestamo', grupoId: G, decision: 'aprobado' }, e.tokens.presi),
    [200, 201]);

  // ===================================================================
  t.section('AUT 2. Un solo directivo no se autopresta');
  // ===================================================================
  preparar();
  const sola = seedUser({ nombre: 'Presidenta Sola', email: 'unica@juntago.test' });
  const socia = seedUser({ nombre: 'Socia', email: 'socia2@juntago.test' });
  seedGroup({ id: 'GUNO', nombre: 'Con una sola directiva', presidente: sola.email });
  seedLink(sola.email, 'GUNO', 'presidente');
  seedLink(socia.email, 'GUNO', 'member');
  const tkSola = await login(sola.email);

  await post('/api/registrar-ahorros', { groupId: 'GUNO', date: hoy, amount: 500 }, tkSola);
  await post('/api/registrar-solicitud',
    { tipo: 'prestamo', data: { Monto: 300, Detalles: 'Plazo: 6', Group: 'GUNO' } }, tkSola);
  const sols2 = fake.dumpSheet('SolicitudesPrestamos') || [];
  const suya = sols2[sols2.length - 1][0];

  const intento = await post('/api/registrar-voto',
    { solicitudId: suya, tipo: 'prestamo', grupoId: 'GUNO', decision: 'aprobado' }, tkSola);
  t.status('la unica directiva tampoco se firma su prestamo', intento, 403);
  t.eq('no se creo ningun prestamo',
    (fake.dumpSheet('Loans') || []).slice(1).filter((l) => (l[2] || '') === 'GUNO').length, 0);

  // ===================================================================
  t.section('AUT 3. El traspaso del cuaderno se hace UNA vez');
  // ===================================================================
  preparar();
  const f = await baseScenario({ groupId: 'GAP' });
  const aplicarLote = async (filas) => {
    const lote = await post('/api/gob/apertura/lote', { groupId: 'GAP', filas }, f.tokens.presi);
    if (lote.status >= 400) return lote;
    const asa = await post('/api/gob/asambleas',
      { groupId: 'GAP', titulo: 'Apertura', fechaProgramada: hoy, modalidad: 'presencial' }, f.tokens.presi);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/asistencia`, {
      groupId: 'GAP',
      registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
        .map((q) => ({ email: f.users[q].email, estado: 'presente' })),
    }, f.tokens.secre);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/estado`,
      { estado: 'abierta', groupId: 'GAP' }, f.tokens.presi);
    const prop = await post(`/api/gob/apertura/lote/${lote.body?.loteId}/proponer`,
      { groupId: 'GAP', asambleaId: asa.body?.asambleaId }, f.tokens.presi);
    for (const q of ['presi', 'teso', 'secre', 'socio1', 'socio2']) {
      await post(`/api/gob/acuerdos/${prop.body?.acuerdoId}/votar`, { groupId: 'GAP', voto: 'favor' }, f.tokens[q]);
    }
    const r = await post(`/api/gob/apertura/lote/${lote.body?.loteId}/aplicar`, {}, f.tokens.presi);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/estado`,
      { estado: 'cerrada', groupId: 'GAP' }, f.tokens.presi);
    return r;
  };

  t.statusIn('el primer traspaso se aplica',
    await aplicarLote([{ email: f.users.socio1.email, ahorro: 500, acciones: 10, valorAccion: 10 }]),
    [200, 201]);

  const ahorroTras1 = (fake.dumpSheet('Savings') || []).slice(1)
    .filter((r) => (r[1] || '') === 'GAP').reduce((s2, r) => s2 + Number(r[2] || 0), 0);
  t.near('la socia tiene sus 500', ahorroTras1, 500, 0.01);

  const segundo = await aplicarLote([{ email: f.users.socio1.email, ahorro: 500, acciones: 10, valorAccion: 10 }]);
  t.status('el segundo traspaso se rechaza', segundo, 409);
  t.eq('con su motivo', segundo.body?.motivo, 'apertura_ya_aplicada');

  const ahorroTras2 = (fake.dumpSheet('Savings') || []).slice(1)
    .filter((r) => (r[1] || '') === 'GAP').reduce((s2, r) => s2 + Number(r[2] || 0), 0);
  t.near('y el dinero del grupo NO se duplico', ahorroTras2, 500, 0.01);

  // ===================================================================
  t.section('AUT 4. El reparto da a cada quien su cifra exacta');
  // ===================================================================
  // El calculo se hacia en coma flotante: 19 x 0,12 x 100 daba
  // 227,99999999999997 y truncar dejaba 227 en vez de 228. La socia perdia un
  // centavo por un error de representacion, y ese centavo se le entregaba
  // luego a quien mas capital tenia.
  const casos = [
    ['19 entre 120/30/50/50', 19, [120, 30, 50, 50]],
    ['1.234,56 entre 30 socios desiguales', 1234.56, Array.from({ length: 30 }, (_, i) => 10 + i * 7)],
    ['300 entre 100/200/300', 300, [100, 200, 300]],
  ];
  for (const [nombre, ganancia, parts] of casos) {
    const r = repartirUtilidades(ganancia,
      parts.map((acciones, i) => ({ email: `s${i}@x.test`, acciones })), 'acciones');
    const dio = r.reparto.map((x) => x.utilidad);
    const ideal = idealDe(ganancia, parts);
    const exactos = dio.filter((v, i) => Math.abs(v - ideal[i]) < 0.005).length;

    t.near(`${nombre}: la suma cuadra al centavo`,
      dio.reduce((a, b) => a + b, 0), ganancia, 0.005);
    t.eq(`${nombre}: no sobra nada`, r.sinRepartir, 0);
    // Con centavos indivisibles alguien tiene que llevarse el de mas; lo que no
    // vale es que fallen muchos.
    t.check(`${nombre}: casi todos reciben su cifra exacta (${exactos}/${parts.length})`,
      exactos >= parts.length - 1,
      `${exactos} de ${parts.length}. dio ${JSON.stringify(dio.slice(0, 6))} ideal ${JSON.stringify(ideal.slice(0, 6))}`);
  }

  const exacto = repartirUtilidades(19,
    [120, 30, 50, 50].map((acciones, i) => ({ email: `s${i}@x.test`, acciones })), 'acciones');
  t.eq('el caso medido da exactamente 9,12 / 2,28 / 3,80 / 3,80',
    JSON.stringify(exacto.reparto.map((x) => x.utilidad)), JSON.stringify([9.12, 2.28, 3.8, 3.8]));

  // ===================================================================
  t.section('AUT 5. No se sale del grupo debiendo');
  // ===================================================================
  preparar();
  const h = await baseScenario({ groupId: 'GSAL2' });
  await post('/api/gob/reglas',
    { groupId: 'GSAL2', requiereAprobacionPrestamos: false }, h.tokens.presi);
  await post('/api/registrar-ahorros', { groupId: 'GSAL2', date: hoy, amount: 300 }, h.tokens.socio1);
  const movS = (fake.dumpSheet('Savings') || []).slice(-1)[0];
  await post('/api/gob/aportes/resolver',
    { groupId: 'GSAL2', tipo: 'ahorro', movId: movS[10], accion: 'confirmar' }, h.tokens.teso);
  await post('/api/registrar-solicitud',
    { tipo: 'prestamo', data: { Monto: 200, Detalles: 'Plazo: 6', Group: 'GSAL2' } }, h.tokens.socio1);
  const solS = fake.dumpSheet('SolicitudesPrestamos') || [];
  await post('/api/approve-loan-request',
    { loanId: solS[solS.length - 1][0], action: 'approve' }, h.tokens.presi);

  const conDeuda = await post('/api/salir-grupo', { groupId: 'GSAL2' }, h.tokens.socio1);
  t.status('con un prestamo vivo no se sale', conDeuda, 409);
  t.eq('y se dice el motivo', conDeuda.body?.codigo, 'PRESTAMO_VIVO');
  t.check('el socio sigue en el grupo, asi que puede seguir pagando',
    (fake.dumpSheet('UserGroupLinks') || []).slice(1)
      .some((v) => (v[1] || '') === 'GSAL2' && (v[0] || '') === h.users.socio1.email), '');

  t.statusIn('quien no debe nada sale sin problema',
    await post('/api/salir-grupo', { groupId: 'GSAL2' }, h.tokens.socio2), [200, 201]);
};
