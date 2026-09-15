/**
 * SUITE 37 - Que lo que se sube a Hostinger este completo.
 *
 * Esta bateria no toca el servidor: mira la carpeta `dist/`, que es exactamente
 * lo que se sube a Hostinger, y comprueba que no falte nada de lo que la app
 * pide al navegador.
 *
 * Sale de un fallo real: el fondo de las pantallas estaba escrito como
 * `url('/public/ahorro-pattern.svg')`. Vite publica lo que hay en `public/`
 * DESDE LA RAIZ, asi que la direccion correcta es `/ahorro-pattern.svg` y esa
 * peticion daba 404 en produccion. Como era un fondo decorativo nadie lo veia:
 * solo aparece si alguien se pone a mirar las peticiones fallidas.
 *
 * Lo mismo puede pasar manana con el logo, con el tipo de letra o con una
 * plantilla de Excel, y ahi si se nota. Aqui queda comprobado.
 */

const fs = require('fs');
const path = require('path');
const t = require('./runner');

const RAIZ = path.resolve(__dirname, '..', '..');
const DIST = path.join(RAIZ, 'dist');

/** Todas las direcciones absolutas de archivo que aparecen en un texto. */
function rutasDe(texto) {
  const patron = /["'(](\/[A-Za-z0-9_\-./]+\.(?:svg|png|jpg|jpeg|webp|gif|woff2?|ttf|xlsx|csv|ico|json|webmanifest))["')]/g;
  const salida = new Set();
  let m = patron.exec(texto);
  while (m) { salida.add(m[1]); m = patron.exec(texto); }
  return salida;
}

function archivos(dir, filtro, acc = []) {
  for (const nombre of fs.readdirSync(dir)) {
    const completo = path.join(dir, nombre);
    if (fs.statSync(completo).isDirectory()) {
      if (nombre === 'node_modules' || nombre === '.git') continue;
      archivos(completo, filtro, acc);
    } else if (filtro(nombre)) {
      acc.push(completo);
    }
  }
  return acc;
}

module.exports = async function run() {
  // ===================================================================
  t.section('PAQ 1. El paquete que se sube existe y trae lo esencial');
  // ===================================================================
  if (!fs.existsSync(DIST)) {
    t.check('la carpeta dist existe (corre `npx vite build` antes)', false, DIST);
    return;
  }
  t.check('la carpeta dist existe', true, '');
  for (const nombre of ['index.html', 'manifest.webmanifest', 'sw.js', 'juntago-logo-cuadrado.svg']) {
    t.check(`dist trae ${nombre}`, fs.existsSync(path.join(DIST, nombre)), nombre);
  }

  // ===================================================================
  t.section('PAQ 2. Ningun archivo que la app pide se queda fuera');
  // ===================================================================
  // Lo que piden el HTML y el CSS ya compilados: es lo que de verdad va a
  // pedir el navegador de la socia.
  const compilados = [
    path.join(DIST, 'index.html'),
    ...archivos(path.join(DIST, 'assets'), (n) => n.endsWith('.css')),
  ];
  const pedidas = new Set();
  for (const f of compilados) {
    for (const r of rutasDe(fs.readFileSync(f, 'utf8'))) pedidas.add(r);
  }
  // Y lo que pide el codigo fuente, por si algo no llega a compilarse.
  for (const f of archivos(path.join(RAIZ, 'src'), (n) => /\.(jsx?|pcss|css)$/.test(n))) {
    for (const r of rutasDe(fs.readFileSync(f, 'utf8'))) pedidas.add(r);
  }

  const faltan = [...pedidas].filter((r) => !fs.existsSync(path.join(DIST, r)));
  t.check(`las ${pedidas.size} direcciones de archivo apuntan a algo que existe`,
    faltan.length === 0, faltan.join(', '));

  // El fallo concreto que dio origen a esta bateria.
  const conPublic = [...pedidas].filter((r) => r.startsWith('/public/'));
  t.check('ninguna empieza por /public/ (Vite publica esa carpeta desde la raiz)',
    conPublic.length === 0, conPublic.join(', '));

  // ===================================================================
  t.section('PAQ 3. El manifiesto es valido y sus iconos existen');
  // ===================================================================
  const man = JSON.parse(fs.readFileSync(path.join(DIST, 'manifest.webmanifest'), 'utf8'));
  t.check('tiene nombre y nombre corto', !!man.name && !!man.short_name, JSON.stringify(man.name));
  t.eq('arranca en la raiz', man.start_url, '/');
  t.check('tiene al menos un icono', (man.icons || []).length > 0, '');
  const iconosRotos = (man.icons || [])
    .map((i) => i.src).filter((src) => !fs.existsSync(path.join(DIST, src)));
  t.check('todos los iconos existen', iconosRotos.length === 0, iconosRotos.join(', '));
  t.check('el logo no esta vacio',
    fs.statSync(path.join(DIST, 'juntago-logo-cuadrado.svg')).size > 500, '');

  const atajosRotos = (man.shortcuts || []).map((s) => s.url)
    .filter((u) => !/^\/[a-z0-9-]*$/i.test(u));
  t.check('los atajos apuntan a rutas de la app', atajosRotos.length === 0, atajosRotos.join(', '));

  const rutasApp = fs.readFileSync(path.join(RAIZ, 'src', 'App.jsx'), 'utf8');
  const atajosSinRuta = (man.shortcuts || []).map((s) => s.url)
    .filter((u) => !rutasApp.includes(`path="${u}"`));
  t.check('y esas rutas existen de verdad en la app',
    atajosSinRuta.length === 0, atajosSinRuta.join(', '));

  // ===================================================================
  t.section('PAQ 4. El trabajador de segundo plano no guarda dinero');
  // ===================================================================
  // Es la regla que no se puede romper: un saldo viejo servido como si fuera de
  // ahora es peor que no ver nada, porque la socia decide con el.
  const sw = fs.readFileSync(path.join(DIST, 'sw.js'), 'utf8');
  t.check('deja pasar /api/ sin tocarlo',
    /url\.pathname\.startsWith\('\/api\/'\)[\s\S]{0,40}return;/.test(sw), '');
  t.check('solo se mete con su propia direccion',
    sw.includes('url.origin !== self.location.origin'), '');
  t.check('la navegacion va primero a la red',
    sw.indexOf('await fetch(peticion)') < sw.indexOf("caches.match('/index.html')"), '');
  t.check('borra las versiones viejas al activarse',
    sw.includes('caches.delete'), '');

  const esenciales = (sw.match(/ESENCIALES = \[([\s\S]*?)\]/) || [])[1] || '';
  const esencialesRotos = [...esenciales.matchAll(/'([^']+)'/g)].map((m) => m[1])
    .filter((r) => r !== '/' && !fs.existsSync(path.join(DIST, r)));
  t.check('los archivos que guarda para abrir sin senal existen',
    esencialesRotos.length === 0, esencialesRotos.join(', '));

  // ===================================================================
  t.section('PAQ 5. No se sube nada que no deba subirse');
  // ===================================================================
  const sospechosos = archivos(DIST, (n) => (
    n === '.env' || n.endsWith('.log') || n.endsWith('.map') || n === 'credentials.json'
  ));
  t.check('sin .env, logs ni credenciales en el paquete',
    sospechosos.length === 0, sospechosos.map((f) => path.basename(f)).join(', '));

  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  t.check('el HTML no lleva localhost dentro',
    !/localhost|127\.0\.0\.1/.test(html), '');
  t.check('y se ve algo mientras carga (no una pantalla en blanco)',
    html.includes('Cargando'), '');

  // ===================================================================
  t.section('PAQ 6. Ninguna pantalla usa las ventanitas del navegador');
  // ===================================================================
  // La ventanita gris de `confirm`/`alert` en un Android barato se lee como un
  // error del telefono, trunca justo los avisos largos (los que mueven dinero)
  // y congela la pagina. Toda la app pasa por `src/components/Dialogos.jsx`.
  // Esto es lo unico que impide que vuelva a colarse una en el proximo cambio.
  const SRC = path.join(RAIZ, 'src');
  const fuentes = archivos(SRC, (n) => n.endsWith('.jsx') || n.endsWith('.js'));
  const conVentanita = [];
  for (const archivo of fuentes) {
    if (archivo.endsWith(path.join('components', 'Dialogos.jsx'))) continue;
    const texto = fs.readFileSync(archivo, 'utf8');
    const lineas = texto.split(String.fromCharCode(10));
    lineas.forEach((linea, i) => {
      const limpia = linea.replace(/\/\/.*$/, '');
      if (/(^|[^.\w])(window\.)?(alert|confirm|prompt)\s*\(/.test(limpia)
          && !/useConfirmar|usePedirTexto|useAvisar/.test(limpia)) {
        conVentanita.push(path.relative(RAIZ, archivo) + ':' + (i + 1));
      }
    });
  }
  t.check('cero alert/confirm/prompt del navegador fuera de Dialogos.jsx',
    conVentanita.length === 0, conVentanita.slice(0, 6).join(', '));

  // Un boton que solo dice "Proximamente" es una pantalla que no sirve.
  const proximamente = [];
  for (const archivo of fuentes) {
    const texto = fs.readFileSync(archivo, 'utf8');
    if (/Próximamente|Proximamente|Coming soon|En construcción/i.test(texto)) {
      proximamente.push(path.relative(RAIZ, archivo));
    }
  }
  t.check('ningun boton promete algo que todavia no existe',
    proximamente.length === 0, proximamente.slice(0, 6).join(', '));

  // Un control con `onClick={null}` se pinta igual que uno vivo: la socia lo
  // toca y no pasa nada. Salio de cuatro entradas de Ajustes que llevaban meses
  // muertas, tres de ellas con el contenido ya escrito y sin conectar.
  const muertos = [];
  for (const archivo of fuentes) {
    const texto = fs.readFileSync(archivo, 'utf8');
    const lineas = texto.split(String.fromCharCode(10));
    lineas.forEach((linea, i) => {
      if (/onClick=\{\s*(null|undefined|\(\)\s*=>\s*\{\s*\})\s*\}/.test(linea)) {
        muertos.push(path.relative(RAIZ, archivo) + ':' + (i + 1));
      }
    });
  }
  t.check('ningun boton se queda sin hacer nada al tocarlo',
    muertos.length === 0, muertos.slice(0, 6).join(', '));

  // ===================================================================
  t.section('PAQ 7. Nadie manda a la socia a pedirle algo al administrador');
  // ===================================================================
  // El administrador de la plataforma evalua el uso para la investigacion: no
  // mete a nadie en un grupo, no aprueba prestamos y no toca el dinero de nadie.
  // Salio de un mensaje real: quien no estaba en ningun grupo leia "No
  // perteneces a ningun grupo. Contacta al administrador." -- la mandaba a
  // pedirle a quien no puede darselo, en vez de a crear su grupo o mirar sus
  // invitaciones.
  const alAdmin = [];
  for (const archivo of fuentes) {
    const texto = fs.readFileSync(archivo, 'utf8');
    const lineas = texto.split(String.fromCharCode(10));
    // Sin barras invertidas a proposito: la primera version usaba un escape de expresion regular y una
    // capa de escapado lo dejo convertido en un caracter de RETROCESO invisible
    // dentro del patron, asi que esta comprobacion pasaba SIEMPRE sin mirar nada.
    // Se descubrio metiendo la frase a mano y viendo que seguia en verde.
    const MANDA_AL_ADMIN = new RegExp(
      '(contacta|contacte|contactar|habla|hable|comunicate|escribe)'
      + '[^.]{0,30}(al|con el|con la) +(administrador|admin)', 'i');
    lineas.forEach((linea, i) => {
      const codigo = linea.split('//')[0];
      if (MANDA_AL_ADMIN.test(codigo)) {
        alAdmin.push(path.relative(RAIZ, archivo) + ':' + (i + 1));
      }
    });
  }
  t.check('ninguna pantalla manda a la socia al administrador de la plataforma',
    alAdmin.length === 0, alAdmin.slice(0, 6).join(', '));
};
