/**
 * Recorre la app entera capturando cada paso del flujo real, para el manual.
 *
 * Antes de ejecutarlo hay que tener sirviendo el BUILD DE PRODUCCION:
 *     npx vite build
 *     npx vite preview --port 5191 --strictPort
 *
 * Y luego, desde la carpeta Backend:
 *     node test/capturas.js
 *
 * Este script arranca el backend en memoria (vacio, sin datos) en el puerto 3001
 * y construye la historia desde cero: registro, grupo, invitaciones, ahorros,
 * prestamo, asamblea y apertura de saldos. Las imagenes salen en manual/img/.
 */

'use strict';

process.env.TEST_PORT = '3001';

const path = require('path');
const { seedWorkbook, startServer, fake } = require('./harness');
const { SHEETS } = require('../governance');
const crypto = require('crypto');
const { Navegador, dormir } = require('./cdp');

const WEB = process.env.WEB_URL || 'http://localhost:5191';
const API = 'http://localhost:3001';
const SALIDA = path.resolve(__dirname, '..', '..', 'manual', 'img');
const CLAVE = 'Clave123';

const CABECERAS_EXTRA = {
  ActasAsamblea: ['ActaID', 'GrupoID', 'Fecha', 'CreadaPor', 'Titulo', 'Contenido', 'Asistentes'],
  AprobacionesAsamblea: ['SolicitudID', 'Tipo', 'GrupoID', 'AprobadoPor', 'RolAprobador', 'Decision', 'Fecha', 'Comentario'],
};

let paso = 0;
const capturas = [];

// --------------------------------------------------------------------------
// Utilidades que corren DENTRO de la pagina
// --------------------------------------------------------------------------

/** Rellena un input controlado por React (hace falta el setter nativo). */
const AYUDAS_EN_PAGINA = `
  window.__escribir = (selector, valor, indice = 0) => {
    const nodos = document.querySelectorAll(selector);
    const el = nodos[indice];
    if (!el) return 'no encontrado: ' + selector;
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
      : el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, valor);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return 'ok';
  };
  window.__clic = (texto, indice = 0) => {
    const botones = [...document.querySelectorAll('button, a')]
      .filter((b) => (b.textContent || '').trim().toLowerCase().includes(texto.toLowerCase()));
    if (!botones[indice]) return 'no encontrado: ' + texto;
    botones[indice].scrollIntoView({ block: 'center' });
    botones[indice].click();
    return 'ok';
  };
  window.__marcarCheckbox = (indice = 0) => {
    const cajas = document.querySelectorAll('input[type=checkbox]');
    if (!cajas[indice]) return 'no encontrado';
    if (!cajas[indice].checked) cajas[indice].click();
    return 'ok';
  };
  window.__irA = (ruta) => {
    history.pushState({}, '', ruta);
    window.dispatchEvent(new PopStateEvent('popstate'));
    return ruta;
  };
  window.__temaClaro = () => { localStorage.setItem('theme', 'light'); return 'light'; };
  window.__sesion = async (correo) => {
    localStorage.setItem('theme', 'light');
    const r = await fetch('${API}/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: correo, password: '${CLAVE}' }),
    });
    const d = await r.json();
    localStorage.setItem('token', d.token);
    localStorage.setItem('user', JSON.stringify(d.user));
    return d.user ? d.user.email : 'sin sesion';
  };
  window.__api = async (metodo, ruta, cuerpo) => {
    const r = await fetch('${API}' + ruta, {
      method: metodo,
      headers: cuerpo ? { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') }
                      : { Authorization: 'Bearer ' + localStorage.getItem('token') },
      body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
`;

// --------------------------------------------------------------------------

async function principal() {
  // 1) Backend vacio: la historia se construye desde cero
  seedWorkbook();
  Object.values(SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  Object.entries(CABECERAS_EXTRA).forEach(([n, c]) => fake.seedSheet(n, [c]));
  await startServer();
  process.stdout.write(`  backend de capturas en ${API}\n`);

  // 2) Comprueba que el frontend este sirviendo
  try {
    const r = await fetch(WEB, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    process.stdout.write(`\n  FALTA EL FRONTEND en ${WEB}\n  Ejecuta antes:  npx vite preview --port 5191 --strictPort\n\n`);
    process.exit(1);
  }

  const nav = new Navegador({ ancho: 1440, alto: 900, escala: 1 });
  await nav.abrir();

  // Navegacion REAL (recarga la pagina). Es imprescindible: la sesion se lee de
  // localStorage al montar la app, asi que un pushState no la aplica y todas las
  // rutas protegidas rebotarian al login.
  const ir = async (ruta, espera = 1800) => {
    await nav.ir(`${WEB}${ruta}`, espera);
    await preparar();
  };

  /** Cambia de usuario y recarga, para que la app tome la sesion nueva. */
  const entrarComo = async (correo, ruta = '/group', espera = 2000) => {
    await nav.evaluar(`await window.__sesion('${correo}'); return 1;`);
    await ir(ruta, espera);
  };
  const preparar = async () => { await nav.evaluar(AYUDAS_EN_PAGINA + ' return 1;'); };

  // En el manual conviene ver la pantalla entera, no solo lo que cabe en la
  // ventana: por eso las capturas de escritorio van completas por defecto.
  // Espera a que la pantalla este QUIETA antes de disparar. Sin esto, las
  // pantallas con animacion de aparicion se capturan a medio desvanecer y
  // salen lavadas, con el texto casi invisible.
  // No basta con esperar a las animaciones declaradas: en varias pantallas los
  // datos llegan DESPUES de esa comprobacion y la animacion de aparicion
  // empieza entonces, asi que la foto salia a medio desvanecer. Lo unico
  // fiable es mirar la pantalla hasta que deje de cambiar.
  const esperarQuieto = async (intentos = 12) => {
    let anterior = null;
    let iguales = 0;
    for (let i = 0; i < intentos; i += 1) {
      const { data } = await nav.enviar('Page.captureScreenshot', { format: 'jpeg', quality: 40 });
      const huella = crypto.createHash('md5').update(data).digest('hex');
      iguales = huella === anterior ? iguales + 1 : 0;
      anterior = huella;
      if (iguales >= 2) break;   // dos lecturas seguidas identicas: ya esta quieta
      await dormir(320);
    }
    await dormir(200);
  };

  const foto = async (nombre, titulo, { completa = true } = {}) => {
    paso += 1;
    const archivo = path.join(SALIDA, `${String(paso).padStart(2, '0')}-${nombre}.png`);
    await esperarQuieto();
    await nav.capturar(archivo, { pantallaCompleta: completa });
    capturas.push({ archivo, nombre, titulo });
    process.stdout.write(`  [${String(paso).padStart(2, '0')}] ${titulo}\n`);
  };
  // =========================================================================
  process.stdout.write('\n  PARTE 1 - Entrar al sistema\n');
  // =========================================================================
  await nav.ir(`${WEB}/login`, 1800);
  await preparar();
  // Todo el manual va en modo claro (fondo blanco), mas legible impreso.
  await nav.evaluar(`window.__temaClaro(); return 1;`);
  await nav.ir(`${WEB}/login`, 2000);
  await preparar();
  await foto('login', 'Pantalla de inicio de sesion');

  await nav.evaluar(`window.__clic('Regístrate aquí'); return 1;`, 1400);
  await preparar();
  await nav.evaluar(`
    window.__escribir('input[type=text]', 'Rosa Villon');
    window.__escribir('input[type=email]', 'rosa@juntago.ec');
    const claves = document.querySelectorAll('input[type=password]');
    if (claves.length) { window.__escribir('input[type=password]', '${CLAVE}', 0); }
    if (claves.length > 1) { window.__escribir('input[type=password]', '${CLAVE}', 1); }
    window.__marcarCheckbox(0);
    return 1;
  `, 700);
  await foto('registro', 'Formulario de registro con el consentimiento marcado');

  // Se crean por API el resto de personas (la historia ya mostro como se registra una)
  const gente = [
    ['Rosa Villon', 'rosa@juntago.ec'],
    ['Luis Tomala', 'luis@juntago.ec'],
    ['Nelly Borbor', 'nelly@juntago.ec'],
    ['Jose Panchana', 'jose@juntago.ec'],
    ['Maria Reyes', 'maria@juntago.ec'],
  ];
  for (const [nombre, correo] of gente) {
    await fetch(`${API}/api/registrar-usuario-en-sheet`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: nombre, Email: correo, password: CLAVE, Balance: 0 }),
    });
  }

  // =========================================================================
  process.stdout.write('\n  PARTE 2 - Crear el grupo\n');
  // =========================================================================
  await nav.ir(`${WEB}/login`, 1500);
  await preparar();
  await entrarComo('rosa@juntago.ec', '/group', 2400);
  await foto('sin-grupo', 'Todavia sin grupo: la app invita a crear el primero');

  await ir('/crear-grupo', 2000);
  await nav.evaluar(`
    window.__escribir('input[type=text]', 'Caja de Ahorro El Progreso', 0);
    const numeros = document.querySelectorAll('input[type=number]');
    if (numeros[0]) window.__escribir('input[type=number]', '20', 0);
    if (numeros[1]) window.__escribir('input[type=number]', '10', 1);
    if (numeros[2]) window.__escribir('input[type=number]', '2', 2);
    const areas = document.querySelectorAll('textarea');
    if (areas.length) window.__escribir('textarea', 'Grupo de ahorro del barrio, reunion mensual.', 0);
    return 1;
  `, 700);
  await foto('crear-grupo', 'Datos del grupo: aporte mensual, valor de la accion e interes');

  const creado = await nav.evaluar(`
    const r = await window.__api('POST', '/api/crear-grupo-en-sheet', {
      GroupName: 'Caja de Ahorro El Progreso',
      Description: 'Grupo de ahorro del barrio, reunion mensual.',
      MonthlyContribution: 20, ValorAccion: 10, PorcentajeInteresMensual: 2,
    });
    return JSON.stringify(r.body).slice(0, 120);
  `, 400);
  process.stdout.write(`      grupo creado: ${creado}\n`);

  const grupoId = await nav.evaluar(`
    const r = await window.__api('GET', '/api/grupos-del-usuario?userEmail=rosa@juntago.ec');
    return (r.body.grupos && r.body.grupos[0]) ? r.body.grupos[0].groupId : '';
  `);

  await ir('/group', 2200);
  await foto('grupo-creado', 'El grupo recien creado: todo en cero, la creadora es la presidenta');

  // =========================================================================
  process.stdout.write('\n  PARTE 3 - Invitar a la junta y a los socios\n');
  // =========================================================================
  await ir('/grupo/gestionar', 2200);
  await nav.evaluar(`
    window.__escribir('input[type=email]', 'luis@juntago.ec', 0);
    const sel = document.querySelector('select');
    if (sel) window.__escribir('select', 'tesorero', 0);
    return 1;
  `, 600);
  await foto('invitar', 'Invitar a una persona ya registrada y proponerle un cargo');

  // Se cursan el resto de invitaciones por API
  const invitados = [['luis@juntago.ec', 'tesorero'], ['nelly@juntago.ec', 'secretario'],
    ['jose@juntago.ec', 'member'], ['maria@juntago.ec', 'member']];
  for (const [correo, rol] of invitados) {
    await nav.evaluar(`await window.__api('POST', '/api/invitar-miembro', { groupId: '${grupoId}', email: '${correo}', role: '${rol}' }); return 1;`);
  }
  await ir('/grupo/gestionar', 1800);
  await foto('invitaciones-enviadas', 'Invitaciones cursadas, a la espera de que cada quien acepte');

  // El invitado ve y acepta
  await entrarComo('luis@juntago.ec', '/invitaciones', 2200);
  await foto('mis-invitaciones', 'Lo que ve la persona invitada: puede aceptar o rechazar');

  for (const [correo] of invitados) {
    await nav.evaluar(`
      await window.__sesion('${correo}');
      const r = await window.__api('GET', '/api/mis-invitaciones');
      const inv = (r.body.invitaciones || [])[0];
      if (inv) await window.__api('POST', '/api/responder-invitacion', { invitationId: inv.invitationId, accion: 'aceptar' });
      return 1;
    `);
  }

  await entrarComo('rosa@juntago.ec', '/grupo/gestionar', 2400);
  await foto('miembros', 'La junta formada: presidencia, tesoreria, secretaria y socios');

  // =========================================================================
  process.stdout.write('\n  PARTE 4 - Los ahorros y su confirmacion\n');
  // =========================================================================
  await entrarComo('jose@juntago.ec', '/nuevo-ahorro', 2200);
  await preparar();
  await nav.evaluar(`
    const numeros = document.querySelectorAll('input[type=number]');
    if (numeros.length) window.__escribir('input[type=number]', '150', 0);
    const textos = document.querySelectorAll('input[type=text]');
    if (textos.length) window.__escribir('input[type=text]', 'Aporte de agosto', textos.length - 1);
    return 1;
  `, 700);
  await foto('nuevo-ahorro', 'Un socio registra su aporte del mes');

  // Se registran los aportes de todos por API
  const aportes = [['rosa@juntago.ec', 320], ['luis@juntago.ec', 280],
    ['nelly@juntago.ec', 240], ['jose@juntago.ec', 150], ['maria@juntago.ec', 190]];
  const movs = {};
  for (const [correo, monto] of aportes) {
    const mov = await nav.evaluar(`
      await window.__sesion('${correo}');
      const r = await window.__api('POST', '/api/savings', { groupId: '${grupoId}', tipo: 'mensual', monto: ${monto}, descripcion: 'Aporte de agosto' });
      return r.body.movId || '';
    `);
    movs[correo] = mov;
  }

  await entrarComo('jose@juntago.ec', '/group', 2600);
  await foto('ahorro-pendiente', 'El aporte queda PENDIENTE: todavia no suma al patrimonio');

  await entrarComo('luis@juntago.ec', '/grupo/aportes', 2600);
  await foto('caja-tesoreria', 'La caja del grupo: la tesoreria confirma o rechaza cada aporte');

  // La tesoreria confirma todo menos el suyo, que lo confirma la presidencia
  for (const [correo] of aportes) {
    const quien = correo === 'luis@juntago.ec' ? 'rosa@juntago.ec' : 'luis@juntago.ec';
    await nav.evaluar(`
      await window.__sesion('${quien}');
      await window.__api('POST', '/api/gob/aportes/resolver', { groupId: '${grupoId}', tipo: 'ahorro', movId: '${movs[correo]}', accion: 'confirmar', nota: 'Recibido en efectivo' });
      return 1;
    `);
  }

  await entrarComo('jose@juntago.ec', '/group', 2600);
  await foto('ahorro-confirmado', 'Confirmado por tesoreria: ahora si forma parte del patrimonio');

  await ir('/historial-ahorros', 2200);
  await foto('historial-ahorros', 'El historial marca el estado de cada movimiento');

  // =========================================================================
  process.stdout.write('\n  PARTE 5 - El reglamento del grupo\n');
  // =========================================================================
  await entrarComo('rosa@juntago.ec', '/grupo/reglamento', 2400);
  await foto('reglamento', 'El reglamento: que se aprueba, cuanto se presta y con que quorum');

  // =========================================================================
  process.stdout.write('\n  PARTE 6 - El prestamo, de la solicitud al pago\n');
  // =========================================================================
  await entrarComo('jose@juntago.ec', '/group', 2000);
  const sobreCupo = await nav.evaluar(`
    const r = await window.__api('POST', '/api/registrar-solicitud', { tipo: 'prestamo', data: { Monto: 2000, Detalles: 'Plazo: 6', Group: '${grupoId}' } });
    return r.body.message || '';
  `);
  process.stdout.write(`      cupo: ${sobreCupo}\n`);

  await ir('/assembly', 2600);
  await nav.evaluar(`window.__clic('Solicitar'); return 1;`, 1400);
  await foto('solicitud-prestamo', 'El socio pide un prestamo desde la asamblea');

  const solId = await nav.evaluar(`
    await window.__api('POST', '/api/registrar-solicitud', { tipo: 'prestamo', data: { Monto: 400, Detalles: 'Plazo: 6', Group: '${grupoId}' } });
    const r = await window.__api('GET', '/api/solicitudes-grupo?groupId=${grupoId}');
    const lista = r.body.solicitudes || r.body.prestamo || [];
    const pendiente = lista.filter((x) => (x.Estado || x.estado) === 'pendiente').pop();
    return pendiente ? (pendiente.ID || pendiente.id) : '';
  `);
  process.stdout.write(`      solicitud: ${solId}\n`);

  await entrarComo('rosa@juntago.ec', '/assembly', 2800);
  await foto('panel-liderazgo', 'La junta ve la solicitud y cada directivo emite su voto');

  await nav.evaluar(`
    await window.__api('POST', '/api/registrar-voto', { solicitudId: '${solId}', tipo: 'prestamo', grupoId: '${grupoId}', decision: 'aprobado' });
    await window.__sesion('luis@juntago.ec');
    await window.__api('POST', '/api/registrar-voto', { solicitudId: '${solId}', tipo: 'prestamo', grupoId: '${grupoId}', decision: 'aprobado' });
    return 1;
  `);

  await entrarComo('jose@juntago.ec', '/group', 2600);
  await foto('prestamo-aprobado', 'Aprobado por la junta: el prestamo aparece con su saldo');

  await ir('/upload-payment', 2200);
  await foto('subir-pago', 'El socio sube el comprobante de su pago');

  await entrarComo('luis@juntago.ec', '/loan-payments-history', 2600);
  await foto('historial-prestamo', 'Trazabilidad completa del prestamo y sus pagos');

  // =========================================================================
  process.stdout.write('\n  PARTE 7 - La asamblea\n');
  // =========================================================================
  await entrarComo('rosa@juntago.ec', '/grupo/asambleas', 2400);
  await nav.evaluar(`window.__clic('Convocar asamblea'); return 1;`, 900);
  await nav.evaluar(`
    window.__escribir('input[type=text]', 'Asamblea ordinaria de septiembre', 0);
    window.__escribir('input[type=date]', '2026-09-05', 0);
    const areas = document.querySelectorAll('textarea');
    if (areas.length) window.__escribir('textarea', '1. Lectura del acta anterior\\n2. Saldos iniciales\\n3. Solicitudes de credito', 0);
    return 1;
  `, 700);
  await foto('convocar-asamblea', 'Convocatoria con fecha, modalidad y orden del dia');

  const asambleaId = await nav.evaluar(`
    const r = await window.__api('POST', '/api/gob/asambleas', {
      groupId: '${grupoId}', titulo: 'Asamblea ordinaria de septiembre',
      fechaProgramada: '2026-09-05', modalidad: 'presencial',
      agenda: '1. Lectura del acta anterior\\n2. Saldos iniciales\\n3. Solicitudes de credito',
    });
    return r.body.asambleaId || '';
  `);

  await ir('/grupo/asambleas', 2200);
  await nav.evaluar(`window.__clic('Asamblea ordinaria'); return 1;`, 1800);
  await foto('asistencia', 'La secretaria marca quien llego: solo los presentes votan');

  await nav.evaluar(`
    await window.__api('POST', '/api/gob/asambleas/${asambleaId}/asistencia', { registros: [
      { email: 'rosa@juntago.ec', estado: 'presente' },
      { email: 'luis@juntago.ec', estado: 'presente' },
      { email: 'nelly@juntago.ec', estado: 'presente' },
      { email: 'jose@juntago.ec', estado: 'presente' },
      { email: 'maria@juntago.ec', estado: 'ausente' },
    ]});
    await window.__api('POST', '/api/gob/asambleas/${asambleaId}/estado', { estado: 'abierta' });
    await window.__api('POST', '/api/gob/asambleas/${asambleaId}/acuerdos', { tipo: 'gasto', titulo: 'Compra del cuaderno de actas', descripcion: 'Gasto de 15 dolares' });
    return 1;
  `);
  await ir('/grupo/asambleas', 2200);
  await nav.evaluar(`window.__clic('Asamblea ordinaria'); return 1;`, 1800);
  await foto('votacion', 'Asamblea abierta: los presentes votan cada punto');

  // =========================================================================
  process.stdout.write('\n  PARTE 8 - Del cuaderno de papel al sistema\n');
  // =========================================================================
  await ir('/grupo/apertura', 2600);
  await nav.evaluar(`
    const numeros = document.querySelectorAll('table input[type=number]');
    const valores = [320, 12, 10, 0, 6,  280, 10, 10, 0, 6,  240, 8, 10, 0, 6];
    valores.forEach((v, i) => { if (numeros[i]) window.__escribir('table input[type=number]', String(v), i); });
    return 1;
  `, 900);
  await foto('apertura-tabla', 'Los saldos del cuaderno, socio por socio (o importando un Excel)');

  const loteId = await nav.evaluar(`
    const r = await window.__api('POST', '/api/gob/apertura/lote', { groupId: '${grupoId}', nota: 'Saldos del cuaderno al 31 de agosto', filas: [
      { email: 'rosa@juntago.ec', ahorro: 320, acciones: 12, valorAccion: 10 },
      { email: 'luis@juntago.ec', ahorro: 280, acciones: 10, valorAccion: 10 },
      { email: 'nelly@juntago.ec', ahorro: 240, acciones: 8, valorAccion: 10, deuda: 120, plazoDeuda: 4 },
    ]});
    return r.body.loteId || '';
  `);
  await nav.evaluar(`await window.__api('POST', '/api/gob/apertura/lote/${loteId}/proponer', { asambleaId: '${asambleaId}' }); return 1;`);
  await ir('/grupo/apertura', 2400);
  await foto('apertura-someter', 'El lote se somete a la asamblea: sin acta no se aplica');

  await nav.evaluar(`
    const det = await window.__api('GET', '/api/gob/asambleas/${asambleaId}');
    const acuerdo = (det.body.acuerdos || []).find((a) => a.tipo === 'apertura_saldos');
    if (acuerdo) {
      await window.__api('POST', '/api/gob/acuerdos/' + acuerdo.acuerdoId + '/votar', { voto: 'favor' });
      await window.__sesion('luis@juntago.ec');
      await window.__api('POST', '/api/gob/acuerdos/' + acuerdo.acuerdoId + '/votar', { voto: 'favor' });
      await window.__sesion('nelly@juntago.ec');
      await window.__api('POST', '/api/gob/acuerdos/' + acuerdo.acuerdoId + '/votar', { voto: 'favor' });
    }
    await window.__sesion('rosa@juntago.ec');
    await window.__api('POST', '/api/gob/apertura/lote/${loteId}/aplicar', {});
    return 1;
  `);
  await ir('/grupo/apertura', 2400);
  await foto('apertura-aplicada', 'Aprobado en asamblea y aplicado: los saldos ya estan en el sistema');

  // =========================================================================
  process.stdout.write('\n  PARTE 9 - Corregir un error\n');
  // =========================================================================
  await ir('/grupo/aportes', 2600);
  await foto('revertir', 'Si algo se confirmo por error, la presidencia lo revierte con motivo');

  // =========================================================================
  process.stdout.write('\n  PARTE 10 - En el telefono\n');
  // =========================================================================
  await nav.tamano(390, 844, 2);
  await entrarComo('jose@juntago.ec', '/group', 2600);
  await foto('movil-grupo', 'La misma pantalla de grupo en el telefono', { completa: false });
  await ir('/grupo/aportes', 2200);
  await foto('movil-aportes', 'La caja del grupo en el telefono', { completa: false });

  await nav.cerrar();

  process.stdout.write(`\n  ${capturas.length} capturas guardadas en manual/img/\n\n`);
  require('fs').writeFileSync(
    path.join(SALIDA, '..', 'capturas.json'),
    JSON.stringify(capturas.map((c) => ({ archivo: path.basename(c.archivo), nombre: c.nombre, titulo: c.titulo })), null, 2)
  );
  process.exit(0);
}

principal().catch((e) => {
  process.stdout.write(`\n  FALLO: ${e.message}\n${e.stack}\n`);
  process.exit(1);
});
