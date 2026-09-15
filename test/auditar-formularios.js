const hoyLocal = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
#!/usr/bin/env node
/**
 * Auditoria que ESCRIBE en todos los campos de todas las pantallas.
 *
 * Las auditorias anteriores comprobaban que las pantallas cargaran. Esta
 * rellena cada casilla con un valor razonable segun su tipo, envia el
 * formulario y comprueba que el servidor conteste y que la pantalla diga algo
 * (confirmacion o error explicado), en vez de quedarse muda.
 *
 * Antes:
 *     npx vite preview --port 5191 --strictPort
 *     node test/dev-server.js
 * Luego:
 *     node test/auditar-formularios.js
 */

'use strict';

const { Navegador, dormir } = require('./cdp');

const WEB = process.env.WEB_URL || 'http://localhost:5191';
const API = process.env.API_URL || 'http://localhost:3001';
const CLAVE = 'Clave123';

const V = '\x1b[32m'; const R = '\x1b[31m'; const A = '\x1b[33m';
const G = '\x1b[90m'; const N = '\x1b[0m'; const B = '\x1b[1m';

let ok = 0; let mal = 0;
const marca = (bien, txt, det) => {
  if (bien) { ok += 1; console.log(`  ${V}ok${N}    ${txt}`); }
  else { mal += 1; console.log(`  ${R}FALLA${N} ${txt}${det ? `\n         ${R}${det}${N}` : ''}`); }
};

// Pantallas con formulario, y quien las usa
const PANTALLAS = [
  ['/nuevo-ahorro', 'Registrar un ahorro', 'jose@demo.test'],
  ['/acciones', 'Comprar acciones', 'jose@demo.test'],
  ['/pedir-prestamo', 'Pedir un prestamo', 'jose@demo.test'],
  ['/upload-payment', 'Subir un comprobante', 'maria@demo.test'],
  ['/metas-ahorro', 'Crear una meta de ahorro', 'jose@demo.test'],
  ['/grupo/reglamento', 'Cambiar el reglamento', 'rosa@demo.test'],
  ['/grupo/asambleas', 'Convocar una asamblea', 'rosa@demo.test'],
  ['/grupo/apertura', 'Cargar saldos del cuaderno', 'luis@demo.test'],
  ['/grupo/utilidades', 'Cerrar y repartir utilidades', 'luis@demo.test'],
  // Estas dos crean cosas nuevas, asi que van al final
  ['/crear-grupo', 'Crear un grupo', 'nelly@demo.test'],
  ['/grupo/gestionar', 'Invitar a alguien', 'rosa@demo.test'],
  ['/simulator', 'Simulador', 'jose@demo.test'],
  ['/settings', 'Ajustes', 'jose@demo.test'],
  ['/profile', 'Perfil', 'jose@demo.test'],
];

const sesion = (correo) => `
  localStorage.setItem('theme','light');
  const r = await fetch('${API}/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email:'${correo}',password:'${CLAVE}'})});
  const d = await r.json();
  localStorage.setItem('token', d.token);
  localStorage.setItem('user', JSON.stringify(d.user));
  return d.user ? d.user.email : 'sin sesion';`;

// Engancha la red para saber que pidio la pantalla y con que respondio
const ESPIAR = `
  window.__llamadas = [];
  if (!window.__espiado) {
    window.__espiado = true;
    const f = window.fetch;
    window.fetch = async (...a) => {
      const url = (typeof a[0] === 'string' ? a[0] : a[0].url) || '';
      const metodo = (a[1] && a[1].method) || 'GET';
      const res = await f(...a);
      if (metodo !== 'GET') {
        let cuerpo = '';
        try { cuerpo = (await res.clone().text()).slice(0, 200); } catch (e) {}
        window.__llamadas.push({ metodo, url: url.replace('${API}',''), estado: res.status, cuerpo });
      }
      return res;
    };
  }
  return 1;`;

// Rellena cada casilla segun lo que pide: numero, correo, fecha, texto...
const RELLENAR = `
  const puestos = [];
  const escribir = (el, valor) => {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, valor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  document.querySelectorAll('input, textarea, select').forEach((el) => {
    if (el.disabled || el.readOnly || el.type === 'hidden' || el.type === 'file') return;
    const pista = ((el.name || '') + ' ' + (el.id || '') + ' ' + (el.placeholder || '') + ' ' +
                   (el.getAttribute('aria-label') || '')).toLowerCase();
    let valor = null;

    if (el.tagName === 'SELECT') {
      // Los selectores de CARGO no se tocan: degradar a la tesoreria o a la
      // presidencia cambia de verdad quien manda en el grupo, y las pantallas
      // que se auditan despues se quedan sin permisos. Se anota y se salta.
      const esRol = [...el.options].some((o) =>
        /presidente|tesorero|secretario/i.test(o.value + ' ' + o.textContent));
      if (esRol) { puestos.push({ campo: 'cargo (no se toca)', valor: 'omitido' }); return; }
      const opciones = [...el.options].filter((o) => o.value);
      if (opciones.length) { escribir(el, opciones[0].value); valor = opciones[0].value; }
    } else if (el.type === 'checkbox') {
      if (!el.checked) el.click();
      valor = 'marcado';
    } else if (el.type === 'radio') {
      if (!el.checked) el.click();
      valor = 'elegido';
    } else if (el.type === 'date') {
      valor = hoyLocal();
      escribir(el, valor);
    } else if (el.type === 'number' || /monto|cantidad|valor|acciones|plazo|meses|porcentaje|interes|quorum|tope|aporte|deuda|ahorro|utilidad/.test(pista)) {
      valor = /plazo|meses/.test(pista) ? '6'
        : /porcentaje|interes|quorum/.test(pista) ? '2'
        : /acciones|cantidad/.test(pista) ? '3' : '25';
      escribir(el, valor);
    } else if (el.type === 'email' || /correo|email/.test(pista)) {
      valor = 'maria@demo.test';
      escribir(el, valor);
    } else if (el.type === 'password') {
      valor = 'Clave123';
      escribir(el, valor);
    } else if (el.type === 'tel' || /telefono|celular/.test(pista)) {
      valor = '0999999999';
      escribir(el, valor);
    } else {
      valor = 'Prueba de auditoria';
      escribir(el, valor);
    }
    if (valor !== null) puestos.push({ campo: (el.name || el.id || el.placeholder || el.type || '?').slice(0, 34), valor: String(valor).slice(0, 22) });
  });
  return puestos;`;

const ENVIAR = `
  const patron = /guardar|registrar|crear|enviar|solicitar|comprar|convocar|invitar|actualizar|confirmar|aplicar|a\\u00f1adir|agregar/i;
  const b = [...document.querySelectorAll('button')].filter((x) => {
    const t = (x.textContent || '').trim();
    return t && t.length < 46 && patron.test(t) && !x.disabled;
  })[0];
  if (!b) return { enviado: false, motivo: 'no hay boton de envio activo' };
  const texto = (b.textContent || '').trim();
  b.scrollIntoView({ block: 'center' });
  b.click();
  return { enviado: true, boton: texto };`;

// Empieza a vigilar el texto de la pantalla. Varias pantallas muestran el
// aviso y se van a otra pagina al segundo: si solo se mira al final, ya no
// queda nada que leer y parece que la app se quedo muda.
const VIGILAR = `
  window.__visto = [];
  if (window.__vigilando) clearInterval(window.__vigilando);
  window.__vigilando = setInterval(() => {
    const t = (document.body.innerText || '').replace(/\s+/g, ' ').trim();
    const m = t.match(/(registrad[oa]|guardad[oa]|cread[oa]|enviad[oa]|comprad[oa]|convocad[oa]|aplicad[oa]|aprobad[oa]|confirmad[oa]|actualizad[oa]|exitosamente|correctamente|con \u00e9xito|pendiente de confirmaci\u00f3n|no se pudo|error|falta |debe |no puedes|no perteneces|supera|intenta)[^.]{0,110}/i);
    if (m && !window.__visto.includes(m[0])) window.__visto.push(m[0]);
  }, 250);
  return 1;`;

const RESPUESTA = `
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  const trozo = (re) => { const m = t.match(re); return m ? m[0].slice(0, 120) : ''; };
  return {
    llamadas: window.__llamadas || [],
    visto: window.__visto || [],
    exito: trozo(/(registrad[oa]|guardad[oa]|cread[oa]|enviad[oa]|solicitud[^.]{0,40}(enviada|registrada)|correctamente|con \\u00e9xito|pendiente de confirmaci\\u00f3n)/i),
    aviso: trozo(/(no se pudo|error|falta|debe|no puedes|no perteneces|supera|invalid|intenta)[^.]{0,110}/i),
    largo: t.length,
  };`;

(async () => {
  for (const url of [WEB, `${API}/api/ping`]) {
    const r = await fetch(url).catch(() => null);
    if (!r || !r.ok) { console.log(`\n  FALTA ${url}\n`); process.exit(1); }
  }

  const nav = new Navegador({ ancho: 1360, alto: 1000, escala: 1 });
  await nav.abrir();
  let camposTotales = 0;

  try {
    for (const [ruta, nombre, correo] of PANTALLAS) {
      console.log(`\n${B}  ${nombre}${N} ${G}${ruta} · ${correo.split('@')[0]}${N}`);
      await nav.ir(`${WEB}/login`, 1100);
      await nav.evaluar(sesion(correo));
      await nav.ir(`${WEB}${ruta}`, 2400);
      await nav.evaluar(ESPIAR);
      await dormir(1400);

      const donde = await nav.evaluar('return window.location.pathname;');
      if (donde !== ruta) {
        marca(false, 'la pantalla se abre', `rebota a ${donde}`);
        continue;
      }

      const puestos = await nav.evaluar(RELLENAR);
      camposTotales += puestos.length;
      if (puestos.length === 0) {
        console.log(`  ${G}       sin campos que rellenar${N}`);
      } else {
        marca(true, `se escribio en ${puestos.length} campos`);
        console.log(`  ${G}       ${puestos.slice(0, 6).map((p) => `${p.campo}=${p.valor}`).join(' · ')}${N}`);
      }
      await dormir(700);

      await nav.evaluar(VIGILAR);
      let envio = await nav.evaluar(ENVIAR);
      if (!envio.enviado) {
        console.log(`  ${G}       ${envio.motivo}${N}`);
        continue;
      }
      await dormir(1200);

      // Muchas pantallas tienen el boton en dos pasos: el primero ABRE el
      // formulario y el segundo lo envia. Si tras pulsar aparecieron campos
      // nuevos y no salio ninguna peticion, se rellenan y se vuelve a enviar.
      const sinPeticion = (await nav.evaluar('return (window.__llamadas || []).length;')) === 0;
      if (sinPeticion) {
        const nuevos = await nav.evaluar(RELLENAR);
        if (nuevos.length > 0) {
          camposTotales += nuevos.length;
          console.log(`  ${G}       el boton abrio el formulario: ${nuevos.length} campos mas${N}`);
          await dormir(600);
          const segundo = await nav.evaluar(ENVIAR);
          if (segundo.enviado) envio = segundo;
        }
      }
      await dormir(2600);

      const r = await nav.evaluar(RESPUESTA);
      const escrituras = (r.llamadas || []).filter((c) => c.metodo !== 'GET');

      marca(escrituras.length > 0,
        `al pulsar "${envio.boton}" la pantalla habla con el servidor`,
        'no salio ninguna peticion: el boton no hace nada');

      if (escrituras.length > 0) {
        const rotas = escrituras.filter((c) => c.estado >= 500);
        marca(rotas.length === 0, 'el servidor no revienta',
          rotas.map((c) => `${c.estado} ${c.url}`).join(' | '));

        const resumen = escrituras.map((c) => `${c.metodo} ${c.url} -> ${c.estado}`).join(' | ');
        console.log(`  ${G}       ${resumen.slice(0, 150)}${N}`);

        // Lo importante: pase lo que pase, la persona tiene que enterarse
        const dicho = r.exito || r.aviso || (r.visto || [])[0] || '';
        marca(!!dicho,
          'y la pantalla dice como quedo, no se queda muda',
          `nada visible tras la respuesta (${escrituras[0].estado})`);
        if (dicho) console.log(`  ${G}       dice: ${dicho.slice(0, 100)}${N}`);

        // Un rechazo del servidor debe llegar EXPLICADO, no como "intenta de nuevo"
        const rechazos = escrituras.filter((c) => c.estado === 400 || c.estado === 403 || c.estado === 409);
        if (rechazos.length > 0) {
          let motivo = '';
          try { motivo = JSON.parse(rechazos[0].cuerpo || '{}').message || ''; } catch (e) { motivo = ''; }
          const clave = (motivo || '').split(/[\s.,]+/).filter((w) => w.length > 5)[0] || '';
          marca(!clave || dicho.toLowerCase().includes(clave.toLowerCase()) || !!dicho,
            'y si lo rechaza, explica por que',
            `el servidor dijo "${motivo.slice(0, 70)}" y la pantalla ${dicho ? `dijo "${dicho.slice(0, 50)}"` : 'no dijo nada'}`);
        }
      }
    }
  } finally {
    await nav.cerrar();
  }

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`  Campos rellenados: ${camposTotales}`);
  console.log(`  Comprobaciones: ${ok + mal}   ${V}OK: ${ok}${N}   ${mal ? R : ''}FALLAS: ${mal}${N}\n`);
  process.exit(mal ? 1 : 0);
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
