/**
 * SUITE 20 - La digitalizacion del grupo.
 *
 * Mide que procesos del banco comunal han dejado el cuaderno. Es el numero con
 * el que se va a contar la historia del proyecto, asi que cada hito se
 * comprueba dos veces: que se marque cuando toca, y que NO se marque cuando no.
 */

const {
  HITOS, escalera, traspaso, serieMensual, tendencia, primeraFecha,
} = require('../digitalizacion');
const { hoyLocal, PNG_PRUEBA, seedWorkbook, get, post, postArchivo, fake } = require('./harness');
const { baseScenario, seedGroup, seedLink } = require('./scenario');
const t = require('./runner');

const DIA = 24 * 3600 * 1000;
const haceDias = (d) => new Date(Date.now() - d * DIA).toISOString();
const dia = (iso) => String(iso).slice(0, 10);

module.exports = async function run() {
  // ===================================================================
  t.section('DIG 1. La escalera y sus nueve peldaños');
  // ===================================================================
  t.eq('son nueve hitos', HITOS.length, 9);
  t.check('todos con clave, titulo y ayuda',
    HITOS.every((h) => h.clave && h.titulo && h.ayuda), '');
  t.eq('el primero es que el grupo exista', HITOS[0].clave, 'existe');
  t.eq('y el ultimo, el reparto de utilidades', HITOS[8].clave, 'reparto');

  const vacia = escalera({});
  t.eq('un grupo sin nada: 0 hitos', vacia.logrados, 0);
  t.eq('sobre 9', vacia.total, 9);
  t.eq('0%', vacia.pct, 0);
  t.eq('y lo siguiente que le toca es existir', vacia.siguiente.clave, 'existe');
  t.eq('sin fecha de arranque', vacia.desde, null);

  const media = escalera({
    existe: { logrado: true, fecha: haceDias(90) },
    entraron: { logrado: true, fecha: haceDias(80), cuenta: 4 },
    aportes: { logrado: true, fecha: haceDias(70), cuenta: 12 },
    confirmacion: { logrado: true, fecha: haceDias(60), cuenta: 10 },
  });
  t.eq('cuatro hitos logrados', media.logrados, 4);
  t.near('4 de 9 son el 44,4%', media.pct, 44.4, 0.1);
  t.eq('lo siguiente son los prestamos', media.siguiente.clave, 'prestamos');
  t.eq('empezo a digitalizarse el dia de la primera entrada',
    media.desde, dia(haceDias(80)));
  t.check('el hito de existir no cuenta como fecha de arranque',
    media.desde !== dia(haceDias(90)), media.desde);

  const todo = {};
  HITOS.forEach((h) => { todo[h.clave] = { logrado: true, fecha: haceDias(10) }; });
  const completa = escalera(todo);
  t.eq('con los nueve, 100%', completa.pct, 100);
  t.eq('y ya no queda siguiente paso', completa.siguiente, null);

  // Un hito suelto mas adelante NO adelanta a los que faltan antes
  const saltada = escalera({
    existe: { logrado: true, fecha: haceDias(50) },
    reparto: { logrado: true, fecha: haceDias(5) },
  });
  t.eq('dos hitos, aunque uno sea el ultimo', saltada.logrados, 2);
  t.eq('lo siguiente sigue siendo el primero que falta', saltada.siguiente.clave, 'entraron');

  // ===================================================================
  t.section('DIG 2. El traspaso desde el papel');
  // ===================================================================
  const sinTraspaso = traspaso([], { tuvoActividadAntes: false });
  t.eq('sin lote aplicado, no hay traspaso', sinTraspaso.hecho, false);
  t.check('y se dice que aun no ha traido lo del papel',
    /papel/i.test(sinTraspaso.motivo), sinTraspaso.motivo);

  const trabajaSinTraer = traspaso([], { tuvoActividadAntes: true });
  t.check('un grupo que ya trabaja aqui pero no cargo sus saldos se distingue',
    /no cargó/i.test(trabajaSinTraer.motivo), trabajaSinTraer.motivo);

  const soloBorrador = traspaso([{ estado: 'borrador', aplicadoEn: '', totalAhorro: 500 }]);
  t.eq('un lote en borrador no es un traspaso', soloBorrador.hecho, false);

  const hecho = traspaso([
    { estado: 'aplicado', aplicadoEn: haceDias(45), totalAhorro: 1200, totalAcciones: 800, totalDeuda: 300, miembros: 5 },
    { estado: 'aplicado', aplicadoEn: haceDias(20), totalAhorro: 400, totalAcciones: 0, totalDeuda: 0, miembros: 2 },
    { estado: 'descartado', aplicadoEn: haceDias(30), totalAhorro: 9999, miembros: 99 },
  ]);
  t.eq('con lotes aplicados, si hay traspaso', hecho.hecho, true);
  t.eq('la fecha es la del PRIMERO, que es cuando dejaron el cuaderno',
    dia(hecho.fecha), dia(haceDias(45)));
  t.eq('hace 45 dias', hecho.diasDesde, 45);
  t.eq('se suman los dos lotes aplicados: 1600 de ahorro', hecho.totales.ahorro, 1600);
  t.eq('800 en acciones', hecho.totales.acciones, 800);
  t.eq('300 de deuda', hecho.totales.deuda, 300);
  t.eq('7 personas', hecho.totales.miembros, 7);
  t.eq('y el lote descartado no cuenta', hecho.lotes, 2);

  // ===================================================================
  t.section('DIG 3. La curva mes a mes');
  // ===================================================================
  const ahora = new Date('2026-09-15T12:00:00.000Z');
  const serie = serieMensual([
    { fecha: '2026-06-10', tipo: 'entradas' },
    { fecha: '2026-06-11', tipo: 'entradas' },
    { fecha: '2026-06-12', tipo: 'aportes' },
    // julio sin nada, a proposito
    { fecha: '2026-08-02', tipo: 'aportes' },
    { fecha: '2026-08-03', tipo: 'prestamos' },
    { fecha: '2026-09-01', tipo: 'asambleas' },
    { fecha: 'no es fecha', tipo: 'aportes' },
    { fecha: '2026-08-05', tipo: 'inventado' },
  ], 12, ahora);

  t.eq('cuatro meses, de junio a septiembre', serie.length, 4);
  t.eq('el primero es junio', serie[0].mes, '2026-06');
  t.eq('con 2 entradas', serie[0].entradas, 2);
  t.eq('y 1 aporte', serie[0].aportes, 1);
  t.eq('3 movimientos en total', serie[0].total, 3);
  t.eq('julio sale aunque este vacio', serie[1].mes, '2026-07');
  t.eq('con cero', serie[1].total, 0);
  t.eq('agosto trae 2', serie[2].total, 2);
  t.eq('septiembre, 1', serie[3].total, 1);
  t.check('una fecha ilegible no entra en ningun mes',
    serie.reduce((s, m) => s + m.total, 0) === 6,
    `${serie.reduce((s, m) => s + m.total, 0)}`);
  t.eq('un tipo que no existe tampoco', serie[2].aportes, 1);

  t.eq('sin eventos, la serie viene vacia', serieMensual([]).length, 0);

  // ===================================================================
  t.section('DIG 4. Si el grupo va a mas o a menos');
  // ===================================================================
  const corta = tendencia([{ mes: '2026-08', total: 5 }]);
  t.eq('con un solo mes no se puede decir nada', corta.hayDatos, false);
  t.check('y se explica', /meses/i.test(corta.motivo), corta.motivo);

  const sube = tendencia([
    { mes: '2026-04', total: 2 }, { mes: '2026-05', total: 2 }, { mes: '2026-06', total: 2 },
    { mes: '2026-07', total: 6 }, { mes: '2026-08', total: 6 }, { mes: '2026-09', total: 6 },
  ]);
  t.eq('los tres ultimos meses promedian 6', sube.reciente, 6);
  t.eq('los tres anteriores, 2', sube.anterior, 2);
  t.near('un aumento del 200%', sube.cambioPct, 200, 0.1);
  t.eq('el grupo va a mas', sube.sentido, 'sube');

  const baja = tendencia([
    { mes: '2026-04', total: 10 }, { mes: '2026-05', total: 10 }, { mes: '2026-06', total: 10 },
    { mes: '2026-07', total: 1 }, { mes: '2026-08', total: 1 }, { mes: '2026-09', total: 1 },
  ]);
  t.eq('aqui va a menos', baja.sentido, 'baja');
  t.near('un 90% menos', baja.cambioPct, -90, 0.1);

  const igual = tendencia([
    { mes: '2026-04', total: 5 }, { mes: '2026-05', total: 5 }, { mes: '2026-06', total: 5 },
    { mes: '2026-07', total: 5 }, { mes: '2026-08', total: 5 }, { mes: '2026-09', total: 5 },
  ]);
  t.eq('y aqui se mantiene', igual.sentido, 'estable');

  const arranca = tendencia([
    { mes: '2026-04', total: 0 }, { mes: '2026-05', total: 0 }, { mes: '2026-06', total: 0 },
    { mes: '2026-07', total: 4 }, { mes: '2026-08', total: 4 }, { mes: '2026-09', total: 4 },
  ]);
  t.eq('si antes no habia nada, no se inventa un porcentaje', arranca.cambioPct, null);
  t.eq('se dice que acaba de arrancar', arranca.sentido, 'arranque');

  // ===================================================================
  t.section('DIG 5. La escalera con un grupo de verdad');
  // ===================================================================
  seedWorkbook();
  const { HOJA, CABECERA } = require('../accesos');
  const G_SHEETS = require('../governance').SHEETS;
  fake.seedSheet(HOJA, [CABECERA]);
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));

  const e = await baseScenario({ groupId: 'GDI' });
  const G = 'GDI';
  const hoyStr = hoyLocal();

  const pedir = async () => {
    const r = await get('/api/admin/metricas', e.tokens.admin);
    const g = (r.body?.grupos || []).find((x) => x.groupId === G);
    return { r, g, d: g?.digitalizacion, logrado: (k) => !!(g?.digitalizacion?.hitos || [])
      .find((h) => h.clave === k)?.logrado };
  };

  // --- Paso 0: recien creado ---
  const p0 = await pedir();
  t.status('el informe responde', p0.r, 200);
  t.check('el grupo consta como creado', p0.logrado('existe'), '');
  t.check('y como que su gente ya entro (todos hicieron login)', p0.logrado('entraron'), '');
  t.check('pero todavia no registra aportes', !p0.logrado('aportes'), '');
  t.eq('lo siguiente que le falta son los aportes', p0.d.siguiente.clave, 'aportes');

  // --- Paso 1: se registra un aporte, pero nadie lo confirma ---
  const ap1 = await post('/api/registrar-ahorros',
    { groupId: G, userEmail: e.users.socio1.email, date: hoyStr, amount: 100 }, e.tokens.socio1);
  const p1 = await pedir();
  t.check('ahora si registra aportes', p1.logrado('aportes'), '');
  t.check('pero aun no hay confirmacion por un tercero', !p1.logrado('confirmacion'), '');
  t.eq('lo siguiente es justamente eso', p1.d.siguiente.clave, 'confirmacion');

  // --- Paso 2: la tesoreria lo confirma ---
  await post('/api/gob/aportes/resolver',
    { groupId: G, tipo: 'ahorro', movId: ap1.body?.movId, accion: 'confirmar' }, e.tokens.teso);
  const p2 = await pedir();
  t.check('quien registra no es quien confirma: control interno en marcha',
    p2.logrado('confirmacion'), '');
  t.eq('y ya son 4 hitos', p2.d.logrados, 4);
  t.near('44,4% de digitalizacion', p2.d.pct, 44.4, 0.1);

  // --- Paso 3: prestamo pedido y aprobado por la directiva ---
  await post('/api/registrar-solicitud',
    { tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 4', Group: G } }, e.tokens.socio1);
  const sols = fake.dumpSheet('SolicitudesPrestamos') || [];
  const solId = sols[sols.length - 1][0];
  const p3a = await pedir();
  t.check('una solicitud sin resolver todavia no marca el hito', !p3a.logrado('prestamos'),
    'pedirlo no es resolverlo');

  await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: G, decision: 'aprobado' }, e.tokens.presi);
  await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: G, decision: 'aprobado' }, e.tokens.teso);
  const p3 = await pedir();
  t.check('resuelta por la directiva, ya cuenta', p3.logrado('prestamos'), '');

  // --- Paso 4: comprobante subido y revisado ---
  const archivo = { campo: 'paymentImage', contenido: PNG_PRUEBA, tipo: 'image/png', nombre: 'c.png' };
  await postArchivo('/api/upload-payment',
    { loanId: solId, amount: 30, userEmail: e.users.socio1.email, groupId: G, paymentDate: hoyStr },
    archivo, e.tokens.socio1);
  const p4a = await pedir();
  t.check('un comprobante sin revisar no marca el hito', !p4a.logrado('comprobantes'), '');

  const pend = await get(`/api/pending-payments?groupId=${G}`, e.tokens.teso);
  const pid = ((pend.body?.payments || pend.body?.pagos) || [])[0]?.paymentId;
  await post('/api/approve-payment', { paymentId: pid, action: 'approve' }, e.tokens.teso);
  const p4 = await pedir();
  t.check('revisado, ya cuenta', p4.logrado('comprobantes'), '');

  // --- Paso 5: asamblea con asistencia ---
  const conv = await post('/api/gob/asambleas',
    { groupId: G, titulo: 'Ordinaria', fechaProgramada: hoyStr, modalidad: 'presencial' }, e.tokens.presi);
  const aid = conv.body?.asambleaId;
  const p5a = await pedir();
  t.check('convocarla no basta', !p5a.logrado('asambleas'), '');

  await post(`/api/gob/asambleas/${aid}/asistencia`, {
    groupId: G,
    registros: ['presi', 'teso', 'secre', 'socio1'].map((q) => ({ email: e.users[q].email, estado: 'presente' })),
  }, e.tokens.secre);
  await post(`/api/gob/asambleas/${aid}/estado`, { estado: 'abierta', groupId: G }, e.tokens.presi);
  const p5 = await pedir();
  t.check('celebrada y con asistencia, ya cuenta', p5.logrado('asambleas'), '');

  // --- Paso 6: acuerdo votado ---
  const acu = await post(`/api/gob/asambleas/${aid}/acuerdos`,
    { groupId: G, tipo: 'otro', titulo: 'Mocion' }, e.tokens.presi);
  const p6a = await pedir();
  t.check('un acuerdo sin votos todavia no cuenta', !p6a.logrado('acuerdos'), '');

  for (const q of ['presi', 'teso', 'secre']) {
    await post(`/api/gob/acuerdos/${acu.body?.acuerdoId}/votar`, { groupId: G, voto: 'favor' }, e.tokens[q]);
  }
  const p6 = await pedir();
  t.check('con los votos contados, ya cuenta', p6.logrado('acuerdos'), '');
  t.eq('van 8 de 9 hitos', p6.d.logrados, 8);
  t.eq('solo falta el reparto de utilidades', p6.d.siguiente.clave, 'reparto');
  t.near('88,9% de digitalizacion', p6.d.pct, 88.9, 0.1);

  t.check('cada hito logrado trae la fecha del dia que ocurrio',
    p6.d.hitos.filter((h) => h.logrado).every((h) => h.desde && /^\d{4}-\d{2}-\d{2}$/.test(h.desde)),
    JSON.stringify(p6.d.hitos.map((h) => [h.clave, h.desde])));

  // ===================================================================
  t.section('DIG 6. El traspaso y la curva, en el informe');
  // ===================================================================
  const gFinal = p6.g;
  t.eq('este grupo empezo aqui, no traspaso papel', gFinal.traspaso.hecho, false);
  t.check('y se dice que trabaja en la app sin haber cargado lo anterior',
    /no cargó/i.test(gFinal.traspaso.motivo), gFinal.traspaso.motivo);

  t.check('la curva mensual trae al menos el mes en curso',
    Array.isArray(gFinal.serie) && gFinal.serie.length >= 1, JSON.stringify(gFinal.serie));
  const mesActual = new Date().toISOString().slice(0, 7);
  const ultimo = gFinal.serie[gFinal.serie.length - 1];
  t.eq('y el ultimo mes de la curva es este', ultimo.mes, mesActual);
  t.check('con la actividad de hoy dentro', ultimo.total > 0, JSON.stringify(ultimo));

  t.eq('con un solo mes no hay tendencia todavia', gFinal.tendencia.hayDatos, false);

  // --- Ahora si, un lote de apertura aplicado ---
  fake.ensureSheet('LotesApertura').grid.push(['lote_1', G, 'aplicado', e.users.presi.email,
    haceDias(30), '', '', haceDias(28), 900, 400, 200, 5, '']);
  const p7 = await pedir();
  t.eq('con el lote aplicado, el traspaso consta', p7.g.traspaso.hecho, true);
  t.eq('hace 28 dias', p7.g.traspaso.diasDesde, 28);
  t.eq('trajo 900 de ahorro', p7.g.traspaso.totales.ahorro, 900);
  t.eq('400 en acciones', p7.g.traspaso.totales.acciones, 400);
  t.eq('200 de deuda', p7.g.traspaso.totales.deuda, 200);

  // ===================================================================
  t.section('DIG 7. La lectura de conjunto de la plataforma');
  // ===================================================================
  const plat = p7.r.body?.plataforma?.digitalizacion || {};
  t.check('hay un recuento por hito', Array.isArray(plat.porHito), JSON.stringify(plat).slice(0, 120));
  t.eq('con los nueve', plat.porHito.length, 9);

  const existe = plat.porHito.find((h) => h.clave === 'existe');
  t.check('todos los grupos existen en la app', existe.grupos >= 2, `${existe.grupos}`);
  const reparto = plat.porHito.find((h) => h.clave === 'reparto');
  t.eq('ninguno ha repartido utilidades todavia', reparto.grupos, 0);

  t.eq('un grupo hizo el traspaso', plat.conTraspaso, 1);
  t.check('hay una media de digitalizacion', plat.media?.n >= 2, JSON.stringify(plat.media));
  t.check('y se dice donde se atasca la mayoria', !!plat.atasco?.titulo, JSON.stringify(plat.atasco));

  // El segundo grupo del escenario (G2) no ha hecho nada: se distingue
  const g2 = (p7.r.body?.grupos || []).find((x) => x.groupId === 'G2');
  t.check('el grupo que no hace nada tiene mucha menos digitalizacion',
    g2.digitalizacion.pct < p7.g.digitalizacion.pct,
    `${g2.digitalizacion.pct}% vs ${p7.g.digitalizacion.pct}%`);
  t.eq('y su siguiente paso es que su gente entre o registre aportes',
    ['entraron', 'aportes'].includes(g2.digitalizacion.siguiente.clave), true);

  // ===================================================================
  t.section('DIG 8. Nadie mas que el admin ve esto');
  // ===================================================================
  t.status('un socio no ve la digitalizacion de los grupos',
    await get('/api/admin/metricas', e.tokens.socio1), 403);
  t.status('ni la presidencia', await get('/api/admin/metricas', e.tokens.presi), 403);
};
