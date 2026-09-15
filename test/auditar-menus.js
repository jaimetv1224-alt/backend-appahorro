#!/usr/bin/env node
/**
 * Revisa, rol por rol, que todo lo que la app OFRECE se pueda usar de verdad:
 * recorre los menus, sigue cada enlace interno y comprueba que no rebote, que
 * no quede en blanco y que no ofrezca cosas que esa persona no puede hacer.
 *
 * Responde a "revisar cada apartado de cada usuario lo que falte".
 */

'use strict';

const { Navegador, dormir } = require('./cdp');

const WEB = process.env.WEB_URL || 'http://localhost:5191';
const API = process.env.API_URL || 'http://localhost:3001';
const CLAVE = 'Clave123';

const ROLES = {
  'socio raso': 'jose@demo.test',
  tesoreria: 'luis@demo.test',
  presidencia: 'rosa@demo.test',
  secretaria: 'nelly@demo.test',
  'admin de plataforma': 'admin@demo.test',
};

// Pantallas desde las que se recogen los enlaces del menu
const PUNTOS_DE_PARTIDA = ['/group', '/more', '/assembly', '/dashboard', '/admin-dashboard'];

// Lo que NINGUN socio raso deberia poder abrir
const SOLO_DIRECTIVA = ['/grupo/aprobaciones', '/grupo/prestamos/aprobar', '/grupo/comprobantes', '/grupo/apertura'];
// Lo que NADIE fuera del admin deberia poder abrir
// Botones que NO se pulsan: cierran sesion, borran, o mueven dinero
const PELIGROSOS = /salir|cerrar sesi|logout|eliminar|borrar|quitar|rechazar|desactivar|revertir|aplicar|confirmar|guardar|enviar|solicitar|comprar|votar|aprobar|registrar|crear/i;

const SOLO_ADMIN = ['/admin-dashboard', '/user-management', '/group-management-advanced', '/reports',
  '/admin/participantes', '/admin/indicadores'];

const V = '\x1b[32m'; const R = '\x1b[31m'; const A = '\x1b[33m';
const G = '\x1b[90m'; const N = '\x1b[0m'; const B = '\x1b[1m';

let ok = 0; let mal = 0;
const marca = (bien, txt, det) => {
  if (bien) { ok += 1; console.log(`  ${V}ok${N}    ${txt}`); }
  else { mal += 1; console.log(`  ${R}FALLA${N} ${txt}${det ? `\n         ${R}${det}${N}` : ''}`); }
};

const sesion = (correo) => `
  localStorage.setItem('theme','light');
  const r = await fetch('${API}/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email:'${correo}',password:'${CLAVE}'})});
  const d = await r.json();
  localStorage.setItem('token', d.token);
  localStorage.setItem('user', JSON.stringify(d.user));
  return d.user ? d.user.email : 'sin sesion';`;

// Recoge los destinos internos que la pantalla ofrece: enlaces y botones que
// navegan. Los botones de React no llevan href, asi que tambien se leen los
// textos para detectar opciones muertas.
const RECOGER = `
  const rutas = new Set();
  document.querySelectorAll('a[href^="/"]').forEach((a) => {
    const h = a.getAttribute('href');
    if (h && !h.startsWith('//')) rutas.add(h.split('?')[0]);
  });
  const opciones = [...document.querySelectorAll('button')]
    .map((b) => (b.textContent || '').replace(/\\s+/g, ' ').trim())
    .filter((t) => t.length > 2 && t.length < 46);
  return { rutas: [...rutas], opciones };
`;

const ESTADO = `
  const t = (document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  return { ruta: window.location.pathname, vacio: t.length < 40, largo: t.length,
           error: /algo sali\\u00f3 mal|no se pudo cargar|Error:/i.test(t) };
`;

(async () => {
  for (const url of [WEB, `${API}/api/ping`]) {
    const r = await fetch(url).catch(() => null);
    if (!r || !r.ok) { console.log(`\n  FALTA ${url}\n`); process.exit(1); }
  }

  const nav = new Navegador({ ancho: 1360, alto: 950, escala: 1 });
  await nav.abrir();

  try {
    for (const [rol, correo] of Object.entries(ROLES)) {
      console.log(`\n${B}  === ${rol.toUpperCase()} (${correo}) ===${N}`);
      await nav.ir(`${WEB}/login`, 1100);
      await nav.evaluar(sesion(correo));

      // --- 1. Recoger todo lo que se le ofrece ---
      const ofrecidas = new Set();
      const menus = [];
      for (const inicio of PUNTOS_DE_PARTIDA) {
        await nav.ir(`${WEB}${inicio}`, 2000);
        await dormir(900);
        const est = await nav.evaluar(ESTADO);
        if (est.ruta !== inicio) continue; // le rebotaron: no es suyo, se salta
        const r = await nav.evaluar(RECOGER);
        r.rutas.forEach((x) => ofrecidas.add(x));
        menus.push(...r.opciones);
      }
      console.log(`${G}         ${ofrecidas.size} destinos ofrecidos, ${new Set(menus).size} opciones de menu${N}`);

      // --- 2. PULSAR cada opcion del menu ---
      // Esta app navega con botones, no con enlaces, asi que hay que pulsarlos
      // de verdad para saber a donde llevan y si llegan a algun sitio.
      const rotas = [];
      const visitadas = new Set();
      for (const inicio of PUNTOS_DE_PARTIDA) {
        await nav.ir(`${WEB}${inicio}`, 1900);
        await dormir(800);
        if ((await nav.evaluar(ESTADO)).ruta !== inicio) continue;

        const cuantos = await nav.evaluar(`
          return [...document.querySelectorAll('button')]
            .filter((b) => !${JSON.stringify(PELIGROSOS.source)} || true).length;`);

        for (let i = 0; i < cuantos; i += 1) {
          await nav.ir(`${WEB}${inicio}`, 1500);
          await dormir(600);
          const info = await nav.evaluar(`
            const bs = [...document.querySelectorAll('button')];
            const b = bs[${i}];
            if (!b || b.disabled) return { saltar: true };
            const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
            if (!t || t.length > 46) return { saltar: true };
            if (new RegExp(${JSON.stringify(PELIGROSOS.source)}, 'i').test(t)) return { saltar: true, t };
            b.scrollIntoView({ block: 'center' });
            b.click();
            return { saltar: false, t };`);
          if (info.saltar) continue;
          await dormir(1100);
          const est = await nav.evaluar(ESTADO);
          if (est.ruta === inicio) continue;         // abrio un panel, no navego
          if (visitadas.has(est.ruta)) continue;
          visitadas.add(est.ruta);
          if (est.vacio) rotas.push(`"${info.t}" -> ${est.ruta} queda en blanco`);
          else if (est.error) rotas.push(`"${info.t}" -> ${est.ruta} muestra un error`);
        }
      }
      marca(rotas.length === 0,
        `todas las opciones del menu llevan a una pantalla que carga (${visitadas.size} destinos pulsados)`,
        rotas.join(' | '));
      visitadas.forEach((v) => ofrecidas.add(v));

      // --- 3. Que NO se le ofrezca lo que no le toca ---
      const esDirectiva = ['tesoreria', 'presidencia', 'secretaria'].includes(rol);
      const esAdmin = rol === 'admin de plataforma';

      if (!esDirectiva) {
        const indebidas = SOLO_DIRECTIVA.filter((x) => ofrecidas.has(x));
        marca(indebidas.length === 0,
          'no se le ofrecen las pantallas de gobierno del grupo', indebidas.join(', '));
      }
      if (!esAdmin) {
        const indebidas = SOLO_ADMIN.filter((x) => ofrecidas.has(x));
        marca(indebidas.length === 0,
          'no se le ofrece el panel de plataforma', indebidas.join(', '));
      }
      if (esAdmin) {
        const gobierno = [...ofrecidas].filter((x) => SOLO_DIRECTIVA.includes(x));
        marca(gobierno.length === 0,
          'al admin de plataforma no se le ofrece gobernar grupos ajenos', gobierno.join(', '));
        const aprobar = menus.filter((t) => /^aprobar|revisar pagos|config\.? grupo/i.test(t));
        marca(aprobar.length === 0,
          'ni botones para aprobar creditos de un grupo', aprobar.join(' | '));
      }

      // --- 4. Que las puertas cerradas sigan cerradas ---
      if (!esDirectiva && !esAdmin) {
        const coladas = [];
        for (const ruta of SOLO_DIRECTIVA) {
          await nav.ir(`${WEB}${ruta}`, 1900);
          await dormir(800);
          const est = await nav.evaluar(ESTADO);
          if (est.ruta === ruta) coladas.push(ruta);
        }
        marca(coladas.length === 0,
          'y escribiendo la direccion a mano tampoco entra', coladas.join(', '));
      }
    }
  } finally {
    await nav.cerrar();
  }

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`  Comprobaciones: ${ok + mal}   ${V}OK: ${ok}${N}   ${mal ? R : ''}FALLAS: ${mal}${N}\n`);
  process.exit(mal ? 1 : 0);
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
