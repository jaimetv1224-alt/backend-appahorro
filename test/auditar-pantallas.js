#!/usr/bin/env node
/**
 * Recorre TODAS las pantallas de la app con cada rol y anota lo que falla.
 *
 * Antes de ejecutarlo:
 *     npx vite build
 *     npx vite preview --port 5191 --strictPort
 *     node test/dev-server.js        (en otra terminal, deja el backend en 3001)
 *
 * Luego:
 *     node test/auditar-pantallas.js
 *
 * Para cada pantalla comprueba:
 *   - que cargue (no pantalla en blanco, no "algo salio mal")
 *   - errores en la consola del navegador
 *   - peticiones de red que fallan (4xx/5xx)
 *   - cifras sin sentido a la vista: NaN, undefined, $0.00 donde no toca,
 *     negativos en saldos y patrimonio
 */

'use strict';

const path = require('path');
const { Navegador, dormir } = require('./cdp');

const WEB = process.env.WEB_URL || 'http://localhost:5191';
const API = process.env.API_URL || 'http://localhost:3001';
const CLAVE = 'Clave123';

// Recien registrada y sin ningun grupo todavia: el primer estado de toda socia.
const SIN_GRUPO = 'nadie@demo.test';

const ROLES = {
  socio: 'jose@demo.test',
  tesorero: 'luis@demo.test',
  presidente: 'rosa@demo.test',
  admin: 'admin@demo.test',
};

// quien: 'todos' = cualquier sesion | 'admin' = solo el admin de plataforma
//        | 'directiva' = presidencia y tesoreria del grupo
const PANTALLAS = [
  ['/dashboard', 'Inicio', 'todos'],
  ['/group', 'Grupo', 'todos'],
  ['/assembly', 'Asamblea', 'todos'],
  ['/more', 'Mas', 'todos'],
  ['/profile', 'Perfil', 'todos'],
  ['/settings', 'Ajustes', 'todos'],
  ['/simulator', 'Simulador', 'todos'],
  ['/acciones', 'Comprar acciones', 'todos'],
  ['/pedir-prestamo', 'Pedir prestamo', 'todos'],
  ['/loan-management', 'Mis prestamos', 'todos'],
  ['/loan-payments-history', 'Historial de pagos', 'todos'],
  ['/upload-payment', 'Subir comprobante', 'todos'],
  ['/nuevo-ahorro', 'Nuevo ahorro', 'todos'],
  ['/historial-ahorros', 'Historial de ahorros', 'todos'],
  ['/metas-ahorro', 'Metas de ahorro', 'todos'],
  ['/savings-management', 'Gestion de ahorros', 'todos'],
  ['/user-savings', 'Ahorros del socio', 'todos'],
  ['/crear-grupo', 'Crear grupo', 'todos'],
  ['/invitaciones', 'Mis invitaciones', 'todos'],
  ['/grupo/gestionar', 'Gestionar miembros', 'todos'],
  ['/grupo/aportes', 'Caja del grupo', 'todos'],
  ['/grupo/reglamento', 'Reglamento', 'todos'],
  ['/grupo/asambleas', 'Asambleas', 'todos'],
  ['/grupo/apertura', 'Apertura de saldos', 'todos'],
  ['/grupo/utilidades', 'Reparto de utilidades', 'todos'],
  ['/grupo/salidas', 'Salidas y cierre', 'directiva'],
  ['/grupo/cartera', 'Cartera del grupo', 'directiva'],
  ['/admin-dashboard', 'Panel de administracion', 'admin'],
  ['/user-management', 'Gestion de usuarios', 'admin'],
  ['/group-management-advanced', 'Gestion de grupos avanzada', 'admin'],
  ['/loan-management-advanced', 'Gestion de prestamos avanzada', 'admin'],
  ['/reports', 'Informes', 'admin'],
  ['/admin/payment-review', 'Revision de pagos', 'admin'],
  ['/admin/loan-approval', 'Aprobacion de prestamos', 'admin'],
  ['/admin/participantes', 'Participantes del proyecto', 'admin'],
  ['/admin/indicadores', 'Indicadores de la plataforma', 'admin'],
  ['/grupo/aprobaciones', 'Aprobacion de solicitudes', 'admin'],
];

const AYUDAS = `
  window.__sesion = async (correo) => {
    localStorage.setItem('theme', 'light');
    const r = await fetch('${API}/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: correo, password: '${CLAVE}' }),
    });
    const d = await r.json();
    if (!d.token) return 'sin sesion';
    localStorage.setItem('token', d.token);
    localStorage.setItem('user', JSON.stringify(d.user));
    return d.user.email;
  };
  window.__errores = [];
  window.__red = [];
  if (!window.__enganchado) {
    window.__enganchado = true;
    const err = console.error;
    console.error = (...a) => { try { window.__errores.push(a.map(String).join(' ').slice(0, 300)); } catch (e) {} err(...a); };
    window.addEventListener('error', (e) => window.__errores.push('window.onerror: ' + (e.message || '')));
    window.addEventListener('unhandledrejection', (e) => window.__errores.push('promesa sin capturar: ' + String(e.reason).slice(0, 200)));
    const f = window.fetch;
    window.fetch = async (...a) => {
      const res = await f(...a);
      try {
        const u = (typeof a[0] === 'string' ? a[0] : a[0].url) || '';
        if (!res.ok) window.__red.push(res.status + '  ' + u.replace('${API}', ''));
      } catch (e) {}
      return res;
    };
  }
`;

// Lo que se busca a la vista, ya renderizado
const REVISION_EN_PAGINA = `
  const txt = document.body.innerText || '';
  const visible = txt.replace(/\\s+/g, ' ').trim();
  const halla = (re) => { const m = visible.match(re); return m ? m.slice(0, 4) : []; };
  return {
    vacio: visible.length < 40,
    texto: visible.slice(0, 160),
    nan: halla(/\\bNaN\\b/g).length,
    indefinido: halla(/\\bundefined\\b|\\bnull\\b/g).length,
    negativos: halla(/-\\s?\\$\\s?[\\d.,]+/g),
    errorVisible: halla(/(algo sali\\u00f3 mal|se produjo un error|error al |no se pudo|Error:|failed)/gi),
    ceros: (visible.match(/\\$\\s?0[.,]00/g) || []).length,
    // Lo que delata una pantalla atascada: el texto de espera, o una rueda
    // girando. Se compara entre dos pasadas para no confundir "esta cargando"
    // con "se quedo cargando".
    cargando: halla(/\b(cargando|consultando|calculando|leyendo|preparando)\b[^\u2026.]{0,40}(\u2026|\.\.\.)/gi),
    ruedas: document.querySelectorAll('[class*="spin"],[class*="Spin"],[data-cargando="true"]').length,
    errores: (window.__errores || []).slice(0, 6),
    red: (window.__red || []).slice(0, 8),
  };
`;


// Lo que solo se ve en un telefono: cosas que se salen del borde y letra ilegible.
const REVISION_MOVIL = `
  const ancho = document.documentElement.clientWidth;
  // Lo que se desplaza a proposito (una tabla ancha con overflow) no cuenta:
  // ahi el desborde es la solucion, no el problema.
  const enScrollAproposito = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowX;
      // 'hidden' y 'clip' recortan igual que 'auto': un adorno que sangra
      // dentro de una tarjeta esta CONTENIDO, no desbordado.
      if (o === 'auto' || o === 'scroll' || o === 'hidden' || o === 'clip') return true;
    }
    return false;
  };
  const fuera = [];
  const chica = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if ((r.right > ancho + 2 || r.left < -2) && !enScrollAproposito(el)) {
      if (fuera.length < 4) {
        fuera.push((el.tagName.toLowerCase()) + ' "' + (el.textContent || '').trim().slice(0, 32) + '"');
      }
    }
    const px = parseFloat(getComputedStyle(el).fontSize) || 16;
    const suyo = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 2);
    if (suyo && px < 10 && chica.length < 3) {
      chica.push(px.toFixed(1) + 'px: "' + (el.textContent || '').trim().slice(0, 30) + '"');
    }
  }
  return { ancho, desbordaBody: document.body.scrollWidth > ancho + 2, fuera, chica };
`;

const V = '\x1b[32m'; const R = '\x1b[31m'; const A = '\x1b[33m';
const G = '\x1b[90m'; const N = '\x1b[0m'; const B = '\x1b[1m';

(async () => {
  for (const url of [WEB, `${API}/api/ping`]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.log(`\n  FALTA ${url}: ${e.message}`);
      console.log('  Levanta:  npx vite preview --port 5191 --strictPort');
      console.log('            node test/dev-server.js\n');
      process.exit(1);
    }
  }

  const nav = new Navegador({ ancho: 1360, alto: 900, escala: 1 });
  await nav.abrir();
  const hallazgos = [];
  let revisadas = 0;

  try {
    for (const [rol, correo] of Object.entries(ROLES)) {
      console.log(`\n${B}  === ${rol.toUpperCase()} (${correo}) ===${N}`);
      await nav.ir(`${WEB}/login`, 1200);
      await nav.evaluar(AYUDAS + ` return await window.__sesion('${correo}');`);

      for (const [ruta, nombre, quien] of PANTALLAS) {
        if (quien === 'admin' && rol !== 'admin') continue;
        if (quien === 'directiva' && !['presidente', 'tesorero'].includes(rol)) continue;
        await nav.ir(`${WEB}${ruta}`, 1400);
        await nav.evaluar(AYUDAS + ' return 1;');
        await dormir(900);
        const r = await nav.evaluar(REVISION_EN_PAGINA);
        revisadas += 1;

        // Segunda mirada: con el backend local respondiendo al instante, lo que
        // siga cargando casi cuatro segundos despues es que se atasco.
        let atascada = null;
        if ((r.cargando || []).length > 0 || r.ruedas > 0) {
          await dormir(1800);
          const r2 = await nav.evaluar(REVISION_EN_PAGINA);
          const sigueElTexto = (r2.cargando || []).length > 0;
          const siguenLasRuedas = r2.ruedas > 0 && r2.ruedas >= r.ruedas;
          if (sigueElTexto || siguenLasRuedas) {
            atascada = sigueElTexto
              ? `sigue cargando: "${(r2.cargando || [])[0]}"`
              : `sigue girando la rueda (${r2.ruedas})`;
          }
        }

        const problemas = [];
        if (r.vacio) problemas.push('la pantalla queda en blanco');
        if (atascada) problemas.push(atascada);
        if (r.errorVisible.length) problemas.push(`error a la vista: ${r.errorVisible[0]}`);
        if (r.nan) problemas.push(`muestra NaN`);
        if (r.indefinido) problemas.push(`muestra undefined/null`);
        if (r.negativos.length) problemas.push(`cifra negativa: ${r.negativos.join(', ')}`);
        if (r.errores.length) problemas.push(`consola: ${r.errores[0]}`);
        if (r.red.length) problemas.push(`red: ${r.red.join(' | ')}`);

        if (problemas.length) {
          hallazgos.push({ rol, ruta, nombre, problemas, ceros: r.ceros });
          console.log(`  ${R}FALLA${N} ${nombre} ${G}(${ruta})${N}`);
          problemas.forEach((p) => console.log(`         ${R}${p}${N}`));
        } else {
          const nota = r.ceros > 3 ? `${A}  (${r.ceros} cifras en $0.00)${N}` : '';
          console.log(`  ${V}ok${N}    ${nombre}${nota}`);
        }
      }
    }
    // ------------------------------------------------------------------
    // Segunda pasada: EN TELEFONO. Es donde se usa la app de verdad, y donde
    // aparecen los desbordes que a 1360 px no existen.
    // ------------------------------------------------------------------
    console.log(`\n${B}  === EN TELEFONO (375 px, socia) ===${N}`);
    await nav.tamano(375, 812, 2);
    await nav.ir(`${WEB}/login`, 1200);
    await nav.evaluar(AYUDAS + ` return await window.__sesion('${ROLES.socio}');`);

    for (const [ruta, nombre, quien] of PANTALLAS) {
      if (quien !== 'todos') continue;
      await nav.ir(`${WEB}${ruta}`, 1400);
      await dormir(900);
      const m = await nav.evaluar(REVISION_MOVIL);
      revisadas += 1;

      const problemas = [];
      if (m.fuera.length) problemas.push(`se sale de la pantalla: ${m.fuera.join(' | ')}`);
      if (m.desbordaBody && !m.fuera.length) problemas.push('la pagina se desplaza de lado');
      if (m.chica.length) problemas.push(`letra ilegible: ${m.chica.join(' | ')}`);

      if (problemas.length) {
        hallazgos.push({ rol: 'telefono', ruta, nombre, problemas, ceros: 0 });
        console.log(`  ${R}FALLA${N} ${nombre} ${G}(${ruta})${N}`);
        problemas.forEach((p) => console.log(`         ${R}${p}${N}`));
      } else {
        console.log(`  ${V}ok${N}    ${nombre}`);
      }
    }
    // ------------------------------------------------------------------
    // Tercera pasada: SIN NINGUN GRUPO. Es el primer estado de toda socia --
    // crea su cuenta y espera la invitacion -- y no lo cubria nada. Cada
    // pantalla tiene que decirle que hacer, no quedarse en blanco ni tirar un
    // error de una lista vacia.
    // ------------------------------------------------------------------
    console.log(`
${B}  === RECIEN REGISTRADA, SIN GRUPO (${SIN_GRUPO}) ===${N}`);
    await nav.tamano(1360, 900, 1);
    await nav.ir(`${WEB}/login`, 1200);
    await nav.evaluar(AYUDAS + ` return await window.__sesion('${SIN_GRUPO}');`);

    for (const [ruta, nombre, quien] of PANTALLAS) {
      if (quien !== 'todos') continue;
      await nav.ir(`${WEB}${ruta}`, 1400);
      await nav.evaluar(AYUDAS + ' return 1;');
      await dormir(900);
      const r = await nav.evaluar(REVISION_EN_PAGINA);
      revisadas += 1;

      let atascada = null;
      if ((r.cargando || []).length > 0 || r.ruedas > 0) {
        await dormir(1800);
        const r2 = await nav.evaluar(REVISION_EN_PAGINA);
        if ((r2.cargando || []).length > 0 || (r2.ruedas > 0 && r2.ruedas >= r.ruedas)) {
          atascada = (r2.cargando || [])[0] ? `sigue cargando: "${(r2.cargando || [])[0]}"` : `sigue girando la rueda (${r2.ruedas})`;
        }
      }

      const problemas = [];
      if (r.vacio) problemas.push('la pantalla queda en blanco');
      if (atascada) problemas.push(atascada);
      if (r.errorVisible.length) problemas.push(`error a la vista: ${r.errorVisible[0]}`);
      if (r.nan) problemas.push('muestra NaN');
      if (r.indefinido) problemas.push('muestra undefined/null');
      if (r.errores.length) problemas.push(`consola: ${r.errores[0]}`);
      if (r.red.length) problemas.push(`red: ${r.red.join(' | ')}`);

      if (problemas.length) {
        hallazgos.push({ rol: 'sin-grupo', ruta, nombre, problemas, ceros: r.ceros });
        console.log(`  ${R}FALLA${N} ${nombre} ${G}(${ruta})${N}`);
        problemas.forEach((p) => console.log(`         ${R}${p}${N}`));
      } else {
        console.log(`  ${V}ok${N}    ${nombre}`);
      }
    }
  } finally {
    await nav.cerrar();
  }

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`  Pantallas revisadas: ${revisadas}   ${hallazgos.length ? R : V}con problemas: ${hallazgos.length}${N}`);
  if (hallazgos.length) {
    console.log(`\n${B}  RESUMEN POR PANTALLA${N}`);
    const porRuta = {};
    hallazgos.forEach((h) => { (porRuta[h.ruta] = porRuta[h.ruta] || []).push(h); });
    Object.entries(porRuta).forEach(([ruta, lista]) => {
      console.log(`\n  ${B}${ruta}${N}  ${G}${lista[0].nombre}${N}`);
      lista.forEach((h) => h.problemas.forEach((p) => console.log(`     [${h.rol}] ${p}`)));
    });
  }
  console.log('');
  require('fs').writeFileSync(
    path.join(__dirname, 'auditoria-pantallas.json'),
    JSON.stringify(hallazgos, null, 2), 'utf8');
})().catch((e) => { console.error('FALLO:', e); process.exit(1); });
