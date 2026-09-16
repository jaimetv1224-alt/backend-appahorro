/**
 * SUITE 45 - Datos de demostracion.
 *
 * Los diez grupos de Salinas estan cargados con sus 152 socias, pero sin un
 * solo aporte la plataforma se ve muerta y no hay como ensenarle a una
 * directiva como funciona su caja. `/api/admin/demo/sembrar` la llena.
 *
 * Lo que se fija aqui es lo que hace que eso NO sea peligroso:
 *   - todo lo sembrado va marcado y se distingue de un aporte de verdad;
 *   - un grupo con dinero real NO se toca, ni por accidente;
 *   - sembrar dos veces no duplica nada;
 *   - `limpiar` borra lo sembrado y SOLO lo sembrado;
 *   - la directiva solo se rellena si esta vacia;
 *   - y esto es del administrador de la plataforma, de nadie mas.
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario, seedUser, seedGroup, seedLink } = require('./scenario');
const t = require('./runner');

const filasDe = (nombre) => (fake.store.sheets.get(nombre) || { grid: [] }).grid;
const cuerpo = (nombre, desde = 1) => filasDe(nombre).slice(desde);
const esDemo = (v) => (v || '').toString().startsWith('demo_');

module.exports = async function run() {
  const hoja = require('../hoja');

  const preparar = () => {
    seedWorkbook();
    ['Savings', 'Acciones', 'Loans'].forEach((n) => fake.ensureSheet(n));
    hoja.invalidarTodo();
  };

  // ===================================================================
  t.section('DEM 1. Un grupo vacio se llena y se ve andando');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'DM1' });
  hoja.invalidarTodo();

  let r = await post('/api/admin/demo/sembrar', { valorAccion: 15 }, e.tokens.admin);
  t.status('el administrador lo siembra', r, 200);
  const s1 = r.body || {};
  t.check('hay aportes', (s1.totales || {}).aportes > 0, JSON.stringify(s1.totales));
  t.check('hay compras de acciones', (s1.totales || {}).compras > 0, JSON.stringify(s1.totales));
  t.check('y hay prestamos vivos', (s1.totales || {}).prestamos > 0, JSON.stringify(s1.totales));

  const grupoDM1 = filasDe('Groups').find((f) => f[0] === 'DM1');
  t.eq('la accion del grupo vale 15', Number(grupoDM1[15]), 15);
  t.check('el grupo tiene fecha de arranque', /^\d{4}-\d{2}-\d{2}$/.test(grupoDM1[9] || ''),
    `quedo: ${grupoDM1[9]}`);

  const aportes = cuerpo('Savings').filter((f) => f[1] === 'DM1');
  t.check('los aportes son de las socias del grupo', aportes.length > 0, '');
  t.check('todos van marcados como demostracion',
    aportes.every((f) => esDemo(f[10])), JSON.stringify(aportes.slice(0, 2)));
  t.check('y se ve en la descripcion, no solo en el identificador',
    aportes.every((f) => (f[5] || '').includes('[demo]')), `${aportes[0] && aportes[0][5]}`);
  t.check('con fechas repartidas en varios meses',
    new Set(aportes.map((f) => (f[3] || '').slice(0, 7))).size >= 2,
    JSON.stringify([...new Set(aportes.map((f) => (f[3] || '').slice(0, 7)))]));
  t.check('y todos confirmados, para que sumen',
    aportes.every((f) => f[6] === 'confirmado'), '');

  const compras = cuerpo('Acciones').filter((f) => f[1] === 'DM1');
  t.check('las acciones se compran al valor del grupo',
    compras.every((f) => Number(f[4]) === 15), JSON.stringify(compras.slice(0, 2)));

  const creditos = cuerpo('Loans').filter((f) => f[2] === 'DM1');
  t.check('los prestamos quedan aprobados',
    creditos.every((f) => f[7] === 'aprobado'), JSON.stringify(creditos.slice(0, 2)));
  t.check('con su total con intereses por encima del capital',
    creditos.every((f) => Number(f[9]) > Number(f[3])), JSON.stringify(creditos[0]));
  t.check('y solo a socias que ya venian ahorrando',
    creditos.every((c) => aportes.some((a) => a[0] === c[1])), '');

  // ===================================================================
  t.section('DEM 2. Grupos distintos arrancan en meses distintos');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'DM2' });
  seedUser({ nombre: 'Socia Otra', email: 'otra@demo.test' });
  seedGroup({ id: 'DM2B', nombre: 'Segundo grupo', presidente: 'otra@demo.test' });
  seedLink('otra@demo.test', 'DM2B', 'presidente');
  seedUser({ nombre: 'Socia Tres', email: 'tres@demo.test' });
  seedLink('tres@demo.test', 'DM2B', 'member');
  hoja.invalidarTodo();

  r = await post('/api/admin/demo/sembrar', {}, e.tokens.admin);
  const arranques = (r.body.grupos || []).map((g) => g.desdeElMes);
  t.check('se sembraron varios grupos', (r.body.grupos || []).length >= 2,
    JSON.stringify(r.body.grupos));
  t.check('y no todos empiezan el mismo mes',
    new Set(arranques).size >= 2 || arranques.length < 2, JSON.stringify(arranques));

  // ===================================================================
  t.section('DEM 3. Un grupo con dinero DE VERDAD no se toca');
  // ===================================================================
  // Es el freno que lo hace seguro: sembrar encima del ahorro real de un banco
  // comunal seria imperdonable, y basta un solo aporte de verdad para frenarlo.
  preparar();
  e = await baseScenario({ groupId: 'DM3' });
  fake.ensureSheet('Savings').grid.push([
    e.users.socio1.email, 'DM3', 40, '2026-02-10', 'mensual', 'aporte de verdad',
    'confirmado', 'a@a.test', 'b@b.test', new Date().toISOString(), 'sav_real_1', '',
  ]);
  hoja.invalidarTodo();

  r = await post('/api/admin/demo/sembrar', {}, e.tokens.admin);
  t.status('responde', r, 200);
  const saltado = (r.body.saltados || []).find((x) => (x.motivo || '').includes('de verdad'));
  t.check('el grupo con dinero real se salta', !!saltado, JSON.stringify(r.body.saltados));
  t.eq('y no se le anade ni un aporte',
    cuerpo('Savings').filter((f) => f[1] === 'DM3').length, 1);

  // ===================================================================
  t.section('DEM 4. Sembrar dos veces no duplica nada');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'DM4' });
  hoja.invalidarTodo();
  await post('/api/admin/demo/sembrar', {}, e.tokens.admin);
  const tras1 = cuerpo('Savings').filter((f) => f[1] === 'DM4').length;
  hoja.invalidarTodo();
  r = await post('/api/admin/demo/sembrar', {}, e.tokens.admin);
  const tras2 = cuerpo('Savings').filter((f) => f[1] === 'DM4').length;
  t.eq('la hoja no crece en la segunda pasada', tras2, tras1);
  t.check('y se dice por que se salto',
    (r.body.saltados || []).some((x) => (x.motivo || '').includes('ya tiene la demostracion')),
    JSON.stringify(r.body.saltados));

  // ===================================================================
  t.section('DEM 5. Limpiar borra lo sembrado y SOLO lo sembrado');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'DM5' });
  seedUser({ nombre: 'Socia Real', email: 'real@demo.test' });
  seedGroup({ id: 'DM5R', nombre: 'Grupo con dinero real', presidente: 'real@demo.test' });
  seedLink('real@demo.test', 'DM5R', 'presidente');
  fake.ensureSheet('Savings').grid.push([
    'real@demo.test', 'DM5R', 99, '2026-02-10', 'mensual', 'aporte de verdad',
    'confirmado', 'a@a.test', 'b@b.test', new Date().toISOString(), 'sav_real_9', '',
  ]);
  hoja.invalidarTodo();
  await post('/api/admin/demo/sembrar', {}, e.tokens.admin);
  const sembrados = cuerpo('Savings').filter((f) => esDemo(f[10])).length;
  t.check('primero se sembro algo', sembrados > 0, `${sembrados}`);

  hoja.invalidarTodo();
  r = await post('/api/admin/demo/limpiar', {}, e.tokens.admin);
  t.status('limpiar responde', r, 200);
  t.eq('no queda ni un aporte de demostracion',
    cuerpo('Savings').filter((f) => esDemo(f[10])).length, 0);
  t.eq('ni una compra de acciones',
    cuerpo('Acciones').filter((f) => esDemo(f[11])).length, 0);
  t.eq('ni un prestamo', cuerpo('Loans').filter((f) => esDemo(f[0])).length, 0);

  const real = cuerpo('Savings').filter((f) => f[10] === 'sav_real_9');
  t.eq('y el aporte DE VERDAD sigue ahi', real.length, 1);
  t.eq('con su importe intacto', Number(real[0] && real[0][2]), 99);

  // ===================================================================
  t.section('DEM 6. La directiva solo se rellena si estaba vacia');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'DM6' });
  const presiAntes = filasDe('UserGroupLinks').find((f) => f[1] === 'DM6' && f[3] === 'presidente')[0];
  // Un grupo hermano sin ningun cargo.
  seedUser({ nombre: 'Huerfana Uno', email: 'h1@demo.test' });
  seedUser({ nombre: 'Huerfana Dos', email: 'h2@demo.test' });
  seedUser({ nombre: 'Huerfana Tres', email: 'h3@demo.test' });
  seedGroup({ id: 'DM6H', nombre: 'Sin cargos', presidente: '' });
  ['h1@demo.test', 'h2@demo.test', 'h3@demo.test'].forEach((c) => seedLink(c, 'DM6H', 'member'));
  hoja.invalidarTodo();

  await post('/api/admin/demo/sembrar', {}, e.tokens.admin);
  t.eq('a quien ya presidia no se le mueve',
    filasDe('UserGroupLinks').find((f) => f[1] === 'DM6' && f[3] === 'presidente')[0], presiAntes);
  t.eq('sigue habiendo una sola presidencia en ese grupo',
    filasDe('UserGroupLinks').filter((f) => f[1] === 'DM6' && f[3] === 'presidente').length, 1);
  const cargosH = filasDe('UserGroupLinks')
    .filter((f) => f[1] === 'DM6H' && f[3] !== 'member').map((f) => f[3]).sort();
  t.eq('y el grupo que no tenia directiva ya la tiene',
    JSON.stringify(cargosH), JSON.stringify(['presidente', 'secretario', 'tesorero']));

  // ===================================================================
  t.section('DEM 7. Esto es solo del administrador de la plataforma');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'DM7' });
  hoja.invalidarTodo();
  for (const [quien, tk] of [
    ['la presidencia de un grupo', e.tokens.presi],
    ['la tesoreria', e.tokens.teso],
    ['una socia', e.tokens.socio1],
  ]) {
    const neg = await post('/api/admin/demo/sembrar', {}, tk);
    t.status(`${quien} no puede sembrar`, neg, 403);
    const neg2 = await post('/api/admin/demo/limpiar', {}, tk);
    t.status(`${quien} tampoco puede limpiar`, neg2, 403);
  }
  const sinSesion = await post('/api/admin/demo/sembrar', {}, null);
  t.status('y sin sesion tampoco', sinSesion, 401);
  t.eq('no se sembro nada', cuerpo('Savings').filter((f) => esDemo(f[10])).length, 0);

  // ===================================================================
  t.section('DEM 9. Configurar no es sembrar: el reglamento si se pone');
  // ===================================================================
  // Un grupo sin valor de accion ni interes no puede operar aunque tenga
  // socias, y saltarlo entero por tener un aporte de verdad lo dejaba
  // inservible. El reglamento se pone igual; el dinero no.
  preparar();
  e = await baseScenario({ groupId: 'DM9' });
  // Grupo con un aporte REAL, sin reglamento y sin directiva.
  seedUser({ nombre: 'Real Uno', email: 'r1@demo.test' });
  seedUser({ nombre: 'Real Dos', email: 'r2@demo.test' });
  seedUser({ nombre: 'Real Tres', email: 'r3@demo.test' });
  seedGroup({ id: 'DM9R', nombre: 'Opera de verdad', presidente: '', valorAccion: 0, interesMensual: 0 });
  ['r1@demo.test', 'r2@demo.test', 'r3@demo.test'].forEach((c) => seedLink(c, 'DM9R', 'member'));
  fake.ensureSheet('Savings').grid.push([
    'r1@demo.test', 'DM9R', 77, '2026-02-10', 'mensual', 'aporte de verdad',
    'confirmado', 'a@a.test', 'b@b.test', new Date().toISOString(), 'sav_real_77', '',
  ]);
  hoja.invalidarTodo();

  r = await post('/api/admin/demo/sembrar', { valorAccion: 15 }, e.tokens.admin);
  const filaDM9R = filasDe('Groups').find((f) => f[0] === 'DM9R');
  t.eq('al grupo que ya opera se le pone el valor de la accion', Number(filaDM9R[15]), 15);
  t.check('y el interes, que estaba en cero', Number(filaDM9R[16]) > 0, `${filaDM9R[16]}`);
  t.eq('tambien se le completa la directiva',
    filasDe('UserGroupLinks').filter((f) => f[1] === 'DM9R' && f[3] !== 'member').length, 3);
  t.eq('pero NO se le siembra ni un aporte',
    cuerpo('Savings').filter((f) => f[1] === 'DM9R').length, 1);
  t.check('y se dice que se le puso el reglamento',
    (r.body.saltados || []).some((x) => (x.reglamento || []).length > 0),
    JSON.stringify(r.body.saltados));

  // ===================================================================
  t.section('DEM 10. Donde ya se compraron acciones, el valor NO se cambia');
  // ===================================================================
  // Es el limite fino: cambiarle el valor de la accion a un grupo que ya tiene
  // acciones compradas le reescribe el patrimonio a gente real.
  preparar();
  e = await baseScenario({ groupId: 'DMA' });
  seedUser({ nombre: 'Accionista', email: 'acc@demo.test' });
  seedGroup({ id: 'DMAC', nombre: 'Con acciones', presidente: 'acc@demo.test', valorAccion: 8 });
  seedLink('acc@demo.test', 'DMAC', 'presidente');
  fake.ensureSheet('Acciones').grid.push([
    'acc@demo.test', 'DMAC', '2026-03-10', 10, 8, 2, new Date().toISOString(),
    'confirmado', 'a@a.test', 'b@b.test', new Date().toISOString(), 'acc_real_1', 'compra real',
  ]);
  hoja.invalidarTodo();

  await post('/api/admin/demo/sembrar', { valorAccion: 15 }, e.tokens.admin);
  const filaDMAC = filasDe('Groups').find((f) => f[0] === 'DMAC');
  t.eq('la accion sigue valiendo lo que valia', Number(filaDMAC[15]), 8);
  t.eq('y la compra real sigue intacta',
    cuerpo('Acciones').filter((f) => f[1] === 'DMAC' && f[11] === 'acc_real_1').length, 1);

  // ===================================================================
  t.section('DEM 11. El prestamo nace de su solicitud, y el panel lo ve');
  // ===================================================================
  // El tablero cuenta los prestamos leyendo SolicitudesPrestamos, no Loans.
  // Sembrar solo el prestamo lo dejaba marcando $0 con creditos vivos, que es
  // justo la cifra que se le ensena a la directiva.
  preparar();
  e = await baseScenario({ groupId: 'DMB' });
  hoja.invalidarTodo();
  await post('/api/admin/demo/sembrar', {}, e.tokens.admin);

  const creditosB = cuerpo('Loans').filter((f) => f[2] === 'DMB');
  const solicitudesB = cuerpo('SolicitudesPrestamos').filter((f) => f[2] === 'DMB');
  t.check('hay prestamos', creditosB.length > 0, '');
  t.eq('cada prestamo tiene su solicitud', solicitudesB.length, creditosB.length);
  t.check('con el MISMO identificador, que es como se enlazan',
    creditosB.every((c) => solicitudesB.some((x) => x[0] === c[0])),
    JSON.stringify({ prestamos: creditosB.map((c) => c[0]), solicitudes: solicitudesB.map((x) => x[0]) }));
  t.check('y todas aprobadas', solicitudesB.every((x) => x[5] === 'aprobado'), '');
  t.check('por el mismo importe',
    creditosB.every((c) => solicitudesB.some((x) => x[0] === c[0] && Number(x[4]) === Number(c[3]))), '');

  hoja.invalidarTodo();
  const panel = await get('/api/admin/resumen', e.tokens.admin);
  t.status('el panel responde', panel, 200);
  const resu = (panel.body || {}).resumen || {};
  t.check('y el panel ya ve dinero prestado',
    Number(resu.prestamosAprobados || 0) > 0, JSON.stringify(resu.prestamosAprobados));
  // El panel es de TODA la plataforma, no de un grupo: se compara contra la hoja entera.
  const todosLosCreditos = cuerpo('Loans').length;
  t.eq('y cuenta exactamente los creditos que hay en la hoja',
    Number(resu.countPrestamosAprobados || 0), todosLosCreditos);

  // ===================================================================
  t.section('DEM 12. Limpiar no hace mil llamadas: borra por tramos');
  // ===================================================================
  // Con mil filas sembradas, borrar de una en una era una llamada a Google por
  // fila y la limpieza no terminaba nunca. Tienen que ser unos pocos tramos.
  preparar();
  e = await baseScenario({ groupId: 'DMC' });
  hoja.invalidarTodo();
  await post('/api/admin/demo/sembrar', {}, e.tokens.admin);
  const cuantasFilas = cuerpo('Savings').filter((f) => esDemo(f[10])).length;
  t.check('se sembraron bastantes filas', cuantasFilas > 20, `${cuantasFilas}`);

  hoja.invalidarTodo();
  const antesLlamadas = fake.store.calls.batchUpdate;
  r = await post('/api/admin/demo/limpiar', {}, e.tokens.admin);
  const llamadas = fake.store.calls.batchUpdate - antesLlamadas;
  t.status('limpiar responde', r, 200);
  // Lo que se fija es la FORMA del coste: una llamada por hoja (son 11), no
  // una por fila. Con mil filas la diferencia es entre tres segundos y nunca.
  t.check('con una llamada por hoja, no una por fila',
    llamadas <= 12, `hizo ${llamadas} llamadas para ${cuantasFilas} filas de aportes`);
  t.check('y muchas menos llamadas que filas borradas',
    llamadas < cuantasFilas, `${llamadas} llamadas vs ${cuantasFilas} filas`);
  t.eq('y no queda nada sembrado', cuerpo('Savings').filter((f) => esDemo(f[10])).length, 0);
  t.eq('ni una solicitud suelta',
    cuerpo('SolicitudesPrestamos').filter((f) => esDemo(f[0])).length, 0);

  // ===================================================================
  t.section('DEM 13. Las entradas a la app: el embudo deja de estar vacio');
  // ===================================================================
  // Sin accesos sembrados el informe decia "0 de 19 grupos han entrado" y el
  // embudo de adopcion, que es el indicador central del proyecto, salia en
  // blanco. Tampoco se podia medir cuanto tardan en entrar la primera vez.
  preparar();
  e = await baseScenario({ groupId: 'DMD' });
  const acc = require('../accesos');
  fake.seedSheet(acc.HOJA, [acc.CABECERA]);
  hoja.invalidarTodo();
  await post('/api/admin/demo/sembrar', {}, e.tokens.admin);

  const entradas = cuerpo(acc.HOJA).filter((f) => (f[7] || '') === 'demo');
  t.check('se sembraron entradas a la app', entradas.length > 0, `${entradas.length}`);
  t.check('de varias personas distintas',
    new Set(entradas.map((f) => f[1])).size > 1,
    `${new Set(entradas.map((f) => f[1])).size} personas`);
  t.check('pero NO de todas: quien nunca entro tambien es un dato',
    new Set(entradas.map((f) => f[1])).size
      < filasDe('UserGroupLinks').filter((f) => f[1] === 'DMD').length + 5, '');
  t.check('desde varios aparatos',
    new Set(entradas.map((f) => f[2])).size >= 1, JSON.stringify([...new Set(entradas.map((f) => f[2]))]));
  t.check('con fechas repartidas, no todas el mismo dia',
    new Set(entradas.map((f) => (f[0] || '').slice(0, 10))).size > 3,
    `${new Set(entradas.map((f) => (f[0] || '').slice(0, 10))).size} dias distintos`);
  t.check('y ninguna en el futuro',
    entradas.every((f) => new Date(f[0]) <= new Date()), '');

  // ===================================================================
  t.section('DEM 14. La app no puede salir mas lenta que el cuaderno');
  // ===================================================================
  // Fallo real: los aportes se sembraban con la hora de confirmacion en AHORA,
  // asi que un aporte de marzo salia confirmado noventa dias despues y el
  // informe del proyecto concluia "mas lento que en papel". Es justo la cifra
  // que se le ensena al INCYT.
  const aportesD = cuerpo('Savings').filter((f) => esDemo(f[10]));
  t.check('hay aportes sembrados', aportesD.length > 0, '');
  const demoras = aportesD.map((f) => {
    const puesto = new Date(`${f[3]}T00:00:00Z`).getTime();
    const confirmado = new Date(f[9]).getTime();
    return (confirmado - puesto) / 86400000;
  });
  const peor = Math.max(...demoras);
  t.check('ninguno tarda mas de cuatro dias en confirmarse',
    peor <= 4, `el peor tardo ${peor.toFixed(1)} dias`);
  t.check('y ninguno se confirma ANTES de hacerse',
    Math.min(...demoras) >= 0, `el minimo fue ${Math.min(...demoras).toFixed(1)}`);

  // ===================================================================
  t.section('DEM 15. Prestamos resueltos, pagados y con acta');
  // ===================================================================
  const creditosD = cuerpo('Loans').filter((f) => esDemo(f[0]));
  const aprobaciones = cuerpo('AprobacionesAsamblea').filter((f) => esDemo(f[0]));
  t.check('cada prestamo tiene al menos dos votos de la directiva',
    creditosD.every((c) => aprobaciones.filter((v) => v[0] === c[0]).length >= 2),
    JSON.stringify(creditosD.map((c) => [c[0], aprobaciones.filter((v) => v[0] === c[0]).length])));
  t.check('y el voto lleva la hora, que es de donde sale el tiempo de respuesta',
    aprobaciones.every((v) => /^\d{4}-\d{2}-\d{2}T/.test(v[6] || '')),
    JSON.stringify(aprobaciones[0]));

  const pagos = cuerpo('LoanPayments').filter((f) => esDemo(f[0]));
  t.check('hay cuotas pagadas', pagos.length > 0, `${pagos.length}`);
  t.check('todas aprobadas', pagos.every((f) => f[6] === 'approved'), '');
  t.check('y de prestamos que existen',
    pagos.every((f) => creditosD.some((c) => c[0] === f[2])), '');

  const asambleas = cuerpo('Asambleas').filter((f) => esDemo(f[0]));
  const asistencia = cuerpo('AsambleaAsistencia').filter((f) => esDemo(f[0]));
  const acuerdos = cuerpo('Acuerdos').filter((f) => esDemo(f[0]));
  const votos = cuerpo('AcuerdoVotos').filter((f) => esDemo(f[0]));
  t.check('hay asambleas cerradas', asambleas.length > 0 && asambleas.every((f) => f[5] === 'cerrada'),
    JSON.stringify(asambleas.map((f) => f[5])));
  t.check('con su lista de asistencia', asistencia.length > 0, `${asistencia.length}`);
  t.check('y con acuerdos aprobados y votados',
    acuerdos.length > 0 && acuerdos.every((f) => f[7] === 'aprobado') && votos.length > 0,
    JSON.stringify({ acuerdos: acuerdos.length, votos: votos.length }));

  // ===================================================================
  t.section('DEM 16. Limpiar se lleva tambien las entradas y las actas');
  // ===================================================================
  hoja.invalidarTodo();
  r = await post('/api/admin/demo/limpiar', {}, e.tokens.admin);
  t.status('limpiar responde', r, 200);
  for (const [etiqueta, nombre, col] of [
    ['entradas a la app', acc.HOJA, 7],
    ['pagos de cuota', 'LoanPayments', 0],
    ['votos de prestamo', 'AprobacionesAsamblea', 0],
    ['asambleas', 'Asambleas', 0],
    ['asistencias', 'AsambleaAsistencia', 0],
    ['acuerdos', 'Acuerdos', 0],
    ['votos de acuerdo', 'AcuerdoVotos', 0],
  ]) {
    const quedan = cuerpo(nombre).filter((f) => (nombre === acc.HOJA
      ? (f[col] || '') === 'demo' : esDemo(f[col]))).length;
    t.eq(`no quedan ${etiqueta}`, quedan, 0);
  }

  // ===================================================================
  t.section('DEM 8. Lo sembrado se ve en el informe del proyecto');
  // ===================================================================
  // Si el ahorro sembrado no llegara al informe, la demostracion no serviria
  // para ensenar nada: es justo la pantalla que se le ensena a la directiva.
  preparar();
  e = await baseScenario({ groupId: 'DM8' });
  hoja.invalidarTodo();
  await post('/api/admin/demo/sembrar', {}, e.tokens.admin);
  hoja.invalidarTodo();

  const inf = await get('/api/admin/informe-proyecto', e.tokens.admin);
  t.status('el informe responde', inf, 200);
  const filaGrupo = (((inf.body || {}).hojas || [])
    .find((h) => h.nombre === 'Grupos') || { filas: [] })
    .filas.find((x) => x.GrupoID === 'DM8');
  t.check('el grupo aparece con ahorro confirmado',
    !!filaGrupo && Number(filaGrupo['Ahorro confirmado']) > 0,
    JSON.stringify(filaGrupo && filaGrupo['Ahorro confirmado']));
  t.check('y con sus aportes contados',
    !!filaGrupo && Number(filaGrupo['Aportes registrados']) > 0,
    JSON.stringify(filaGrupo && filaGrupo['Aportes registrados']));
};
