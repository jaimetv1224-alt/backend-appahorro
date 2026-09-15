/**
 * SUITE 39 - Barrido de permisos sobre todo lo nuevo.
 *
 * Cada endpoint nuevo se probó con quien SÍ puede usarlo. Esta batería hace lo
 * contrario: los recorre todos con las cuatro identidades que existen en la app
 * y comprueba que nadie llegue a donde no le toca.
 *
 *   sin sesión        no entra a ninguna parte
 *   socia rasa        ve lo que es de todas; no mueve dinero de nadie
 *   ajena al grupo    no ve ni toca nada, ni siquiera para mirar
 *   admin de la app   NO gobierna el grupo. Es la regla del proyecto: él evalúa
 *                     cómo se usa la plataforma, no aprueba ni niega nada; eso
 *                     lo hace la directiva con su propio grupo.
 *
 * Es la prueba que cuesta escribir cuando se añaden veinte endpoints de golpe y
 * la que sale cara si falta: un solo `requireLider` olvidado deja a cualquiera
 * condonando deudas.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();

function haceMeses(n) {
  const d = new Date();
  const total = (d.getFullYear() * 12) + d.getMonth() - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

const ahorro = (email, grupo, monto, fecha) => fake.ensureSheet('Savings').grid.push([
  email, grupo, monto, fecha, 'mensual', 'aporte', 'confirmado',
  'a@a.test', 'b@b.test', new Date().toISOString(),
  `sav_${Math.random().toString(36).slice(2, 9)}`, '',
]);

function prestamo(id, email, grupo, principal, total, inicio) {
  fake.ensureSheet('Loans').grid.push([
    id, email, grupo, principal, inicio, '', 2, 'aprobado', 6, total,
  ]);
}

module.exports = async function run() {
  const G_SHEETS = require('../governance').SHEETS;
  const { HOJA, CABECERA } = require('../accesos');
  const hoja = require('../hoja');

  seedWorkbook();
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  fake.seedSheet(HOJA, [CABECERA]);
  hoja.invalidarTodo();

  const G = 'GBLI';
  const e = await baseScenario({ groupId: G });
  ahorro(e.users.socio1.email, G, 300, haceMeses(3));
  ahorro(e.users.socio2.email, G, 300, haceMeses(3));
  prestamo('LBL', e.users.socio1.email, G, 200, 224, haceMeses(3));
  hoja.invalidarTodo();

  // La asamblea, para que los endpoints que la piden lleguen al control de
  // permisos y no se caigan antes por falta de datos.
  const asa = await post('/api/gob/asambleas',
    { groupId: G, titulo: 'Ordinaria', fechaProgramada: hoy(), modalidad: 'presencial' },
    e.tokens.presi);
  const asambleaId = asa.body?.asambleaId;
  hoja.invalidarTodo();

  /**
   * Cada fila: qué se pide, y qué debe contestar a cada identidad.
   * 'ok' = tiene que dejarle (2xx). 'no' = tiene que cortarle (401/403/404).
   * Los 4xx por datos (409/400) cuentan como "le dejó pasar el permiso",
   * porque el corte que importa aquí es el de identidad.
   */
  const RUTAS = [
    // [metodo, ruta, cuerpo, socia, ajena, admin]
    ['GET', `/api/gob/cartera?groupId=${G}`, null, 'no', 'no', 'no'],
    // El prestamo es de socio1, asi que a socio2 tiene que cortarle. Que su
    // propia duena si lo vea se comprueba aparte, mas abajo.
    ['GET', '/api/gob/prestamo/LBL', null, 'no', 'no', 'no'],
    ['POST', '/api/gob/prestamo/LBL/mora', {}, 'no', 'no', 'no'],
    ['POST', '/api/gob/prestamo/LBL/proponer',
      { tipo: 'condonacion', importe: 10, motivo: 'una razon suficientemente larga', asambleaId },
      'no', 'no', 'no'],
    ['POST', '/api/gob/prestamo/LBL/aplicar', { acuerdoId: 'x' }, 'no', 'no', 'no'],

    ['GET', `/api/gob/caja?groupId=${G}`, null, 'ok', 'no', 'ok'],
    ['POST', '/api/gob/caja/proponer',
      { groupId: G, tipo: 'gasto', importe: 5, concepto: 'pasajes al banco', asambleaId },
      'no', 'no', 'no'],
    ['POST', '/api/gob/caja/xxx/aplicar', { acuerdoId: 'x' }, 'no', 'no', 'no'],
    ['POST', '/api/gob/caja/xxx/cobrar', {}, 'no', 'no', 'no'],

    ['GET', `/api/gob/avales?groupId=${G}`, null, 'ok', 'no', 'ok'],
    ['POST', '/api/gob/aval/proponer',
      { groupId: G, email: 'a@a.test', avalEmail: 'b@b.test', cupo: 10,
        motivo: 'una razon suficientemente larga', asambleaId },
      'no', 'no', 'no'],
    ['POST', '/api/gob/aval/xxx/aplicar', {}, 'no', 'no', 'no'],
    ['POST', '/api/gob/aval/xxx/liberar', {}, 'no', 'no', 'no'],

    ['GET', `/api/gob/grupo/cierre?groupId=${G}`, null, 'ok', 'no', 'ok'],
    ['POST', '/api/gob/grupo/cierre/calcular', { groupId: G }, 'no', 'no', 'no'],
    ['POST', '/api/gob/grupo/cierre/xxx/proponer', { asambleaId }, 'no', 'no', 'no'],
    ['POST', '/api/gob/grupo/cierre/xxx/aplicar', {}, 'no', 'no', 'no'],
    ['POST', '/api/gob/grupo/cierre/xxx/descartar', {}, 'no', 'no', 'no'],

    ['GET', `/api/gob/mi-compromiso?groupId=${G}`, null, 'ok', 'no', 'ok'],
    ['GET', `/api/gob/ahorradores?groupId=${G}`, null, 'ok', 'no', 'ok'],
    // Responde 200 a cualquier socia, pero FILTRADO: quien no es de la
    // directiva solo ve la suya. Se comprueba el contenido mas abajo.
    ['GET', `/api/gob/salidas?groupId=${G}`, null, 'ok', 'no', 'ok'],
    ['GET', `/api/gob/salida/estimacion?groupId=${G}`, null, 'ok', 'no', 'ok'],
  ];

  const llamar = (metodo, ruta, cuerpo, token) => (metodo === 'GET'
    ? get(ruta, token)
    : post(ruta, cuerpo || {}, token));

  // Un 2xx significa que el permiso le dejo pasar. Un 400/409 tambien: el corte
  // fue por datos, no por identidad. Lo que se comprueba es el 401/403/404.
  const dejoPasar = (res) => ![401, 403, 404].includes(res.status);

  // ===================================================================
  t.section('BLI 1. Sin sesion no se entra a ninguna parte');
  // ===================================================================
  let coladas = [];
  for (const [metodo, ruta, cuerpo] of RUTAS) {
    const res = await llamar(metodo, ruta, cuerpo, null);
    if (res.status !== 401) coladas.push(`${metodo} ${ruta} -> ${res.status}`);
  }
  t.check(`las ${RUTAS.length} rutas nuevas responden 401 sin token`,
    coladas.length === 0, coladas.join(' | '));

  // ===================================================================
  t.section('BLI 2. Una socia rasa ve lo de todas, no mueve el dinero de nadie');
  // ===================================================================
  coladas = [];
  const negadas = [];
  for (const [metodo, ruta, cuerpo, socia] of RUTAS) {
    const res = await llamar(metodo, ruta, cuerpo, e.tokens.socio2);
    if (socia === 'no' && dejoPasar(res)) coladas.push(`${metodo} ${ruta} -> ${res.status}`);
    if (socia === 'ok' && !dejoPasar(res)) negadas.push(`${metodo} ${ruta} -> ${res.status}`);
  }
  t.check('no llega a nada que mueva dinero', coladas.length === 0, coladas.join(' | '));
  t.check('pero si a lo que es de todas (la caja, los avales, lo suyo)',
    negadas.length === 0, negadas.join(' | '));

  // ===================================================================
  t.section('BLI 3. Quien no es del grupo no ve ni toca nada');
  // ===================================================================
  coladas = [];
  for (const [metodo, ruta, cuerpo] of RUTAS) {
    const res = await llamar(metodo, ruta, cuerpo, e.tokens.ajeno);
    if (dejoPasar(res)) coladas.push(`${metodo} ${ruta} -> ${res.status}`);
  }
  t.check('ni una sola ruta le deja pasar', coladas.length === 0, coladas.join(' | '));

  // ===================================================================
  t.section('BLI 4. El administrador de la plataforma NO gobierna el grupo');
  // ===================================================================
  // Es la regla del proyecto: el admin evalúa cómo se usa la plataforma, no
  // aprueba ni niega nada dentro de un grupo. Eso lo hace su directiva.
  coladas = [];
  for (const [metodo, ruta, cuerpo, , , admin] of RUTAS) {
    const res = await llamar(metodo, ruta, cuerpo, e.tokens.admin);
    if (admin === 'no' && dejoPasar(res)) coladas.push(`${metodo} ${ruta} -> ${res.status}`);
  }
  t.check('no condona, no carga mora, no cierra el grupo, no gasta',
    coladas.length === 0, coladas.join(' | '));

  // ===================================================================
  t.section('BLI 5. La tesoreria y la presidencia si pueden lo suyo');
  // ===================================================================
  // El reverso: que el blindaje no haya dejado a la directiva sin poder trabajar.
  const paraLaDirectiva = [
    ['GET', `/api/gob/cartera?groupId=${G}`, null],
    ['GET', `/api/gob/salidas?groupId=${G}`, null],
    ['GET', '/api/gob/prestamo/LBL', null],
    ['GET', `/api/gob/caja?groupId=${G}`, null],
    ['GET', `/api/gob/avales?groupId=${G}`, null],
    ['GET', `/api/gob/grupo/cierre?groupId=${G}`, null],
  ];
  const bloqueadas = [];
  for (const [metodo, ruta, cuerpo] of paraLaDirectiva) {
    const res = await llamar(metodo, ruta, cuerpo, e.tokens.teso);
    if (!dejoPasar(res)) bloqueadas.push(`${metodo} ${ruta} -> ${res.status}`);
  }
  t.check('la tesoreria llega a las seis pantallas que necesita',
    bloqueadas.length === 0, bloqueadas.join(' | '));

  const cierrePresi = await post('/api/gob/grupo/cierre/calcular', { groupId: G }, e.tokens.presi);
  t.check('y la presidencia si puede plantear el cierre del grupo',
    dejoPasar(cierrePresi), `HTTP ${cierrePresi.status}`);

  // Su propio prestamo si lo ve su duena. El corte de arriba era porque el
  // prestamo es de otra, no porque las socias no puedan ver los suyos.
  const suPrestamo = await get('/api/gob/prestamo/LBL', e.tokens.socio1);
  t.status('la deudora si ve su propio prestamo', suPrestamo, 200);

  // ===================================================================
  t.section('BLI 5b. Lo que se lee no es lo mismo para todas');
  // ===================================================================
  // Un 200 no basta: hay que mirar QUE devuelve. La lista de salidas responde a
  // cualquiera, pero recortada segun quien pregunta.
  // socio2, que no debe nada: socio1 tiene el prestamo LBL vivo y con deuda no
  // se sale, que es lo correcto y se prueba en la bateria de salidas.
  const pidioSalir = await post('/api/salir-grupo', { groupId: G }, e.tokens.socio2);
  t.status('una socia sin deudas pide salir', pidioSalir, 200);
  hoja.invalidarTodo();

  const deLaDirectiva = await get(`/api/gob/salidas?groupId=${G}`, e.tokens.teso);
  t.eq('la tesoreria ve la salida que hay', (deLaDirectiva.body?.salidas || []).length, 1);
  t.eq('y se sabe que es de la directiva', deLaDirectiva.body?.soyLider, true);

  const deOtraSocia = await get(`/api/gob/salidas?groupId=${G}`, e.tokens.socio1);
  t.eq('otra socia no ve la salida ajena', (deOtraSocia.body?.salidas || []).length, 0);
  t.eq('y no figura como directiva', deOtraSocia.body?.soyLider, false);

  const deSuDuena = await get(`/api/gob/salidas?groupId=${G}`, e.tokens.socio2);
  t.eq('quien la pidio si ve la suya', (deSuDuena.body?.salidas || []).length, 1);

  const delAdmin = await get(`/api/gob/salidas?groupId=${G}`, e.tokens.admin);
  t.eq('y al administrador de la plataforma le sale vacia: no gobierna el grupo',
    (delAdmin.body?.salidas || []).length, 0);

  // ===================================================================
  t.section('BLI 6. Un identificador de otro grupo no abre la puerta');
  // ===================================================================
  // La presidenta del grupo pequeno (G2) intenta operar sobre GBLI pasando su
  // propio identificador por delante: el permiso se comprueba contra el grupo
  // REAL del objeto, no contra lo que diga quien llama.
  const cruzado = await post('/api/gob/prestamo/LBL/mora', { groupId: 'G2' }, e.tokens.ajeno);
  t.status('no se carga mora a un prestamo de otro grupo', cruzado, 403);

  const carteraCruzada = await get('/api/gob/cartera?groupId=G2', e.tokens.presi);
  t.status('ni se lee la cartera del grupo ajeno', carteraCruzada, 403);

  const cajaCruzada = await post('/api/gob/caja/proponer', {
    groupId: 'G2', tipo: 'gasto', importe: 50, concepto: 'gasto en grupo ajeno', asambleaId,
  }, e.tokens.presi);
  t.status('ni se le carga un gasto', cajaCruzada, 403);

  // ===================================================================
  t.section('BLI 7. Dos veces a la vez no cobra dos veces');
  // ===================================================================
  seedWorkbook();
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  fake.seedSheet(HOJA, [CABECERA]);
  hoja.invalidarTodo();

  const f = await baseScenario({ groupId: 'GBL2' });
  prestamo('LBL2', f.users.socio1.email, 'GBL2', 300, 336, haceMeses(4));
  await post('/api/gob/reglas', { groupId: 'GBL2', moraPorcentajeMensual: 2 }, f.tokens.presi);
  hoja.invalidarTodo();

  // Dos peticiones simultaneas de carga de mora sobre el mismo prestamo.
  const [uno, dos] = await Promise.all([
    post('/api/gob/prestamo/LBL2/mora', {}, f.tokens.teso),
    post('/api/gob/prestamo/LBL2/mora', {}, f.tokens.presi),
  ]);
  const buenas = [uno, dos].filter((x) => x.status === 200).length;
  t.eq('solo una de las dos cargas prospera', buenas, 1);
  hoja.invalidarTodo();

  const movs = fake.ensureSheet('PrestamoMovimientos').grid
    .filter((x) => (x[2] || '') === 'LBL2' && (x[4] || '') === 'mora');
  t.eq('y queda una sola fila de mora', movs.length, 1);

  // Lo mismo con el cierre del grupo: dos aplicaciones a la vez.
  seedWorkbook();
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  fake.seedSheet(HOJA, [CABECERA]);
  hoja.invalidarTodo();

  const g = await baseScenario({ groupId: 'GBL3' });
  ahorro(g.users.socio1.email, 'GBL3', 100, haceMeses(2));
  hoja.invalidarTodo();

  const calc = await post('/api/gob/grupo/cierre/calcular', { groupId: 'GBL3' }, g.tokens.presi);
  const asa3 = await post('/api/gob/asambleas',
    { groupId: 'GBL3', titulo: 'Cierre', fechaProgramada: hoy(), modalidad: 'presencial' },
    g.tokens.presi);
  await post(`/api/gob/asambleas/${asa3.body?.asambleaId}/asistencia`, {
    groupId: 'GBL3',
    registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
      .map((q) => ({ email: g.users[q].email, estado: 'presente' })),
  }, g.tokens.secre);
  await post(`/api/gob/asambleas/${asa3.body?.asambleaId}/estado`,
    { estado: 'abierta', groupId: 'GBL3' }, g.tokens.presi);
  const prop = await post(`/api/gob/grupo/cierre/${calc.body?.cierreId}/proponer`,
    { asambleaId: asa3.body?.asambleaId }, g.tokens.presi);
  for (const q of ['presi', 'teso', 'secre', 'socio1', 'socio2']) {
    await post(`/api/gob/acuerdos/${prop.body?.acuerdoId}/votar`,
      { groupId: 'GBL3', voto: 'favor' }, g.tokens[q]);
  }
  hoja.invalidarTodo();

  const [c1, c2] = await Promise.all([
    post(`/api/gob/grupo/cierre/${calc.body?.cierreId}/aplicar`, {}, g.tokens.presi),
    post(`/api/gob/grupo/cierre/${calc.body?.cierreId}/aplicar`, {}, g.tokens.presi),
  ]);
  t.eq('el grupo se cierra una sola vez',
    [c1, c2].filter((x) => x.status === 200).length, 1);
  hoja.invalidarTodo();

  const devoluciones = fake.ensureSheet('Savings').grid
    .filter((x) => (x[1] || '') === 'GBL3' && (x[4] || '') === 'retiro_salida');
  t.eq('y a cada socia se le devuelve una sola vez', devoluciones.length,
    new Set(devoluciones.map((x) => x[0])).size);
};
