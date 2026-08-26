#!/usr/bin/env node
/**
 * Verificador de despliegue. SOLO LECTURA: no escribe nada en la hoja de calculo.
 *
 *   node test/verificar-produccion.js
 *   node test/verificar-produccion.js https://backend-appahorro.onrender.com https://juntago.com
 *
 * ADVERTENCIA sobre como se comprueba que el codigo nuevo esta publicado:
 * el backend tiene un porton global que responde 401 a CUALQUIER ruta que no
 * este en la lista publica, incluidas las que no existen. Por eso preguntar
 * por un endpoint nuevo NO distingue "ya esta" de "todavia no": ambas cosas
 * devuelven 401. Lo unico que lo prueba es que el propio servidor declare su
 * version en /api/ping, que si es publico.
 */

const BASE = (process.argv[2] || 'https://backend-appahorro.onrender.com').replace(/\/+$/, '');
const ORIGEN_WEB = (process.argv[3] || 'https://juntago.com').replace(/\/+$/, '');
const VERSION_ESPERADA = '2026.08.26-control-interno';

const V = '\x1b[32m';
const R = '\x1b[31m';
const A = '\x1b[33m';
const G = '\x1b[90m';
const N = '\x1b[0m';
const B = '\x1b[1m';

let ok = 0;
let fallas = 0;
const problemas = [];

function marcar(bien, titulo, detalle) {
  if (bien) {
    ok += 1;
    console.log(`  ${V}OK${N}  ${titulo}`);
  } else {
    fallas += 1;
    problemas.push(`${titulo}${detalle ? `\n    ${detalle}` : ''}`);
    console.log(`  ${R}FALLA${N}  ${titulo}${detalle ? `\n         ${R}${detalle}${N}` : ''}`);
  }
}

async function pedir(ruta, opciones = {}) {
  const control = new AbortController();
  const corte = setTimeout(() => control.abort(), opciones.timeout || 90000);
  try {
    const res = await fetch(`${BASE}${ruta}`, { ...opciones, signal: control.signal, redirect: 'manual' });
    const texto = await res.text();
    let cuerpo = null;
    try { cuerpo = JSON.parse(texto); } catch (e) { cuerpo = null; }
    return { status: res.status, body: cuerpo, texto, headers: res.headers };
  } catch (e) {
    return { status: 0, body: null, texto: e.message, headers: new Headers() };
  } finally {
    clearTimeout(corte);
  }
}

(async () => {
  console.log(`\n${B}Verificando el backend publicado${N}`);
  console.log(`${G}  servidor: ${BASE}`);
  console.log(`  origen web esperado: ${ORIGEN_WEB}${N}\n`);

  // ---------------------------------------------------------------- 1
  console.log(`${B}1. El servidor responde${N}`);
  console.log(`  ${G}si estaba dormido, Render tarda hasta 60 s en despertar${N}`);
  const inicio = Date.now();
  const ping = await pedir('/api/ping');
  const tardo = ((Date.now() - inicio) / 1000).toFixed(1);
  marcar(ping.status === 200, `/api/ping responde 200 (${tardo} s)`,
    ping.status === 0 ? `no hubo respuesta: ${ping.texto}` : `devolvio ${ping.status}`);

  if (ping.status !== 200) {
    console.log(`\n${R}El backend no responde. Abre los Logs en el panel de Render.${N}\n`);
    process.exit(1);
  }

  // ---------------------------------------------------------------- 2
  console.log(`\n${B}2. Es el codigo nuevo, no el anterior${N}`);
  const versionViva = (ping.body && ping.body.version) || null;
  marcar(!!versionViva,
    'el servidor declara su version',
    'la respuesta de /api/ping no trae "version": Render sigue sirviendo la version ANTERIOR');
  if (versionViva) {
    marcar(versionViva === VERSION_ESPERADA,
      `la version publicada es ${versionViva}`,
      `se esperaba ${VERSION_ESPERADA}. Render no ha terminado de desplegar, o desplego otro commit`);
  }
  marcar(ping.body && ping.body.controlInterno === true,
    'el modulo de control interno esta cargado (/api/gob/*)',
    'controlInterno no es true: governance.js no se subio o fallo al registrarse. Revisa los Logs de Render');

  // ---------------------------------------------------------------- 3
  console.log(`\n${B}3. La web podra hablar con el backend (CORS)${N}`);
  const conOrigen = await pedir('/api/ping', { headers: { Origin: ORIGEN_WEB } });
  const permitido = conOrigen.headers.get('access-control-allow-origin');
  marcar(permitido === ORIGEN_WEB || permitido === '*',
    `el servidor acepta peticiones desde ${ORIGEN_WEB}`,
    permitido
      ? `solo acepta "${permitido}". Corrige FRONTEND_ORIGINS en Render`
      : 'no devolvio cabecera CORS. Si FRONTEND_ORIGINS esta definido, este dominio no esta en la lista');

  const preflight = await pedir('/api/login', {
    method: 'OPTIONS',
    headers: {
      Origin: ORIGEN_WEB,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type,authorization',
    },
  });
  marcar([200, 204].includes(preflight.status),
    'el navegador podra enviar el token en la cabecera Authorization',
    `la consulta previa del navegador devolvio ${preflight.status}`);

  // ---------------------------------------------------------------- 4
  console.log(`\n${B}4. Llega a la hoja de calculo${N}`);
  const login = await pedir('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'no-existe@verificacion.local', password: 'x' }),
  });
  marcar([400, 401, 404].includes(login.status),
    'el inicio de sesion consulta la hoja y niega a un usuario inexistente',
    login.status === 500
      ? 'devolvio 500: revisa GOOGLE_CREDENTIALS y SPREADSHEET_ID en Render, y que la cuenta de servicio siga compartida en la hoja'
      : `devolvio ${login.status}`);
  marcar(!/private_key|BEGIN PRIVATE KEY|juntago-dev-secret/.test(login.texto || ''),
    'no se filtran credenciales ni el secreto de desarrollo en las respuestas', '');

  // ---------------------------------------------------------------- 5
  console.log(`\n${B}5. La puerta esta cerrada por defecto${N}`);
  for (const [ruta, nombre] of [
    ['/api/obtener-usuarios', 'Listado de usuarios'],
    ['/api/resumen-admin', 'Resumen de administracion'],
    ['/api/obtener-grupos', 'Listado de grupos'],
    ['/api/gob/tablero?groupId=X', 'Tablero del grupo'],
    ['/api/gob/bitacora?groupId=X', 'Bitacora'],
  ]) {
    const r = await pedir(ruta);
    marcar(r.status === 401, `${nombre} exige sesion`, `devolvio ${r.status}; deberia ser 401`);
  }

  const traversal = await pedir('/api/payment-image/..%2F..%2Fserver.js');
  marcar(traversal.status !== 200,
    'no se puede descargar un archivo fuera de la carpeta de comprobantes',
    'devolvio 200: hay fuga de archivos');

  const conBasura = await pedir('/api/obtener-usuarios', { headers: { Authorization: 'Bearer token-falso' } });
  marcar(conBasura.status === 401, 'un token inventado no abre nada', `devolvio ${conBasura.status}`);

  // ---------------------------------------------------------------- fin
  console.log(`\n${'-'.repeat(60)}`);
  console.log(`  Comprobaciones: ${ok + fallas}   ${V}OK: ${ok}${N}   ${fallas ? R : ''}FALLAS: ${fallas}${N}`);
  console.log(`${G}  Sin iniciar sesion no se puede probar mas: todo lo demas exige${N}`);
  console.log(`${G}  token. Esa parte se comprueba entrando a la web.${N}`);
  if (fallas) {
    console.log(`\n${R}${B}Pendiente por resolver:${N}`);
    problemas.forEach((p) => console.log(`  - ${p}`));
    console.log('');
    process.exit(1);
  }
  console.log(`\n${V}${B}El backend publicado es el correcto.${N}\n`);
})();
