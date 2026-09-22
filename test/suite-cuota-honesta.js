/**
 * SUITE 50 - Cuando la hoja no se deja leer, se dice. No se devuelven ceros.
 *
 * El fallo que cierra esta suite es el mas feo que tenia el sistema de cara a
 * la socia, porque no se parecia a un error: se parecia a una respuesta.
 *
 * Google limita las lecturas. Cuando se pasa, responde 429. Nueve endpoints
 * capturaban ese 429 y devolvian HTTP 200 con la lista vacia o con el
 * patrimonio a cero. Para la socia eso no era "la app esta ocupada": era abrir
 * la aplicacion y ver "$0.00" donde estaban sus ahorros, o "no perteneces a
 * ningun grupo" cuando llevaba meses en su caja. Y el frontend guardaba esa
 * mentira en cache noventa segundos, asi que sobrevivia al corte.
 *
 * Lo que se fija aqui:
 *   1. Ante un error de cuota, la respuesta es 429 con motivo 'cuota_hoja'.
 *      Nunca 200 con datos vacios.
 *   2. La distincion sigue viva: una hoja que de verdad no tiene filas SI
 *      devuelve vacio con 200. Sin esto, una instalacion recien creada diria
 *      "no se pudo leer" y seria igual de mentirosa por el otro lado.
 *
 * Va la ULTIMA porque inyecta fallos deliberados en la hoja.
 */

const { seedWorkbook, get, fake } = require('./harness');
const { baseScenario, seedUser, seedGroup, seedLink } = require('./scenario');
const t = require('./runner');

// Suficientes turnos para agotar los 3 reintentos que hoja.js hace ante cuota.
const VECES = 50;
const CUOTA = 'Quota exceeded for quota metric';

module.exports = async function run() {
  const hoja = require('../hoja');

  const preparar = async () => {
    seedWorkbook();
    ['Savings', 'Acciones', 'Loans', 'LoanPayments', 'Transactions', 'MetasAhorro']
      .forEach((n) => fake.ensureSheet(n));
    hoja.invalidarTodo();
    const e = await baseScenario({ groupId: 'CUOTA' });
    hoja.invalidarTodo();
    return e;
  };

  // Cada caso: que endpoint, que hoja tiene que reventar, y con que token.
  // La hoja que revienta NUNCA es Users, porque de Users lee el guardia de
  // sesion: matarla mediria la puerta de entrada y no el endpoint.
  const CASOS = [
    { ruta: '/api/grupos-del-usuario', hoja: 'UserGroupLinks', quien: 'socio1' },
    { ruta: '/api/obtener-grupos', hoja: 'Groups', quien: 'socio1' },
    { ruta: '/api/savings?email=socio1@juntago.test', hoja: 'Savings', quien: 'socio1' },
    { ruta: '/api/savings/stats?email=socio1@juntago.test', hoja: 'Savings', quien: 'socio1' },
    { ruta: '/api/savings/goals?email=socio1@juntago.test', hoja: 'MetasAhorro', quien: 'socio1' },
    { ruta: '/api/user-loan-payments?email=socio1@juntago.test', hoja: 'LoanPayments', quien: 'socio1' },
    { ruta: '/api/pending-payments', hoja: 'LoanPayments', quien: 'admin' },
    { ruta: '/api/admin/transacciones', hoja: 'Transactions', quien: 'admin' },
  ];

  // ===================================================================
  t.section('QTA 1. Un 429 de Google NO se le presenta a la socia como ceros');
  // ===================================================================
  for (const caso of CASOS) {
    const e = await preparar();
    fake.fallarEn('get', `^${caso.hoja}`, VECES, CUOTA);
    fake.fallarEn('batchGet', caso.hoja, VECES, CUOTA);

    const r = await get(caso.ruta, e.tokens[caso.quien]);
    t.check(`${caso.ruta} no responde 200 con datos vacios`,
      r.status !== 200, `respondio ${r.status} ${JSON.stringify(r.body).slice(0, 110)}`);
    t.check(`${caso.ruta} lo dice como problema de cuota`,
      r.status === 429 && r.body && r.body.motivo === 'cuota_hoja',
      `respondio ${r.status} ${JSON.stringify(r.body).slice(0, 110)}`);
    t.check(`${caso.ruta} explica que hay que reintentar`,
      /vuelve a intentarlo|espera/i.test(String(r.body && r.body.message)),
      JSON.stringify(r.body));
    fake.store.fallos.length = 0;
  }

  // ===================================================================
  t.section('QTA 2. El resumen del panel tampoco inventa un cero');
  // ===================================================================
  // Este devolvia resumen:null con 200, y el panel pintaba el patrimonio del
  // proyecto entero a cero delante de quien viniera a verlo.
  let e = await preparar();
  fake.fallarEn('get', '^Savings', VECES, CUOTA);
  fake.fallarEn('batchGet', 'Savings', VECES, CUOTA);
  let r = await get('/api/admin/resumen', e.tokens.admin);
  t.check('/api/admin/resumen no responde 200 con el resumen vacio',
    r.status !== 200, `respondio ${r.status} ${JSON.stringify(r.body).slice(0, 110)}`);
  t.eq('sino 429', r.status, 429);
  fake.store.fallos.length = 0;

  // ===================================================================
  t.section('QTA 3. Una hoja de verdad vacia SIGUE devolviendo vacio');
  // ===================================================================
  // La otra mitad del arreglo. Google rechaza A2:X de una hoja con solo
  // cabecera diciendo "exceeds grid limits", y eso significa "sin filas", no
  // un fallo. Si se tratara como error, una instalacion recien montada diria
  // "no se pudo leer la lista de grupos" y seria igual de falso.
  e = await preparar();
  fake.fallarEn('get', '^Groups', VECES, 'Unable to parse range: Groups!A2:R exceeds grid limits. Max rows: 1');
  r = await get('/api/obtener-grupos', e.tokens.socio1);
  t.eq('una hoja sin filas devuelve 200', r.status, 200);
  t.check('con la lista vacia y sin avisos falsos',
    Array.isArray(r.body && r.body.grupos) && r.body.grupos.length === 0,
    JSON.stringify(r.body).slice(0, 140));
  fake.store.fallos.length = 0;

  // ===================================================================
  t.section('QTA 4. Con la hoja sana todo sigue respondiendo 200');
  // ===================================================================
  // Que no se haya cerrado de mas: el camino bueno tiene que seguir igual.
  e = await preparar();
  seedUser({ nombre: 'Vecina', email: 'vecina@juntago.test' });
  seedGroup({ id: 'CUOTA2', nombre: 'Caja sana', presidente: 'vecina@juntago.test' });
  seedLink('vecina@juntago.test', 'CUOTA2', 'presidente');
  hoja.invalidarTodo();

  for (const caso of CASOS) {
    r = await get(caso.ruta, e.tokens[caso.quien]);
    t.eq(`${caso.ruta} responde bien cuando la hoja se deja leer`, r.status, 200);
  }
  r = await get('/api/obtener-grupos', e.tokens.socio1);
  t.check('y los grupos se listan de verdad',
    Array.isArray(r.body.grupos) && r.body.grupos.length > 0,
    JSON.stringify(r.body).slice(0, 140));

  // ===================================================================
  t.section('QTA 5. La cuota de una socia no se le cobra a otra');
  // ===================================================================
  // El freno reparte la cuota por persona, y para eso tiene que saber de quien
  // es la peticion en curso. Ese dato vivia en una variable suelta del modulo:
  // mientras la peticion de Ana esperaba a la red, entraba la de Berta y la
  // pisaba, asi que el consumo de Ana pasaba a cobrarsele a Berta. Con el tope
  // de administrador era peor: una socia podia heredar un tope que no le toca,
  // y un administrador quedarse esperando por el de una socia.
  const dormir = (ms) => new Promise((res) => setTimeout(res, ms));
  let vioAna = null;
  let vioBerta = null;
  let topeAna = null;
  let topeBerta = null;

  await Promise.all([
    hoja.enNombreDe('ana@juntago.test', false, async () => {
      // Se duerme a proposito: aqui es donde entraba la otra peticion.
      await dormir(30);
      const suyo = hoja.cuentaDeLaPeticion();
      vioAna = suyo.cuenta;
      topeAna = suyo.esAdmin;
    }),
    (async () => {
      await dormir(10);
      return hoja.enNombreDe('berta@juntago.test', true, async () => {
        const suyo = hoja.cuentaDeLaPeticion();
        vioBerta = suyo.cuenta;
        topeBerta = suyo.esAdmin;
        await dormir(40);
      });
    })(),
  ]);

  t.eq('Ana sigue siendo Ana despues de esperar a la red', vioAna, 'ana@juntago.test');
  t.eq('y con su tope de socia, no el de administradora', topeAna, false);
  t.eq('Berta es Berta', vioBerta, 'berta@juntago.test');
  t.eq('y con el suyo de administradora', topeBerta, true);

  // Fuera de toda peticion se sigue pudiendo fijar la cuenta, que es como
  // trabajan los scripts y las tareas que no nacen de una peticion HTTP.
  hoja.enNombreDe('script@juntago.test', false);
  t.eq('sin peticion en curso vale la cuenta por defecto',
    hoja.cuentaDeLaPeticion().cuenta, 'script@juntago.test');
  hoja.enNombreDe('', false);
};
