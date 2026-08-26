/**
 * SUITE 5 - CONSISTENCIA: el mismo hecho visto por personas distintas tiene que
 * dar exactamente el mismo numero.
 *
 * Es dinero de gente real: si el socio ve $500, el tesorero ve $480 y el admin
 * ve $520, el sistema no sirve aunque cada pantalla "funcione". Aqui se cruzan
 * todas las vistas contra la misma verdad.
 */

const { seedWorkbook, get, post, fake, anotar } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** Reune el ahorro/acciones de un socio desde TODAS las vistas disponibles. */
async function vistasDelSocio(groupId, email, tokenSocio, tokenLider, tokenAdmin) {
  const [completo, mis, stats, ahorros, acciones, tablero, resumen] = [
    await get(`/api/savings/complete?email=${email}&groupId=${groupId}`, tokenSocio),
    await get(`/api/gob/mis-aportes?groupId=${groupId}`, tokenSocio),
    await get(`/api/savings/stats?email=${email}&groupId=${groupId}`, tokenSocio),
    await get(`/api/obtener-ahorros?groupId=${groupId}&userEmail=${email}`, tokenSocio),
    await get(`/api/obtener-acciones?groupId=${groupId}&userEmail=${email}`, tokenSocio),
    await get(`/api/gob/tablero?groupId=${groupId}`, tokenLider),
    await get('/api/admin/resumen', tokenAdmin),
  ];
  return {
    completoAhorro: r2(completo.body?.data?.totalAhorros),
    completoAcciones: r2(completo.body?.data?.totalAcciones),
    completoPendiente: r2(completo.body?.data?.pendientes?.totalAhorros),
    misAhorro: r2(mis.body?.resumen?.ahorroConfirmado),
    misPendiente: r2(mis.body?.resumen?.ahorroPendiente),
    misAcciones: r2(mis.body?.resumen?.accionesConfirmadas),
    statsAhorro: r2(stats.body?.stats?.totalSavingsAmount),
    statsPendiente: r2(stats.body?.stats?.pendienteAmount),
    sumaObtenerAhorros: r2((ahorros.body?.savings || []).reduce((s, x) => s + Number(x.amount || 0), 0)),
    sumaObtenerAcciones: r2((acciones.body?.shares || []).reduce((s, x) => s + Number(x.shares || 0) * Number(x.shareValue || 0), 0)),
    unidadesAcciones: (acciones.body?.shares || []).reduce((s, x) => s + Number(x.shares || 0), 0),
    tableroAhorro: r2(tablero.body?.aportes?.ahorroConfirmado),
    tableroPendiente: r2(tablero.body?.aportes?.ahorroPendiente),
    adminAhorro: r2(resumen.body?.resumen?.totalAhorros),
    adminPendiente: r2(resumen.body?.resumen?.totalAhorrosPendientes),
  };
}

module.exports = async function run() {
  seedWorkbook();
  const { users, tokens, groupId } = await baseScenario();

  // ===================================================================
  t.section('CONS 1. Un socio, cinco vistas, el mismo numero');
  // ===================================================================
  const decl = await post('/api/savings', { groupId, tipo: 'mensual', monto: 137.37 }, tokens.socio1);
  const mov1 = decl.body?.movId;
  await post('/api/savings', { groupId, tipo: 'extra', monto: 62.63 }, tokens.socio1);

  let v = await vistasDelSocio(groupId, users.socio1.email, tokens.socio1, tokens.presi, tokens.admin);
  t.eq('nada confirmado todavia: savings/complete', v.completoAhorro, 0);
  t.eq('nada confirmado todavia: mis-aportes', v.misAhorro, 0);
  t.eq('nada confirmado todavia: savings/stats', v.statsAhorro, 0);
  t.eq('nada confirmado todavia: obtener-ahorros', v.sumaObtenerAhorros, 0);
  t.eq('nada confirmado todavia: tablero del grupo', v.tableroAhorro, 0);
  t.eq('nada confirmado todavia: resumen del admin', v.adminAhorro, 0);

  t.eq('el pendiente es 200 en savings/complete', v.completoPendiente, 200);
  t.eq('el pendiente es 200 en mis-aportes', v.misPendiente, 200);
  t.eq('el pendiente es 200 en savings/stats', v.statsPendiente, 200);
  t.eq('el pendiente es 200 en el tablero', v.tableroPendiente, 200);
  t.eq('el pendiente es 200 para el admin', v.adminPendiente, 200);

  // Lo que el tesorero ve en su bandeja debe ser exactamente lo que el socio declaro
  const bandeja = await get(`/api/gob/aportes-pendientes?groupId=${groupId}`, tokens.teso);
  const enBandeja = (bandeja.body?.ahorros || []).find((a) => a.movId === mov1);
  t.check('el tesorero ve el mismo movimiento que registro el socio', !!enBandeja, JSON.stringify(bandeja.body?.ahorros));
  t.eq('...con el mismo monto exacto', r2(enBandeja?.monto), 137.37);
  t.eq('...y a nombre del mismo socio', enBandeja?.email, users.socio1.email);
  t.eq('el total de la bandeja coincide con el pendiente del socio', r2(bandeja.body?.totalPendiente), 200);

  // ===================================================================
  t.section('CONS 2. Conservacion: confirmar mueve el monto exacto');
  // ===================================================================
  await post('/api/gob/aportes/resolver', { groupId, tipo: 'ahorro', movId: mov1, accion: 'confirmar' }, tokens.teso);
  const v2 = await vistasDelSocio(groupId, users.socio1.email, tokens.socio1, tokens.presi, tokens.admin);

  t.eq('el confirmado subio exactamente 137.37 (complete)', v2.completoAhorro, 137.37);
  t.eq('el pendiente bajo exactamente 137.37 (complete)', v2.completoPendiente, r2(200 - 137.37));
  t.eq('confirmado + pendiente sigue siendo 200',
    r2(v2.completoAhorro + v2.completoPendiente), 200);

  t.eq('mis-aportes coincide con savings/complete', v2.misAhorro, v2.completoAhorro);
  t.eq('savings/stats coincide con savings/complete', v2.statsAhorro, v2.completoAhorro);
  t.eq('obtener-ahorros coincide con savings/complete', v2.sumaObtenerAhorros, v2.completoAhorro);
  t.eq('el tablero del grupo coincide', v2.tableroAhorro, v2.completoAhorro);
  t.eq('el resumen del admin coincide', v2.adminAhorro, v2.completoAhorro);
  t.eq('el pendiente coincide en las 5 vistas',
    [v2.completoPendiente, v2.misPendiente, v2.statsPendiente, v2.tableroPendiente, v2.adminPendiente].join('|'),
    Array(5).fill(r2(200 - 137.37)).join('|'));

  // ===================================================================
  t.section('CONS 3. El total del grupo es la suma de sus socios');
  // ===================================================================
  const aportes = [
    [tokens.socio2, users.socio2.email, 80.25],
    [tokens.presi, users.presi.email, 45.10],
    [tokens.secre, users.secre.email, 33.33],
  ];
  const movs = [];
  for (const [tk, email, monto] of aportes) {
    const r = await post('/api/savings', { groupId, tipo: 'mensual', monto }, tk);
    movs.push([r.body?.movId, email, monto]);
  }
  // Los confirma la presidencia (no puede confirmar el suyo -> lo hace el tesorero)
  for (const [movId, email] of movs) {
    const quien = email === users.presi.email ? tokens.teso : tokens.presi;
    await post('/api/gob/aportes/resolver', { groupId, tipo: 'ahorro', movId, accion: 'confirmar' }, quien);
  }

  let sumaPorSocio = 0;
  for (const email of [users.presi.email, users.teso.email, users.secre.email, users.socio1.email, users.socio2.email]) {
    const c = await get(`/api/savings/complete?email=${email}&groupId=${groupId}`, tokens.admin);
    sumaPorSocio += Number(c.body?.data?.totalAhorros || 0);
  }
  const tablero = await get(`/api/gob/tablero?groupId=${groupId}`, tokens.presi);
  const resumen = await get('/api/admin/resumen', tokens.admin);

  t.eq('suma socio a socio == tablero del grupo', r2(sumaPorSocio), r2(tablero.body?.aportes?.ahorroConfirmado));
  t.eq('suma socio a socio == resumen del admin', r2(sumaPorSocio), r2(resumen.body?.resumen?.totalAhorros));
  t.eq('el numero esperado es 137.37 + 80.25 + 45.10 + 33.33', r2(sumaPorSocio), 296.05);

  // ===================================================================
  t.section('CONS 4. Compra de acciones aprobada por la junta');
  // ===================================================================
  // Via A: el socio registra la compra y la tesoreria la confirma
  const compra = await post('/api/registrar-acciones',
    { groupId, date: '2026-08-10', shares: 15, shareValue: 10, interestRate: 2 }, tokens.socio2);
  const movAcc = compra.body?.movId;
  const bandeja2 = await get(`/api/gob/aportes-pendientes?groupId=${groupId}`, tokens.teso);
  const accPend = (bandeja2.body?.acciones || []).find((a) => a.movId === movAcc);
  t.check('la compra de acciones llega a la bandeja de la junta', !!accPend, JSON.stringify(bandeja2.body?.acciones));
  t.eq('con el valor correcto (15 x 10)', r2(accPend?.monto), 150);

  await post('/api/gob/aportes/resolver', { groupId, tipo: 'accion', movId: movAcc, accion: 'confirmar' }, tokens.presi);
  const vAcc = await vistasDelSocio(groupId, users.socio2.email, tokens.socio2, tokens.presi, tokens.admin);
  t.eq('el capital en acciones aparece en savings/complete', vAcc.completoAcciones, 150);
  t.eq('obtener-acciones da el mismo capital', vAcc.sumaObtenerAcciones, 150);
  t.eq('mis-aportes cuenta 15 unidades', vAcc.misAcciones, 15);
  t.eq('obtener-acciones cuenta 15 unidades', vAcc.unidadesAcciones, 15);

  // Via B: solicitud de acciones aprobada por VOTACION de la junta
  const solAcc = await post('/api/registrar-solicitud', {
    tipo: 'accion', data: { Cantidad: 8, Detalles: 'Compra aprobada en asamblea', Group: groupId },
  }, tokens.socio1);
  t.status('el socio pide comprar 8 acciones', solAcc, 201);
  const filasSol = fake.dumpSheet('SolicitudesAcciones') || [];
  const solId = filasSol[filasSol.length - 1][0];

  await post('/api/registrar-voto', { solicitudId: solId, tipo: 'accion', grupoId: groupId, decision: 'aprobado' }, tokens.presi);
  await post('/api/registrar-voto', { solicitudId: solId, tipo: 'accion', grupoId: groupId, decision: 'aprobado' }, tokens.teso);

  const estadoSol = (fake.dumpSheet('SolicitudesAcciones') || []).find((r) => r[0] === solId)?.[5];
  t.eq('la junta aprueba la solicitud de acciones', estadoSol, 'aprobado');

  // La aprobacion de la junta REGISTRA las acciones (antes no pasaba nada). Como el
  // grupo exige confirmacion de tesoreria, entran pendientes de que llegue el dinero.
  const filaAcc = (fake.dumpSheet('Acciones') || []).find((r) => (r[11] || '') === `solacc_${solId}`);
  t.check('la aprobacion registra la compra en la hoja Acciones', !!filaAcc, JSON.stringify(fake.dumpSheet('Acciones')?.slice(-2)));
  t.eq('...con las 8 acciones pedidas', Number(filaAcc?.[3]), 8);
  t.eq('...al valor de accion del grupo', Number(filaAcc?.[4]), 10);
  t.eq('...y pendiente de que la tesoreria confirme el pago', filaAcc?.[7], 'pendiente');

  const bandejaAcc = await get(`/api/gob/aportes-pendientes?groupId=${groupId}`, tokens.teso);
  const pendAcc = (bandejaAcc.body?.acciones || []).find((a) => a.movId === `solacc_${solId}`);
  t.check('la compra aprobada aparece en la bandeja de tesoreria', !!pendAcc, JSON.stringify(bandejaAcc.body?.acciones));
  t.eq('...por el valor correcto (8 x 10)', r2(pendAcc?.monto), 80);

  const vAntesConf = await vistasDelSocio(groupId, users.socio1.email, tokens.socio1, tokens.presi, tokens.admin);
  t.eq('mientras no entre el dinero no suma capital', vAntesConf.completoAcciones, 0);

  await post('/api/gob/aportes/resolver',
    { groupId, tipo: 'accion', movId: `solacc_${solId}`, accion: 'confirmar' }, tokens.teso);

  const vTrasVoto = await vistasDelSocio(groupId, users.socio1.email, tokens.socio1, tokens.presi, tokens.admin);
  t.eq('confirmado el pago, el socio tiene sus 8 acciones', vTrasVoto.unidadesAcciones, 8);
  t.eq('...y suman capital (8 x 10)', vTrasVoto.completoAcciones, 80);
  t.eq('...y el capital coincide en obtener-acciones', vTrasVoto.sumaObtenerAcciones, vTrasVoto.completoAcciones);

  // Una segunda votacion sobre la misma solicitud no puede duplicar las acciones
  const antesDup = (fake.dumpSheet('Acciones') || []).filter((r) => (r[11] || '') === `solacc_${solId}`).length;
  await post('/api/aprobar-solicitud', { tipo: 'accion', solicitudId: solId, nuevoEstado: 'aprobado' }, tokens.presi);
  const despuesDup = (fake.dumpSheet('Acciones') || []).filter((r) => (r[11] || '') === `solacc_${solId}`).length;
  t.eq('reaprobar la misma solicitud no duplica las acciones', despuesDup, antesDup);

  // ===================================================================
  t.section('CONS 5. Prestamo: el saldo es el mismo para todos');
  // ===================================================================
  // socio1 tiene 137.37 de ahorro + 80 en acciones; cupo 3x del ahorro = 412.11
  const sol = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 300, Detalles: 'Plazo: 6', Group: groupId },
  }, tokens.socio1);
  t.status('el socio pide 300 dentro de su cupo', sol, 201);
  const filasPrest = fake.dumpSheet('SolicitudesPrestamos') || [];
  const loanId = filasPrest[filasPrest.length - 1][0];

  await post('/api/registrar-voto', { solicitudId: loanId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tokens.presi);
  await post('/api/registrar-voto', { solicitudId: loanId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tokens.teso);

  const filaLoan = (fake.dumpSheet('Loans') || []).find((r) => r[0] === loanId);
  t.near('total = 300 x (1 + 0,02 x 6) = 336', filaLoan?.[9], 336);

  const comoSocio = await get(`/api/obtener-prestamos?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  const comoAdmin = await get(`/api/obtener-prestamos?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.admin);
  const saldoSocio = r2((comoSocio.body?.loans || []).find((l) => l.loanId === loanId)?.remainingBalance);
  const saldoAdmin = r2((comoAdmin.body?.loans || []).find((l) => l.loanId === loanId)?.remainingBalance);
  t.eq('el saldo que ve el socio es 336', saldoSocio, 336);
  t.eq('el saldo que ve el admin es el mismo', saldoAdmin, saldoSocio);

  const todos = await get('/api/obtener-todos-prestamos', tokens.admin);
  const enGlobal = (todos.body?.loans || todos.body?.prestamos || []).find((l) => (l.loanId || l.LoanID || l.id) === loanId);
  t.check('el prestamo aparece en la vista global del admin', !!enGlobal, JSON.stringify(todos.body).slice(0, 200));

  // ===================================================================
  t.section('CONS 5b. Un pago sin aprobar no puede figurar como pagado');
  // ===================================================================
  const { BASE } = require('./harness');
  const subirPago = async (monto) => {
    const form = new FormData();
    form.append('loanId', loanId);
    form.append('amount', String(monto));
    form.append('userEmail', users.socio1.email);
    form.append('groupId', groupId);
    form.append('paymentDate', '2026-08-22');
    form.append('paymentImage', new Blob([Buffer.from('x')], { type: 'image/png' }), 'c.png');
    anotar('POST', '/api/upload-payment');
    const res = await fetch(`${BASE}/api/upload-payment`, {
      method: 'POST', headers: { Authorization: `Bearer ${tokens.socio1}` }, body: form,
    });
    return res.status;
  };

  await subirPago(100);   // se aprobara
  const pagosPend = await get(`/api/pending-payments?groupId=${groupId}`, tokens.teso);
  const listaPend = pagosPend.body?.payments || pagosPend.body?.pagos || [];
  const idPrimerPago = listaPend[0]?.paymentId || listaPend[0]?.PaymentID || listaPend[0]?.id;
  await post('/api/approve-payment', { paymentId: idPrimerPago, action: 'approve' }, tokens.presi);

  await subirPago(60);    // queda esperando revision

  const historial = await get(`/api/user-loan-payments?userEmail=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  t.status('el historial de pagos responde', historial, 200);
  const pagosDelSocio = (historial.body?.payments || historial.body?.pagos || historial.body?.data || [])
    .filter((x) => (x.loanId || x.LoanID) === loanId);
  t.eq('el socio ve sus 2 comprobantes', pagosDelSocio.length, 2);
  t.check('cada comprobante trae su estado, para poder distinguirlos',
    pagosDelSocio.every((x) => !!(x.status || x.Status || x.estado)),
    JSON.stringify(pagosDelSocio.slice(0, 2)));

  const esAprobado = (x) => ['approved', 'aprobado'].includes(
    String(x.status || x.Status || x.estado || '').toLowerCase());
  const sumaAprobados = r2(pagosDelSocio.filter(esAprobado).reduce((s, x) => s + Number(x.amount || x.Amount || 0), 0));
  const sumaTodos = r2(pagosDelSocio.reduce((s, x) => s + Number(x.amount || x.Amount || 0), 0));
  t.eq('lo aprobado suma 100', sumaAprobados, 100);
  t.eq('el total de comprobantes suma 160', sumaTodos, 160);

  const prestamoTrasPagos = await get(`/api/obtener-prestamos?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  const elPrestamo = (prestamoTrasPagos.body?.loans || []).find((l) => l.loanId === loanId);
  t.eq('el saldo descuenta SOLO lo aprobado (336 - 100)', r2(elPrestamo?.remainingBalance), 236);
  t.eq('el campo "paid" del prestamo coincide con lo aprobado', r2(elPrestamo?.paid), sumaAprobados);
  t.check('el saldo NO usa la suma de todos los comprobantes',
    r2(elPrestamo?.remainingBalance) !== r2(336 - sumaTodos),
    `saldo ${elPrestamo?.remainingBalance} coincidiria con 336-${sumaTodos}`);

  // ===================================================================
  t.section('CONS 6. Los votos que ve cada uno son los mismos');
  // ===================================================================
  const votosPresi = await get(`/api/votos-solicitud?solicitudId=${loanId}`, tokens.presi);
  const votosSocio = await get(`/api/votos-solicitud?solicitudId=${loanId}`, tokens.socio2);
  t.eq('presidencia y socio ven el mismo numero de votos',
    votosPresi.body?.votos?.length, votosSocio.body?.votos?.length);
  t.eq('son 2 votos', votosPresi.body?.votos?.length, 2);
  t.eq('el detalle es identico',
    JSON.stringify(votosPresi.body?.votos), JSON.stringify(votosSocio.body?.votos));
  t.status('un ajeno no ve los votos de otro grupo',
    await get(`/api/votos-solicitud?solicitudId=${loanId}`, tokens.ajeno), 403);

  // ===================================================================
  t.section('CONS 7. Rechazar devuelve el sistema al estado anterior');
  // ===================================================================
  const antes = await get(`/api/gob/tablero?groupId=${groupId}`, tokens.presi);
  const ahorroAntes = r2(antes.body?.aportes?.ahorroConfirmado);
  const pendienteAntes = r2(antes.body?.aportes?.ahorroPendiente);

  const declRech = await post('/api/savings', { groupId, tipo: 'mensual', monto: 500 }, tokens.socio2);
  const movRech = declRech.body?.movId;
  const durante = await get(`/api/gob/tablero?groupId=${groupId}`, tokens.presi);
  t.eq('mientras esta pendiente el patrimonio NO cambia',
    r2(durante.body?.aportes?.ahorroConfirmado), ahorroAntes);
  t.eq('el pendiente sube exactamente 500',
    r2(durante.body?.aportes?.ahorroPendiente - pendienteAntes), 500);

  await post('/api/gob/aportes/resolver', { groupId, tipo: 'ahorro', movId: movRech, accion: 'rechazar', nota: 'no entro el dinero' }, tokens.presi);
  const despues = await get(`/api/gob/tablero?groupId=${groupId}`, tokens.presi);
  t.eq('tras rechazar, el patrimonio queda igual que antes',
    r2(despues.body?.aportes?.ahorroConfirmado), ahorroAntes);
  t.eq('y el pendiente vuelve al valor previo',
    r2(despues.body?.aportes?.ahorroPendiente), pendienteAntes);

  const misTrasRech = await get(`/api/gob/mis-aportes?groupId=${groupId}`, tokens.socio2);
  t.eq('el socio ve su aporte rechazado con la nota',
    misTrasRech.body?.ahorros?.find((a) => a.movId === movRech)?.nota, 'no entro el dinero');

  // ===================================================================
  t.section('CONS 7b. Corregir una confirmacion equivocada');
  // ===================================================================
  const errado = await post('/api/savings', { groupId, tipo: 'mensual', monto: 70 }, tokens.socio2);
  const movErr = errado.body?.movId;
  await post('/api/gob/aportes/resolver', { groupId, tipo: 'ahorro', movId: movErr, accion: 'confirmar' }, tokens.teso);

  const conError = await get(`/api/gob/tablero?groupId=${groupId}`, tokens.presi);
  t.eq('el aporte equivocado entro al patrimonio',
    r2(conError.body?.aportes?.ahorroConfirmado - ahorroAntes), 70);

  t.status('el tesorero NO puede revertir su propia confirmacion',
    await post('/api/gob/aportes/resolver',
      { groupId, tipo: 'ahorro', movId: movErr, accion: 'revertir', nota: 'me equivoque' }, tokens.teso), 403);
  t.status('la presidencia tampoco puede revertir sin motivo',
    await post('/api/gob/aportes/resolver',
      { groupId, tipo: 'ahorro', movId: movErr, accion: 'revertir' }, tokens.presi), 400);

  const revertido = await post('/api/gob/aportes/resolver',
    { groupId, tipo: 'ahorro', movId: movErr, accion: 'revertir', nota: 'se confirmo por error, el socio no pago' }, tokens.presi);
  t.status('la presidencia revierte indicando el motivo', revertido, 200);
  t.eq('el movimiento vuelve a pendiente', revertido.body?.estado, 'pendiente');

  const trasRevertir = await get(`/api/gob/tablero?groupId=${groupId}`, tokens.presi);
  t.eq('el patrimonio vuelve a como estaba',
    r2(trasRevertir.body?.aportes?.ahorroConfirmado), ahorroAntes);

  const bandejaRev = await get(`/api/gob/aportes-pendientes?groupId=${groupId}`, tokens.teso);
  t.check('y el movimiento reaparece en la bandeja de la junta',
    (bandejaRev.body?.ahorros || []).some((a) => a.movId === movErr),
    JSON.stringify(bandejaRev.body?.ahorros));

  const bitacora = await get(`/api/gob/bitacora?groupId=${groupId}`, tokens.presi);
  t.check('la reversion queda registrada en la bitacora con su motivo',
    (bitacora.body?.eventos || []).some((e) => (e.accion || '').includes('revertido')
      && (e.detalle || '').includes('se confirmo por error')),
    JSON.stringify((bitacora.body?.eventos || []).slice(0, 3)));

  // Se deja limpio: se rechaza definitivamente
  await post('/api/gob/aportes/resolver',
    { groupId, tipo: 'ahorro', movId: movErr, accion: 'rechazar', nota: 'no pago' }, tokens.presi);

  // ===================================================================
  t.section('CONS 8. Aislamiento: dos grupos no se contaminan');
  // ===================================================================
  const { seedGroup, seedLink } = require('./scenario');
  seedGroup({ id: 'G9', nombre: 'Otro banco comunal', presidente: users.ajeno.email });
  seedLink(users.ajeno.email, 'G9', 'presidente');
  seedLink(users.socio1.email, 'G9', 'member');

  const enOtro = await post('/api/savings', { groupId: 'G9', tipo: 'mensual', monto: 999 }, tokens.socio1);
  t.status('el socio aporta en su otro grupo', enOtro, 200);
  await post('/api/gob/aportes/resolver',
    { groupId: 'G9', tipo: 'ahorro', movId: enOtro.body?.movId, accion: 'confirmar' }, tokens.ajeno);

  const enG1 = await get(`/api/savings/complete?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  const enG9 = await get(`/api/savings/complete?email=${users.socio1.email}&groupId=G9`, tokens.socio1);
  t.eq('lo aportado en G9 no aparece en el grupo 1', r2(enG1.body?.data?.totalAhorros), 137.37);
  t.eq('y en G9 aparece completo', r2(enG9.body?.data?.totalAhorros), 999);

  const tabG1 = await get(`/api/gob/tablero?groupId=${groupId}`, tokens.presi);
  t.eq('el tablero del grupo 1 no incluye el dinero del grupo 9',
    r2(tabG1.body?.aportes?.ahorroConfirmado), ahorroAntes);

  const reglasG9 = await get('/api/gob/reglas?groupId=G9', tokens.ajeno);
  t.status('cada grupo tiene su propio reglamento', reglasG9, 200);
  t.status('el presidente de G1 no puede tocar el reglamento de G9',
    await post('/api/gob/reglas', { groupId: 'G9', topePrestamoFactorAhorro: 50 }, tokens.presi), 403);
};
