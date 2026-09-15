/**
 * SUITE 2 - Control interno: reglamento, confirmacion de aportes, asambleas,
 * acuerdos con votacion y apertura de saldos (paso de papel a digital).
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

module.exports = async function run() {
  seedWorkbook();
  const { users, tokens, groupId } = await baseScenario();

  // ===================================================================
  t.section('GOB 1. Reglamento del grupo');
  // ===================================================================
  const reglas0 = await get(`/api/gob/reglas?groupId=${groupId}`, tokens.socio1);
  t.status('cualquier socio puede leer el reglamento', reglas0, 200);
  t.eq('por defecto los aportes requieren aprobacion', reglas0.body?.reglas?.requiereAprobacionAportes, true);
  t.eq('por defecto los prestamos requieren aprobacion colegiada', reglas0.body?.reglas?.requiereAprobacionPrestamos, true);
  t.eq('el tope de credito por defecto es 3x el ahorro', reglas0.body?.reglas?.topePrestamoFactorAhorro, 3);

  t.status('un socio raso NO puede cambiar el reglamento',
    await post('/api/gob/reglas', { groupId, topePrestamoFactorAhorro: 99 }, tokens.socio1), 403);
  t.status('el tesorero tampoco (es potestad de la presidencia)',
    await post('/api/gob/reglas', { groupId, topePrestamoFactorAhorro: 99 }, tokens.teso), 403);
  t.status('un ajeno tampoco',
    await post('/api/gob/reglas', { groupId, topePrestamoFactorAhorro: 99 }, tokens.ajeno), 403);

  t.status('la presidenta SI puede endurecer el reglamento (bajar el tope)',
    await post('/api/gob/reglas', { groupId, topePrestamoFactorAhorro: 2, aporteMinimo: 5 }, tokens.presi), 200);

  const relajar = await post('/api/gob/reglas', { groupId, requiereAprobacionAportes: false }, tokens.presi);
  t.status('relajar el control interno exige acuerdo de asamblea', relajar, 409);
  t.eq('...y lo indica explicitamente', relajar.body?.requiereAcuerdo, true);

  const reglas1 = await get(`/api/gob/reglas?groupId=${groupId}`, tokens.presi);
  t.eq('el reglamento endurecido quedo guardado', reglas1.body?.reglas?.topePrestamoFactorAhorro, 2);
  t.eq('la aprobacion de aportes sigue activa tras el intento fallido',
    reglas1.body?.reglas?.requiereAprobacionAportes, true);

  // ===================================================================
  t.section('GOB 2. Confirmacion de aportes por tesoreria');
  // ===================================================================
  const dec = await post('/api/savings', { groupId, tipo: 'mensual', monto: 120, descripcion: 'aporte de agosto' }, tokens.socio1);
  t.status('el socio declara su aporte', dec, 200);
  t.eq('nace pendiente', dec.body?.estado, 'pendiente');
  const movAhorro = dec.body?.movId;
  t.check('devuelve un identificador de movimiento', !!movAhorro, JSON.stringify(dec.body));

  const decAcc = await post('/api/registrar-acciones',
    { groupId, date: '2026-08-05', shares: 10, shareValue: 10, interestRate: 2 }, tokens.socio1);
  const movAccion = decAcc.body?.movId;

  t.status('un socio raso no ve la bandeja de pendientes',
    await get(`/api/gob/aportes-pendientes?groupId=${groupId}`, tokens.socio1), 403);
  t.status('un ajeno tampoco',
    await get(`/api/gob/aportes-pendientes?groupId=${groupId}`, tokens.ajeno), 403);

  const bandeja = await get(`/api/gob/aportes-pendientes?groupId=${groupId}`, tokens.teso);
  t.status('el tesorero ve la bandeja', bandeja, 200);
  t.eq('hay 1 ahorro pendiente', bandeja.body?.ahorros?.length, 1);
  t.eq('hay 1 compra de acciones pendiente', bandeja.body?.acciones?.length, 1);
  t.near('el total pendiente es 120 + 100', bandeja.body?.totalPendiente, 220);

  t.status('el propio socio no puede confirmarse su aporte',
    await post('/api/gob/aportes/resolver',
      { groupId, tipo: 'ahorro', movId: movAhorro, accion: 'confirmar' }, tokens.socio1), 403);

  t.status('el secretario no confirma dinero (solo presidencia y tesoreria)',
    await post('/api/gob/aportes/resolver',
      { groupId, tipo: 'ahorro', movId: movAhorro, accion: 'confirmar' }, tokens.secre), 403);

  const conf = await post('/api/gob/aportes/resolver',
    { groupId, tipo: 'ahorro', movId: movAhorro, accion: 'confirmar', nota: 'recibido en efectivo' }, tokens.teso);
  t.status('el tesorero confirma el ahorro', conf, 200);
  t.eq('queda confirmado', conf.body?.estado, 'confirmado');

  t.status('confirmar dos veces el mismo movimiento devuelve 409',
    await post('/api/gob/aportes/resolver',
      { groupId, tipo: 'ahorro', movId: movAhorro, accion: 'confirmar' }, tokens.teso), 409);

  const trasConf = await get(`/api/savings/complete?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  t.near('ahora si cuenta en el patrimonio', trasConf.body?.data?.totalAhorros, 120);
  t.near('y ya no figura como pendiente', trasConf.body?.data?.pendientes?.totalAhorros, 0);

  const rech = await post('/api/gob/aportes/resolver',
    { groupId, tipo: 'accion', movId: movAccion, accion: 'rechazar', nota: 'no se recibio el dinero' }, tokens.presi);
  t.status('la presidenta rechaza la compra de acciones', rech, 200);
  const trasRech = await get(`/api/savings/complete?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  t.near('las acciones rechazadas no suman capital', trasRech.body?.data?.totalAcciones, 0);
  t.near('ni quedan como pendientes', trasRech.body?.data?.pendientes?.totalAcciones, 0);

  const mios = await get(`/api/gob/mis-aportes?groupId=${groupId}`, tokens.socio1);
  t.status('el socio consulta el estado de sus aportes', mios, 200);
  t.near('resumen: 120 confirmados', mios.body?.resumen?.ahorroConfirmado, 120);
  t.eq('el socio ve el rechazo con su motivo',
    mios.body?.acciones?.find((a) => a.movId === movAccion)?.estado, 'rechazado');

  t.status('no se puede resolver un movimiento inexistente',
    await post('/api/gob/aportes/resolver', { groupId, tipo: 'ahorro', movId: 'no_existe', accion: 'confirmar' }, tokens.teso), 404);

  // ===================================================================
  t.section('GOB 3. Asambleas: convocatoria, apertura y cierre');
  // ===================================================================
  t.status('un socio raso no convoca asamblea',
    await post('/api/gob/asambleas', { groupId, titulo: 'Mi asamblea', fechaProgramada: '2026-09-01' }, tokens.socio1), 403);
  t.status('el tesorero no convoca (es de presidencia/secretaria)',
    await post('/api/gob/asambleas', { groupId, titulo: 'X', fechaProgramada: '2026-09-01' }, tokens.teso), 403);
  t.status('sin titulo no se convoca',
    await post('/api/gob/asambleas', { groupId, fechaProgramada: '2026-09-01' }, tokens.presi), 400);
  t.status('con fecha invalida no se convoca',
    await post('/api/gob/asambleas', { groupId, titulo: 'X', fechaProgramada: 'el jueves' }, tokens.presi), 400);

  const conv = await post('/api/gob/asambleas', {
    groupId, titulo: 'Asamblea ordinaria de septiembre', fechaProgramada: '2026-09-01',
    modalidad: 'presencial', agenda: '1. Saldos iniciales\n2. Varios',
  }, tokens.presi);
  t.status('la presidenta convoca la asamblea', conv, 201);
  const asambleaId = conv.body?.asambleaId;
  t.check('devuelve el id de la asamblea', !!asambleaId, JSON.stringify(conv.body));

  const lista = await get(`/api/gob/asambleas?groupId=${groupId}`, tokens.socio1);
  t.eq('todos los socios ven la convocatoria', lista.body?.asambleas?.length, 1);
  t.status('un ajeno no ve las asambleas del grupo',
    await get(`/api/gob/asambleas?groupId=${groupId}`, tokens.ajeno), 403);

  t.status('no se puede cerrar una asamblea que aun no se abrio',
    await post(`/api/gob/asambleas/${asambleaId}/estado`, { estado: 'cerrada' }, tokens.presi), 409);

  // Asistencia
  t.status('no se registra asistencia de quien no es miembro',
    await post(`/api/gob/asambleas/${asambleaId}/asistencia`,
      { registros: [{ email: users.ajeno.email, estado: 'presente' }] }, tokens.secre), 400);
  t.status('no se acepta un estado de asistencia invalido',
    await post(`/api/gob/asambleas/${asambleaId}/asistencia`,
      { registros: [{ email: users.socio1.email, estado: 'quiza' }] }, tokens.secre), 400);

  const asis = await post(`/api/gob/asambleas/${asambleaId}/asistencia`, {
    registros: [
      { email: users.presi.email, estado: 'presente' },
      { email: users.teso.email, estado: 'presente' },
      { email: users.secre.email, estado: 'presente' },
      { email: users.socio1.email, estado: 'presente' },
      { email: users.socio2.email, estado: 'ausente' },
    ],
  }, tokens.secre);
  t.status('la secretaria registra la asistencia', asis, 200);
  t.eq('se registraron 5 asistencias', asis.body?.registrados, 5);

  const det = await get(`/api/gob/asambleas/${asambleaId}`, tokens.socio1);
  t.status('el detalle de la asamblea es visible para el socio', det, 200);
  t.eq('quorum requerido = 3 de 5 miembros (50%)', det.body?.quorum?.requerido, 3);
  t.eq('presentes = 4', det.body?.quorum?.presentes, 4);
  t.eq('hay quorum', det.body?.quorum?.alcanzado, true);

  t.status('la presidenta abre la asamblea',
    await post(`/api/gob/asambleas/${asambleaId}/estado`, { estado: 'abierta' }, tokens.presi), 200);
  t.status('no se puede convocar otra asamblea con una abierta',
    await post('/api/gob/asambleas', { groupId, titulo: 'Otra', fechaProgramada: '2026-09-02' }, tokens.presi), 409);

  // ===================================================================
  t.section('GOB 4. Acuerdos y votacion');
  // ===================================================================
  t.status('un socio raso no propone acuerdos',
    await post(`/api/gob/asambleas/${asambleaId}/acuerdos`, { tipo: 'otro', titulo: 'Mi mocion' }, tokens.socio1), 403);
  t.status('no se acepta un tipo de acuerdo desconocido',
    await post(`/api/gob/asambleas/${asambleaId}/acuerdos`, { tipo: 'inventado', titulo: 'X' }, tokens.presi), 400);

  const acu = await post(`/api/gob/asambleas/${asambleaId}/acuerdos`, {
    tipo: 'gasto', titulo: 'Compra de un cuaderno de actas', descripcion: 'Gasto de 15 dolares',
  }, tokens.secre);
  t.status('la secretaria propone un acuerdo', acu, 201);
  const acuerdoId = acu.body?.acuerdoId;

  t.status('quien esta AUSENTE no puede votar',
    await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, tokens.socio2), 403);
  t.status('un ajeno al grupo no puede votar',
    await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, tokens.ajeno), 403);
  t.status('no se acepta un voto invalido',
    await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'quizas' }, tokens.presi), 400);

  const v1 = await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, tokens.presi);
  t.status('la presidenta vota a favor', v1, 201);
  t.eq('el acuerdo sigue abierto con 1 voto', v1.body?.estado, 'abierto');

  t.status('nadie vota dos veces el mismo acuerdo',
    await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'contra' }, tokens.presi), 409);

  await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, tokens.teso);
  const v3 = await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, tokens.socio1);
  t.eq('con 3 de 4 presentes a favor el acuerdo queda aprobado', v3.body?.estado, 'aprobado');
  t.eq('el conteo a favor es 3', v3.body?.aFavor, 3);

  t.status('un acuerdo ya resuelto no admite mas votos',
    await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'contra' }, tokens.secre), 409);

  // ===================================================================
  t.section('GOB 5. Apertura: del papel al sistema');
  // ===================================================================
  t.status('un socio raso no crea lotes de apertura',
    await post('/api/gob/apertura/lote', { groupId, filas: [{ email: users.socio1.email, ahorro: 10 }] }, tokens.socio1), 403);
  t.status('un lote sin filas se rechaza',
    await post('/api/gob/apertura/lote', { groupId, filas: [] }, tokens.teso), 400);
  t.status('no se admiten socios que no pertenecen al grupo',
    await post('/api/gob/apertura/lote', { groupId, filas: [{ email: users.ajeno.email, ahorro: 10 }] }, tokens.teso), 400);
  t.status('no se admiten saldos negativos',
    await post('/api/gob/apertura/lote', { groupId, filas: [{ email: users.socio1.email, ahorro: -50 }] }, tokens.teso), 400);
  t.status('no se admite el mismo socio dos veces',
    await post('/api/gob/apertura/lote', {
      groupId, filas: [{ email: users.socio1.email, ahorro: 10 }, { email: users.socio1.email, ahorro: 20 }],
    }, tokens.teso), 400);
  t.status('no se admite una fila vacia de saldos',
    await post('/api/gob/apertura/lote', { groupId, filas: [{ email: users.socio1.email, ahorro: 0, acciones: 0, deuda: 0 }] }, tokens.teso), 400);
  t.status('acciones sin valor de accion se rechazan',
    await post('/api/gob/apertura/lote', { groupId, filas: [{ email: users.socio1.email, acciones: 5, valorAccion: 0 }] }, tokens.teso), 400);

  const lote = await post('/api/gob/apertura/lote', {
    groupId,
    nota: 'Saldos del cuaderno al 31 de agosto',
    filas: [
      { email: users.socio1.email, ahorro: 250.50, acciones: 12, valorAccion: 10, nota: 'libreta 001' },
      { email: users.socio2.email, ahorro: 480, acciones: 30, valorAccion: 10, deuda: 200, plazoDeuda: 5 },
      { email: users.presi.email, ahorro: 1000, acciones: 50, valorAccion: 10 },
    ],
  }, tokens.teso);
  t.status('el tesorero crea el lote de apertura', lote, 201);
  const loteId = lote.body?.loteId;
  t.near('total de ahorro del lote', lote.body?.resumen?.totalAhorro, 1730.5);
  t.eq('total de acciones del lote', lote.body?.resumen?.totalAcciones, 92);
  t.near('total de deuda del lote', lote.body?.resumen?.totalDeuda, 200);

  t.status('no se puede aplicar un lote sin someterlo a asamblea',
    await post(`/api/gob/apertura/lote/${loteId}/aplicar`, {}, tokens.teso), 409);

  const prop = await post(`/api/gob/apertura/lote/${loteId}/proponer`, { asambleaId }, tokens.teso);
  t.status('el lote se somete a la asamblea', prop, 200);
  const acuerdoLote = prop.body?.acuerdoId;

  t.status('aun aprobado el lote NO se aplica sin votacion favorable',
    await post(`/api/gob/apertura/lote/${loteId}/aplicar`, {}, tokens.teso), 409);

  await post(`/api/gob/acuerdos/${acuerdoLote}/votar`, { voto: 'favor' }, tokens.presi);
  await post(`/api/gob/acuerdos/${acuerdoLote}/votar`, { voto: 'favor' }, tokens.teso);
  const votoFinal = await post(`/api/gob/acuerdos/${acuerdoLote}/votar`, { voto: 'favor' }, tokens.secre);
  t.eq('la asamblea aprueba los saldos iniciales', votoFinal.body?.estado, 'aprobado');

  const aplicar = await post(`/api/gob/apertura/lote/${loteId}/aplicar`, {}, tokens.teso);
  t.status('con el acuerdo aprobado el lote se aplica', aplicar, 200);
  t.eq('se cargaron 3 ahorros', aplicar.body?.aplicado?.ahorros, 3);
  t.eq('se cargaron 3 paquetes de acciones', aplicar.body?.aplicado?.acciones, 3);
  t.eq('se cargo 1 deuda', aplicar.body?.aplicado?.deudas, 1);

  t.status('un lote aplicado no se vuelve a aplicar',
    await post(`/api/gob/apertura/lote/${loteId}/aplicar`, {}, tokens.teso), 409);

  const socio2Completo = await get(`/api/savings/complete?email=${users.socio2.email}&groupId=${groupId}`, tokens.socio2);
  t.near('socio2 arranca con 480 de ahorro confirmado', socio2Completo.body?.data?.totalAhorros, 480);
  t.near('socio2 arranca con 300 en acciones (30 x 10)', socio2Completo.body?.data?.totalAcciones, 300);
  t.near('el ahorro de apertura NO queda pendiente', socio2Completo.body?.data?.pendientes?.total, 0);

  const prestamosSocio2 = await get(`/api/obtener-prestamos?groupId=${groupId}&userEmail=${users.socio2.email}`, tokens.socio2);
  t.check('socio2 arrastra su deuda de 200 del cuaderno',
    JSON.stringify(prestamosSocio2.body).includes('200'),
    JSON.stringify(prestamosSocio2.body).slice(0, 300));

  // ===================================================================
  t.section('GOB 6. Cierre de asamblea y acta');
  // ===================================================================
  const acuSinVotos = await post(`/api/gob/asambleas/${asambleaId}/acuerdos`, {
    tipo: 'otro', titulo: 'Punto que nadie voto',
  }, tokens.presi);
  t.status('se propone un punto que quedara sin votar', acuSinVotos, 201);

  t.status('la presidenta cierra la asamblea',
    await post(`/api/gob/asambleas/${asambleaId}/estado`, { estado: 'cerrada' }, tokens.presi), 200);

  const detFinal = await get(`/api/gob/asambleas/${asambleaId}`, tokens.presi);
  const sinVotos = detFinal.body?.acuerdos?.find((a) => a.acuerdoId === acuSinVotos.body.acuerdoId);
  // 'sin_resolver', no 'rechazado': nadie lo voto en contra. Decir "rechazado"
  // de un punto que no se llego a votar es falso y ademas irreversible, porque
  // un acuerdo rechazado ya no admite votos.
  t.eq('al cerrar, el punto que nadie voto queda sin resolver', sinVotos?.estado, 'sin_resolver');
  t.eq('la asamblea queda cerrada', detFinal.body?.asamblea?.estado, 'cerrada');

  t.status('con la asamblea cerrada ya no se vota',
    await post(`/api/gob/acuerdos/${acuSinVotos.body.acuerdoId}/votar`, { voto: 'favor' }, tokens.presi), 409);
  t.status('una asamblea cerrada no se reabre',
    await post(`/api/gob/asambleas/${asambleaId}/estado`, { estado: 'abierta' }, tokens.presi), 409);

  const acta = await post('/api/registrar-acta', {
    grupoId: groupId, titulo: 'Acta de la asamblea de septiembre',
    contenido: 'Se aprobaron los saldos iniciales del cuaderno.',
    asistentes: 'presi, teso, secre, socio1',
  }, tokens.secre);
  t.status('la secretaria registra el acta', acta, 201);
  const actas = await get(`/api/actas-asamblea?groupId=${groupId}`, tokens.socio1);
  t.eq('el acta queda visible para el grupo', actas.body?.actas?.length, 1);

  // ===================================================================
  t.section('GOB 7. Reglamento aplicado a los prestamos');
  // ===================================================================
  // socio1 tiene 250.50 (apertura) + 120 (confirmado) = 370.50; tope 2x = 741
  const sobreCupo = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 5000, Detalles: 'Plazo: 12', Group: groupId },
  }, tokens.socio1);
  t.status('una solicitud por encima del cupo se rechaza', sobreCupo, 409);
  t.eq('...con el codigo correcto', sobreCupo.body?.codigo, 'SOBRE_CUPO');
  t.near('...e informa el cupo real (2x de 370.50)', sobreCupo.body?.cupoMaximo, 741);

  const dentroCupo = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 400, Detalles: 'Plazo: 4', Group: groupId },
  }, tokens.socio1);
  t.status('una solicitud dentro del cupo se acepta', dentroCupo, 201);

  const solRows = fake.dumpSheet('SolicitudesPrestamos') || [];
  const solId = solRows[solRows.length - 1][0];

  const directa = await post('/api/approve-loan-request', { loanId: solId, action: 'approve' }, tokens.presi);
  t.status('con aprobacion colegiada activa, un solo lider no aprueba', directa, 409);
  t.eq('...y se le indica que debe votar', directa.body?.codigo, 'REQUIERE_VOTACION');

  // La via legacy tampoco puede saltarse la votacion
  const legacy = await post('/api/aprobar-solicitud', { tipo: 'prestamo', solicitudId: solId, nuevoEstado: 'aprobado' }, tokens.teso);
  t.status('la via antigua tampoco permite aprobar sin votacion', legacy, 409);
  t.eq('...con el mismo codigo', legacy.body?.codigo, 'REQUIERE_VOTACION');
  t.status('la via antigua rechaza estados inventados',
    await post('/api/aprobar-solicitud', { tipo: 'prestamo', solicitudId: solId, nuevoEstado: 'quiza' }, tokens.teso), 400);

  await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tokens.presi);
  await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tokens.teso);
  const estadoFinal = (fake.dumpSheet('SolicitudesPrestamos') || []).find((r) => r[0] === solId)?.[5];
  t.eq('con el quorum de la junta la solicitud se aprueba', estadoFinal, 'aprobado');

  t.status('una solicitud ya aprobada no se reprocesa por la via antigua',
    await post('/api/aprobar-solicitud', { tipo: 'prestamo', solicitudId: solId, nuevoEstado: 'rechazado' }, tokens.presi), 409);
  t.eq('sigue habiendo un solo prestamo en Loans',
    (fake.dumpSheet('Loans') || []).slice(1).filter((r) => r[0] === solId).length, 1);

  // Con el prestamo activo, el maximo por defecto (1) impide otro
  const segundo = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 2', Group: groupId },
  }, tokens.socio1);
  t.status('no se permite un segundo prestamo activo', segundo, 409);
  t.eq('...con el codigo correcto', segundo.body?.codigo, 'MAX_PRESTAMOS_ACTIVOS');

  // ===================================================================
  t.section('GOB 8. Tablero y bitacora');
  // ===================================================================
  const tablero = await get(`/api/gob/tablero?groupId=${groupId}`, tokens.presi);
  t.status('el tablero de control responde', tablero, 200);
  t.eq('reporta 5 miembros activos', tablero.body?.miembros?.activos, 5);
  t.eq('reporta 3 lideres', tablero.body?.miembros?.lideres, 3);
  t.eq('reporta el lote aplicado', tablero.body?.apertura?.lotesAplicados, 1);
  t.check('el patrimonio confirmado del grupo es > 0', Number(tablero.body?.aportes?.ahorroConfirmado) > 0,
    JSON.stringify(tablero.body?.aportes));

  const bitacora = await get(`/api/gob/bitacora?groupId=${groupId}`, tokens.presi);
  t.status('la bitacora responde a un lider', bitacora, 200);
  t.check('la bitacora registro eventos', (bitacora.body?.eventos?.length || 0) > 5,
    `eventos: ${bitacora.body?.eventos?.length}`);
  t.check('la bitacora incluye la aplicacion del lote',
    (bitacora.body?.eventos || []).some((e) => e.accion === 'lote_apertura_aplicado'),
    JSON.stringify((bitacora.body?.eventos || []).map((e) => e.accion)));
  t.status('un socio raso no lee la bitacora',
    await get(`/api/gob/bitacora?groupId=${groupId}`, tokens.socio1), 403);
};
