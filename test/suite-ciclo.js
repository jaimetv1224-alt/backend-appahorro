/**
 * SUITE 3 - Ciclo completo de un grupo autogestionado, usando SOLO los
 * endpoints publicos que usa la app: registro, creacion de grupo, invitaciones,
 * roles, aportes, prestamo por votacion y pago del prestamo.
 */

const { seedWorkbook, get, post, fake, BASE, anotar } = require('./harness');
const { login } = require('./scenario');
const t = require('./runner');

async function registrar(nombre, email, password = 'Clave123') {
  const r = await post('/api/registrar-usuario-en-sheet', {
    Username: nombre, Email: email, password, Balance: 0,
  });
  return r;
}

/** Sube un comprobante de pago (multipart) al endpoint real. */
async function subirPago({ token, loanId, amount, userEmail, groupId }) {
  const form = new FormData();
  form.append('loanId', loanId);
  form.append('amount', String(amount));
  form.append('userEmail', userEmail);
  if (groupId) form.append('groupId', groupId);
  form.append('paymentDate', new Date().toISOString().split('T')[0]);
  form.append('paymentImage', new Blob([Buffer.from('imagen-de-prueba')], { type: 'image/png' }), 'comprobante.png');
  anotar('POST', '/api/upload-payment');
    const res = await fetch(`${BASE}/api/upload-payment`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
  return { status: res.status, body, text };
}

module.exports = async function run() {
  seedWorkbook();

  // ===================================================================
  t.section('CICLO 1. Registro y creacion autogestionada del grupo');
  // ===================================================================
  const P = 'rosa@barrio.test', T = 'luis@barrio.test', S = 'nelly@barrio.test', M = 'jose@barrio.test';
  t.status('se registra la futura presidenta', await registrar('Rosa', P), 201);
  t.status('se registra el futuro tesorero', await registrar('Luis', T), 201);
  t.status('se registra la futura secretaria', await registrar('Nelly', S), 201);
  t.status('se registra un socio', await registrar('Jose', M), 201);
  t.status('no se puede registrar dos veces el mismo correo', await registrar('Rosa bis', P), 409);

  const tk = {
    P: await login(P), T: await login(T), S: await login(S), M: await login(M),
  };

  const nuevoRol = await post('/api/registrar-usuario-en-sheet', {
    Username: 'Colado', Email: 'colado@barrio.test', password: 'Clave123', Role: 'admin', Balance: 0,
  });
  t.status('el registro publico acepta la peticion', nuevoRol, 201);
  const usersRows = fake.dumpSheet('Users') || [];
  const colado = usersRows.find((r) => r[1] === 'colado@barrio.test');
  t.eq('...pero nadie se autoasigna el rol de administrador', colado?.[3], 'member');

  const crea = await post('/api/crear-grupo-en-sheet', {
    GroupName: 'Caja de Ahorro El Progreso',
    Description: 'Grupo del barrio',
    ValorAccion: 10,
    PorcentajeInteresMensual: 2,
    MonthlyContribution: 20,
  }, tk.P);
  t.statusIn('cualquier usuario registrado crea su grupo', crea, [200, 201]);
  const grupos = await get(`/api/grupos-del-usuario?userEmail=${P}`, tk.P);
  const groupId = grupos.body?.grupos?.[0]?.groupId || grupos.body?.grupos?.[0]?.GroupID;
  t.check('la creadora queda vinculada a su grupo', !!groupId, JSON.stringify(grupos.body).slice(0, 300));
  t.eq('...y con el rol de presidenta', (grupos.body?.grupos?.[0]?.groupRole || '').toLowerCase(), 'presidente');

  // ===================================================================
  t.section('CICLO 2. Invitaciones y roles de la junta');
  // ===================================================================
  t.status('no se invita a un correo que no existe',
    await post('/api/invitar-miembro', { groupId, email: 'fantasma@barrio.test', role: 'member' }, tk.P), 404);

  t.status('la presidenta invita al tesorero',
    await post('/api/invitar-miembro', { groupId, email: T, role: 'tesorero' }, tk.P), 201);
  t.status('no se duplica una invitacion pendiente',
    await post('/api/invitar-miembro', { groupId, email: T, role: 'tesorero' }, tk.P), 409);
  t.status('la presidenta invita a la secretaria',
    await post('/api/invitar-miembro', { groupId, email: S, role: 'secretario' }, tk.P), 201);
  t.status('la presidenta invita al socio',
    await post('/api/invitar-miembro', { groupId, email: M, role: 'member' }, tk.P), 201);
  t.status('un invitado no puede invitar a otros',
    await post('/api/invitar-miembro', { groupId, email: 'colado@barrio.test', role: 'member' }, tk.M), 403);

  const invT = await get('/api/mis-invitaciones', tk.T);
  t.status('el invitado ve su invitacion', invT, 200);
  t.eq('tiene 1 invitacion pendiente', invT.body?.invitaciones?.length, 1);
  const invId = invT.body?.invitaciones?.[0]?.invitationId || invT.body?.invitaciones?.[0]?.InvitationID;

  t.status('el tesorero acepta',
    await post('/api/responder-invitacion', { invitationId: invId, accion: 'aceptar' }, tk.T), 200);
  t.status('la misma invitacion no se responde dos veces',
    await post('/api/responder-invitacion', { invitationId: invId, accion: 'aceptar' }, tk.T), 409);

  for (const [quien, token] of [['secretaria', tk.S], ['socio', tk.M]]) {
    const inv = await get('/api/mis-invitaciones', token);
    const id = inv.body?.invitaciones?.[0]?.invitationId || inv.body?.invitaciones?.[0]?.InvitationID;
    t.status(`la ${quien} acepta la invitacion`,
      await post('/api/responder-invitacion', { invitationId: id, accion: 'aceptar' }, token), 200);
  }

  const miembros = await get(`/api/obtener-miembros?groupId=${groupId}`, tk.P);
  t.eq('el grupo tiene 4 miembros', (miembros.body?.miembros || miembros.body?.members || []).length, 4);

  t.statusIn('no se puede degradar a la unica presidenta',
    await post('/api/cambiar-rol-usuario-grupo', { GroupID: groupId, UserEmail: P, NewGroupRole: 'member' }, tk.P), [400, 409]);
  t.statusIn('no se puede desvincular a la unica presidenta',
    await post('/api/desvincular-usuario-grupo', { GroupID: groupId, UserEmail: P }, tk.P), [400, 409]);
  t.statusIn('la unica presidenta no puede salirse del grupo',
    await post('/api/salir-grupo', { groupId }, tk.P), [400, 409]);
  t.status('el socio raso no cambia roles',
    await post('/api/cambiar-rol-usuario-grupo', { GroupID: groupId, UserEmail: M, NewGroupRole: 'tesorero' }, tk.M), 403);
  t.status('no puede haber dos tesoreros',
    await post('/api/cambiar-rol-usuario-grupo', { GroupID: groupId, UserEmail: M, NewGroupRole: 'tesorero' }, tk.P), 409);

  // ===================================================================
  t.section('CICLO 3. Aportes de la reunion mensual');
  // ===================================================================
  const aportes = {};
  for (const [quien, token, email, monto] of [
    ['presidenta', tk.P, P, 100], ['tesorero', tk.T, T, 80],
    ['secretaria', tk.S, S, 60], ['socio', tk.M, M, 40],
  ]) {
    const r = await post('/api/savings', { groupId, tipo: 'mensual', monto }, token);
    aportes[email] = r.body?.movId;
    t.eq(`el aporte de la ${quien} nace pendiente`, r.body?.estado, 'pendiente');
  }

  const bandeja = await get(`/api/gob/aportes-pendientes?groupId=${groupId}`, tk.T);
  t.eq('la bandeja del tesorero muestra los 4 aportes', bandeja.body?.ahorros?.length, 4);
  t.near('el total pendiente es 280', bandeja.body?.totalPendiente, 280);

  t.status('el tesorero no confirma su propio aporte',
    await post('/api/gob/aportes/resolver', { groupId, tipo: 'ahorro', movId: aportes[T], accion: 'confirmar' }, tk.T), 403);
  t.status('pero la presidenta si se lo confirma',
    await post('/api/gob/aportes/resolver', { groupId, tipo: 'ahorro', movId: aportes[T], accion: 'confirmar' }, tk.P), 200);

  for (const email of [P, S, M]) {
    await post('/api/gob/aportes/resolver', { groupId, tipo: 'ahorro', movId: aportes[email], accion: 'confirmar' }, tk.T);
  }

  const tablero = await get(`/api/gob/tablero?groupId=${groupId}`, tk.P);
  t.near('el patrimonio confirmado del grupo es 280', tablero.body?.aportes?.ahorroConfirmado, 280);
  t.eq('no queda nada pendiente', tablero.body?.aportes?.pendientesAhorro, 0);

  // ===================================================================
  t.section('CICLO 4. Prestamo aprobado por la junta');
  // ===================================================================
  // El socio tiene 40 confirmados; tope por defecto 3x = 120
  t.status('el socio no puede pedir mas de su cupo',
    await post('/api/registrar-solicitud', { tipo: 'prestamo', data: { Monto: 500, Detalles: 'Plazo: 6', Group: groupId } }, tk.M), 409);

  t.status('el socio pide un prestamo dentro de su cupo',
    await post('/api/registrar-solicitud', { tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 5', Group: groupId } }, tk.M), 201);

  const solRows = fake.dumpSheet('SolicitudesPrestamos') || [];
  const solId = solRows[solRows.length - 1][0];

  const pendientes = await get(`/api/pending-loan-requests?groupId=${groupId}`, tk.P);
  t.status('los lideres ven la solicitud pendiente', pendientes, 200);

  t.status('el propio solicitante no puede votarse el prestamo',
    await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tk.M), 403);

  await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tk.P);
  const v2 = await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tk.T);
  t.status('el segundo voto alcanza el quorum', v2, 201);

  const loan = (fake.dumpSheet('Loans') || []).slice(1).find((r) => r[0] === solId);
  t.check('el prestamo quedo creado', !!loan, JSON.stringify(loan));
  // 100 a 5 meses al 2% mensual = 100 * (1 + 0.02*5) = 110
  t.near('el total a pagar incluye el interes pactado', loan?.[9], 110);

  const misPrestamos = await get(`/api/obtener-prestamos?groupId=${groupId}&userEmail=${M}`, tk.M);
  t.status('el socio ve su prestamo', misPrestamos, 200);

  // ===================================================================
  t.section('CICLO 5. Pago del prestamo');
  // ===================================================================
  const pago = await subirPago({ token: tk.M, loanId: solId, amount: 40, userEmail: M, groupId });
  t.statusIn('el socio sube su comprobante de pago', pago, [200, 201]);

  const sobrepago = await subirPago({ token: tk.M, loanId: solId, amount: 99999, userEmail: M, groupId });
  t.statusIn('no se admite un pago mayor al saldo', sobrepago, [400, 409]);

  const pendientesPago = await get(`/api/pending-payments?groupId=${groupId}`, tk.T);
  t.status('el tesorero ve los pagos por revisar', pendientesPago, 200);
  const lista = pendientesPago.body?.payments || pendientesPago.body?.pagos || [];
  const paymentId = lista[0]?.paymentId || lista[0]?.PaymentID || lista[0]?.id;
  t.check('hay un pago pendiente de revision', !!paymentId, JSON.stringify(lista).slice(0, 300));

  if (paymentId) {
    t.status('el tesorero aprueba el pago',
      await post('/api/approve-payment', { paymentId, action: 'approve' }, tk.T), 200);
    const trasPago = await get(`/api/obtener-prestamos?groupId=${groupId}&userEmail=${M}`, tk.M);
    const prest = (trasPago.body?.loans || trasPago.body?.prestamos || [])[0];
    t.near('el saldo del prestamo baja a 70', prest?.remainingBalance ?? prest?.saldo, 70);
  }

  // ===================================================================
  t.section('CICLO 6. Salidas y transferencia de la presidencia');
  // ===================================================================
  t.status('el socio puede salirse del grupo por su cuenta',
    await post('/api/salir-grupo', { groupId }, tk.M), 200);
  const miembros2 = await get(`/api/obtener-miembros?groupId=${groupId}`, tk.P);
  t.eq('el grupo queda con 3 miembros', (miembros2.body?.miembros || miembros2.body?.members || []).length, 3);

  t.status('la presidenta transfiere la presidencia al tesorero',
    await post('/api/cambiar-rol-usuario-grupo', { GroupID: groupId, UserEmail: T, NewGroupRole: 'presidente' }, tk.P), 200);
  const gruposP = await get(`/api/grupos-del-usuario?userEmail=${P}`, tk.P);
  t.eq('la presidenta anterior queda como socia',
    (gruposP.body?.grupos?.[0]?.groupRole || '').toLowerCase(), 'member');
  const gruposT = await get(`/api/grupos-del-usuario?userEmail=${T}`, tk.T);
  t.eq('el tesorero es ahora presidente',
    (gruposT.body?.grupos?.[0]?.groupRole || '').toLowerCase(), 'presidente');

  t.status('ya sin la presidencia, no puede cambiar el reglamento',
    await post('/api/gob/reglas', { groupId, topePrestamoFactorAhorro: 5 }, tk.P), 403);
  t.status('el nuevo presidente si puede',
    await post('/api/gob/reglas', { groupId, topePrestamoFactorAhorro: 2 }, tk.T), 200);
};
