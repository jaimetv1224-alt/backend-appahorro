/**
 * SUITE 18 - Indicadores para evaluar la plataforma.
 *
 * Son los numeros con los que se va a juzgar si esto sirvio. Si estan mal,
 * la conclusion del proyecto sale mal. Cada comprobacion lleva la cuenta hecha
 * a mano al lado.
 */

const {
  estadistica, horasEntre, adopcion, tiemposDeRespuesta, saludDelGrupo, notaDelGrupo, pct,
} = require('../metricas');
const { hoyLocal, PNG_PRUEBA, seedWorkbook, get, post, postArchivo, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const HORA = 3600 * 1000;
const DIA = 24 * HORA;
const haceHoras = (h) => new Date(Date.now() - h * HORA).toISOString();
const haceDias = (d) => new Date(Date.now() - d * DIA).toISOString();

module.exports = async function run() {
  // ===================================================================
  t.section('MET 1. La estadistica basica, con la cuenta a mano');
  // ===================================================================
  const e1 = estadistica([2, 4, 4, 4, 5, 5, 7, 9]);
  t.eq('son 8 casos', e1.n, 8);
  t.near('la media es 5', e1.media, 5, 0.001);
  t.near('la mediana es 4,5 (los dos del medio: 4 y 5)', e1.mediana, 4.5, 0.001);
  t.near('el minimo es 2', e1.min, 2, 0.001);
  t.near('el maximo es 9', e1.max, 9, 0.001);

  const impar = estadistica([1, 3, 100]);
  t.near('con 3 casos la mediana es el del medio: 3', impar.mediana, 3, 0.001);
  t.near('mientras la media se dispara a 34,67', impar.media, 34.67, 0.01);
  t.check('por eso se informan las dos: la media engaña con un caso raro',
    impar.media > impar.mediana * 5, `media ${impar.media} vs mediana ${impar.mediana}`);

  const vacia = estadistica([]);
  t.eq('sin casos, n es cero', vacia.n, 0);
  t.eq('y no se inventa una media', vacia.media, null);
  t.eq('los valores invalidos se descartan', estadistica([1, NaN, -5, 'x', 3]).n, 2);

  // ===================================================================
  t.section('MET 2. Horas entre dos momentos');
  // ===================================================================
  t.near('de hace 48 horas a ahora son 48', horasEntre(haceHoras(48), new Date().toISOString()), 48, 0.1);
  t.eq('sin fecha de fin, no se calcula', horasEntre(haceHoras(10), null), null);
  t.eq('si van al reves, tampoco', horasEntre(new Date().toISOString(), haceHoras(10)), null);
  t.eq('una fecha con basura da null', horasEntre('no es fecha', new Date().toISOString()), null);

  // ===================================================================
  t.section('MET 3. Adopcion: quien llego a usarla de verdad');
  // ===================================================================
  const personas = [
    { email: 'a@x.test', alta: haceDias(60) },
    { email: 'b@x.test', alta: haceDias(60) },
    { email: 'c@x.test', alta: haceDias(60) },
    { email: 'd@x.test', alta: haceDias(3) },
  ];
  const accesos = {
    // entro el mismo dia del alta y sigue entrando: activo y retenido
    'a@x.test': [{ fecha: haceDias(59) }, { fecha: haceDias(20) }, { fecha: haceDias(1) }],
    // entro una sola vez hace mucho: activo nunca mas
    'b@x.test': [{ fecha: haceDias(58) }],
    // nunca entro
    // 'c@x.test' ausente a proposito
    // se registro hace nada y ya entro
    'd@x.test': [{ fecha: haceDias(2) }],
  };
  const ad = adopcion(personas, accesos);
  t.eq('hay 4 personas registradas', ad.registradas, 4);
  t.eq('3 llegaron a entrar', ad.activaron, 3);
  t.near('la tasa de activacion es del 75%', ad.tasaActivacion, 75, 0.1);
  t.eq('1 nunca entro', ad.nuncaEntraron, 1);
  t.eq('activos en los ultimos 7 dias: 2', ad.activosUltimos7, 2);
  t.eq('activos en los ultimos 30 dias: 2', ad.activosUltimos30, 2);
  t.eq('entradas totales: 5', ad.entradasTotales, 5);
  t.near('a 1,67 entradas por persona activa', ad.entradasPorPersonaActiva, 1.67, 0.01);

  // Retencion a 30 dias: solo cuentan quienes tuvieron tiempo de volver
  t.eq('la base de retencion a 30 dias son 2 personas', ad.retencion30.base, 2);
  t.eq('de las cuales volvio 1', ad.retencion30.volvieron, 1);
  t.near('el 50%', ad.retencion30.pct, 50, 0.1);
  t.check('quien se registro hace 3 dias NO entra en la base de 30 dias',
    ad.retencion30.base === 2, `base: ${ad.retencion30.base}`);

  t.check('se mide cuanto tardan en entrar por primera vez',
    ad.horasHastaPrimerAcceso.n === 3, `n: ${ad.horasHastaPrimerAcceso.n}`);

  const sinNadie = adopcion([], {});
  t.eq('sin gente, cero registradas', sinNadie.registradas, 0);
  t.eq('y la tasa no se rompe', sinNadie.tasaActivacion, 0);

  // ===================================================================
  t.section('MET 4. Tiempos: lo que tarda el grupo en resolver');
  // ===================================================================
  const tiempos = tiemposDeRespuesta({
    aportes: [
      { creado: haceHoras(50), resuelto: haceHoras(48) },   // 2 h
      { creado: haceHoras(30), resuelto: haceHoras(26) },   // 4 h
      { creado: haceHoras(20), resuelto: haceHoras(14) },   // 6 h
      { creado: haceHoras(10), resuelto: null },            // sigue pendiente
    ],
    prestamos: [
      { creado: haceHoras(100), resuelto: haceHoras(28) },  // 72 h
    ],
    comprobantes: [],
    asambleas: [
      { creado: haceDias(10), resuelto: haceDias(3) },      // 168 h
    ],
  });

  const ap = tiempos.partes.find((p) => p.nombre === 'confirmar un aporte');
  t.eq('hay 4 aportes', ap.total, 4);
  t.eq('3 resueltos', ap.resueltos, 3);
  t.eq('1 pendiente', ap.pendientes, 1);
  t.near('la mediana de confirmacion son 4 horas', ap.horas.mediana, 4, 0.1);
  t.near('la media tambien, 4 horas', ap.horas.media, 4, 0.1);
  t.near('la mas rapida, 2 horas', ap.horas.min, 2, 0.1);
  t.near('la mas lenta, 6', ap.horas.max, 6, 0.1);

  const pr = tiempos.partes.find((p) => p.nombre === 'resolver un prestamo');
  t.near('un prestamo tardo 72 horas', pr.horas.mediana, 72, 0.5);

  const cp = tiempos.partes.find((p) => p.nombre === 'revisar un comprobante');
  t.eq('sin comprobantes, n es cero', cp.horas.n, 0);
  t.eq('y no se inventa una mediana', cp.horas.mediana, null);

  t.eq('el total de pendientes en todo el grupo es 1', tiempos.pendientesTotales, 1);

  // Juntando TODAS las esperas: 2, 4, 6, 72 y 168 horas -> la del medio es 6
  t.eq('se juntan las 5 esperas medibles', tiempos.global.n, 5);
  t.near('y la mediana de todas ellas son 6 horas', tiempos.medianaGeneral, 6, 0.1);
  t.check('que no es el promedio de las medianas (que daria 62,5)',
    Math.abs(tiempos.medianaGeneral - 62.5) > 1, `${tiempos.medianaGeneral}`);
  t.eq('el proceso mas lento es la asamblea', tiempos.peorProceso.nombre, 'celebrar una asamblea');
  t.near('con 168 horas', tiempos.peorProceso.mediana, 168, 0.5);

  const sinNada = tiemposDeRespuesta({});
  t.eq('un grupo sin actividad no tiene mediana', sinNada.medianaGeneral, null);
  t.eq('ni proceso mas lento', sinNada.peorProceso, null);

  // ===================================================================
  t.section('MET 5. Salud del grupo');
  // ===================================================================
  const salud = saludDelGrupo({
    aportes: [
      { estado: 'confirmado' }, { estado: 'confirmado' }, { estado: 'confirmado' },
      { estado: 'confirmado' }, { estado: 'rechazado' }, { estado: 'pendiente' },
    ],
    prestamos: [{ alDia: true }, { alDia: true }, { alDia: true }, { alDia: false }],
    asambleas: [
      { presentes: 4, miembros: 5 },   // 80 %
      { presentes: 3, miembros: 5 },   // 60 %
    ],
    votos: [{ emitidos: 4, presentes: 4 }, { emitidos: 2, presentes: 4 }],
  });
  t.eq('6 aportes en total', salud.aportes.total, 6);
  t.near('4 de 6 confirmados = 66,7%', salud.aportes.tasaConfirmacion, 66.7, 0.1);
  t.near('1 de 6 rechazados = 16,7%', salud.aportes.tasaRechazo, 16.7, 0.1);
  t.eq('1 aporte sigue pendiente', salud.aportes.pendientes, 1);
  t.near('3 de 4 prestamos al dia = 75%', salud.prestamos.tasaAlDia, 75, 0.1);
  t.near('la asistencia media a las asambleas es del 70%',
    salud.asambleas.asistenciaMedia, 70, 0.1);
  t.near('y la participacion en los votos, del 75%',
    salud.asambleas.participacionEnVotos, 75, 0.1);

  const saludVacia = saludDelGrupo({});
  t.eq('un grupo sin actividad no rompe nada', saludVacia.aportes.total, 0);
  t.eq('y su tasa de confirmacion es cero, no NaN', saludVacia.aportes.tasaConfirmacion, 0);
  t.eq('sin asambleas no se inventa una asistencia',
    saludVacia.asambleas.asistenciaMedia, null);

  // ===================================================================
  t.section('MET 6. La nota del grupo, para poder compararlos');
  // ===================================================================
  const bueno = notaDelGrupo({
    adopcion: { registradas: 10, tasaActivacion: 100 },
    tiempos: { medianaGeneral: 6 },          // resuelve en 6 horas
    salud: {
      aportes: { total: 10, tasaConfirmacion: 100 },
      prestamos: { alDia: 5, atrasados: 0, tasaAlDia: 100 },
      asambleas: { asistenciaMedia: 90 },
    },
  });
  t.check('un grupo que va bien saca casi 100', bueno.nota >= 95, `nota: ${bueno.nota}`);
  t.eq('con los 5 conceptos calculados', bueno.partes.length, 5);
  t.near('y cobertura completa', bueno.cobertura, 100, 0.1);

  const malo = notaDelGrupo({
    adopcion: { registradas: 10, tasaActivacion: 20 },
    tiempos: { medianaGeneral: 200 },        // tarda mas de una semana
    salud: {
      aportes: { total: 10, tasaConfirmacion: 40 },
      prestamos: { alDia: 1, atrasados: 4, tasaAlDia: 20 },
      asambleas: { asistenciaMedia: 30 },
    },
  });
  t.check('uno que va mal saca poco', malo.nota <= 35, `nota: ${malo.nota}`);
  t.check('y se distingue claramente del bueno', bueno.nota - malo.nota > 50,
    `${bueno.nota} vs ${malo.nota}`);

  const base = { adopcion: { registradas: 5, tasaActivacion: 80 } };
  const rapido = notaDelGrupo({ ...base, tiempos: { medianaGeneral: 12 } });
  const lento = notaDelGrupo({ ...base, tiempos: { medianaGeneral: 160 } });
  t.check('resolver en 12 horas puntua mas que en 160',
    rapido.nota > lento.nota, `${rapido.nota} vs ${lento.nota}`);
  t.check('con datos parciales se avisa de que la cobertura es menor',
    rapido.cobertura < 100 && !!rapido.motivo, `cobertura ${rapido.cobertura}`);

  const sinDatos = notaDelGrupo({});
  t.eq('un grupo recien creado no tiene nota', sinDatos.nota, null);
  t.check('y se explica por que', /actividad/i.test(sinDatos.motivo), sinDatos.motivo);

  // Lo que de verdad importa para no publicar un numero enganoso:
  const soloEntro = notaDelGrupo({ adopcion: { registradas: 1, tasaActivacion: 100 } });
  t.eq('un grupo donde solo consta que alguien entro NO saca 100', soloEntro.nota, null);
  t.near('su cobertura es del 35%, insuficiente', soloEntro.cobertura, 35, 0.1);
  t.check('y se dice claramente', /poca actividad/i.test(soloEntro.motivo), soloEntro.motivo);

  const conAlgo = notaDelGrupo({
    adopcion: { registradas: 5, tasaActivacion: 100 },
    salud: { aportes: { total: 4, tasaConfirmacion: 100 } },
  });
  t.eq('en cuanto hay actividad de verdad, ya se puede puntuar', conAlgo.nota, 100);
  t.near('con el 55% de cobertura', conAlgo.cobertura, 55, 0.1);

  // ===================================================================
  t.section('MET 7. El informe completo, de punta a punta');
  // ===================================================================
  seedWorkbook();
  const { HOJA, CABECERA, filaDeAcceso } = require('../accesos');
  fake.seedSheet(HOJA, [CABECERA]);
  const e = await baseScenario({ groupId: 'GME' });

  const UA_MOVIL = 'Mozilla/5.0 (Linux; Android 13; SM-A536E) Mobile Safari/537.36';
  // Unos accesos repartidos en el tiempo
  [[e.users.presi.email, 40], [e.users.presi.email, 20], [e.users.presi.email, 1],
    [e.users.teso.email, 15], [e.users.socio1.email, 2]].forEach(([correo, dias]) => {
    fake.ensureSheet(HOJA).grid.push(filaDeAcceso(correo, UA_MOVIL, '10.0.0.1', haceDias(dias)));
  });

  // Aportes: uno confirmado rapido, otro pendiente
  const ap1 = await post('/api/registrar-ahorros',
    { groupId: 'GME', userEmail: e.users.socio1.email, date: haceDias(0).split('T')[0], amount: 100 },
    e.tokens.socio1);
  await post('/api/gob/aportes/resolver',
    { groupId: 'GME', tipo: 'ahorro', movId: ap1.body?.movId, accion: 'confirmar' }, e.tokens.teso);
  await post('/api/registrar-ahorros',
    { groupId: 'GME', userEmail: e.users.socio2.email, date: haceDias(0).split('T')[0], amount: 50 },
    e.tokens.socio2);

  const inf = await get('/api/admin/metricas', e.tokens.admin);
  t.status('el informe de indicadores responde', inf, 200);

  const g = (inf.body?.grupos || []).find((x) => x.groupId === 'GME');
  t.check('trae el grupo', !!g, JSON.stringify((inf.body?.grupos || []).map((x) => x.groupId)));
  t.check('con su adopcion', g?.adopcion?.registradas > 0, JSON.stringify(g?.adopcion || {}));
  t.check('sus tiempos', Array.isArray(g?.tiempos?.partes), JSON.stringify(g?.tiempos || {}));
  t.check('su salud', !!g?.salud?.aportes, JSON.stringify(g?.salud || {}));

  const aportesG = g?.salud?.aportes;
  t.eq('cuenta los 2 aportes del grupo', aportesG?.total, 2);
  t.eq('1 confirmado', aportesG?.confirmados, 1);
  t.eq('y 1 pendiente', aportesG?.pendientes, 1);
  t.near('tasa de confirmacion del 50%', aportesG?.tasaConfirmacion, 50, 0.1);

  const tiempoAporte = (g?.tiempos?.partes || []).find((p) => /aporte/.test(p.nombre));
  t.eq('hay 1 aporte pendiente sin resolver', tiempoAporte?.pendientes, 1);
  t.check('y 1 resuelto, con su tiempo medido',
    tiempoAporte?.resueltos === 1 && tiempoAporte?.horas?.n === 1,
    JSON.stringify(tiempoAporte || {}));

  t.check('el grupo tiene nota', g?.nota?.nota !== undefined, JSON.stringify(g?.nota || {}));
  t.check('con su desglose, para saber de donde sale',
    Array.isArray(g?.nota?.partes), JSON.stringify(g?.nota || {}));

  // --- Totales de la plataforma ---
  const tot = inf.body?.plataforma || {};
  t.check('hay adopcion de toda la plataforma', tot.adopcion?.registradas > 0,
    JSON.stringify(tot.adopcion || {}));
  t.check('y tiempos agregados', !!tot.tiempos, JSON.stringify(tot.tiempos || {}).slice(0, 80));

  // ===================================================================
  t.section('MET 8. Los indicadores no los ve cualquiera');
  // ===================================================================
  t.status('un socio raso no ve los indicadores',
    await get('/api/admin/metricas', e.tokens.socio1), 403);
  t.status('la presidencia de un grupo tampoco',
    await get('/api/admin/metricas', e.tokens.presi), 403);
  t.status('y sin sesion menos', await get('/api/admin/metricas'), 401);

  const texto = JSON.stringify(inf.body || {});
  t.check('el informe no filtra contrasenas', !/\$2[aby]\$\d{2}\$/.test(texto), '');
  t.check('ni tokens', !/eyJhbGciOi/.test(texto), '');

  // ===================================================================
  t.section('MET 9. Un ciclo entero del grupo, medido de verdad');
  // ===================================================================
  seedWorkbook();
  fake.seedSheet(HOJA, [CABECERA]);
  const c = await baseScenario({ groupId: 'GCI' });
  const G = 'GCI';
  const hoyStr = hoyLocal();

  // --- Cuatro aportes: 2 confirmados, 1 rechazado, 1 sin tocar ---
  const movs = [];
  for (const [quien, monto] of [['socio1', 100], ['socio2', 80], ['socio1', 60], ['socio2', 40]]) {
    const r = await post('/api/registrar-ahorros',
      { groupId: G, userEmail: c.users[quien].email, date: hoyStr, amount: monto }, c.tokens[quien]);
    movs.push(r.body && r.body.movId);
  }
  await post('/api/gob/aportes/resolver', { groupId: G, tipo: 'ahorro', movId: movs[0], accion: 'confirmar' }, c.tokens.teso);
  await post('/api/gob/aportes/resolver', { groupId: G, tipo: 'ahorro', movId: movs[1], accion: 'confirmar' }, c.tokens.teso);
  await post('/api/gob/aportes/resolver', { groupId: G, tipo: 'ahorro', movId: movs[2], accion: 'rechazar', nota: 'no cuadra' }, c.tokens.teso);

  // --- Prestamo: se pide, la directiva vota, queda aprobado ---
  await post('/api/registrar-solicitud',
    { tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 4', Group: G } }, c.tokens.socio1);
  const solRows = fake.dumpSheet('SolicitudesPrestamos') || [];
  const solId = solRows[solRows.length - 1][0];
  await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: G, decision: 'aprobado' }, c.tokens.presi);
  t.status('el segundo voto aprueba el prestamo',
    await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: G, decision: 'aprobado' }, c.tokens.teso), 201);

  // --- Dos comprobantes: uno aprobado, otro por revisar ---
  const archivo = { campo: 'paymentImage', contenido: PNG_PRUEBA, tipo: 'image/png', nombre: 'c.png' };
  await postArchivo('/api/upload-payment',
    { loanId: solId, amount: 30, userEmail: c.users.socio1.email, groupId: G, paymentDate: hoyStr },
    archivo, c.tokens.socio1);
  const pend = await get('/api/pending-payments?groupId=' + G, c.tokens.teso);
  const listaPagos = (pend.body && (pend.body.payments || pend.body.pagos)) || [];
  const pid = listaPagos[0] && listaPagos[0].paymentId;
  t.status('el tesorero aprueba el comprobante',
    await post('/api/approve-payment', { paymentId: pid, action: 'approve' }, c.tokens.teso), 200);
  await postArchivo('/api/upload-payment',
    { loanId: solId, amount: 10, userEmail: c.users.socio1.email, groupId: G, paymentDate: hoyStr },
    archivo, c.tokens.socio1);

  // --- Asamblea: convocada, asistencia 4 de 5, abierta, acuerdo con 3 votos ---
  const conv = await post('/api/gob/asambleas',
    { groupId: G, titulo: 'Asamblea de prueba', fechaProgramada: hoyStr, modalidad: 'presencial' }, c.tokens.presi);
  const aid = conv.body && conv.body.asambleaId;
  await post('/api/gob/asambleas/' + aid + '/asistencia', {
    groupId: G,
    registros: [
      { email: c.users.presi.email, estado: 'presente' },
      { email: c.users.teso.email, estado: 'presente' },
      { email: c.users.secre.email, estado: 'presente' },
      { email: c.users.socio1.email, estado: 'presente' },
      { email: c.users.socio2.email, estado: 'ausente' },
    ],
  }, c.tokens.secre);
  await post('/api/gob/asambleas/' + aid + '/estado', { estado: 'abierta', groupId: G }, c.tokens.presi);
  const acu = await post('/api/gob/asambleas/' + aid + '/acuerdos',
    { groupId: G, tipo: 'otro', titulo: 'Mocion de prueba' }, c.tokens.presi);
  for (const quien of ['presi', 'teso', 'secre']) {
    await post('/api/gob/acuerdos/' + (acu.body && acu.body.acuerdoId) + '/votar',
      { groupId: G, voto: 'favor' }, c.tokens[quien]);
  }

  // --- Y ahora, que dice el informe ---
  const inf2 = await get('/api/admin/metricas', c.tokens.admin);
  const gc = ((inf2.body && inf2.body.grupos) || []).find((x) => x.groupId === G);
  t.check('el informe trae el grupo del ciclo completo', !!gc,
    JSON.stringify((inf2.body && inf2.body.grupos) || []).slice(0, 200));

  const parte = (n) => ((gc && gc.tiempos && gc.tiempos.partes) || []).find((x) => x.nombre === n) || {};
  const ap2 = parte('confirmar un aporte');
  t.eq('4 aportes registrados', ap2.total, 4);
  t.eq('3 resueltos', ap2.resueltos, 3);
  t.eq('1 sin resolver', ap2.pendientes, 1);
  t.check('los 3 se resolvieron al momento, no 19 horas despues',
    ap2.horas && ap2.horas.max < 0.2,
    'max: ' + (ap2.horas && ap2.horas.max) + ' h. La columna Fecha del ahorro es solo el DIA; '
    + 'el instante real de registro sale del movId.');

  const pr2 = parte('resolver un prestamo');
  t.eq('1 solicitud de prestamo', pr2.total, 1);
  t.eq('resuelta', pr2.resueltos, 1);
  t.eq('con su tiempo medido, gracias al acta de votacion', pr2.horas && pr2.horas.n, 1);

  const cp2 = parte('revisar un comprobante');
  t.eq('2 comprobantes subidos', cp2.total, 2);
  t.eq('1 revisado', cp2.resueltos, 1);
  t.eq('1 esperando', cp2.pendientes, 1);
  t.eq('el revisado tiene su tiempo', cp2.horas && cp2.horas.n, 1);

  const as2 = parte('celebrar una asamblea');
  t.eq('1 asamblea convocada', as2.total, 1);
  t.eq('y celebrada', as2.resueltos, 1);

  t.eq('en total quedan 2 cosas pendientes', gc && gc.tiempos && gc.tiempos.pendientesTotales, 2);

  // --- Salud ---
  const saludC = (gc && gc.salud) || {};
  t.eq('2 de 4 aportes confirmados', saludC.aportes && saludC.aportes.confirmados, 2);
  t.eq('1 rechazado', saludC.aportes && saludC.aportes.rechazados, 1);
  t.near('tasa de confirmacion del 50%', saludC.aportes && saludC.aportes.tasaConfirmacion, 50, 0.1);
  t.near('y de rechazo del 25%', saludC.aportes && saludC.aportes.tasaRechazo, 25, 0.1);
  t.eq('el prestamo recien dado esta al dia', saludC.prestamos && saludC.prestamos.alDia, 1);
  t.eq('ninguno atrasado', saludC.prestamos && saludC.prestamos.atrasados, 0);
  t.eq('1 asamblea celebrada', saludC.asambleas && saludC.asambleas.celebradas, 1);
  t.near('con 4 de 5 presentes: 80%', saludC.asambleas && saludC.asambleas.asistenciaMedia, 80, 0.1);
  t.near('y votaron 3 de los 4 presentes: 75%', saludC.asambleas && saludC.asambleas.participacionEnVotos, 75, 0.1);

  // --- Nota: uso 100, rapidez 100, aportes 50, prestamos 100, asistencia 80 ---
  // (100*35 + 100*25 + 50*20 + 100*10 + 80*10) / 100 = 87,5 -> 88
  t.eq('la nota del grupo sale de sus cinco conceptos', gc && gc.nota && gc.nota.nota, 88);
  t.near('sobre el 100% de los conceptos', gc && gc.nota && gc.nota.cobertura, 100, 0.1);

  // ===================================================================
  t.section('MET 10. Nada se cuenta dos veces ni se cuela de otro grupo');
  // ===================================================================
  const todosG = (inf2.body && inf2.body.grupos) || [];
  const otro = todosG.find((x) => x.groupId === 'G2');
  t.check('el otro grupo aparece por separado', !!otro, todosG.map((x) => x.groupId).join(','));
  t.eq('sin ningun aporte propio', otro && otro.salud.aportes.total, 0);
  t.eq('ni prestamos', otro && otro.salud.prestamos.total, 0);
  t.eq('y sin nota, porque no tiene actividad que juzgar', otro && otro.nota.nota, null);

  const sumaAportes = todosG.reduce((s2, x) => s2 + x.salud.aportes.total, 0);
  t.eq('los 4 aportes se cuentan una sola vez en toda la plataforma', sumaAportes, 4);
  const plat = (inf2.body && inf2.body.plataforma) || {};
  t.eq('y el total de la plataforma coincide', plat.salud && plat.salud.aportes, 4);
  t.eq('igual que los pendientes', plat.tiempos && plat.tiempos.pendientesTotales, 2);
  t.check('la plataforma cuenta a toda la gente registrada',
    plat.adopcion && plat.adopcion.registradas >= 7, String(plat.adopcion && plat.adopcion.registradas));
  t.eq('y avisa de cuantos grupos no tienen nota todavia', plat.gruposSinNota, 1);

  const orden = todosG.map((x) => x.groupId);
  t.eq('el grupo con nota va primero, el que no la tiene al final', orden[orden.length - 1], 'G2');

  // ===================================================================
  t.section('MET 11. Resuelto sin hora anotada NO es lo mismo que pendiente');
  // ===================================================================
  // Salio mirando el informe con datos ya cargados: una solicitud aprobada
  // meses atras, de la que no quedo la hora de la decision, aparecia como
  // "esperando respuesta". Es decirle al grupo que alguien sigue en espera.
  const mixto = tiemposDeRespuesta({
    prestamos: [
      { estado: 'aprobado', creado: haceHoras(100), resuelto: haceHoras(28), cerrado: true },
      { estado: 'aprobado', creado: haceDias(200), resuelto: null, cerrado: true },
      { estado: 'pendiente', creado: haceHoras(5), resuelto: null, cerrado: false },
    ],
  });
  const bloque = mixto.partes.find((x) => x.nombre === 'resolver un prestamo');
  t.eq('3 solicitudes en total', bloque.total, 3);
  t.eq('2 resueltas, aunque de una no se sepa cuando', bloque.resueltos, 2);
  t.eq('y solo 1 pendiente de verdad', bloque.pendientes, 1);
  t.eq('la mediana se calcula sobre 1 caso, no sobre 2', bloque.horas.n, 1);
  t.eq('y se avisa de que 1 resuelta no se pudo medir', bloque.sinFecha, 1);
  t.near('la mediana son las 72 horas del caso medible', bloque.horas.mediana, 72, 0.5);

  // Sin `cerrado` explicito se sigue comportando como antes
  const viejoEstilo = tiemposDeRespuesta({
    aportes: [{ creado: haceHoras(4), resuelto: haceHoras(2) }, { creado: haceHoras(3), resuelto: null }],
  });
  const b2 = viejoEstilo.partes[0];
  t.eq('con el trato de siempre, 1 resuelto', b2.resueltos, 1);
  t.eq('y 1 pendiente', b2.pendientes, 1);
  t.eq('sin resueltos sin fecha', b2.sinFecha, 0);

  // ===================================================================
  t.section('MET 12. Lo que aun no toca no es un atraso');
  // ===================================================================
  seedWorkbook();
  fake.seedSheet(HOJA, [CABECERA]);
  const f = await baseScenario({ groupId: 'GAS' });
  const dentroDeUnaSemana = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const laSemanaPasada = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  await post('/api/gob/asambleas', {
    groupId: 'GAS', titulo: 'La de la proxima semana', fechaProgramada: dentroDeUnaSemana,
  }, f.tokens.presi);

  const infA = await get('/api/admin/metricas', f.tokens.admin);
  const gA = (infA.body?.grupos || []).find((x) => x.groupId === 'GAS');
  const asaA = (gA?.tiempos?.partes || []).find((x) => /asamblea/.test(x.nombre));
  t.eq('una asamblea convocada para dentro de una semana no cuenta como atraso',
    asaA?.pendientes, 0);
  t.eq('ni siquiera entra en el recuento todavia', asaA?.total, 0);
  t.eq('y no engorda los pendientes del grupo', gA?.tiempos?.pendientesTotales, 0);

  // Ahora una que ya paso de fecha y sigue sin celebrarse: eso si es un atraso
  const filasAsa = fake.ensureSheet('Asambleas');
  filasAsa.grid.forEach((fila) => {
    if ((fila[1] || '') === 'GAS') fila[3] = laSemanaPasada;
  });
  const infB = await get('/api/admin/metricas', f.tokens.admin);
  const gB = (infB.body?.grupos || []).find((x) => x.groupId === 'GAS');
  const asaB = (gB?.tiempos?.partes || []).find((x) => /asamblea/.test(x.nombre));
  t.eq('la que ya paso de fecha y sigue programada si es un atraso', asaB?.pendientes, 1);
  t.eq('y aparece en los pendientes del grupo', gB?.tiempos?.pendientesTotales, 1);

  // ===================================================================
  t.section('MET 13. La participacion en los votos sale del recuento del acta');
  // ===================================================================
  // El acta lleva su propio recuento (a favor, en contra, abstenciones). Antes
  // solo se contaban las papeletas sueltas y un acuerdo votado salia con 0%.
  seedWorkbook();
  fake.seedSheet(HOJA, [CABECERA]);
  const h = await baseScenario({ groupId: 'GVO' });
  const ahora = new Date().toISOString();

  // Las hojas de gobernanza las crea el propio modulo la primera vez; aqui hay
  // que sembrarlas con su cabecera para poder escribir filas a mano.
  const G_SHEETS = require('../governance').SHEETS || {};
  [['Asambleas', 'asambleas'], ['AsambleaAsistencia', 'asistencia'], ['Acuerdos', 'acuerdos']]
    .forEach(([nombre, clave]) => {
      const def = G_SHEETS[clave];
      if (def) fake.seedSheet(nombre, [def.headers]);
    });

  fake.ensureSheet('Asambleas').grid.push(['asm_v', 'GVO', 'Ordinaria', ahora, 'presencial',
    'cerrada', '', h.users.presi.email, ahora, ahora, ahora, h.users.presi.email, '', '']);
  ['presi', 'teso', 'secre', 'socio1'].forEach((quien) => {
    fake.ensureSheet('AsambleaAsistencia').grid.push(
      ['asm_v', 'GVO', h.users[quien].email, 'presente', h.users.secre.email, ahora]);
  });
  fake.ensureSheet('AsambleaAsistencia').grid.push(
    ['asm_v', 'GVO', h.users.socio2.email, 'ausente', h.users.secre.email, ahora]);
  // Acuerdo con 3 a favor y 0 en contra, sin ninguna papeleta suelta guardada
  fake.ensureSheet('Acuerdos').grid.push(['acu_v', 'asm_v', 'GVO', 'otro', 'Mocion', '', '{}',
    'aprobado', h.users.presi.email, ahora, ahora, '', 3, 0, 0]);

  const infV = await get('/api/admin/metricas', h.tokens.admin);
  const gV = (infV.body?.grupos || []).find((x) => x.groupId === 'GVO');
  t.eq('4 de 5 presentes: 80% de asistencia', gV?.salud?.asambleas?.asistenciaMedia, 80);
  t.near('y votaron 3 de esos 4: 75%', gV?.salud?.asambleas?.participacionEnVotos, 75, 0.1);
  t.check('no sale 0% por no encontrar papeletas sueltas',
    gV?.salud?.asambleas?.participacionEnVotos > 0,
    String(gV?.salud?.asambleas?.participacionEnVotos));

  // ===================================================================
  t.section('MET 9. Los indicadores no se comen la cuota del grupo');
  // ===================================================================
  // Leia dieciseis pestañas de una en una. La cuota de Google la comparte todo
  // el grupo: cuando se agota, la app deja de leer para TODAS, no solo para
  // quien abrio la pantalla pesada.
  const hojaMod = require('../hoja');
  const medirLecturas = async () => {
    hojaMod.invalidarTodo();
    hojaMod.reiniciarEstadisticas();
    const antes = hojaMod.estadisticas().lecturas;
    const res = await get('/api/admin/metricas', h.tokens.admin);
    return { res, gastadas: hojaMod.estadisticas().lecturas - antes };
  };

  // Caso 1: el libro de un grupo que lleva tiempo, con TODAS las pestañas que
  // lee el informe. Si falta una sola, el lote falla entero y se mediria el
  // camino degradado creyendo que se mide el normal.
  ['Users', 'Groups', 'UserGroupLinks', 'Accesos', 'Savings', 'Acciones',
    'Loans', 'LoanPayments', 'SolicitudesPrestamos', 'AprobacionesAsamblea',
    'Asambleas', 'AsambleaAsistencia', 'Acuerdos', 'AcuerdoVotos',
    'LotesApertura', 'CierresUtilidades'].forEach((n) => fake.ensureSheet(n));
  const completo = await medirLecturas();
  t.status('los indicadores responden', completo.res, 200);
  t.check(`con el libro completo gasta ${completo.gastadas} lectura(s), no dieciseis`,
    completo.gastadas <= 2, `${completo.gastadas} lecturas`);
  t.check('y trae los mismos grupos que antes',
    (completo.res.body?.grupos || []).length > 0,
    `${(completo.res.body?.grupos || []).length} grupos`);

  // Caso 2: libro recien creado, con una pestaña que todavia no existe. El lote
  // falla entero (es lo que hace Google) y se rehace con lo que si hay.
  fake.store.sheets.delete('LotesApertura');
  const incompleto = await medirLecturas();
  t.status('con una pestaña que no existe todavia, tampoco revienta', incompleto.res, 200);
  t.check(`y aun asi gasta ${incompleto.gastadas} lectura(s), no dieciseis`,
    incompleto.gastadas <= 6, `${incompleto.gastadas} lecturas`);
  t.check('sigue trayendo los grupos',
    (incompleto.res.body?.grupos || []).length > 0,
    `${(incompleto.res.body?.grupos || []).length} grupos`);
};
