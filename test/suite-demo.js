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

const { seedWorkbook, post, fake } = require('./harness');
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
  t.section('DEM 8. Lo sembrado se ve en el informe del proyecto');
  // ===================================================================
  // Si el ahorro sembrado no llegara al informe, la demostracion no serviria
  // para ensenar nada: es justo la pantalla que se le ensena a la directiva.
  preparar();
  e = await baseScenario({ groupId: 'DM8' });
  hoja.invalidarTodo();
  await post('/api/admin/demo/sembrar', {}, e.tokens.admin);
  hoja.invalidarTodo();

  const { get } = require('./harness');
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
