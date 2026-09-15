/**
 * SUITE 28 - Un periodo cerrado esta cerrado.
 *
 * Sale de una simulacion de un ano entero de un banco comunal de doce socias.
 * La caja cuadraba al centavo, pero las PERSONAS no: el reparto rehacia toda la
 * historia con la foto de hoy, asi que en cuanto una socia se daba de baja las
 * cifras de las demas cambiaban hacia atras.
 *
 * Medido: cinco socias con $100 cada una, se reparten $20 en marzo ($4 a cada
 * una), la socia B se va, la socia A compra $300 mas, se reparten otros $20 en
 * mayo. A la socia A le tocaban $15,43 y la app le dio $14,36. Perdio $1,07,
 * que se repartio entre las otras tres.
 *
 * Aqui se fija que un cierre aplicado no se vuelve a tocar, que lo que llega
 * tarde a un mes ya cerrado no se pierde, y que el aporte se puede fechar (sin
 * eso, todos los aportes del ano caian en el mismo mes y con base 'ahorros' el
 * grupo repartia $0 de $66 ganados).
 */

const { PNG_PRUEBA, hoyLocal, seedWorkbook, get, post, postArchivo, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();

/** Compra de acciones ya confirmada, con su fecha. */
const acciones = (email, grupo, cantidad, fecha) => fake.ensureSheet('Acciones').grid.push([
  email, grupo, fecha, cantidad, 10, 2, new Date().toISOString(),
  'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(),
  `acc_${Math.random().toString(36).slice(2, 8)}`, '',
]);

/** Prestamo con sus pagos aprobados, fechados. */
function prestamo(id, email, grupo, principal, total, inicio, pagos) {
  fake.ensureSheet('Loans').grid.push([
    id, email, grupo, principal, inicio, new Date().toISOString(), 2, 'aprobado', 6, total,
  ]);
  pagos.forEach(([monto, fecha], i) => fake.ensureSheet('LoanPayments').grid.push([
    `${id}_P${i}`, email, id, monto, fecha, 'cuota', 'approved',
    '', '', '', '', new Date().toISOString(), 'teso@juntago.test', new Date().toISOString(), '',
  ]));
}

/** Da por aprobado en asamblea el ultimo cierre creado. */
function aplicarCierre(cierreId) {
  const filas = fake.ensureSheet('CierresUtilidades').grid;
  const fila = filas.find((r) => (r[0] || '') === cierreId);
  if (fila) fila[2] = 'aplicado';
  return !!fila;
}

module.exports = async function run() {
  const G_SHEETS = require('../governance').SHEETS;
  const { HOJA, CABECERA } = require('../accesos');
  const preparar = () => {
    seedWorkbook();
    Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
    fake.seedSheet(HOJA, [CABECERA]);
    require('../hoja').invalidarTodo();
  };

  // ===================================================================
  t.section('CIE 1. Una baja no cambia lo que ya cobraron las demas');
  // ===================================================================
  preparar();
  const e = await baseScenario({ groupId: 'GCIE' });
  const G = 'GCIE';
  const quien = {
    A: e.users.socio1.email,
    B: e.users.socio2.email,
    C: e.users.secre.email,
    D: e.users.presi.email,
    E: e.users.teso.email,
  };

  // Las cinco ponen $100 en enero
  Object.values(quien).forEach((c) => acciones(c, G, 10, '2026-01-10'));
  // El grupo gana $20 en marzo
  prestamo('LN_M', quien.A, G, 100, 120, '2026-02-01', [[120, '2026-03-15']]);

  const rep1 = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.status('el primer reparto responde', rep1, 200);
  t.near('el grupo gano $20', rep1.body?.ganancia?.total, 20, 0.01);
  const toca1 = (c) => Number((rep1.body?.reparto || []).find((x) => x.email === c)?.utilidad);
  for (const [nombre, correo] of Object.entries(quien)) {
    t.near(`a ${nombre} le tocan $4,00`, toca1(correo), 4, 0.01);
  }

  const cierre1 = await post('/api/gob/utilidades/cierre', { groupId: G }, e.tokens.presi);
  t.status('se crea el cierre de marzo', cierre1, 201);
  t.check('y se aplica', aplicarCierre(cierre1.body?.cierreId), 'no se encontro el cierre');
  require('../hoja').invalidarTodo();

  // La socia B se va del grupo. Pedirlo ya no la borra: sigue siendo socia hasta
  // que la asamblea aprueba su liquidacion y se le devuelve lo suyo. Aqui se
  // recorre el ciclo entero, porque lo que hay que fijar es que al final NI ella
  // pierde lo suyo NI el grupo lo paga dos veces.
  const pidio = await post('/api/salir-grupo', { groupId: G }, e.tokens.socio2);
  t.statusIn('la socia B pide salir', pidio, [200, 201]);
  t.eq('y sigue contando como socia mientras tanto',
    (await get(`/api/obtener-miembros?groupId=${G}`, e.tokens.presi))
      .body?.miembros?.length ?? (await get(`/api/obtener-miembros?groupId=${G}`, e.tokens.presi))
      .body?.members?.length, 5);

  const calculada = await post(`/api/gob/salida/${pidio.body?.salidaId}/calcular`,
    {}, e.tokens.presi);
  t.status('la tesoreria calcula lo que le corresponde', calculada, 200);
  t.near('le devuelven sus $100 de capital', calculada.body?.accionesValor, 100, 0.01);
  t.near('mas los $4 de utilidades que ya cobro en marzo... que no, esos ya los tiene',
    calculada.body?.utilidades, 0, 0.01);

  const asaSal = await post('/api/gob/asambleas',
    { groupId: G, titulo: 'Salida de la socia B', fechaProgramada: hoy(), modalidad: 'presencial' },
    e.tokens.presi);
  await post(`/api/gob/asambleas/${asaSal.body?.asambleaId}/asistencia`, {
    groupId: G,
    registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
      .map((q) => ({ email: e.users[q].email, estado: 'presente' })),
  }, e.tokens.secre);
  await post(`/api/gob/asambleas/${asaSal.body?.asambleaId}/estado`,
    { estado: 'abierta', groupId: G }, e.tokens.presi);
  const propuesta = await post(`/api/gob/salida/${pidio.body?.salidaId}/proponer`,
    { asambleaId: asaSal.body?.asambleaId }, e.tokens.presi);
  t.status('se lleva a la asamblea', propuesta, 200);
  for (const q of ['presi', 'teso', 'secre', 'socio1']) {
    await post(`/api/gob/acuerdos/${propuesta.body?.acuerdoId}/votar`,
      { groupId: G, voto: 'favor' }, e.tokens[q]);
  }
  const pagada = await post(`/api/gob/salida/${pidio.body?.salidaId}/aplicar`, {}, e.tokens.presi);
  t.status('y con el acuerdo aprobado se le paga', pagada, 200);
  t.near('cobra su capital', pagada.body?.pagado, 100, 0.01);

  require('../hoja').invalidarTodo();
  t.eq('ahora si deja de contar como socia',
    (await get(`/api/obtener-miembros?groupId=${G}`, e.tokens.presi))
      .body?.miembros?.length ?? (await get(`/api/obtener-miembros?groupId=${G}`, e.tokens.presi))
      .body?.members?.length, 4);
  const tb = await get(`/api/gob/tablero?groupId=${G}`, e.tokens.presi);
  t.near('y su capital sale del patrimonio del grupo',
    tb.body?.aportes?.patrimonio, 400, 0.01);
  // Y la socia A pone $300 mas en abril
  acciones(quien.A, G, 30, '2026-04-05');
  // El grupo gana otros $20 en mayo
  prestamo('LN_M2', quien.C, G, 100, 120, '2026-04-01', [[120, '2026-05-15']]);
  require('../hoja').invalidarTodo();

  const rep2 = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.status('el segundo reparto responde', rep2, 200);
  const toca2 = (c) => Number((rep2.body?.reparto || []).find((x) => x.email === c)?.utilidad);

  // En mayo el capital es: A $400, C/D/E $100 cada una = $700.
  // A A le toca 20 x 400/700 = $11,43; a las otras tres 20 x 100/700 = $2,857.
  t.near('a la socia A le tocan los $11,43 de mayo por su capital real',
    toca2(quien.A), 11.43, 0.02);
  for (const nombre of ['C', 'D', 'E']) {
    t.near(`a ${nombre} le tocan $2,86`, toca2(quien[nombre]), 2.86, 0.02);
  }
  t.near('la suma es exactamente los $20 de mayo',
    (rep2.body?.reparto || []).reduce((s, x) => s + Number(x.utilidad), 0), 20, 0.01);

  t.near('lo de marzo consta como ya repartido', rep2.body?.ganancia?.yaRepartido, 20, 0.01);
  t.near('y solo queda por repartir lo de mayo', rep2.body?.ganancia?.porRepartir, 20, 0.01);
  t.check('marzo consta como mes cerrado',
    (rep2.body?.mesesCerrados || []).includes('2026-03'),
    JSON.stringify(rep2.body?.mesesCerrados));
  t.check('y los meses abiertos ya no lo incluyen',
    !(rep2.body?.porMes || []).some((m) => m.mes === '2026-03'),
    JSON.stringify((rep2.body?.porMes || []).map((m) => m.mes)));

  // Lo que cobro cada una en total: marzo (4) + mayo
  t.near('en total la socia A se lleva 4 + 11,43 = 15,43',
    4 + toca2(quien.A), 15.43, 0.02);

  // ===================================================================
  t.section('CIE 2. El comprobante que llega tarde no se pierde');
  // ===================================================================
  // La tesoreria aprueba en enero un pago fechado en diciembre, cuando el
  // periodo ya se cerro. Ese interes no se puede repartir hacia atras sin
  // cambiar lo que cada socia cobro, pero tampoco puede desaparecer.
  const antesDelAtraso = Number(rep2.body?.ganancia?.total);
  prestamo('LN_TARDE', quien.D, G, 100, 110, '2026-02-01', [[110, '2026-03-20']]);
  require('../hoja').invalidarTodo();

  const rep3 = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('el grupo gano $10 mas', rep3.body?.ganancia?.total, antesDelAtraso + 10, 0.01);
  t.near('y esos $10 constan como llegados tarde',
    rep3.body?.ganancia?.llegoTarde, 10, 0.01);
  t.check('se explica por que se reparten ahora',
    /ya se cerraron/i.test(rep3.body?.ganancia?.aviso || ''), rep3.body?.ganancia?.aviso);
  t.near('no se pierde: entra en lo que hay por repartir',
    rep3.body?.ganancia?.porRepartir, 30, 0.02);
  t.near('y la suma del reparto es esa misma cifra',
    (rep3.body?.reparto || []).reduce((s, x) => s + Number(x.utilidad), 0), 30, 0.02);

  // ===================================================================
  t.section('CIE 3. El aporte se registra con SU fecha, no con la de hoy');
  // ===================================================================
  preparar();
  const f = await baseScenario({ groupId: 'GFEC' });

  const r = await post('/api/savings',
    { groupId: 'GFEC', tipo: 'mensual', monto: 40, fecha: '2026-03-15' }, f.tokens.socio1);
  t.statusIn('se acepta un aporte fechado en marzo', r, [200, 201]);
  const fila = (fake.dumpSheet('Savings') || []).slice(1)
    .find((x) => (x[1] || '') === 'GFEC' && Number(x[2]) === 40);
  t.eq('y en la hoja queda con esa fecha', (fila?.[3] || '').toString(), '2026-03-15');

  const futuro = new Date();
  futuro.setFullYear(futuro.getFullYear() + 1);
  t.status('una fecha futura se rechaza',
    await post('/api/savings',
      { groupId: 'GFEC', tipo: 'mensual', monto: 10, fecha: futuro.toISOString().slice(0, 10) },
      f.tokens.socio1), 400);
  t.status('y una fecha que no es una fecha, tambien',
    await post('/api/savings',
      { groupId: 'GFEC', tipo: 'mensual', monto: 10, fecha: 'el mes pasado' }, f.tokens.socio1), 400);

  const sinFecha = await post('/api/savings',
    { groupId: 'GFEC', tipo: 'mensual', monto: 11 }, f.tokens.socio1);
  t.statusIn('sin fecha se usa la de hoy', sinFecha, [200, 201]);
  const fila2 = (fake.dumpSheet('Savings') || []).slice(1)
    .find((x) => (x[1] || '') === 'GFEC' && Number(x[2]) === 11);
  t.eq('en calendario local, no en UTC', (fila2?.[3] || '').toString(), hoy());

  // ===================================================================
  t.section('CIE 4. El minimo y el maximo del reglamento gobiernan');
  // ===================================================================
  preparar();
  const g = await baseScenario({ groupId: 'GMIN' });
  t.status('la presidencia fija minimo 20 y maximo 500',
    await post('/api/gob/reglas',
      { groupId: 'GMIN', aporteMinimo: 20, aporteMaximo: 500 }, g.tokens.presi), 200);

  const bajo = await post('/api/savings',
    { groupId: 'GMIN', tipo: 'mensual', monto: 3 }, g.tokens.socio1);
  t.status('un aporte de $3 no pasa el minimo', bajo, 400);
  t.eq('con su motivo', bajo.body?.motivo, 'bajo_el_minimo');
  t.check('y el mensaje dice cuanto es el minimo',
    /20/.test(bajo.body?.message || ''), bajo.body?.message);

  const alto = await post('/api/savings',
    { groupId: 'GMIN', tipo: 'mensual', monto: 900 }, g.tokens.socio1);
  t.status('un aporte de $900 no pasa el maximo', alto, 400);
  t.eq('con su motivo', alto.body?.motivo, 'sobre_el_maximo');

  t.statusIn('uno de $50 si entra',
    await post('/api/savings', { groupId: 'GMIN', tipo: 'mensual', monto: 50 }, g.tokens.socio1),
    [200, 201]);
  t.eq('y es el unico que quedo en la hoja',
    (fake.dumpSheet('Savings') || []).slice(1).filter((x) => (x[1] || '') === 'GMIN').length, 1);

  // ===================================================================
  t.section('CIE 5. Con aportes fechados, la base "ahorros" tambien reparte');
  // ===================================================================
  // Antes todos los aportes del ano caian en el mismo dia, asi que con base
  // 'ahorros' el grupo declaraba $66 ganados y repartia $0,00.
  preparar();
  const h = await baseScenario({ groupId: 'GBAS' });
  await post('/api/gob/reglas', { groupId: 'GBAS', baseReparto: 'ahorros' }, h.tokens.presi);

  for (const [correo, fecha] of [
    [h.users.socio1.email, '2026-01-10'],
    [h.users.socio2.email, '2026-01-10'],
    [h.users.secre.email, '2026-04-10'],
  ]) {
    fake.ensureSheet('Savings').grid.push([
      correo, 'GBAS', 500, fecha, 'mensual', 'aporte', 'confirmado',
      'a@a.test', 'b@b.test', new Date().toISOString(),
      `sav_${Math.random().toString(36).slice(2, 8)}`, '',
    ]);
  }
  prestamo('LN_B', h.users.socio1.email, 'GBAS', 1000, 1120, '2026-01-05',
    [[560, '2026-02-10'], [560, '2026-05-10']]);
  require('../hoja').invalidarTodo();

  const repB = await get('/api/gob/utilidades/reparto?groupId=GBAS&base=ahorros', h.tokens.presi);
  t.status('el reparto por ahorros responde', repB, 200);
  t.near('el grupo gano $120', repB.body?.ganancia?.total, 120, 0.02);
  t.near('y se reparten los $120, no $0', repB.body?.ganancia?.porRepartir, 120, 0.02);
  const cuota = (c) => Number((repB.body?.reparto || []).find((x) => x.email === c)?.utilidad);
  t.check('la que entro en abril cobra menos que las de enero',
    cuota(h.users.secre.email) < cuota(h.users.socio1.email),
    JSON.stringify((repB.body?.reparto || []).map((x) => `${x.email}=${x.utilidad}`)));
  t.near('y la suma cuadra con lo ganado',
    (repB.body?.reparto || []).reduce((s, x) => s + Number(x.utilidad), 0), 120, 0.02);

  // ===================================================================
  t.section('CIE 6. Las pruebas no se creen el UTC');
  // ===================================================================
  // Sacar la fecha de hoy del reloj UTC devuelve MANANA a partir de las 19:00 en
  // Ecuador. Las baterias lo hacian y, como el servidor rechaza las fechas
  // futuras, se ponian rojas todas las tardes: medido, 20 fallas con el reloj a
  // las 20:00 y ninguna a las 16:00. El dia se saca del calendario local, con
  // `hoyLocal()` del arnes. Este guardian evita que vuelva a colarse.
  const { hoyLocal: hl } = require('./harness');
  const tarde = new Date(2026, 8, 3, 20, 30, 0);
  t.eq('a las 20:30 en Ecuador, el UTC ya dice manana',
    tarde.toISOString().split('T')[0], '2026-09-04');
  t.eq('pero el calendario de quien usa la app dice hoy', hl(tarde), '2026-09-03');
  t.eq('y a media manana coinciden', hl(new Date(2026, 8, 3, 10, 0, 0)), '2026-09-03');

  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname);
  const culpables = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js') && f !== 'harness.js')
    // La aguja se arma por trozos para que este guardian no se encuentre a si
    // mismo: si se escribiera entera, este archivo seria el primer culpable.
    .filter((f) => fs.readFileSync(path.join(dir, f), 'utf8')
      .includes(['new Date().toISO', "String().split('T", "')[0]"].join('')));
  t.eq('ninguna bateria saca la fecha de hoy del UTC', culpables.length, 0,
    `usan toISOString: ${culpables.join(', ')}`);

  // ===================================================================
  t.section('CIE 7. No se cierra el periodo a ciegas');
  // ===================================================================
  // Medido en la simulacion de un ano: la presidencia cerro sin saber que
  // quedaba un comprobante de $10 sin revisar, y sus $1,07 de interes cayeron
  // despues en un mes ya repartido. El mecanismo aguanto, pero la decision se
  // tomo a ciegas.
  preparar();
  const k = await baseScenario({ groupId: 'GAVI' });
  acciones(k.users.socio1.email, 'GAVI', 50, '2026-01-10');
  acciones(k.users.socio2.email, 'GAVI', 50, '2026-01-10');
  prestamo('LN_AVI', k.users.socio1.email, 'GAVI', 1000, 1120, '2026-01-05', [[560, '2026-03-10']]);
  fake.ensureSheet('LoanPayments').grid.push([
    // Fechado DENTRO del periodo que se va a cerrar: su interes pertenece a este
    // reparto y se quedaria fuera. Uno fechado despues no estorba, y no avisa.
    'SIN_MIRAR', k.users.socio1.email, 'LN_AVI', 560, '2026-03-20', 'cuota', 'pending_approval',
    '', '', '', '', new Date().toISOString(), '', '', '',
  ]);
  require('../hoja').invalidarTodo();

  const repAvi = await get('/api/gob/utilidades/reparto?groupId=GAVI', k.tokens.presi);
  t.status('el reparto responde', repAvi, 200);
  const rev = repAvi.body?.revisionPendiente || {};
  t.eq('avisa de que hay un comprobante sin revisar', rev.comprobantes, 1);
  t.near('con su importe', rev.montoComprobantes, 560, 0.01);
  t.near('y el interes que se quedaria fuera', rev.interesEnJuego, 60, 0.02);
  t.check('y de quien es', (rev.detalle?.comprobantes || [])
    .some((c) => c.email === k.users.socio1.email),
  JSON.stringify(rev.detalle));

  const aCiegas = await post('/api/gob/utilidades/cierre', { groupId: 'GAVI' }, k.tokens.presi);
  t.status('cerrar sin haberlo revisado se frena', aCiegas, 409);
  t.eq('con su motivo', aCiegas.body?.motivo, 'falta_revisar');
  t.check('y el mensaje dice que falta y que pasa si cierra igual',
    /comprobante/i.test(aCiegas.body?.message || '')
      && /periodo siguiente/i.test(aCiegas.body?.message || ''),
  aCiegas.body?.message);

  const aSabiendas = await post('/api/gob/utilidades/cierre',
    { groupId: 'GAVI', cerrarConPendientes: true }, k.tokens.presi);
  t.status('pero se puede cerrar igual, decidiendolo', aSabiendas, 201);

  const bitacora = (fake.dumpSheet('GobernanzaLog') || []).slice(1)
    .filter((r) => (r[3] || '') === 'cierre_utilidades_creado');
  t.check('y queda anotado en la bitacora QUIEN quedaba sin revisar',
    bitacora.some((r) => (r[5] || '').includes(k.users.socio1.email)),
    JSON.stringify(bitacora.map((r) => r[5])));

  // ===================================================================
  t.section('CIE 8. El interes que el grupo tiene por cobrar se ve');
  // ===================================================================
  // No se reparte, solo se reparte lo cobrado, pero la tesoreria necesita saber
  // que le queda por entrar. Antes no salia en ninguna pantalla.
  const pc = repAvi.body?.porCobrar || {};
  t.near('el prestamo de 1.000 por 1.120 con 560 pagados debe 60 de interes',
    pc.total, 60, 0.02);
  t.check('con el detalle del prestamo', (pc.prestamos || []).some((x) => x.loanId === 'LN_AVI'),
    JSON.stringify(pc.prestamos));
  t.near('y no se mezcla con lo ya ganado', repAvi.body?.ganancia?.total, 60, 0.02);

  // ===================================================================
  t.section('CIE 9. La fecha del comprobante se valida');
  // ===================================================================
  preparar();
  const m = await baseScenario({ groupId: 'GFPA' });
  fake.ensureSheet('Loans').grid.push([
    'LN_FPA', m.users.socio1.email, 'GFPA', 300, hoy(),
    new Date().toISOString(), 2, 'aprobado', 6, 336,
  ]);
  const subir = (fecha) => postArchivo('/api/upload-payment',
    { loanId: 'LN_FPA', amount: 10, paymentDate: fecha, description: 'x' },
    { campo: 'paymentImage', nombre: 'c.png', contenido: PNG_PRUEBA, tipo: 'image/png' },
    m.tokens.socio1);

  const anioQueViene = new Date();
  anioQueViene.setFullYear(anioQueViene.getFullYear() + 1);
  const enFuturo = await subir(anioQueViene.toISOString().slice(0, 10));
  t.status('un pago fechado en el futuro se rechaza', enFuturo, 400);
  t.eq('con su motivo', enFuturo.body?.motivo, 'fecha_futura');

  const noEsFecha = await subir('el mes pasado');
  t.status('lo que no es una fecha, tambien', noEsFecha, 400);
  t.eq('con su motivo', noEsFecha.body?.motivo, 'fecha_invalida');

  const muyVieja = await subir('1999-05-05');
  t.status('y un ano imposible', muyVieja, 400);
  t.eq('con su motivo', muyVieja.body?.motivo, 'fecha_muy_vieja');

  t.statusIn('un pago de hoy si entra', await subir(hoy()), [200, 201]);
};
