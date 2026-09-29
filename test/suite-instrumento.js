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
 *
 * Desde el 28-sep-2026 la regla es la del informe firmado: digitalizado =
 * INCORPORADO (en la app con su nomina anotada por la direccion). La regla
 * anterior (directiva + dinero + uso) es el nivel 4 y se sigue probando.
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

  // La ficha de campo: los dos primeros son CAYC, el de prueba NO se anota. Al
  // primero la direccion le anoto como entro su nomina; al segundo no, como a
  // un grupo de una sola persona que nunca entrego su nomina.
  let r = await post('/api/admin/seguimiento-campo', {
    grupos: [
      { groupId: 'CAYC1', grupo: 'Banco Comunal Salinas', esCayc: true,
        socializacionFecha: '2026-02-10', socializacionAsistentes: 12,
        capacitacionFecha: '2026-02-20', capacitacionAsistentes: 10,
        responsable: 'Sabina Villon', evidencia: 'Acta 001',
        formaDeIncorporacion: 'Nómina entregada por el grupo' },
      { groupId: 'CAYC2', grupo: 'Segundo banco', esCayc: true,
        socializacionFecha: '2026-02-11', socializacionAsistentes: 8 },
    ],
  }, e.tokens.admin);
  t.status('la ficha de campo se anota', r, 200);
  hoja.invalidarTodo();

  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  t.status('el instrumento responde', r, 200);
  t.eq('la primera hoja es la del indicador', (r.body.hojas || [])[0] && r.body.hojas[0].nombre, 'Indicador');
  t.check('y trae las secciones del informe',
    ['Datos generales', 'Criterio', 'Resultado', 'Niveles', 'Grupos digitalizados', 'Cobertura',
      'Matriz de seguimiento', 'Registro de operaciones', 'Listado inicial del Plan',
      'Registro de socializados', 'Control de consistencia'].every((n) => !!hojaDe(r, n)),
    JSON.stringify((r.body.hojas || []).map((h) => h.nombre)));
  t.eq('el denominador son los grupos CAYC, no todos los de la plataforma',
    r.body.indicador.denominador, 2);
  t.eq('el numerador es el grupo incorporado con su nomina', r.body.indicador.numerador, 1);
  t.eq('y el resultado es el 50 %', r.body.indicador.porcentaje, 50);
  t.eq('que es justo la meta', dato(r, 'Cumple la meta'), 'si');
  t.eq('el grupo de prueba no aparece', filasDe(r, 'Grupos').length, 2);

  const g1 = filasDe(r, 'Grupos').find((x) => x.GrupoID === 'CAYC1');
  const g2 = filasDe(r, 'Grupos').find((x) => x.GrupoID === 'CAYC2');
  t.eq('el primero sale digitalizado', g1 && g1.DIGITALIZADA, 'si');
  t.eq('y como cumple directiva, dinero y uso, esta en el nivel 4',
    g1 && g1['Nivel 4: en uso por sus socias'], 'si');
  t.eq('el segundo no', g2 && g2.DIGITALIZADA, 'no');
  t.check('y se dice QUE le falta', !!g2 && g2['Que le falta'].length > 0, JSON.stringify(g2));
  t.check('empezando por la nomina que nadie anoto',
    /Nomina levantada/.test(String(g2 && g2['Que le falta'])), JSON.stringify(g2 && g2['Que le falta']));
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

  // ---------------------------------------------------------------------
  // El Plan y la plataforma no llaman igual a la misma caja
  // ---------------------------------------------------------------------
  // El Plan usa nombres formales ("Caja de Ahorro Mujeres al Progreso") y la
  // plataforma los nombres con los que las socias la llaman ("Mi aguinaldo").
  // Sin poder anotar la correspondencia, una caja que SI esta digitalizada se
  // contaba como "no esta en la app" solo porque el nombre no coincidia; y
  // cuadrar la lista obligaba a renombrar grupos en la plataforma, que es tocar
  // el dato para que encaje con el informe.
  r = await post('/api/admin/seguimiento-campo', {
    grupos: [{
      groupId: 'CAYC2',
      nombreEnElPlan: 'Caja de Ahorro y Credito Mujeres al Progreso',
      fuenteDeLaSeleccion: 'Plan Integral, tabla 23',
    }],
  }, e.tokens.admin);
  t.status('se puede anotar como se llama en el Plan', r, 200);
  hoja.invalidarTodo();

  r = await get('/api/admin/seguimiento-campo', e.tokens.admin);
  const anotado = ((r.body && r.body.anotados) || []).find((x) => x.groupId === 'CAYC2');
  t.eq('la ficha devuelve el nombre del Plan',
    anotado && anotado.nombreEnElPlan, 'Caja de Ahorro y Credito Mujeres al Progreso');
  t.eq('y de donde sale que es del proyecto',
    anotado && anotado.fuenteDeLaSeleccion, 'Plan Integral, tabla 23');
  t.eq('sin haber borrado lo que ya estaba de la socializacion',
    anotado && anotado.socializacion && anotado.socializacion.fecha, '2026-02-11');

  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  const g2p = filasDe(r, 'Grupos').find((x) => x.GrupoID === 'CAYC2');
  t.eq('el instrumento publica los DOS nombres en la misma fila',
    g2p && g2p['Nombre en el Plan'], 'Caja de Ahorro y Credito Mujeres al Progreso');
  t.eq('y el nombre de la app al lado', g2p && g2p.Grupo, 'Segundo banco');
  t.eq('con la fuente de la seleccion', g2p && g2p['Fuente de la seleccion'], 'Plan Integral, tabla 23');

  // El denominador es la cifra mas discutida del indicador, asi que cada grupo
  // tiene que poder decir en que documento consta. Lo que no lo diga, se avisa:
  // el indicador se calcula igual, pero esa parte hay que creersela.
  t.eq('se cuenta cuantos CAYC no dicen de donde salen',
    r.body.indicador.caycSinFuenteDocumentada, 1);
  t.eq('y se publica cuanto del denominador esta documentado',
    dato(r, 'Denominador con su fuente documentada'), '1 de 2');
  t.check('con su aviso, sin dejar de calcular',
    filasDe(r, 'Indicador').some((x) => /denominador no esta documentado/i.test(String(x.Concepto))),
    JSON.stringify(filasDe(r, 'Indicador').map((x) => x.Concepto).slice(0, 5)));

  // Y cuando los dos tienen fuente, el aviso desaparece: un aviso que no se
  // apaga cuando se atiende deja de significar algo.
  r = await post('/api/admin/seguimiento-campo', {
    grupos: [{ groupId: 'CAYC1', fuenteDeLaSeleccion: 'Acta de socializacion 001' }],
  }, e.tokens.admin);
  t.status('se documenta el que faltaba', r, 200);
  hoja.invalidarTodo();
  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  t.eq('ya no queda ninguno sin fuente', r.body.indicador.caycSinFuenteDocumentada, 0);
  t.check('y el aviso se apaga',
    !filasDe(r, 'Indicador').some((x) => /denominador no esta documentado/i.test(String(x.Concepto))),
    JSON.stringify(filasDe(r, 'Indicador').map((x) => x.Concepto).slice(0, 5)));

  // ---------------------------------------------------------------------
  // La directiva se mide por FUNCION, no por la palabra que use cada grupo
  // ---------------------------------------------------------------------
  // No todos los grupos se organizan igual: en los libros que entregaron, unos
  // tienen Presidenta, otros Lideresa y otros seis Lideres. La condicion pide
  // presidencia y tesoreria, y funciona porque el cargo llega normalizado, no
  // porque el grupo escriba esa palabra. Estaba asi desde antes pero SIN
  // ninguna prueba, o sea que un cambio en la normalizacion lo habria roto en
  // silencio y el grupo habria dejado de contar sin que nadie supiera por que.
  preparar();
  e = await baseScenario({ groupId: 'AUXR' });
  seedUser({ nombre: 'Lideresa Rosa', email: 'rosa@rol.test' });
  seedUser({ nombre: 'Tesorera Marta', email: 'marta@rol.test' });
  seedUser({ nombre: 'Socia Tres', email: 'tres@rol.test' });
  seedGroup({ id: 'ROLES', nombre: 'Caja con lideresa', presidente: 'rosa@rol.test' });
  seedLink('rosa@rol.test', 'ROLES', 'Lideresa');
  seedLink('marta@rol.test', 'ROLES', 'Tesorera');
  seedLink('tres@rol.test', 'ROLES', 'member');
  fake.seedSheet(acc.HOJA, [acc.CABECERA]);
  ['rosa@rol.test', 'marta@rol.test'].forEach((c, i) => entrar(c, `2026-04-0${i + 1}T10:00:00.000Z`));
  aportar('rosa@rol.test', 'ROLES', 30, '2026-04-05', 'sav_roles_1');
  hoja.invalidarTodo();

  r = await post('/api/admin/seguimiento-campo', {
    grupos: [{ groupId: 'ROLES', grupo: 'Caja con lideresa', esCayc: true,
      formaDeIncorporacion: 'Nómina entregada por el grupo' }],
  }, e.tokens.admin);
  t.status('se anota la ficha', r, 200);
  hoja.invalidarTodo();

  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  const gRol = filasDe(r, 'Grupos').find((x) => x.GrupoID === 'ROLES');
  t.eq('una Lideresa cuenta como presidencia', gRol && gRol['Presidencia y tesoreria'], 'si');
  t.eq('y con eso el grupo cumple la condicion de directiva',
    !/directiva|tesoreria|presidencia/i.test(String(gRol && gRol['Que le falta'])), true);
  t.eq('el grupo sale digitalizado', gRol && gRol.DIGITALIZADA, 'si');
  t.eq('y llega al nivel 2 con esa directiva', gRol && gRol['Nivel 2: con directiva'], 'si');

  // Y el contraste: sin tesoreria no basta, se llame como se llame la cabeza.
  const rejillaRol = fake.store.sheets.get('UserGroupLinks').grid;
  const filaMarta = rejillaRol.find((f) => f[0] === 'marta@rol.test' && f[1] === 'ROLES');
  filaMarta[3] = 'member';
  hoja.invalidarTodo();
  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  const gRol2 = filasDe(r, 'Grupos').find((x) => x.GrupoID === 'ROLES');
  t.eq('sin tesoreria la condicion falla', gRol2 && gRol2['Presidencia y tesoreria'], 'no');
  t.check('y se dice que le falta la directiva',
    /directiva|tesoreria|presidencia/i.test(String(gRol2 && gRol2['Que le falta'])),
    JSON.stringify(gRol2 && gRol2['Que le falta']));
  t.eq('sigue incorporado: la directiva es el nivel 2, no el 1', gRol2 && gRol2.DIGITALIZADA, 'si');
  t.eq('pero ya no llega al nivel 2', gRol2 && gRol2['Nivel 2: con directiva'], 'no');

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
    // La fila sembrada se pide al modulo que siembra de verdad, no se copia.
    .push(require('../demo').filaDeAccesoSembrado(u.email, `2026-03-0${i + 1}T10:00:00.000Z`)));
  aportar(e.users.presi.email, 'CAYCD', 20, '2026-03-05', 'demo_sav_1');
  hoja.invalidarTodo();

  await post('/api/admin/seguimiento-campo',
    { groupId: 'CAYCD', grupo: 'Solo demostracion', esCayc: true,
      formaDeIncorporacion: 'Nómina entregada por el grupo' }, e.tokens.admin);
  hoja.invalidarTodo();

  // El nivel 1 (incorporado) no depende de las operaciones: el grupo esta en
  // la app con su nomina. Lo sembrado importaria en los niveles 3 y 4 y en las
  // cifras de uso, y es AHI donde no puede contar.
  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  const nivelDe = (resp, clave) => ((resp.body.indicador.niveles || [])
    .find((n) => n.clave === clave) || {});
  t.eq('el grupo esta incorporado', r.body.indicador.numerador, 1);
  t.eq('pero lo sembrado NO le da movimiento propio (nivel 3)', nivelDe(r, 'movimiento').grupos, 0);
  t.eq('ni uso por sus socias (nivel 4)', nivelDe(r, 'uso').grupos, 0);
  t.eq('el registro de operaciones del informe suma cero',
    (filasDe(r, 'Registro de operaciones').find((x) => x['GRUPO DE AHORRO'] === 'TOTAL') || {}).TOTAL, 0);
  t.eq('y la cobertura no cuenta entradas sembradas',
    (filasDe(r, 'Cobertura').find((x) => /entradas/.test(x.PREGUNTA)) || {}).RESPUESTA, 0);
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
  t.eq('pedido con la demostracion dentro, el grupo si llega al nivel 3',
    nivelDe(conDemo, 'movimiento').grupos, 1);
  t.eq('y el indicador NO se afirma', conDemo.body.indicador.cumple, null);
  t.check('el control de consistencia lo marca como no conforme',
    (filasDe(conDemo, 'Control de consistencia').find((x) => /solo datos reales/.test(x['COMPROBACIÓN'])) || {})
      .RESULTADO === 'No conforme', '');
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
  t.check('y el criterio de digitalizacion del informe',
    regla.some((x) => /Criterio/.test(String(x.Punto)) && /nómina de sus integrantes/.test(String(x.Regla))), '');
  t.eq('los siete hitos estan escritos',
    regla.filter((x) => /^Hito \d/.test(String(x.Punto))).length, 7);
  t.eq('y los cuatro niveles', regla.filter((x) => /^Nivel \d/.test(String(x.Punto))).length, 4);
  t.eq('y las tres condiciones del nivel 4',
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
      { groupId: 'CAYCX', grupo: 'El que si esta', esCayc: true,
        formaDeIncorporacion: 'Invitación de la presidencia' },
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
  t.eq('el numerador es solo la que si esta en la app', r.body.indicador.numerador, 1);
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

  // ===================================================================
  t.section('INS 7. El archivo de la plataforma sigue las secciones del informe firmado');
  // ===================================================================
  // El informe IN-DIBA-2026-1.2 que se entrego mide con siete hitos y cuatro
  // niveles y presenta el resultado en secciones fijas. Aqui se fija que el
  // archivo que baja la plataforma trae esas mismas secciones, en el orden del
  // registro que certifica la direccion, y con las cifras que salen de SUS
  // datos: un grupo sin nomina anotada no cuenta, una caja del registro que se
  // carga despues se reconoce por su nombre, y lo que no cuadra se dice.
  preparar();
  e = await baseScenario({ groupId: 'AUX7' });
  const socia = (correo, gid, cargo) => {
    seedUser({ nombre: `Persona ${correo.split('@')[0]}`, email: correo });
    seedLink(correo, gid, cargo);
  };
  seedGroup({ id: 'G_BANQ', nombre: 'Banquio de ahorros', presidente: 'lider@ins7.test' });
  socia('lider@ins7.test', 'G_BANQ', 'Líder');
  socia('tesorera@ins7.test', 'G_BANQ', 'Tesorera');
  socia('banq3@ins7.test', 'G_BANQ', 'member');
  seedGroup({ id: 'G_JUNT', nombre: 'Juntos Crecemos', presidente: 'presi@ins7.test' });
  socia('presi@ins7.test', 'G_JUNT', 'presidente');
  socia('teso@ins7.test', 'G_JUNT', 'tesorero');
  socia('junt3@ins7.test', 'G_JUNT', 'member');
  seedGroup({ id: 'G_COF', nombre: 'cofrecito', presidente: 'cofre@ins7.test' });
  socia('cofre@ins7.test', 'G_COF', 'presidente');
  // Una persona enlazada a dos grupos a la vez: el control de consistencia
  // tiene que verla, como vio a la socia repetida en la base real.
  seedUser({ nombre: 'Socia Doble', email: 'doble@ins7.test' });
  seedLink('doble@ins7.test', 'G_BANQ', 'member');
  seedLink('doble@ins7.test', 'G_JUNT', 'member');
  fake.seedSheet(acc.HOJA, [acc.CABECERA]);
  aportar('junt3@ins7.test', 'G_JUNT', 10, '2026-07-08', 'sav_ins7_junt');
  aportar('cofre@ins7.test', 'G_COF', 300, '2026-08-02', 'sav_ins7_cofre');
  hoja.invalidarTodo();

  const FUENTE7 = 'Registro de grupos socializados certificado por la directora';
  r = await post('/api/admin/seguimiento-campo', {
    grupos: [
      { groupId: 'G_BANQ', grupo: 'Banquio de ahorros', esCayc: true, orden: 1,
        procedencia: 'Identificado durante la ejecución', capacitado: true,
        formaDeIncorporacion: 'Nómina entregada por el grupo', fuenteDeLaSeleccion: FUENTE7 },
      { groupId: 'G_JUNT', grupo: 'Juntos Crecemos', esCayc: true, orden: 2,
        procedencia: 'Listado inicial del Plan Integral', capacitacionFecha: '2026-08-14',
        formaDeIncorporacion: 'Invitación de la presidencia', parroquia: 'Chipipe',
        ordenEnElPlan: 11, fuenteDeLaSeleccion: FUENTE7 },
      // Socializada y con su nomina, pero todavia sin cargar en la app.
      { grupo: 'Banquito Familiar', esCayc: true, orden: 3,
        procedencia: 'Identificado durante la ejecución', capacitado: true,
        formaDeIncorporacion: 'Nómina entregada por el grupo', fuenteDeLaSeleccion: FUENTE7 },
      { grupo: 'Santa Rosa 1', esCayc: true, orden: 4, parroquia: 'Santa Rosa', ordenEnElPlan: 1,
        procedencia: 'Listado inicial del Plan Integral', fuenteDeLaSeleccion: FUENTE7 },
      // En la app con una sola persona y sin nomina entregada.
      { groupId: 'G_COF', grupo: 'Cofrecito', esCayc: true, orden: 5,
        procedencia: 'Identificado durante la ejecución', fuenteDeLaSeleccion: FUENTE7 },
    ],
  }, e.tokens.admin);
  t.status('se anota el registro de socializados', r, 200);
  hoja.invalidarTodo();

  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  t.status('el instrumento responde', r, 200);
  t.eq('el denominador son los cinco socializados', r.body.indicador.denominador, 5);
  t.eq('digitalizados: los dos que estan en la app con su nomina', r.body.indicador.numerador, 2);
  t.eq('cofrecito no cuenta aunque este en la app', (filasDe(r, 'Grupos')
    .find((x) => x.GrupoID === 'G_COF') || {}).DIGITALIZADA, 'no');

  const res7 = Object.fromEntries(filasDe(r, 'Resultado').map((x) => [x.Concepto, x.Valor]));
  t.eq('Resultado: socializados', res7['Grupos de ahorro socializados'], 5);
  t.eq('Resultado: capacitados (fecha o marca del equipo)', res7['Grupos de ahorro capacitados'], 3);
  t.eq('Resultado: digitalizados', res7['Grupos de ahorro digitalizados'], 2);
  t.eq('Resultado: la formula escrita como en el informe',
    res7['Resultado del indicador'], '(2 / 5) × 100 = 40,0 %');
  t.eq('Resultado: cumplimiento', res7.Cumplimiento, 'Meta no alcanzada');

  const niv7 = filasDe(r, 'Niveles');
  t.eq('cuatro niveles', niv7.length, 4);
  t.eq('nivel 1', `${niv7[0].GRUPOS} | ${niv7[0].INDICADOR}`, '2 | 40,0 %');
  t.eq('nivel 2: Banquio cuenta con Líder y Tesorera', `${niv7[1].GRUPOS} | ${niv7[1].INDICADOR}`, '2 | 40,0 %');
  t.eq('nivel 3: solo Juntos Crecemos tiene movimiento propio',
    `${niv7[2].GRUPOS} | ${niv7[2].INDICADOR}`, '1 | 20,0 %');
  t.eq('nivel 4: sin registro de entradas es un intervalo, no un cero',
    `${niv7[3].GRUPOS} | ${niv7[3].INDICADOR}`, '0 a 1 | 0,0 % a 20,0 %');

  const soc7 = filasDe(r, 'Registro de socializados');
  t.eq('el registro sale en el orden que certifica la direccion',
    soc7.map((x) => x['GRUPO DE AHORRO']).join(' | '),
    'Banquio de ahorros | Juntos Crecemos | Banquito Familiar | Santa Rosa 1 | Cofrecito');
  t.eq('con su columna de digitalizado', soc7.map((x) => x.DIGITALIZADO).join(''), 'SíSíNoNoNo');
  t.eq('y su procedencia', soc7[1].PROCEDENCIA, 'Listado inicial del Plan Integral');

  const plan7 = filasDe(r, 'Listado inicial del Plan');
  t.eq('el listado del Plan va por su propio orden',
    plan7.map((x) => `${x['N.º']}:${x['GRUPO DEL LISTADO']}:${x.PARROQUIA}`).join(' | '),
    '1:Santa Rosa 1:Santa Rosa | 11:Juntos Crecemos:Chipipe');
  t.eq('el que no esta en la app lleva N/A', plan7[0]['OBSERVACIÓN'], 'N/A');
  t.check('el incorporado dice con cuantas socias',
    /^Incorporado a la plataforma con \d+ socias$/.test(plan7[1]['OBSERVACIÓN']), plan7[1]['OBSERVACIÓN']);

  const dig7 = filasDe(r, 'Grupos digitalizados');
  t.eq('grupos digitalizados: dos filas y el total', dig7.length, 3);
  t.eq('con su forma de incorporacion', dig7[1]['FORMA DE INCORPORACIÓN'], 'Invitación de la presidencia');
  t.eq('y el total suma sus socios', dig7[2].SOCIOS, Number(dig7[0].SOCIOS) + Number(dig7[1].SOCIOS));

  const ops7 = filasDe(r, 'Registro de operaciones');
  t.eq('operaciones: el aporte real de Juntos Crecemos',
    (ops7.find((x) => x['GRUPO DE AHORRO'] === 'Juntos Crecemos') || {}).AHORROS, 1);
  t.eq('y el total no mete el de cofrecito, que no esta digitalizado',
    (ops7.find((x) => x['GRUPO DE AHORRO'] === 'TOTAL') || {}).TOTAL, 1);
  t.check('aunque el aporte de cofrecito si queda en las evidencias',
    filasDe(r, 'Evidencias de operaciones').some((x) => x.Importe === 300), '');

  const mat7 = filasDe(r, 'Matriz de seguimiento');
  const matJ = mat7.find((x) => x['GRUPO DE AHORRO'] === 'Juntos Crecemos') || {};
  const matB = mat7.find((x) => x['GRUPO DE AHORRO'] === 'Banquio de ahorros') || {};
  t.eq('matriz: Juntos Crecemos con movimiento y uso sin medir',
    `${matJ.MOVIMIENTO}/${matJ['EN USO']}`, 'Sí/Sin medir');
  t.eq('matriz: Banquio sin movimiento y sin uso', `${matB.MOVIMIENTO}/${matB['EN USO']}`, 'No/No');

  const cob7 = filasDe(r, 'Cobertura');
  t.eq('cobertura: siete preguntas', cob7.length, 7);
  t.eq('cobertura: grupos con aportes propios',
    (cob7.find((x) => /aportes propios/.test(x.PREGUNTA)) || {}).RESPUESTA, 1);

  const con7 = filasDe(r, 'Control de consistencia');
  const control = (rx) => con7.find((x) => rx.test(x['COMPROBACIÓN'])) || {};
  t.eq('la persona en dos grupos se detecta', control(/dos grupos/).RESULTADO, 'No conforme');
  t.check('y se nombra', /Socia Doble/.test(String(control(/dos grupos/)['OBSERVACIÓN'])),
    String(control(/dos grupos/)['OBSERVACIÓN']));
  t.eq('y por eso la suma de socios no coincide con las personas',
    control(/suma de socios/).RESULTADO, 'No conforme');

  const dat7 = Object.fromEntries(filasDe(r, 'Datos generales').map((x) => [x.Campo, x.Valor]));
  t.eq('datos generales: la directora como firma el informe', dat7['Directora del proyecto'],
    'Ing. Sabina Villón Perero, Msc.');
  t.eq('datos generales: el periodo del indicador', dat7.Periodo, 'Segundo cuatrimestre de 2026');
  t.check('datos generales: el corte es la fecha de hoy en letras',
    /^\d{1,2} de [a-z]+ de 20\d\d$/.test(String(dat7['Corte de la información'])),
    String(dat7['Corte de la información']));
  t.eq('criterio: siete hitos', filasDe(r, 'Criterio').length, 7);

  // Se da de baja el enlace sobrante, como se hizo en la base real: la
  // persona se queda en un solo grupo y el control pasa a conforme.
  const filaDoble = fake.store.sheets.get('UserGroupLinks').grid
    .find((f) => f[0] === 'doble@ins7.test' && f[1] === 'G_JUNT');
  while (filaDoble.length < 5) filaDoble.push('');
  filaDoble[4] = 'inactivo';
  hoja.invalidarTodo();
  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  t.eq('con el enlace sobrante inactivo, ya nadie esta en dos grupos',
    (filasDe(r, 'Control de consistencia').find((x) => /dos grupos/.test(x['COMPROBACIÓN'])) || {}).RESULTADO,
    'Conforme');

  // Ahora se carga Banquito Familiar. Nadie vuelve a copiar su identificador en
  // la ficha: se reconoce por el nombre y pasa a contar.
  seedGroup({ id: 'G_BF', nombre: 'Banquito Familiar', presidente: 'bf1@ins7.test' });
  socia('bf1@ins7.test', 'G_BF', 'presidente');
  socia('bf2@ins7.test', 'G_BF', 'tesorero');
  hoja.invalidarTodo();
  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  t.eq('al cargarse Banquito Familiar, el numerador sube a 3', r.body.indicador.numerador, 3);
  t.eq('o sea el 60 %', r.body.indicador.porcentaje, 60);
  t.eq('y se cumple la meta', (filasDe(r, 'Resultado').find((x) => x.Concepto === 'Cumplimiento') || {}).Valor,
    'Meta alcanzada');
  t.eq('el denominador no cambia', r.body.indicador.denominador, 5);
  t.check('y se avisa de que se enlazo por su nombre',
    filasDe(r, 'Indicador').some((x) => /enlazados por su nombre/.test(String(x.Concepto))
      && /Banquito Familiar/.test(String(x.Valor))), '');

  // Pero si hay DOS grupos vivos con ese nombre, no se adivina cual es.
  seedGroup({ id: 'G_BF2', nombre: 'Banquito  familiar', presidente: 'bf1@ins7.test' });
  hoja.invalidarTodo();
  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  t.eq('con dos grupos del mismo nombre no se enlaza ninguno', r.body.indicador.numerador, 2);
  t.eq('y el control de consistencia lo marca',
    (filasDe(r, 'Control de consistencia').find((x) => /sin ambigüedad/.test(x['COMPROBACIÓN'])) || {}).RESULTADO,
    'No conforme');

  // Un correo repetido en la hoja de usuarios son dos registros y UNA cuenta
  // (se entra con el correo). Se cuenta una vez y se dice cuantos repiten,
  // para que cuadre con quien cuente filas sin contar a nadie dos veces.
  const cuentasAntes = r.body.indicador.cuentas;
  seedUser({ nombre: 'Registro repetido', email: 'banq3@ins7.test' });
  hoja.invalidarTodo();
  r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
  const cuentas7 = filasDe(r, 'Cobertura').find((x) => /cuentas/.test(x.PREGUNTA)) || {};
  t.eq('un correo repetido no suma una cuenta mas', r.body.indicador.cuentas, cuentasAntes);
  t.check('pero se declara el registro repetido', /1 repiten un correo/.test(String(cuentas7.DETALLE)),
    String(cuentas7.DETALLE));
};
