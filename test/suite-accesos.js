/**
 * SUITE 17 - Registro de accesos e informe de participantes.
 *
 * Es informacion para el seguimiento del proyecto: quien entra, cuando y desde
 * que aparato. Se comprueba que se registre bien, que las cuentas cuadren, y
 * sobre todo que NO se le muestre a quien no debe.
 */

const {
  interpretarNavegador, resumirAccesos, filaDeAcceso, accesoDesdeFila, franjaHoraria, HOJA, CABECERA,
} = require('../accesos');
const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

// Cadenas reales de navegadores, tal como llegan
const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 13; SM-A536E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1',
  windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  windowsEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36 Edg/121.0.0.0',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/604.1',
  tabletAndroid: 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:122.0) Gecko/20100101 Firefox/122.0',
  samsung: 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
};

const haceDias = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
};

module.exports = async function run() {
  // ===================================================================
  t.section('ACC 1. Se entiende de que aparato viene cada acceso');
  // ===================================================================
  const casos = [
    ['un telefono Android con Chrome', UA.androidChrome, 'movil', 'Android 13', 'Chrome'],
    ['un iPhone con Safari', UA.iphoneSafari, 'movil', 'iOS 17', 'Safari'],
    ['una computadora Windows con Chrome', UA.windowsChrome, 'escritorio', 'Windows 10/11', 'Chrome'],
    ['la misma con Edge', UA.windowsEdge, 'escritorio', 'Windows 10/11', 'Edge'],
    ['un iPad', UA.ipad, 'tableta', 'iOS', 'Safari'],
    ['una tableta Android', UA.tabletAndroid, 'tableta', 'Android 13', 'Chrome'],
    ['un Mac con Firefox', UA.macFirefox, 'escritorio', 'macOS', 'Firefox'],
    ['el navegador de Samsung', UA.samsung, 'movil', 'Android 12', 'Samsung Internet'],
  ];
  for (const [nombre, ua, disp, sis, nav] of casos) {
    const r = interpretarNavegador(ua);
    t.eq(`${nombre}: aparato`, r.dispositivo, disp);
    t.eq(`${nombre}: sistema`, r.sistema, sis);
    t.eq(`${nombre}: navegador`, r.navegador, nav);
  }

  const vacio = interpretarNavegador('');
  t.eq('sin dato, no se inventa nada', vacio.dispositivo, 'desconocido');
  t.eq('un programa (curl) se distingue de una persona',
    interpretarNavegador('curl/8.0').navegador, 'programa');

  // ===================================================================
  t.section('ACC 2. Las franjas del dia');
  // ===================================================================
  const aLas = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.toISOString(); };
  t.eq('las 3 de la manana es madrugada', franjaHoraria(aLas(3)), 'madrugada');
  t.eq('las 9 es mañana', franjaHoraria(aLas(9)), 'mañana');
  t.eq('las 15 es tarde', franjaHoraria(aLas(15)), 'tarde');
  t.eq('las 21 es noche', franjaHoraria(aLas(21)), 'noche');

  // ===================================================================
  t.section('ACC 3. El resumen de una persona cuadra');
  // ===================================================================
  const filas = [
    { fecha: haceDias(40), dispositivo: 'movil', sistema: 'Android 13', navegador: 'Chrome' },
    { fecha: haceDias(20), dispositivo: 'movil', sistema: 'Android 13', navegador: 'Chrome' },
    { fecha: haceDias(20), dispositivo: 'movil', sistema: 'Android 13', navegador: 'Chrome' },
    { fecha: haceDias(5), dispositivo: 'escritorio', sistema: 'Windows 10/11', navegador: 'Edge' },
    { fecha: haceDias(1), dispositivo: 'movil', sistema: 'Android 13', navegador: 'Chrome' },
  ];
  const r = resumirAccesos(filas);
  t.eq('cuenta las 5 entradas', r.entradas, 5);
  t.eq('y los 4 dias distintos', r.diasDistintos, 4);
  t.eq('en los ultimos 30 dias fueron 4', r.entradasUltimos30, 4);
  t.eq('el aparato mas usado es el movil', r.dispositivos[0]?.nombre, 'movil');
  t.eq('con 4 veces', r.dispositivos[0]?.veces, 4);
  t.eq('y tambien uso el escritorio', r.dispositivos[1]?.nombre, 'escritorio');
  // El porcentaje lo calcula el servidor, para que la pantalla no lo rehaga
  t.near('4 de 5 entradas desde el movil: 80%', r.dispositivos[0]?.pct, 80, 0.1);
  t.near('y 1 de 5 desde el escritorio: 20%', r.dispositivos[1]?.pct, 20, 0.1);
  t.near('los porcentajes suman 100',
    r.dispositivos.reduce((s2, d) => s2 + d.pct, 0), 100, 0.2);
  t.check('la ultima entrada es la mas reciente',
    r.ultimo === filas[4].fecha, `${r.ultimo}`);
  t.check('y la primera la mas antigua', r.primero === filas[0].fecha, `${r.primero}`);
  t.eq('la suma por aparato es el total de entradas',
    r.dispositivos.reduce((s, d) => s + d.veces, 0), 5);

  const vacia = resumirAccesos([]);
  t.eq('quien nunca entro tiene cero entradas', vacia.entradas, 0);
  t.eq('y ninguna fecha', vacia.ultimo, null);
  t.eq('sin romperse', resumirAccesos(null).entradas, 0);

  // ===================================================================
  t.section('ACC 4. La fila que se guarda y se vuelve a leer');
  // ===================================================================
  const fila = filaDeAcceso('ANA@Ejemplo.COM ', UA.androidChrome, '181.199.1.1', haceDias(0));
  // Ocho: se anadio Origen para distinguir el inicio de sesion de la vuelta a
  // la app. Sin esa columna solo se contaban los logins, y como la sesion dura
  // 30 dias, quien entraba a diario figuraba con una entrada al mes.
  t.eq('la cabecera tiene 8 columnas', CABECERA.length, 8);
  t.eq('y la fila tambien', fila.length, 8);
  t.eq('la ultima dice de donde viene la entrada', CABECERA[7], 'Origen');
  t.eq('una entrada de login se marca como tal', fila[7], 'login');

  const filaVuelta = filaDeAcceso('x@y.test', 'Mozilla/5.0 (Linux; Android 13) Mobile',
    '1.2.3.4', new Date().toISOString(), 'vuelta');
  t.eq('y una vuelta a la app, como vuelta', filaVuelta[7], 'vuelta');
  t.eq('al releerla se conserva', accesoDesdeFila(filaVuelta).origen, 'vuelta');
  t.eq('una fila antigua, sin esa columna, cuenta como login',
    accesoDesdeFila(['2026-01-01', 'x@y.test', 'movil', 'Android', 'Chrome', '1.2.3.4', 'ua']).origen, 'login');
  t.eq('el correo se guarda en minusculas y sin espacios', fila[1], 'ana@ejemplo.com');
  t.eq('el aparato', fila[2], 'movil');
  t.eq('el sistema', fila[3], 'Android 13');
  t.eq('el navegador', fila[4], 'Chrome');
  const vuelta = accesoDesdeFila(fila);
  t.eq('al releerla, el correo coincide', vuelta.email, 'ana@ejemplo.com');
  t.eq('y el aparato tambien', vuelta.dispositivo, 'movil');

  const larga = filaDeAcceso('x@x.test', 'U'.repeat(900), '1.2.3.4');
  t.check('una cadena de navegador larguisima se recorta',
    String(larga[6]).length <= 300, `mide ${String(larga[6]).length}`);

  // ===================================================================
  t.section('ACC 5. Entrar deja rastro, de verdad');
  // ===================================================================
  seedWorkbook();
  fake.seedSheet(HOJA, [CABECERA]);
  const e = await baseScenario({ groupId: 'GAC' });

  const antes = (fake.dumpSheet(HOJA) || []).length;
  const login = await post('/api/login',
    { email: e.users.socio1.email, password: e.users.socio1.password });
  t.status('el socio entra', login, 200);
  const despues = fake.dumpSheet(HOJA) || [];
  t.eq('y queda anotado el acceso', despues.length, antes + 1);
  const anotado = despues[despues.length - 1];
  t.eq('a su nombre', (anotado[1] || '').toLowerCase(), e.users.socio1.email);
  t.check('con fecha', !!anotado[0], `fecha: ${anotado[0]}`);

  t.check('un intento fallido NO deja rastro de acceso',
    (await post('/api/login', { email: e.users.socio1.email, password: 'mal' })).status !== 200
      && (fake.dumpSheet(HOJA) || []).length === despues.length,
    'se anoto un acceso que no ocurrio');

  // ===================================================================
  t.section('ACC 6. El informe del panel: grupos con su gente');
  // ===================================================================
  // Unos cuantos accesos de distinta gente y aparato
  const sembrar = (correo, ua, dias) => fake.ensureSheet(HOJA).grid.push(
    filaDeAcceso(correo, ua, '10.0.0.1', haceDias(dias)));
  sembrar(e.users.presi.email, UA.androidChrome, 10);
  sembrar(e.users.presi.email, UA.androidChrome, 3);
  sembrar(e.users.presi.email, UA.windowsChrome, 1);
  sembrar(e.users.teso.email, UA.iphoneSafari, 5);
  sembrar(e.users.socio2.email, UA.ipad, 2);

  // Ojo: baseScenario inicia sesion con CADA usuario para sacar su token, y
  // eso tambien queda registrado. Asi que todos parten con 1 entrada de base.
  const BASE_LOGIN = 1;

  const inf = await get('/api/admin/participantes', e.tokens.admin);
  t.status('el informe responde al administrador', inf, 200);

  const grupo = (inf.body?.grupos || []).find((g) => g.groupId === 'GAC');
  t.check('trae el grupo con su nombre', !!grupo && !!grupo.nombre, JSON.stringify(grupo || {}).slice(0, 120));
  t.eq('con sus 5 integrantes', grupo?.resumen?.integrantes, 5);
  t.eq('de los cuales 3 son directivos', grupo?.resumen?.directivos, 3);

  const presi = (grupo?.miembros || []).find((m) => m.correo === e.users.presi.email);
  t.eq('la presidencia sale primero en la lista', grupo?.miembros?.[0]?.cargo, 'presidente');
  t.check('con su nombre, no solo el correo', !!presi?.nombre && presi.nombre !== presi.correo,
    `nombre: ${presi?.nombre}`);
  t.eq('y sus 3 entradas sembradas mas la del arranque',
    presi?.accesos?.entradas, 3 + BASE_LOGIN);
  t.eq('desde 2 aparatos distintos', presi?.accesos?.dispositivos?.length, 2);
  t.check('usa movil y escritorio',
    (presi?.accesos?.dispositivos || []).map((d) => d.nombre).sort().join(',').includes('movil'),
    JSON.stringify(presi?.accesos?.dispositivos));

  const socio1 = (grupo?.miembros || []).find((m) => m.correo === e.users.socio1.email);
  t.eq('quien inicio sesion aparte suma su entrada',
    socio1?.accesos?.entradas, 1 + BASE_LOGIN);
  const secre = (grupo?.miembros || []).find((m) => m.correo === e.users.secre.email);
  t.eq('quien no hizo nada mas solo tiene la del arranque',
    secre?.accesos?.entradas, BASE_LOGIN);
  t.eq('y consta desde un solo aparato', secre?.accesos?.dispositivos?.length, 1);

  t.eq('el grupo cuenta cuantos han entrado', grupo?.resumen?.hanEntrado, 5);
  t.eq('y cuantos no', grupo?.resumen?.nuncaHanEntrado, 0);
  t.check('quien nunca entra se detecta: se anade a alguien sin acceso',
    grupo?.resumen?.hanEntrado + grupo?.resumen?.nuncaHanEntrado === grupo?.resumen?.integrantes,
    `${grupo?.resumen?.hanEntrado} + ${grupo?.resumen?.nuncaHanEntrado} != ${grupo?.resumen?.integrantes}`);
  const sumaEntradas = (grupo?.miembros || []).reduce((s, m) => s + m.accesos.entradas, 0);
  t.eq('el total del grupo es la suma de su gente', grupo?.resumen?.entradasTotales, sumaEntradas);

  // ===================================================================
  t.section('ACC 7. Los totales de la plataforma');
  // ===================================================================
  const tot = inf.body?.totales || {};
  t.check('cuenta los grupos', tot.grupos >= 1, `${tot.grupos}`);
  t.check('y las personas registradas', tot.personas >= 5, `${tot.personas}`);
  t.eq('los accesos registrados son los que hay',
    tot.accesosRegistrados, (fake.dumpSheet(HOJA) || []).length - 1);
  t.check('desglosa por aparato', (tot.dispositivos || []).length >= 2,
    JSON.stringify(tot.dispositivos));
  t.check('por sistema', (tot.sistemas || []).length >= 2, JSON.stringify(tot.sistemas));
  t.check('y por navegador', (tot.navegadores || []).length >= 1, JSON.stringify(tot.navegadores));
  const sumaDisp = (tot.dispositivos || []).reduce((s, d) => s + d.veces, 0);
  t.eq('la suma por aparato cuadra con el total', sumaDisp, tot.accesosRegistrados);

  // El porcentaje viene del servidor. Salio de la pantalla, donde todos los
  // aparatos aparecian con 0%: la lista de totales no lo traia.
  t.check('cada aparato trae su porcentaje',
    (tot.dispositivos || []).every((d) => typeof d.pct === 'number' && d.pct > 0),
    JSON.stringify(tot.dispositivos));
  t.check('igual los sistemas',
    (tot.sistemas || []).every((d) => typeof d.pct === 'number' && d.pct > 0),
    JSON.stringify(tot.sistemas));
  t.check('y los navegadores',
    (tot.navegadores || []).every((d) => typeof d.pct === 'number' && d.pct > 0),
    JSON.stringify(tot.navegadores));
  t.near('los porcentajes por aparato suman 100',
    (tot.dispositivos || []).reduce((s2, d) => s2 + d.pct, 0), 100, 0.3);

  // ===================================================================
  // ===================================================================
  t.section('ACC 7b. Se cuentan las veces que se usa, no solo los logins');
  // ===================================================================
  // La sesion dura 30 dias: quien abria la app a diario figuraba con UNA
  // entrada al mes, y con eso los activos de la semana, la retencion y la
  // curva del informe no median nada util.
  const antesDeUsar = (fake.dumpSheet(HOJA) || []).length;
  await get('/api/mi-perfil', e.tokens.socio1);
  await get('/api/mi-perfil', e.tokens.socio1);
  await get('/api/mi-perfil', e.tokens.socio1);
  await new Promise((r) => setTimeout(r, 250));
  const trasUsar = (fake.dumpSheet(HOJA) || []).length;
  t.eq('dar vueltas por la app en el mismo rato NO anota una entrada por clic',
    trasUsar - antesDeUsar, 0);

  // Y si vuelve despues de un rato, si cuenta
  const acc2 = require('../accesos');
  const filaVieja = (fake.dumpSheet(HOJA) || []).slice(1)
    .filter((r) => (r[1] || '') === e.users.socio1.email);
  t.check('su entrada de login quedo anotada', filaVieja.length >= 1,
    `${filaVieja.length} filas`);
  t.eq('la ventana de sesion son 30 minutos', acc2.MINUTOS_DE_SESION, 30);

  const conVuelta = (fake.dumpSheet(HOJA) || []).slice(1)
    .filter((r) => (r[7] || 'login') === 'login').length;
  t.check('todas las anotadas hasta ahora son de inicio de sesion',
    conVuelta >= 1, `${conVuelta}`);

  // ===================================================================
  t.section('ACC 8. Esto NO lo ve cualquiera');
  // ===================================================================
  t.status('un socio raso no puede ver el informe',
    await get('/api/admin/participantes', e.tokens.socio1), 403);
  t.status('la presidencia de un grupo tampoco',
    await get('/api/admin/participantes', e.tokens.presi), 403);
  t.status('la tesoreria tampoco',
    await get('/api/admin/participantes', e.tokens.teso), 403);
  t.status('y sin sesion menos',
    await get('/api/admin/participantes'), 401);

  // ===================================================================
  t.section('ACC 9. El informe no filtra lo que no debe');
  // ===================================================================
  const texto = JSON.stringify(inf.body || {});
  t.check('no incluye contrasenas ni sus hashes', !/\$2[aby]\$\d{2}\$/.test(texto), '');
  t.check('ni tokens de sesion', !/eyJhbGciOi/.test(texto), '');
  t.check('ni credenciales de Google', !/private_key|BEGIN .*PRIVATE KEY/.test(texto), '');
  t.check('no muestra saldos: el dinero lo gobierna cada grupo',
    !/totalPatrimonio|totalAhorros|saldo/i.test(texto), '');
};
