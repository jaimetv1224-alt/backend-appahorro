/**
 * SUITE 40 - El informe que se descarga para el proyecto.
 *
 * Los datos de seguimiento (quien preside cada grupo, quien lleva la tesoreria,
 * quien ha entrado a la app y desde que aparato) ya se VEIAN en la pantalla de
 * Participantes, pero no habia forma de descargarlos: para el informe de la
 * UPSE habia que copiarlos a mano de la pantalla.
 *
 * Lo que se fija aqui: que el informe traiga a la directiva con nombre y
 * correo, que no se mezclen los grupos, que una fila historica sin columna de
 * estado SIGA contando (si no, el informe dejaria fuera todo lo anterior al
 * control interno), que no lo pueda descargar la directiva de un grupo, y que
 * cueste UNA sola lectura de la cuota de Sheets.
 */

const { seedWorkbook, get, fake } = require('./harness');
const { baseScenario, seedUser, seedGroup, seedLink } = require('./scenario');
const t = require('./runner');

const hojaDe = (r, nombre) => ((r.body && r.body.hojas) || []).find((h) => h.nombre === nombre);
const filasDe = (r, nombre) => (hojaDe(r, nombre) || {}).filas || [];

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

  const ahorro = (email, grupo, monto, fecha, estado) => fake.ensureSheet('Savings').grid.push([
    email, grupo, monto, fecha, 'mensual', 'aporte', estado === undefined ? 'confirmado' : estado,
    'a@a.test', 'b@b.test', new Date().toISOString(),
    `sav_${Math.random().toString(36).slice(2, 8)}`, '',
  ]);

  /** Una entrada a la app, tal como la escribe la hoja de Accesos. */
  const acceso = (email, fechaIso, dispositivo, sistema, navegador) => fake.ensureSheet(HOJA).grid
    .push([fechaIso, email, dispositivo, sistema, navegador, '190.0.0.1', 'UA', 'web']);

  // ===================================================================
  t.section('INF 1. La directiva sale con nombre y correo');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'IP1' });
  const G = 'IP1';
  hoja.invalidarTodo();

  let r = await get('/api/admin/informe-proyecto', e.tokens.admin);
  t.status('el administrador de la plataforma lo descarga', r, 200);
  t.eq('trae las seis hojas', ((r.body && r.body.hojas) || []).length, 6);

  const directiva = filasDe(r, 'Directiva');
  const presi = directiva.find((f) => f.Cargo === 'presidente');
  const teso = directiva.find((f) => f.Cargo === 'tesorero');
  const secre = directiva.find((f) => f.Cargo === 'secretario');
  t.check('aparece la presidencia', !!presi, JSON.stringify(directiva.map((x) => x.Cargo)));
  t.eq('con su correo', presi && presi.Correo, e.users.presi.email);
  t.eq('y con su nombre, no solo el correo', presi && presi.Nombre, e.users.presi.nombre);
  t.check('aparece la tesoreria', !!teso, '');
  t.check('aparece la secretaria', !!secre, '');

  const gruposHoja = filasDe(r, 'Grupos');
  const elGrupo = gruposHoja.find((g) => g.GrupoID === G);
  t.check('el grupo esta en la hoja de grupos', !!elGrupo, JSON.stringify(gruposHoja.map((x) => x.GrupoID)));
  t.eq('con la presidencia en su columna', elGrupo && elGrupo.Presidenta, e.users.presi.nombre);
  t.eq('y los tres cargos cubiertos', elGrupo && elGrupo['Cargos cubiertos'], 3);

  // ===================================================================
  t.section('INF 2. Una fila historica sin estado SIGUE contando');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IP2' });
  // Fila al estilo viejo: solo A..F, sin columna de estado.
  fake.ensureSheet('Savings').grid.push(
    [e.users.socio1.email, 'IP2', 200, '2025-11-10', 'mensual', 'aporte historico']);
  ahorro(e.users.socio2.email, 'IP2', 50, '2026-01-10');
  hoja.invalidarTodo();

  r = await get('/api/admin/informe-proyecto', e.tokens.admin);
  const g2 = filasDe(r, 'Grupos').find((g) => g.GrupoID === 'IP2');
  t.near('el ahorro historico se suma igual que el nuevo',
    g2 && g2['Ahorro confirmado'], 250, 0.01);
  t.eq('y cuenta como dos aportes registrados', g2 && g2['Aportes registrados'], 2);

  // ===================================================================
  t.section('INF 3. Los grupos no se mezclan');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IP3' });
  seedUser({ nombre: 'Otra Presidenta', email: 'otra@juntago.test' });
  seedGroup({ id: 'IP3B', nombre: 'Segundo grupo', presidente: 'otra@juntago.test' });
  seedLink('otra@juntago.test', 'IP3B', 'presidente');
  ahorro(e.users.socio1.email, 'IP3', 300, '2026-01-10');
  ahorro('otra@juntago.test', 'IP3B', 700, '2026-01-10');
  hoja.invalidarTodo();

  r = await get('/api/admin/informe-proyecto', e.tokens.admin);
  const a = filasDe(r, 'Grupos').find((g) => g.GrupoID === 'IP3');
  const b = filasDe(r, 'Grupos').find((g) => g.GrupoID === 'IP3B');
  t.near('cada grupo lleva lo suyo (300)', a && a['Ahorro confirmado'], 300, 0.01);
  t.near('y el otro lo suyo (700)', b && b['Ahorro confirmado'], 700, 0.01);
  t.eq('la presidenta del segundo es la suya', b && b.Presidenta, 'Otra Presidenta');

  // ===================================================================
  t.section('INF 4. Quien ha entrado a la app, y desde que aparato');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IP4' });
  // baseScenario inicia sesion con cada persona, y ENTRAR A LA APP ES UN
  // ACCESO: la hoja ya trae cinco antes de sembrar nada. Se vacia para que lo
  // que se mide sean solo las entradas de esta prueba.
  fake.seedSheet(HOJA, [CABECERA]);
  acceso(e.users.presi.email, '2026-03-01T10:00:00.000Z', 'movil', 'Android', 'Chrome');
  acceso(e.users.presi.email, '2026-03-05T10:00:00.000Z', 'movil', 'Android', 'Chrome');
  acceso(e.users.socio1.email, '2026-03-02T10:00:00.000Z', 'escritorio', 'Windows', 'Edge');
  hoja.invalidarTodo();

  r = await get('/api/admin/informe-proyecto', e.tokens.admin);
  const personas = filasDe(r, 'Personas');
  const laPresi = personas.find((p) => p.Correo === e.users.presi.email);
  t.eq('la presidencia ha entrado dos veces', laPresi && laPresi['Veces que ha entrado'], 2);
  t.eq('desde el movil', laPresi && laPresi['Aparato mas usado'], 'movil');
  t.eq('con su primera entrada', laPresi && laPresi['Primera entrada'], '2026-03-01');
  t.eq('y su ultima', laPresi && laPresi['Ultima entrada'], '2026-03-05');

  const nunca = personas.find((p) => p.Correo === e.users.socio2.email);
  t.eq('quien nunca entro sale marcado', nunca && nunca['Ha entrado a la app'], 'no');

  const uso = filasDe(r, 'Uso de la plataforma');
  const movil = uso.find((u) => u.Categoria === 'dispositivo' && u.Valor === 'movil');
  t.eq('el reparto por aparato cuenta las entradas', movil && movil.Entradas, 2);
  t.near('con su porcentaje', movil && movil['Porcentaje de las entradas'], 66.7, 0.2);

  const meses = filasDe(r, 'Actividad por mes');
  const marzo = meses.find((m) => m.Mes === '2026-03');
  t.eq('y marzo aparece con sus tres entradas', marzo && marzo.Entradas, 3);

  // ===================================================================
  t.section('INF 5. El informe es SOLO del administrador de la plataforma');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IP5' });
  hoja.invalidarTodo();

  for (const [quien, token] of [
    ['la presidencia de un grupo', e.tokens.presi],
    ['la tesoreria', e.tokens.teso],
    ['una socia', e.tokens.socio1],
  ]) {
    const neg = await get('/api/admin/informe-proyecto', token);
    t.status(`${quien} no lo descarga`, neg, 403);
  }
  const sinSesion = await get('/api/admin/informe-proyecto', null);
  t.status('y sin sesion tampoco', sinSesion, 401);

  // ===================================================================
  t.section('INF 6. Cuesta UNA lectura de la cuota, no dieciseis');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IP6' });
  // Todas las pestanas sembradas: es el caso del libro completo.
  ['Savings', 'Acciones', 'Loans', 'LoanPayments', 'SolicitudesPrestamos',
    'AprobacionesAsamblea'].forEach((n) => fake.ensureSheet(n));
  hoja.invalidarTodo();

  const antes = hoja.estadisticas().lecturas;
  r = await get('/api/admin/informe-proyecto', e.tokens.admin);
  const gastadas = hoja.estadisticas().lecturas - antes;
  t.status('el informe responde', r, 200);
  t.check('con el libro completo gasta 2 unidades de cuota o menos',
    gastadas <= 2, `gasto ${gastadas}`);

  // Y con una pestana que no existe, el respaldo tampoco se dispara.
  fake.store.sheets.delete('CierresUtilidades');
  hoja.invalidarTodo();
  const antes2 = hoja.estadisticas().lecturas;
  const r2 = await get('/api/admin/informe-proyecto', e.tokens.admin);
  const gastadas2 = hoja.estadisticas().lecturas - antes2;
  t.status('sigue respondiendo con una pestana borrada', r2, 200);
  t.check('y ahi gasta 6 o menos', gastadas2 <= 6, `gasto ${gastadas2}`);

  // ===================================================================
  t.section('INF 7. La pantalla de grupos tambien gasta una sola lectura');
  // ===================================================================
  // Es la que mas se abre, y era la que mas gastaba: cuatro lecturas sueltas
  // por visita. Google corta a 60 por minuto, asi que con varias personas
  // mirando a la vez la unica salida era esperar.
  preparar();
  e = await baseScenario({ groupId: 'IP7' });
  hoja.invalidarTodo();

  const antesP = hoja.estadisticas().lecturas;
  const part = await get('/api/admin/participantes', e.tokens.admin);
  const gastoP = hoja.estadisticas().lecturas - antesP;
  t.status('la pantalla de participantes responde', part, 200);
  t.check('y gasta 2 unidades de cuota o menos (antes cuatro)',
    gastoP <= 2, `gasto ${gastoP}`);
  t.check('trayendo los grupos', ((part.body && part.body.grupos) || []).length > 0,
    JSON.stringify((part.body && part.body.totales) || {}));

  // Con una pestana borrada sigue abriendo por el respaldo.
  fake.store.sheets.delete('UserGroupLinks');
  hoja.invalidarTodo();
  const rota = await get('/api/admin/participantes', e.tokens.admin);
  t.status('y con una pestana borrada no revienta', rota, 200);
};