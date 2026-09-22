/**
 * SUITE 47 - Instrumento de seguimiento de la digitalizacion.
 *
 * Es el medio de verificacion que pide la planilla del INCYT para el indicador
 * IN-DIBA-2026-1.2 ("porcentaje de las CAYC seleccionadas estan digitalizadas",
 * meta 50 %), con numerador = grupos digitalizados y denominador = total de
 * grupos CAYC.
 *
 * Lo que se fija aqui, por orden de gravedad si fallara:
 *   1. El indicador se calcula SOLO con datos reales. Si contara lo sembrado
 *      para ensenar la app, el informe de avance del INCYT estaria diciendo que
 *      unos grupos operan cuando no han hecho un solo aporte.
 *   2. El denominador NO se adivina: sale de los grupos marcados como CAYC en
 *      la ficha de campo. Contar todos los grupos de la plataforma (hay de
 *      prueba) hundiria el indicador; contar solo los que van bien lo inflaria.
 *   3. La regla de "digitalizada" viaja junto al numero y cada grupo dice que
 *      le falta, para que se pueda comprobar en vez de creerselo.
 *   4. Anotar la capacitacion no borra lo que ya estaba de la socializacion.
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario, seedUser, seedGroup, seedLink } = require('./scenario');
const t = require('./runner');

const hojaDe = (r, nombre) => ((r.body && r.body.hojas) || []).find((h) => h.nombre === nombre);
const filasDe = (r, nombre) => (hojaDe(r, nombre) || {}).filas || [];
const dato = (r, concepto) => (filasDe(r, 'Indicador')
  .find((x) => new RegExp(concepto, 'i').test(String(x.Concepto))) || {}).Valor;
const gridDe = (nombre) => (fake.store.sheets.get(nombre) || { grid: [] }).grid;

module.exports = async function run() {
  const hoja = require('../hoja');
  const acc = require('../accesos');
  const G = require('../governance').SHEETS;
  const { HOJA_CAMPO, CABECERA_CAMPO } = require('../instrumento');

  const preparar = () => {
    seedWorkbook();
    Object.values(G).forEach((d) => fake.seedSheet(d.name, [d.headers]));
    fake.seedSheet(acc.HOJA, [acc.CABECERA]);
    fake.seedSheet(HOJA_CAMPO, [CABECERA_CAMPO]);
    ['Savings', 'Acciones', 'Loans', 'LoanPayments'].forEach((n) => fake.ensureSheet(n));
    hoja.invalidarTodo();
  };

  const entrar = (email, fechaIso) => fake.ensureSheet(acc.HOJA).grid
    .push([fechaIso, email, 'movil', 'Android', 'Chrome', '1.1.1.1', 'UA', 'vuelta']);
  const aportar = (email, gid, monto, fecha, id) => fake.ensureSheet('Savings').grid.push([
    email, gid, monto, fecha, 'mensual', 'aporte', 'confirmado',
    email, 'teso@juntago.test', `${fecha}T10:00:00.000Z`, id, '',
  ]);

  // ===================================================================
  t.section('INS 1. El indicador sale con su numerador y su denominador');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'CAYC1' });
  // Un segundo grupo del proyecto, que se quedara sin digitalizar.
  seedUser({ nombre: 'Presi Dos', email: 'p2@cayc.test' });
  seedUser({ nombre: 'Teso Dos', email: 't2@cayc.test' });
  seedGroup({ id: 'CAYC2', nombre: 'Segundo banco', presidente: 'p2@cayc.test' });
  seedLink('p2@cayc.test', 'CAYC2', 'presidente');
  seedLink('t2@cayc.test', 'CAYC2', 'tesorero');
  // Y un grupo de PRUEBA que no es del proyecto: no debe entrar en el denominador.
  seedUser({ nombre: 'Prueba', email: 'prueba@cayc.test' });
  seedGroup({ id: 'NOPE', nombre: 'Grupo de prueba', presidente: 'prueba@cayc.test' });
  seedLink('prueba@cayc.test', 'NOPE', 'presidente');

  // El primero cumple las tres condiciones.
  fake.seedSheet(acc.HOJA, [acc.CABECERA]);
  [e.users.presi, e.users.teso, e.users.secre].forEach((u, i) => entrar(u.email, `2026-03-0${i + 1}T10:00:00.000Z`));
  aportar(e.users.presi.email, 'CAYC1', 20, '2026-03-05', 'sav_real_1');
  hoja.invalidarTodo();

  // La ficha de campo: los dos primeros son CAYC, el de prueba NO se anota.
  let r = await post('/api/admin/seguimiento-campo', {
    grupos: [
      { groupId: 'CAYC1', grupo: 'Banco Comunal Salinas', esCayc: true,
        socializacionFecha: '2026-02-10', socializacionAsistentes: 12,
        capacitacionFecha: '2026-02-20', capacitacionAsistentes: 10,
        responsable: 'Sabina Villon', evidencia: 'Acta 001' },
      { groupId: 'CAYC2', grupo: 'Segundo banco', esCayc: true,
        socializacionFecha: '2026-02-11', socializacionAsistentes: 8 },
    ],
  }, e.tokens.admin);
  t.status('la ficha de campo se anota', r, 200);
  hoja.invalidarTodo();

  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  t.status('el instrumento responde', r, 200);
  t.eq('trae las seis hojas', ((r.body && r.body.hojas) || []).length, 6);
  t.eq('el denominador son los grupos CAYC, no todos los de la plataforma',
    r.body.indicador.denominador, 2);
  t.eq('el numerador es el que cumple las tres condiciones', r.body.indicador.numerador, 1);
  t.eq('y el resultado es el 50 %', r.body.indicador.porcentaje, 50);
  t.eq('que es justo la meta', dato(r, 'Cumple la meta'), 'si');
  t.eq('el grupo de prueba no aparece', filasDe(r, 'Grupos').length, 2);

  const g1 = filasDe(r, 'Grupos').find((x) => x.GrupoID === 'CAYC1');
  const g2 = filasDe(r, 'Grupos').find((x) => x.GrupoID === 'CAYC2');
  t.eq('el primero sale digitalizado', g1 && g1.DIGITALIZADA, 'si');
  t.eq('el segundo no', g2 && g2.DIGITALIZADA, 'no');
  t.check('y se dice QUE le falta', !!g2 && g2['Que le falta'].length > 0, JSON.stringify(g2));
  t.eq('con su fecha de socializacion', g1 && g1['Socializacion (fecha)'], '2026-02-10');
  t.eq('y de capacitacion', g1 && g1['Capacitacion (fecha)'], '2026-02-20');
  t.eq('cuantos grupos se socializaron', dato(r, 'socializo'), '2 de 2');
  t.eq('y cuantos se capacitaron', dato(r, 'capacitados'), '1 de 2');

  t.check('la nomina trae a las socias de los dos grupos',
    filasDe(r, 'Nomina de socias').length >= 7, `${filasDe(r, 'Nomina de socias').length}`);
  t.check('y las evidencias traen el aporte',
    filasDe(r, 'Evidencias de operaciones').some((x) => x.Tipo === 'aporte' && x.Importe === 20),
    JSON.stringify(filasDe(r, 'Evidencias de operaciones')));
  t.check('el grupo de prueba sale avisado como sin ficha',
    filasDe(r, 'Grupos sin ficha de campo').some((x) => x.GrupoID === 'NOPE'), '');

  // ===================================================================
  t.section('INS 2. Los datos de demostracion NO cuentan en el indicador');
  // ===================================================================
  // Es lo mas grave que podria fallar: el informe de avance del INCYT diria
  // que un grupo opera cuando no ha hecho un solo aporte de verdad.
  preparar();
  e = await baseScenario({ groupId: 'CAYCD' });
  fake.seedSheet(acc.HOJA, [acc.CABECERA]);
  // Todo lo de este grupo es SEMBRADO: entradas marcadas 'demo' y aportes demo_.
  [e.users.presi, e.users.teso, e.users.secre].forEach((u, i) => fake.ensureSheet(acc.HOJA).grid
    .push([`2026-03-0${i + 1}T10:00:00.000Z`, u.email, 'movil', 'Android', 'Chrome', '1.1.1.1', 'UA', 'demo']));
  aportar(e.users.presi.email, 'CAYCD', 20, '2026-03-05', 'demo_sav_1');
  hoja.invalidarTodo();

  await post('/api/admin/seguimiento-campo',
    { groupId: 'CAYCD', grupo: 'Solo demostracion', esCayc: true }, e.tokens.admin);
  hoja.invalidarTodo();

  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  t.eq('el grupo NO cuenta como digitalizado', r.body.indicador.numerador, 0);
  t.eq('y el indicador es cero', r.body.indicador.porcentaje, 0);
  t.check('el documento dice que solo trae datos reales', r.body.soloDatosReales === true, '');
  const gd = filasDe(r, 'Grupos')[0];
  t.eq('sus aportes reales son cero', gd && gd['Aportes registrados'], 0);
  t.eq('y sus entradas reales tambien', gd && gd['Socias que han entrado'], 0);
  t.check('y se dice cuantas filas sembradas se dejaron fuera',
    filasDe(r, 'Como se calcula').some((x) => /Dejadas fuera/i.test(String(x.Regla))),
    JSON.stringify(filasDe(r, 'Como se calcula')));

  // Pedido a proposito CON la demostracion dentro, avisa en el propio documento.
  hoja.invalidarTodo();
  const conDemo = await get('/api/admin/instrumento-digitalizacion?incluirDemo=1', e.tokens.admin);
  t.eq('pedido con la demostracion dentro, el grupo si cuenta',
    conDemo.body.indicador.numerador, 1);
  t.check('pero el archivo se llama distinto',
    /CON-DATOS-DE-DEMOSTRACION/.test(conDemo.body.archivo || ''), conDemo.body.archivo);
  t.check('y el documento avisa de que NO sirve como medio de verificacion',
    filasDe(conDemo, 'Como se calcula').some((x) => /NO sirve como medio de verificacion/i.test(String(x.Regla))),
    '');

  // ===================================================================
  t.section('INS 3. La regla viaja con el numero');
  // ===================================================================
  // Un porcentaje suelto no se puede auditar. Quien lea el instrumento tiene
  // que poder comprobar grupo por grupo por que sale ese numero.
  const regla = filasDe(r, 'Como se calcula');
  t.check('se explica de donde sale el denominador',
    regla.some((x) => /Denominador/i.test(String(x.Punto))), '');
  t.eq('y las tres condiciones estan escritas',
    regla.filter((x) => /Condicion \d/.test(String(x.Punto))).length, 3);

  // ===================================================================
  t.section('INS 4. Anotar la capacitacion no borra la socializacion');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'CAYCP' });
  hoja.invalidarTodo();
  await post('/api/admin/seguimiento-campo', {
    groupId: 'CAYCP', grupo: 'Por partes', esCayc: true,
    socializacionFecha: '2026-01-15', socializacionAsistentes: 14, responsable: 'Sabina',
  }, e.tokens.admin);
  hoja.invalidarTodo();
  await post('/api/admin/seguimiento-campo', {
    groupId: 'CAYCP', capacitacionFecha: '2026-04-02', capacitacionAsistentes: 11,
  }, e.tokens.admin);
  hoja.invalidarTodo();

  const ficha = await get('/api/admin/seguimiento-campo', e.tokens.admin);
  t.status('la ficha se lee', ficha, 200);
  const suya = ((ficha.body || {}).anotados || []).find((x) => x.groupId === 'CAYCP');
  t.eq('la socializacion sigue ahi', suya && suya.socializacion.fecha, '2026-01-15');
  t.eq('con sus asistentes', suya && suya.socializacion.asistentes, 14);
  t.eq('y ahora tambien la capacitacion', suya && suya.capacitacion.fecha, '2026-04-02');
  t.eq('el responsable no se perdio', suya && suya.responsable, 'Sabina');
  t.eq('y no se duplico la fila',
    gridDe(HOJA_CAMPO).filter((f) => f[0] === 'CAYCP').length, 1);

  // ===================================================================
  t.section('INS 6. Una CAYC del plan que aun NO esta en la app');
  // ===================================================================
  // El Plan Integral selecciona once CAYC y la mayoria todavia no existe en la
  // plataforma. Esas cuentan en el DENOMINADOR (son grupos seleccionados que
  // aun no se digitalizan) y nunca en el numerador. Dejarlas fuera del
  // denominador inflaria el indicador: es la diferencia entre decir 18 % y
  // decir 91 %.
  preparar();
  e = await baseScenario({ groupId: 'CAYCX' });
  fake.seedSheet(acc.HOJA, [acc.CABECERA]);
  [e.users.presi, e.users.teso, e.users.secre].forEach((u, i) => entrar(u.email, `2026-03-0${i + 1}T10:00:00.000Z`));
  aportar(e.users.presi.email, 'CAYCX', 30, '2026-03-05', 'sav_real_x');
  hoja.invalidarTodo();

  await post('/api/admin/seguimiento-campo', {
    grupos: [
      { groupId: 'CAYCX', grupo: 'El que si esta', esCayc: true },
      // Estas solo existen en el plan: se anotan por NOMBRE, sin identificador.
      { grupo: 'Grupo Santa Rosa 1', esCayc: true, socializacionFecha: '2026-03-01' },
      { grupo: 'Grupo San Lorenzo', esCayc: true },
      { grupo: 'Grupo Las Palmeras', esCayc: true },
    ],
  }, e.tokens.admin);
  hoja.invalidarTodo();

  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  t.status('el instrumento responde', r, 200);
  t.eq('el denominador son las cuatro seleccionadas', r.body.indicador.denominador, 4);
  t.eq('el numerador es solo la que si esta y opera', r.body.indicador.numerador, 1);
  t.eq('y el indicador es el 25 %', r.body.indicador.porcentaje, 25);
  t.eq('se dice cuantas siguen fuera de la app', dato(r, 'AUN NO estan en la app'), '3 de 4');

  const fuera = filasDe(r, 'Grupos').filter((x) => x['Esta en la app'] === 'no');
  t.eq('las tres salen listadas', fuera.length, 3);
  t.check('ninguna cuenta como digitalizada',
    fuera.every((x) => x.DIGITALIZADA === 'no'), JSON.stringify(fuera.map((x) => x.Grupo)));
  t.check('y se dice que lo que les falta es existir en la app',
    fuera.every((x) => /no existe en la app/i.test(String(x['Que le falta']))), '');
  t.check('pero su socializacion si se conserva',
    fuera.some((x) => x['Socializacion (fecha)'] === '2026-03-01'),
    JSON.stringify(fuera.map((x) => [x.Grupo, x['Socializacion (fecha)']])));

  // ===================================================================
  t.section('INS 5. Esto es solo del administrador de la plataforma');
  // ===================================================================
  for (const [quien, tk] of [
    ['la presidencia de un grupo', e.tokens.presi],
    ['la tesoreria', e.tokens.teso],
    ['una socia', e.tokens.socio1],
  ]) {
    t.status(`${quien} no descarga el instrumento`,
      await get('/api/admin/instrumento-digitalizacion', tk), 403);
    t.status(`${quien} no lee la ficha de campo`,
      await get('/api/admin/seguimiento-campo', tk), 403);
    t.status(`${quien} no anota en la ficha`,
      await post('/api/admin/seguimiento-campo', { groupId: 'CAYCP', esCayc: false }, tk), 403);
  }
  t.status('y sin sesion tampoco',
    await get('/api/admin/instrumento-digitalizacion', null), 401);
};
