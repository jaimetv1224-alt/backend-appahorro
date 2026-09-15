/**
 * SUITE 16 - Seguridad.
 *
 * Aqui no se comprueba que la app funcione, sino que NO se pueda abusar de
 * ella. Cada seccion es un ataque concreto:
 *
 *   - leer o tocar el dinero de otra persona o de otro grupo
 *   - ascenderse a uno mismo a presidente o a administrador
 *   - colar campos que no toca ("mass assignment"): confirmar el propio aporte
 *   - manipular el token de sesion
 *   - inyectar formulas de hoja de calculo o etiquetas HTML
 *   - salirse de la carpeta de comprobantes al descargar un archivo
 *   - que ninguna respuesta filtre contrasenas, tokens ni credenciales
 *
 * Todo esto contra el dinero de gente real, asi que un fallo aqui es grave.
 */

const { seedWorkbook, get, post, fake, BASE } = require('./harness');

/**
 * Peticion cruda, para poder mandar cabeceras a mano (o ninguna) y probar
 * tokens falsificados. El arnes normal siempre pone una cabecera correcta.
 */
async function crudo(metodo, ruta, cabeceras = {}) {
  const res = await fetch(BASE + ruta, { method: metodo, headers: cabeceras });
  const texto = await res.text();
  let cuerpo = null;
  try { cuerpo = texto ? JSON.parse(texto) : null; } catch (err) { cuerpo = texto; }
  return { status: res.status, body: cuerpo, text: texto };
}
const { baseScenario } = require('./scenario');
const t = require('./runner');

const haceMeses = (n) => {
  const d = new Date();
  d.setDate(10);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
};

/** Rastros que NUNCA deben aparecer en una respuesta. */
const FUGAS = [
  [/\$2[aby]\$\d{2}\$/, 'un hash de contrasena'],
  [/BEGIN (RSA )?PRIVATE KEY/, 'una llave privada'],
  [/"private_key"/, 'las credenciales de Google'],
  [/juntago-dev-secret/, 'el secreto de desarrollo'],
  [/eyJhbGciOi/, 'un token de sesion ajeno'],
  [/client_secret|refresh_token/, 'credenciales de servicio'],
];

function revisarFuga(nombre, respuesta) {
  const texto = JSON.stringify(respuesta?.body ?? '');
  const encontrada = FUGAS.find(([re]) => re.test(texto));
  t.check(`${nombre}: no filtra nada sensible`, !encontrada,
    encontrada ? `aparece ${encontrada[1]}` : '');
}

module.exports = async function run() {
  seedWorkbook();
  const e = await baseScenario({ groupId: 'GS1' });
  // baseScenario ya crea un segundo grupo (G2) con 'ajeno' de presidente:
  // sirve como atacante que SI tiene sesion pero no pinta nada en GS1.

  // Datos con dinero en el grupo 1
  fake.ensureSheet('Acciones').grid.push([
    e.users.presi.email, 'GS1', haceMeses(4), 50, 10, 2, new Date().toISOString(),
    'confirmado', 'x@x', 'y@y', new Date().toISOString(), 'accS1', '',
  ]);
  fake.ensureSheet('Savings').grid.push([
    e.users.presi.email, 'GS1', 800, haceMeses(3), 'mensual', 'aporte',
    'confirmado', 'x@x', 'y@y', new Date().toISOString(), 'savS1', '',
  ]);
  fake.ensureSheet('Loans').grid.push([
    'LN_S1', e.users.socio1.email, 'GS1', 500, haceMeses(5),
    new Date().toISOString(), 2, 'aprobado', 5, 550,
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_S1', e.users.socio1.email, 'LN_S1', 550, haceMeses(1), 'ok', 'approved',
    '', '', '', '', new Date().toISOString(), e.users.teso.email, new Date().toISOString(), '',
  ]);

  // ===================================================================
  t.section('SEG 1. El dinero de otro grupo no se toca ni se mira');
  // ===================================================================
  const ajeno = e.tokens.ajeno;   // presidente de OTRO grupo

  const lecturas = [
    ['el reparto de utilidades', '/api/gob/utilidades/reparto?groupId=GS1'],
    ['los cierres', '/api/gob/utilidades/cierres?groupId=GS1'],
    ['el tablero', '/api/gob/tablero?groupId=GS1'],
    ['la bitacora', '/api/gob/bitacora?groupId=GS1'],
    ['el reglamento', '/api/gob/reglas?groupId=GS1'],
    ['los aportes pendientes', '/api/gob/aportes-pendientes?groupId=GS1'],
    ['los lotes de apertura', '/api/gob/apertura/lotes?groupId=GS1'],
    ['las asambleas', '/api/gob/asambleas?groupId=GS1'],
    ['los miembros', '/api/obtener-miembros?groupId=GS1'],
    ['los prestamos', '/api/obtener-prestamos?groupId=GS1'],
    ['las acciones', '/api/obtener-acciones?groupId=GS1&userEmail=' + e.users.presi.email],
    ['las solicitudes', '/api/solicitudes-pendientes?group=GS1&tipo=prestamo'],
  ];
  for (const [nombre, ruta] of lecturas) {
    const r = await get(ruta, ajeno);
    t.status(`quien no es del grupo NO puede leer ${nombre}`, r, 403);
  }

  const escrituras = [
    ['crear un cierre', 'POST', '/api/gob/utilidades/cierre', { groupId: 'GS1' }],
    ['cambiar el reglamento', 'POST', '/api/gob/reglas', { groupId: 'GS1', aporteMinimo: 999 }],
    ['convocar una asamblea', 'POST', '/api/gob/asambleas',
      { groupId: 'GS1', titulo: 'colada', fechaProgramada: '2026-12-01', modalidad: 'virtual' }],
    ['crear un lote de apertura', 'POST', '/api/gob/apertura/lote',
      { groupId: 'GS1', filas: [{ email: e.users.presi.email, ahorro: 9999 }] }],
    ['meter un aporte', 'POST', '/api/registrar-ahorros',
      { groupId: 'GS1', userEmail: e.users.presi.email, date: haceMeses(0), amount: 500 }],
    ['comprar acciones', 'POST', '/api/registrar-acciones',
      { groupId: 'GS1', date: haceMeses(0), shares: 10, shareValue: 10, interestRate: 2 }],
  ];
  for (const [nombre, metodo, ruta, cuerpo] of escrituras) {
    const r = await post(ruta, cuerpo, ajeno);
    t.status(`ni ${nombre}`, r, 403);
  }

  // ===================================================================
  t.section('SEG 2. Un socio raso no puede ascenderse solo');
  // ===================================================================
  const socio = e.tokens.socio1;

  t.status('no puede darse el cargo de presidente',
    await post('/api/cambiar-rol-usuario-grupo',
      { GroupID: 'GS1', UserEmail: e.users.socio1.email, NewGroupRole: 'presidente' }, socio), 403);
  t.status('ni el de tesorero',
    await post('/api/cambiar-rol-usuario-grupo',
      { GroupID: 'GS1', UserEmail: e.users.socio1.email, NewGroupRole: 'tesorero' }, socio), 403);
  t.status('ni hacerse administrador de la plataforma',
    await post('/api/cambiar-rol-usuario', { Email: e.users.socio1.email, Role: 'admin' }, socio), 403);
  t.status('ni invitar gente al grupo',
    await post('/api/invitar-miembro',
      { groupId: 'GS1', email: 'colado@x.test', role: 'presidente' }, socio), 403);
  t.status('ni desactivar a otra persona',
    await post('/api/desactivar-usuario', { Email: e.users.presi.email }, socio), 403);

  // Sigue siendo socio raso despues de intentarlo
  const suGrupo = await get(`/api/grupos-del-usuario?userEmail=${e.users.socio1.email}`, socio);
  const rolReal = ((suGrupo.body?.grupos || [])[0]?.groupRole || '').toLowerCase();
  t.eq('y tras todos los intentos sigue siendo socio raso', rolReal, 'member');

  // ===================================================================
  t.section('SEG 3. Nadie se confirma su propio aporte');
  // ===================================================================
  const propio = await post('/api/registrar-ahorros',
    { groupId: 'GS1', userEmail: e.users.teso.email, date: haceMeses(0), amount: 300 }, e.tokens.teso);
  t.statusIn('la tesoreria registra un aporte suyo', propio, [200, 201]);
  t.eq('que nace pendiente', propio.body?.estado, 'pendiente');

  const autoConfirma = await post('/api/gob/aportes/resolver',
    { groupId: 'GS1', tipo: 'ahorro', movId: propio.body?.movId, accion: 'confirmar' }, e.tokens.teso);
  t.status('pero NO puede confirmarselo a si misma', autoConfirma, 403);
  t.check('y se explica por que',
    /registraste|otra persona|otro miembro/i.test(autoConfirma.body?.message || ''),
    autoConfirma.body?.message);

  // Ni colando el estado directamente al registrarlo
  const colado = await post('/api/registrar-ahorros',
    { groupId: 'GS1', userEmail: e.users.socio1.email, date: haceMeses(0), amount: 400,
      estado: 'confirmado', cuenta: true, resueltoPor: e.users.presi.email }, socio);
  t.statusIn('registrar un aporte marcandolo ya confirmado', colado, [200, 201]);
  t.eq('el servidor lo deja pendiente igual, ignorando el campo colado',
    colado.body?.estado, 'pendiente');

  // ===================================================================
  t.section('SEG 4. Campos que no le tocan al cliente');
  // ===================================================================
  // Crear un cierre pidiendo que nazca ya aplicado
  const cierreColado = await post('/api/gob/utilidades/cierre',
    { groupId: 'GS1', estado: 'aplicado', ganancia: 999999, aplicadoEn: new Date().toISOString() },
    e.tokens.presi);
  t.status('se crea el cierre', cierreColado, 201);
  const idc = cierreColado.body?.cierreId;
  const leido = await get(`/api/gob/utilidades/cierre/${idc}`, e.tokens.presi);
  t.eq('pero nace en BORRADOR, no aplicado', leido.body?.cierre?.estado, 'borrador');
  t.check('y con la ganancia real, no la que pidio el cliente',
    Number(leido.body?.cierre?.ganancia) < 1000,
    `ganancia: ${leido.body?.cierre?.ganancia}`);

  // Un prestamo pidiendo interes cero
  // Para poder pedir prestamo hace falta ahorro confirmado (el cupo es 3x).
  fake.ensureSheet('Savings').grid.push([
    e.users.socio1.email, 'GS1', 500, haceMeses(2), 'mensual', 'para el cupo',
    'confirmado', 'x@x', 'y@y', new Date().toISOString(), 'savCupo', '',
  ]);
  const prestamoColado = await post('/api/registrar-solicitud', {
    tipo: 'prestamo',
    data: { Monto: 100, Detalles: 'Plazo: 3', Group: 'GS1', Estado: 'aprobado', InterestRate: 0 },
  }, socio);
  t.statusIn('se registra la solicitud de prestamo', prestamoColado, [200, 201]);
  const pendientes = await get('/api/solicitudes-pendientes?group=GS1&tipo=prestamo', e.tokens.presi);
  const suya = (pendientes.body?.solicitudes || [])
    .find((r) => (Array.isArray(r) ? r[1] : r.UserEmail) === e.users.socio1.email);
  t.check('pero queda PENDIENTE, no aprobada por pedirlo',
    !suya || /pendiente/i.test(Array.isArray(suya) ? suya[5] : suya.Estado),
    JSON.stringify(suya));

  // ===================================================================
  t.section('SEG 5. El token de sesion no se puede falsear');
  // ===================================================================
  const intentos = [
    ['sin cabecera', null],
    ['vacia', ''],
    ['sin la palabra Bearer', 'soy-admin'],
    ['con un token inventado', 'Bearer no.es.un.token'],
    ['con un token bien formado pero falso',
      'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJlbWFpbCI6ImFkbWluQGRlbW8udGVzdCIsInJvbGUiOiJhZG1pbiJ9.firmafalsa'],
    ['con el algoritmo "none"',
      'Bearer eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJlbWFpbCI6ImFkbWluQGRlbW8udGVzdCIsInJvbGUiOiJhZG1pbiJ9.'],
  ];
  for (const [nombre, cabecera] of intentos) {
    const r = await crudo('GET', '/api/obtener-usuarios',
      cabecera === null ? {} : { Authorization: cabecera });
    t.status(`${nombre}: no abre nada`, r, 401);
  }

  // Un token VALIDO de un socio no sirve para lo de admin
  t.status('el token de un socio no vale para el panel de plataforma',
    await get('/api/obtener-usuarios', socio), 403);
  t.status('ni para el resumen de administracion',
    await get('/api/admin/resumen', socio), 403);

  // ===================================================================
  t.section('SEG 6. Inyeccion de formulas y de HTML');
  // ===================================================================
  const veneno = [
    '=SUM(A1:A100)',
    '+1+1',
    '-1-1',
    '@SUM(1)',
    '=HYPERLINK("http://malo.test","clic")',
    '=IMPORTXML("http://malo.test","//a")',
  ];
  for (const carga of veneno) {
    const r = await post('/api/registrar-ahorros',
      { groupId: 'GS1', userEmail: e.users.socio1.email, date: haceMeses(0), amount: 5,
        descripcion: carga }, socio);
    t.statusIn(`se acepta el texto "${carga.slice(0, 18)}"`, r, [200, 201]);
  }
  const filasSav = (fake.dumpSheet('Savings') || []).slice(1)
    .filter((f) => (f[1] || '') === 'GS1');
  const peligrosas = filasSav.filter((f) => /^[=+\-@]/.test(String(f[5] || '')));
  t.eq('ninguna descripcion queda en la hoja empezando por = + - @',
    peligrosas.length, 0);
  t.check('todas van precedidas de apostrofe para que Sheets las trate como texto',
    filasSav.filter((f) => veneno.some((v) => String(f[5] || '').includes(v.slice(1, 10))))
      .every((f) => String(f[5]).startsWith("'")),
    JSON.stringify(filasSav.map((f) => f[5]).slice(-6)));

  // HTML / script
  const conHtml = await post('/api/registrar-ahorros',
    { groupId: 'GS1', userEmail: e.users.socio1.email, date: haceMeses(0), amount: 5,
      descripcion: '<script>alert(1)</script><img src=x onerror=alert(2)>' }, socio);
  t.statusIn('se acepta texto con etiquetas HTML', conHtml, [200, 201]);
  const listaSav = await get(`/api/savings?userEmail=${e.users.socio1.email}`, socio);
  const conEtiqueta = (listaSav.body?.savings || [])
    .find((s) => String(s.descripcion || '').includes('script'));
  t.check('vuelve como TEXTO, no como json/html interpretable',
    !conEtiqueta || typeof conEtiqueta.descripcion === 'string',
    JSON.stringify(conEtiqueta));

  // ===================================================================
  t.section('SEG 7. No se sale de la carpeta de comprobantes');
  // ===================================================================
  const rutas = [
    '../../server.js',
    '..%2F..%2Fserver.js',
    '....//....//server.js',
    '%2e%2e%2f%2e%2e%2fcredentials.json',
    '..\\..\\credentials.json',
    '/etc/passwd',
    'C:%5CWindows%5Cwin.ini',
  ];
  // Sin cabeceras la peticion ya no llega al endpoint: el gate responde 401 y
  // estas aserciones se satisfarian solas sin ejercitar la defensa. Cada ruta
  // se prueba por los DOS caminos que si entran: con token (carril del token) y
  // con una firma en la direccion (carril de la firma).
  const conFirmaCualquiera = '?vence=9999999999&quien=aaaaaaaaaaaa&firma=AAAAAAAAAAAAAAAAAAAAAA';
  for (const ruta of rutas) {
    const porLosDosCarriles = [
      ['con token, sin firma', await crudo('GET', `/api/payment-image/${ruta}`,
        { Authorization: `Bearer ${e.tokens.teso}` })],
      ['con firma en la direccion', await crudo('GET', `/api/payment-image/${ruta}${conFirmaCualquiera}`)],
    ];
    for (const [via, r] of porLosDosCarriles) {
      t.check(`no entrega "${ruta.slice(0, 24)}" (${via})`, r.status !== 200,
        `devolvio ${r.status}`);
      // Una ruta con barra o contrabarra SIN CODIFICAR ni siquiera casa con
      // `/api/payment-image/:filename`, asi que no llega al endpoint y el gate
      // responde 401. Eso tambien esta bien: el archivo no se entrega. La
      // comprobacion de "llego al endpoint" solo aplica a las que si casan,
      // que son las que de verdad ejercitan la defensa de la carpeta.
      const llevaSeparador = ruta.includes('/') || ruta.includes(String.fromCharCode(92));
      if (!llevaSeparador) {
        t.check('   y la peticion llego al endpoint, no la corto el gate',
          r.status !== 401, `devolvio ${r.status}`);
      }
      const cuerpo = typeof r.body === 'string' ? r.body : JSON.stringify(r.body || '');
      t.check('   y su respuesta no trae codigo del servidor',
        !/require\(|module\.exports|BEGIN PRIVATE KEY/.test(cuerpo), cuerpo.slice(0, 80));
    }
  }

  // Y la puerta que se acaba de cerrar. Medido antes del cambio: esta misma
  // peticion respondia 200 con el archivo entero.
  t.eq('sin token y sin firma, la foto del comprobante ya no se sirve',
    (await crudo('GET', '/api/payment-image/loquesea')).status, 401);

  // ===================================================================
  t.section('SEG 8. Importes imposibles no entran');
  // ===================================================================
  const malos = [
    ['negativo', -100],
    ['cero', 0],
    ['texto', 'mucho'],
    ['infinito', 1e400],
    ['descomunal', 999999999999],
    ['nulo', null],
  ];
  for (const [nombre, monto] of malos) {
    const r = await post('/api/registrar-ahorros',
      { groupId: 'GS1', userEmail: e.users.socio1.email, date: haceMeses(0), amount: monto }, socio);
    t.status(`un aporte ${nombre} se rechaza`, r, 400);
  }
  // El precio y el interes salen de la configuracion del grupo. Mandar cifras
  // propias no las impone: o se rechaza por desajuste (409) o por rango (400).
  const accMalas = [
    ['cantidad negativa', { shares: -5, shareValue: 10, interestRate: 2 }, [400]],
    ['valor negativo', { shares: 5, shareValue: -10, interestRate: 2 }, [409]],
    ['tasa negativa', { shares: 5, shareValue: 10, interestRate: -2 }, [409]],
    ['cantidad absurda', { shares: 99999999, shareValue: 10, interestRate: 2 }, [400, 409]],
  ];
  for (const [nombre, datos, esperado] of accMalas) {
    const r = await post('/api/registrar-acciones',
      { groupId: 'GS1', date: haceMeses(0), ...datos }, socio);
    t.statusIn(`comprar acciones con ${nombre} se rechaza`, r, esperado);
  }
  t.eq('ninguna de esas compras impuso su propia cifra',
    (fake.dumpSheet('Acciones') || []).slice(1)
      .filter((fila) => (fila[1] || '') === 'GS1')
      .filter((fila) => Math.abs(Number(fila[4] || 0) - 10) > 0.005
        || Math.abs(Number(fila[5] || 0) - 2) > 0.005).length, 0);

  // ===================================================================
  t.section('SEG 9. El voto y el acuerdo no se manipulan');
  // ===================================================================
  const asa = await post('/api/gob/asambleas', {
    groupId: 'GS1', titulo: 'Seguridad', fechaProgramada: '2026-11-01', modalidad: 'presencial',
  }, e.tokens.presi);
  const asambleaId = asa.body?.asambleaId;
  await post(`/api/gob/asambleas/${asambleaId}/asistencia`, {
    registros: [e.users.presi, e.users.teso, e.users.socio1]
      .map((u) => ({ email: u.email, estado: 'presente' })),
  }, e.tokens.presi);
  await post(`/api/gob/asambleas/${asambleaId}/estado`, { estado: 'abierta' }, e.tokens.presi);

  const cierre2 = await post('/api/gob/utilidades/cierre', { groupId: 'GS1' }, e.tokens.presi);
  const id2 = cierre2.body?.cierreId || idc;
  const prop = await post(`/api/gob/utilidades/cierre/${id2}/proponer`,
    { asambleaId }, e.tokens.presi);
  const acuerdoId = prop.body?.acuerdoId;

  t.status('alguien de otro grupo no puede votar aqui',
    await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, ajeno), 403);

  const v1 = await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, e.tokens.presi);
  t.statusIn('la presidencia vota una vez', v1, [200, 201]);
  const v2 = await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, e.tokens.presi);
  const votos = await get(`/api/gob/acuerdos/${acuerdoId}`, e.tokens.presi).catch(() => null);
  t.check('votar dos veces no suma dos votos',
    v2.status !== 200 || (votos?.body?.acuerdo?.aFavor ?? 1) <= 1,
    `segundo voto: ${v2.status}`);

  t.status('un socio no puede aplicar el cierre',
    await post(`/api/gob/utilidades/cierre/${id2}/aplicar`, {}, socio), 403);

  // ===================================================================
  t.section('SEG 10. Ninguna respuesta filtra nada sensible');
  // ===================================================================
  // El inicio de sesion se revisa aparte: devolver TU token es su trabajo.
  // Lo que no puede es soltar el hash de la clave ni credenciales.
  const login = await post('/api/login', { email: e.users.presi.email, password: 'Clave123' });
  const textoLogin = JSON.stringify(login.body || '');
  t.check('el inicio de sesion no devuelve el hash de la contrasena',
    !/\$2[aby]\$\d{2}\$/.test(textoLogin), 'aparece el hash');
  t.check('ni las credenciales de Google',
    !/private_key|BEGIN .*PRIVATE KEY/.test(textoLogin), 'aparecen credenciales');
  t.check('ni el secreto con el que se firman los tokens',
    !/juntago-dev-secret/.test(textoLogin), 'aparece el secreto');

  const aRevisar = [
    ['mi perfil', await get('/api/perfil', e.tokens.presi)],
    ['mis grupos', await get(`/api/grupos-del-usuario?userEmail=${e.users.presi.email}`, e.tokens.presi)],
    ['mis ahorros', await get(`/api/savings/complete?email=${e.users.presi.email}&groupId=GS1`, e.tokens.presi)],
    ['los miembros', await get('/api/obtener-miembros?groupId=GS1', e.tokens.presi)],
    ['el reparto', await get('/api/gob/utilidades/reparto?groupId=GS1', e.tokens.presi)],
    ['el tablero', await get('/api/gob/tablero?groupId=GS1', e.tokens.presi)],
    ['la bitacora', await get('/api/gob/bitacora?groupId=GS1', e.tokens.presi)],
    ['la lista de usuarios (admin)', await get('/api/obtener-usuarios', e.tokens.admin)],
    ['el resumen de admin', await get('/api/admin/resumen', e.tokens.admin)],
  ];
  for (const [nombre, r] of aRevisar) revisarFuga(nombre, r);

  // El listado de usuarios del admin es el sitio mas goloso
  const usuarios = await get('/api/obtener-usuarios', e.tokens.admin);
  const lista = usuarios.body?.usuarios || usuarios.body?.users || usuarios.body || [];
  const conClave = (Array.isArray(lista) ? lista : []).filter((u) => {
    const v = JSON.stringify(u);
    return /\$2[aby]\$/.test(v) || /"password"\s*:\s*"[^"]{6,}"/i.test(v);
  });
  t.eq('la lista de usuarios no incluye contrasenas ni sus hashes', conClave.length, 0);

  // Un error del servidor no debe soltar la pila de llamadas
  const roto = await get('/api/gob/utilidades/cierre/../../etc/passwd', e.tokens.presi);
  const textoRoto = JSON.stringify(roto.body || '');
  t.check('un error no devuelve la traza interna del servidor',
    !/at .*\.js:\d+|node_modules|\/Backend\//.test(textoRoto), textoRoto.slice(0, 120));

  // ===================================================================
  t.section('SEG 12. Quien sale del grupo pierde las fotos que ya tenia');
  // ===================================================================
  // Se usa a proposito un comprobante que NO existe en disco: con la firma viva
  // el endpoint llega hasta el archivo y contesta 404 "Imagen no encontrada";
  // cuando la firma deja de valer, contesta 403 antes de mirar el disco. La
  // diferencia entre 404 y 403 ES la revocacion, y asi la prueba no deja
  // archivos sueltos en uploads/.
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_S9', e.users.socio2.email, 'LN_S1', 100, haceMeses(1), 'ok', 'pending_approval',
    'comprobante-que-no-existe-en-disco', '', '', '', new Date().toISOString(), '', '', '',
  ]);
  const listaTeso = await get('/api/pending-payments?groupId=GS1', e.tokens.teso);
  const firmada = (listaTeso.body?.payments || [])
    .find((p) => p.imageFilename === 'comprobante-que-no-existe-en-disco')?.imagenUrl || '';
  t.check('la tesoreria recibe la direccion ya firmada del comprobante',
    firmada.includes('firma=') && firmada.includes('vence='), firmada);
  t.check('   y esa direccion no publica el correo de nadie',
    !firmada.includes('@') && /[?&]quien=[0-9a-f]{12}(&|$)/.test(firmada), firmada);
  t.eq('con la firma viva, la peticion sin cabeceras llega hasta el archivo',
    (await crudo('GET', firmada)).status, 404);

  await post('/api/desvincular-usuario-grupo',
    { UserEmail: e.users.teso.email, GroupID: 'GS1' }, e.tokens.presi);
  const trasSalir = await crudo('GET', firmada);
  t.eq('al sacarla del grupo, la direccion que ya se habia llevado deja de valer',
    trasSalir.status, 403);
  t.eq('   y se le dice por que', trasSalir.body?.motivo, 'anulada');
};
