#!/usr/bin/env node
/**
 * Prueba de extremo a extremo del traspaso desde el papel, HACIENDOLO de verdad
 * en la app: se sube un Excel por el campo de archivo, se arma el lote, se
 * somete a la asamblea, se vota, se aplica y se comprueba que el dinero quedo
 * guardado y que TODOS ven las mismas cifras.
 *
 * Antes:
 *     npx vite preview --port 5191 --strictPort
 *     node test/dev-server.js
 * Luego:
 *     node test/probar-importacion.js
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');
const { Navegador, dormir } = require('./cdp');

const WEB = process.env.WEB_URL || 'http://localhost:5191';
const API = process.env.API_URL || 'http://localhost:3001';
const CLAVE = 'Clave123';
const GRUPO = 'DEMO-001';

const V = '\x1b[32m'; const R = '\x1b[31m'; const G = '\x1b[90m';
const N = '\x1b[0m'; const B = '\x1b[1m';

let ok = 0; let mal = 0;
function marca(bien, texto, detalle) {
  if (bien) { ok += 1; console.log(`  ${V}ok${N}    ${texto}`); }
  else { mal += 1; console.log(`  ${R}FALLA${N} ${texto}${detalle ? `\n         ${R}${detalle}${N}` : ''}`); }
}
function cerca(a, b, texto, tol = 0.02) {
  const bien = Number.isFinite(Number(a)) && Math.abs(Number(a) - b) <= tol;
  marca(bien, texto, bien ? '' : `esperado ${b}, obtenido ${a}`);
}

// --------------------------------------------------------------------------
// Los saldos del cuaderno que se van a importar
// --------------------------------------------------------------------------
const CUADERNO = [
  // email, ahorro, acciones, valor, deuda, plazo, interes, pagados, utilidades
  ['rosa@demo.test', 640, 20, 10, 600, 12, 2, 3, 48.75, 'Libreta 001'],
  ['luis@demo.test', 520, 15, 10, '', '', '', '', 31.40, 'Libreta 002'],
  ['nelly@demo.test', 410, 10, 10, 250, 6, 1.5, 2, 19.05, 'Libreta 003'],
  ['jose@demo.test', 180, 4, 10, '', '', '', '', 7.20, 'Libreta 004'],
  ['maria@demo.test', 295, 8, 10, 120, 10, 3, 1, 12.85, 'Libreta 005'],
];
const CABECERA = ['Email', 'Ahorro', 'Acciones', 'Valor accion', 'Deuda',
  'Plazo (meses)', 'Interes mensual (%)', 'Meses pagados', 'Utilidades', 'Nota'];

const TOTAL_AHORRO = CUADERNO.reduce((s, f) => s + Number(f[1] || 0), 0);
const TOTAL_ACCIONES = CUADERNO.reduce((s, f) => s + Number(f[2] || 0), 0);
const TOTAL_DEUDA = CUADERNO.reduce((s, f) => s + Number(f[4] || 0), 0);
const TOTAL_UTIL = CUADERNO.reduce((s, f) => s + Number(f[8] || 0), 0);

function crearExcel() {
  const libro = XLSX.utils.book_new();
  const hoja = XLSX.utils.aoa_to_sheet([CABECERA, ...CUADERNO]);
  XLSX.utils.book_append_sheet(libro, hoja, 'Saldos');
  const ruta = path.join(os.tmpdir(), `cuaderno-${process.pid}.xlsx`);
  XLSX.writeFile(libro, ruta);
  return ruta;
}

// --------------------------------------------------------------------------
const sesion = (correo) => `
  localStorage.setItem('theme','light');
  const r = await fetch('${API}/api/login',{method:'POST',headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email:'${correo}',password:'${CLAVE}'})});
  const d = await r.json();
  localStorage.setItem('token', d.token);
  localStorage.setItem('user', JSON.stringify(d.user));
  return d.user ? d.user.email : 'sin sesion';`;

const api = (metodo, ruta, cuerpo) => `
  const r = await fetch('${API}${ruta}', {
    method: '${metodo}',
    headers: ${cuerpo ? "{'Content-Type':'application/json', Authorization: 'Bearer ' + localStorage.getItem('token')}"
    : "{Authorization: 'Bearer ' + localStorage.getItem('token')}"},
    ${cuerpo ? `body: JSON.stringify(${JSON.stringify(cuerpo)}),` : ''}
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };`;

const textoPagina = `return (document.body.innerText || '').replace(/\\s+/g,' ').trim();`;

const pulsar = (etiqueta) => `
  const b = [...document.querySelectorAll('button')]
    .find(x => new RegExp(${JSON.stringify(etiqueta)}, 'i').test((x.textContent||'').trim()));
  if (!b) return 'no encontrado';
  if (b.disabled) return 'deshabilitado';
  b.scrollIntoView({block:'center'});
  b.click();
  return 'ok';`;

(async () => {
  for (const url of [WEB, `${API}/api/ping`]) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      console.log(`\n  FALTA ${url}: ${e.message}\n`);
      process.exit(1);
    }
  }

  // La prueba parte de un grupo SIN lotes aplicados. Si se lanza dos veces
  // contra el mismo servidor, la segunda encuentra los saldos ya cargados y
  // suelta una docena de fallos que parecen del codigo y no lo son.
  try {
    const login = await fetch(`${API}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'luis@demo.test', password: CLAVE }),
    }).then((r) => r.json());
    const lotes = await fetch(`${API}/api/gob/apertura/lotes?groupId=${GRUPO}`, {
      headers: { Authorization: `Bearer ${login.token}` },
    }).then((r) => r.json());
    if ((lotes.lotes || []).length > 0) {
      console.log(`
  ${R}El grupo ${GRUPO} ya tiene ${lotes.lotes.length} lote(s) de apertura.${N}`);
      console.log('  Esta prueba necesita empezar de cero. Reinicia el backend:');
      console.log('    node test/dev-server.js');
      process.exit(1);
    }
  } catch (e) {
    console.log(`  aviso: no se pudo comprobar el estado previo (${e.message})`);
  }

  const excel = crearExcel();
  console.log(`\n${B}  Cuaderno de prueba: ${path.basename(excel)}${N}`);
  console.log(`${G}  ${CUADERNO.length} socios · $${TOTAL_AHORRO} de ahorro · ${TOTAL_ACCIONES} acciones`);
  console.log(`  $${TOTAL_DEUDA} de deuda · $${TOTAL_UTIL.toFixed(2)} de utilidades${N}`);

  const nav = new Navegador({ ancho: 1440, alto: 1000, escala: 1 });
  await nav.abrir();

  try {
    // ==================================================================
    console.log(`\n${B}1. La tesoreria sube el Excel del cuaderno${N}`);
    // ==================================================================
    await nav.ir(`${WEB}/login`, 1200);
    await nav.evaluar(sesion('luis@demo.test'));
    await nav.ir(`${WEB}/grupo/apertura`, 2800);
    await dormir(1500);

    const hayCampo = await nav.evaluar(`return !!document.querySelector('input[type=file]');`);
    marca(hayCampo, 'la pantalla ofrece el campo para subir el archivo');

    const hayPlantilla = await nav.evaluar(`
      const a = [...document.querySelectorAll('a')].find(x => /plantilla/i.test(x.textContent||''));
      if (!a) return '';
      const r = await fetch(a.getAttribute('href'));
      return r.ok ? String(r.headers.get('content-length') || 'ok') : 'error ' + r.status;`);
    marca(!!hayPlantilla && !hayPlantilla.startsWith('error'),
      'y la plantilla de ejemplo se descarga de verdad', `respuesta: ${hayPlantilla}`);

    await nav.adjuntar('input[type=file]', excel);
    await dormir(2600);

    const trasSubir = await nav.evaluar(textoPagina);
    marca(/Se cargaron 5 filas/i.test(trasSubir),
      'lee las 5 filas del archivo', trasSubir.slice(0, 220));

    // Las cifras leidas deben aparecer en la tabla, no solo el ahorro
    const enTabla = await nav.evaluar(`
      const filas = [...document.querySelectorAll('tbody tr')].map(tr =>
        [...tr.querySelectorAll('input')].map(i => i.value));
      return filas;`);
    marca(enTabla.length === 5, `la tabla queda con 5 filas`, `tiene ${enTabla.length}`);
    const primera = enTabla[0] || [];
    marca(primera.length >= 8,
      'cada fila trae las 8 casillas (ahorro, acciones, valor, deuda, plazo, interes, pagados, utilidades)',
      `la primera tiene ${primera.length}`);
    marca(primera.includes('600') && primera.includes('12') && primera.includes('2') && primera.includes('3'),
      'la deuda, el plazo, el interes y los meses pagados llegaron a la tabla',
      JSON.stringify(primera));
    marca(primera.some((v) => v === '48.75' || v === '48,75'),
      'y tambien las utilidades', JSON.stringify(primera));

    const totales = await nav.evaluar(textoPagina);
    marca(totales.includes('2,045.00') || totales.includes('2045') || totales.includes('$2.045'),
      `el total de ahorro suma ${TOTAL_AHORRO}`, totales.slice(0, 260));

    // ==================================================================
    console.log(`\n${B}2. Se guarda el lote como borrador${N}`);
    // ==================================================================
    const clic = await nav.evaluar(pulsar('guardar|crear lote|generar lote'));
    marca(clic === 'ok', 'se pulsa el boton de guardar el lote', `resultado: ${clic}`);
    await dormir(2600);
    const trasGuardar = await nav.evaluar(textoPagina);
    marca(/borrador/i.test(trasGuardar), 'el lote queda en estado borrador', trasGuardar.slice(0, 220));

    const lotes = await nav.evaluar(api('GET', `/api/gob/apertura/lotes?groupId=${GRUPO}`));
    const lote = (lotes.body?.lotes || [])[0];
    marca(!!lote, 'el lote existe en el servidor, no solo en la pantalla');
    cerca(lote?.totalAhorro, TOTAL_AHORRO, 'con el total de ahorro correcto');
    cerca(lote?.totalAcciones, TOTAL_ACCIONES, 'con el total de acciones correcto');
    cerca(lote?.totalDeuda, TOTAL_DEUDA, 'con el total de deuda correcto');

    // ==================================================================
    console.log(`\n${B}3. Sin asamblea aprobada NO se aplica${N}`);
    // ==================================================================
    const sinActa = await nav.evaluar(api('POST', `/api/gob/apertura/lote/${lote?.loteId}/aplicar`, {}));
    marca(sinActa.status === 409, 'aplicarlo sin acuerdo se rechaza', `devolvio ${sinActa.status}`);

    const saldoAntes = await nav.evaluar(api('GET',
      `/api/savings/complete?email=rosa@demo.test&groupId=${GRUPO}`));
    const ahorroAntes = Number(saldoAntes.body?.data?.totalAhorros || 0);

    // ==================================================================
    console.log(`\n${B}4. La asamblea lo aprueba por votacion${N}`);
    // ==================================================================
    await nav.ir(`${WEB}/login`, 1000);
    await nav.evaluar(sesion('rosa@demo.test'));
    const conv = await nav.evaluar(api('POST', '/api/gob/asambleas', {
      groupId: GRUPO, titulo: 'Traspaso del cuaderno', fechaProgramada: '2026-09-20', modalidad: 'presencial',
    }));
    const asambleaId = conv.body?.asambleaId;
    marca(!!asambleaId, 'se convoca la asamblea', JSON.stringify(conv.body).slice(0, 160));

    await nav.ir(`${WEB}/login`, 1000);
    await nav.evaluar(sesion('nelly@demo.test'));
    const asis = await nav.evaluar(api('POST', `/api/gob/asambleas/${asambleaId}/asistencia`, {
      registros: [
        { email: 'rosa@demo.test', estado: 'presente' },
        { email: 'luis@demo.test', estado: 'presente' },
        { email: 'nelly@demo.test', estado: 'presente' },
        { email: 'jose@demo.test', estado: 'presente' },
        { email: 'maria@demo.test', estado: 'ausente' },
      ],
    }));
    marca(asis.status === 200, 'la secretaria registra la asistencia');

    await nav.ir(`${WEB}/login`, 1000);
    await nav.evaluar(sesion('rosa@demo.test'));
    await nav.evaluar(api('POST', `/api/gob/asambleas/${asambleaId}/estado`, { estado: 'abierta' }));

    await nav.ir(`${WEB}/login`, 1000);
    await nav.evaluar(sesion('luis@demo.test'));
    const prop = await nav.evaluar(api('POST', `/api/gob/apertura/lote/${lote?.loteId}/proponer`, { asambleaId }));
    const acuerdoId = prop.body?.acuerdoId;
    marca(!!acuerdoId, 'el lote se somete a esa asamblea');

    const votos = [];
    for (const [correo, quien] of [['rosa@demo.test', 'presidenta'], ['luis@demo.test', 'tesorero'], ['nelly@demo.test', 'secretaria']]) {
      await nav.ir(`${WEB}/login`, 900);
      await nav.evaluar(sesion(correo));
      const v = await nav.evaluar(api('POST', `/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }));
      votos.push(`${quien}:${v.body?.estado || v.status}`);
    }
    marca(votos.some((v) => v.includes('aprobado')), 'la votacion aprueba el traspaso', votos.join(' '));

    // ==================================================================
    console.log(`\n${B}5. Se aplica y el dinero queda guardado${N}`);
    // ==================================================================
    await nav.ir(`${WEB}/login`, 1000);
    await nav.evaluar(sesion('luis@demo.test'));
    const aplicado = await nav.evaluar(api('POST', `/api/gob/apertura/lote/${lote?.loteId}/aplicar`, {}));
    marca(aplicado.status === 200, 'con el acuerdo aprobado el lote se aplica',
      JSON.stringify(aplicado.body).slice(0, 200));
    // Cuenta filas escritas en Savings: 5 saldos iniciales + 5 de utilidades
    marca(aplicado.body?.aplicado?.ahorros === 10,
      'entraron 10 movimientos de ahorro (5 saldos + 5 de utilidades)',
      `fueron ${aplicado.body?.aplicado?.ahorros}`);
    marca(aplicado.body?.aplicado?.deudas === 3, 'y las 3 deudas', `fueron ${aplicado.body?.aplicado?.deudas}`);

    const repetir = await nav.evaluar(api('POST', `/api/gob/apertura/lote/${lote?.loteId}/aplicar`, {}));
    marca(repetir.status === 409, 'aplicarlo dos veces no duplica nada', `devolvio ${repetir.status}`);

    // ==================================================================
    console.log(`\n${B}6. Las cifras guardadas son las del cuaderno${N}`);
    // ==================================================================
    // El servidor solo entrega los datos de quien pregunta (y eso esta bien),
    // asi que se entra con cada cuenta para comprobar SU saldo.
    // Al ahorro del cuaderno hay que sumarle lo que ya tenia sembrado la demo.
    const YA_TENIA = { rosa: 320, luis: 280, nelly: 240, jose: 150, maria: 190 };
    // dev-server siembra 10 + i*5 acciones a cada quien, en este orden
    const ACC_PREVIAS = { rosa: 10, luis: 15, nelly: 20, jose: 25, maria: 30 };
    for (const fila of CUADERNO) {
      const [correo, ahorro, acciones, valor, , , , , util] = fila;
      const nombre = correo.split('@')[0];
      await nav.ir(`${WEB}/login`, 900);
      await nav.evaluar(sesion(correo));
      const r = await nav.evaluar(api('GET', `/api/savings/complete?email=${correo}&groupId=${GRUPO}`));
      const d = r.body?.data || {};
      const esperado = YA_TENIA[nombre] + Number(ahorro) + Number(util || 0);
      cerca(d.totalAhorros, esperado,
        `${nombre}: ${YA_TENIA[nombre]} que tenia + ${ahorro} del cuaderno + ${util} de utilidades = ${esperado.toFixed(2)}`, 0.05);
      const accEsperadas = (ACC_PREVIAS[nombre] + Number(acciones)) * Number(valor);
      cerca(d.totalAcciones, accEsperadas,
        `${nombre}: ${ACC_PREVIAS[nombre]} + ${acciones} acciones valen ${accEsperadas.toFixed(2)}`, 0.05);
    }

    // ==================================================================
    console.log(`\n${B}7. Los prestamos heredados conservan su interes${N}`);
    // ==================================================================
    for (const fila of CUADERNO.filter((f) => f[4])) {
      const [correo, , , , deuda, plazo, interes] = fila;
      await nav.ir(`${WEB}/login`, 900);
      await nav.evaluar(sesion(correo));
      const r = await nav.evaluar(api('GET', `/api/obtener-prestamos?groupId=${GRUPO}&userEmail=${correo}`));
      const l = (r.body?.loans || []).find((x) => Math.abs(Number(x.amount) - Number(deuda)) < 0.01);
      const nombre = correo.split('@')[0];
      marca(!!l, `${nombre} arrastra su prestamo de $${deuda}`);
      const total = Math.round(deuda * (1 + (interes / 100) * plazo) * 100) / 100;
      cerca(l?.remainingBalance, total, `${nombre}: saldo con su ${interes}% a ${plazo} meses = ${total}`, 0.05);
    }

    // ==================================================================
    console.log(`\n${B}8. Todos ven lo mismo, y sigue ahi tras recargar${N}`);
    // ==================================================================
    // Lo que TIENE que coincidir entre todos es el patrimonio del grupo
    const patrimonios = [];
    for (const correo of ['rosa@demo.test', 'luis@demo.test', 'jose@demo.test', 'maria@demo.test']) {
      await nav.ir(`${WEB}/login`, 900);
      await nav.evaluar(sesion(correo));
      const g = await nav.evaluar(api('GET', `/api/grupos-del-usuario?userEmail=${correo}`));
      const grupo = (g.body?.grupos || []).find((x) => (x.GroupID || x.groupId) === '${GRUPO}'.replace('$', '') || (x.GroupID || x.groupId) === 'DEMO-001');
      patrimonios.push({ correo, total: Number(grupo?.TotalPatrimonio ?? grupo?.totalPatrimonio ?? NaN) });
    }
    const dist = new Set(patrimonios.filter((p) => Number.isFinite(p.total)).map((p) => p.total.toFixed(2)));
    marca(dist.size <= 1, 'los cuatro socios ven el MISMO patrimonio del grupo',
      JSON.stringify(patrimonios));

    // Y cada quien ve su propio saldo, no el de otro
    await nav.ir(`${WEB}/login`, 900);
    await nav.evaluar(sesion('jose@demo.test'));
    const ajeno = await nav.evaluar(api('GET', `/api/savings/complete?email=rosa@demo.test&groupId=${GRUPO}`));
    cerca(ajeno.body?.data?.totalAhorros, 150 + 180 + 7.20,
      'pedir el saldo de otra persona devuelve el propio, no el ajeno', 0.05);

    await nav.ir(`${WEB}/group`, 2800);
    await dormir(1600);
    const pantalla = await nav.evaluar(textoPagina);
    // jose: 150 que ya tenia + 180 del cuaderno + 7,20 de utilidades = 337,20
    // de ahorro, mas 29 acciones a $10 = 290, o sea $627,20 de patrimonio
    marca(/627[.,]20/.test(pantalla),
      'el socio ve su patrimonio de $627,20 en la pantalla de grupo', pantalla.slice(0, 240));
    marca(!/NaN|undefined/.test(pantalla), 'sin NaN ni undefined a la vista');

    // Recargar del todo: si algo vivia solo en memoria, aqui se cae
    await nav.ir(`${WEB}/group`, 3000);
    await dormir(1600);
    const tras = await nav.evaluar(textoPagina);
    marca(/627[.,]20/.test(tras), 'y sigue ahi despues de recargar la pagina');

    const lotesFinal = await nav.evaluar(api('GET', `/api/gob/apertura/lotes?groupId=${GRUPO}`));
    marca((lotesFinal.body?.lotes || [])[0]?.estado === 'aplicado',
      'el lote queda marcado como aplicado, con su rastro',
      JSON.stringify((lotesFinal.body?.lotes || [])[0] || {}).slice(0, 160));
  } finally {
    await nav.cerrar();
    try { fs.unlinkSync(excel); } catch (e) { /* da igual */ }
  }

  console.log(`\n${'-'.repeat(64)}`);
  console.log(`  Comprobaciones: ${ok + mal}   ${V}OK: ${ok}${N}   ${mal ? R : ''}FALLAS: ${mal}${N}\n`);
  process.exit(mal ? 1 : 0);
})().catch((e) => { console.error('FALLO:', e.message); process.exit(1); });
