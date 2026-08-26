/**
 * SUITE 8 - PERSISTENCIA: que lo que se escribe caiga en la columna correcta y
 * vuelva a leerse igual.
 *
 * El riesgo real con Google Sheets es el desalineamiento: el codigo escribe la
 * fecha en la columna C y otro lector la espera en la D. No revienta nada, no
 * salta ningun error: simplemente el dato aparece en el sitio equivocado o
 * desaparece. Aqui, para CADA hoja, se escribe por la API, se inspecciona la
 * celda exacta y se vuelve a leer por la API.
 */

const { seedWorkbook, get, post, put, del, fake, BASE, anotar } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const filasDe = (hoja) => (fake.dumpSheet(hoja) || []).slice(1);
const ultima = (hoja) => {
  const f = filasDe(hoja);
  return f[f.length - 1];
};

/** Comprueba una fila celda por celda contra lo esperado. */
function celdas(titulo, fila, esperado) {
  if (!fila) {
    t.check(titulo, false, 'la fila no existe');
    return;
  }
  const fallos = [];
  for (const [indice, [nombre, valor]] of Object.entries(esperado).entries()) {
    void indice;
    const i = Number(nombre);
    const real = fila[i];
    const coincide = typeof valor === 'function'
      ? valor(real)
      : String(real).trim().toLowerCase() === String(valor).trim().toLowerCase();
    if (!coincide) fallos.push(`col ${String.fromCharCode(65 + i)} (idx ${i}): esperado ${valor}, hay "${real}"`);
  }
  t.check(titulo, fallos.length === 0, fallos.join(' | '));
}

module.exports = async function run() {
  seedWorkbook();
  const { users, tokens, groupId } = await baseScenario();

  // ===================================================================
  t.section('PERS 1. Users: registro -> login -> perfil');
  // ===================================================================
  t.status('se registra un usuario nuevo', await post('/api/registrar-usuario-en-sheet', {
    Username: 'Marta Perez', Email: 'MARTA@Test.COM', password: 'Clave123',
    Balance: 0, Telefono: '0999999999', Cedula: '0912345678',
  }), 201);

  const filaUser = ultima('Users');
  celdas('Users: A=nombre B=email(minusculas) D=rol E=balance I=estado', filaUser, {
    0: 'Marta Perez',
    1: 'marta@test.com',
    2: (v) => /^\$2[aby]\$/.test(String(v)),   // C = hash bcrypt, nunca la clave en claro
    3: 'member',
    4: (v) => Number(v) === 0,
    8: 'activo',
  });
  t.check('la contrasena NUNCA se guarda en claro',
    !JSON.stringify(fake.dumpSheet('Users')).includes('Clave123'),
    'aparece la clave en texto plano en la hoja');

  const { login } = require('./scenario');
  const tkMarta = await login('marta@test.com', 'Clave123');
  const perfil = await get('/api/mi-perfil', tkMarta);
  t.status('el usuario recien creado puede entrar y leer su perfil', perfil, 200);
  t.eq('el correo del perfil coincide con el de la hoja',
    (perfil.body?.perfil?.email || perfil.body?.perfil?.Email || '').toLowerCase(), 'marta@test.com');

  t.status('actualiza su telefono', await post('/api/actualizar-perfil',
    { telefono: '0988888888', cedula: '0912345678' }, tkMarta), 200);
  const filaUser2 = (fake.dumpSheet('Users') || []).find((r) => r[1] === 'marta@test.com');
  t.eq('el telefono se guarda en la columna G', filaUser2?.[6], '0988888888');
  t.eq('y la cedula en la H', filaUser2?.[7], '0912345678');

  // ===================================================================
  t.section('PERS 2. Groups y UserGroupLinks');
  // ===================================================================
  const creado = await post('/api/crear-grupo-en-sheet', {
    GroupName: 'Caja Persistencia', Description: 'prueba',
    ValorAccion: 25, PorcentajeInteresMensual: 1.5, MonthlyContribution: 30,
  }, tkMarta);
  t.statusIn('se crea un grupo', creado, [200, 201]);

  const filaGrupo = ultima('Groups');
  celdas('Groups: B=nombre D=presidente E=creador P=valorAccion Q=interes', filaGrupo, {
    1: 'Caja Persistencia',
    3: 'marta@test.com',
    4: 'marta@test.com',
    15: (v) => Number(v) === 25,
    16: (v) => Number(v) === 1.5,
  });

  const nuevoGrupoId = filaGrupo[0];
  const filaLink = ultima('UserGroupLinks');
  celdas('UserGroupLinks: A=email B=grupo D=rol E=estado', filaLink, {
    0: 'marta@test.com',
    1: nuevoGrupoId,
    3: 'presidente',
    4: 'activo',
  });

  const susGrupos = await get(`/api/grupos-del-usuario?userEmail=marta@test.com`, tkMarta);
  const g = (susGrupos.body?.grupos || [])[0];
  t.eq('grupos-del-usuario devuelve el mismo id', g?.groupId, nuevoGrupoId);
  t.eq('...el mismo nombre', g?.groupName, 'Caja Persistencia');
  t.eq('...el valor de accion configurado', Number(g?.ValorAccion), 25);
  t.eq('...el interes configurado', Number(g?.PorcentajeInteresMensual), 1.5);
  t.eq('...y el rol correcto', (g?.groupRole || '').toLowerCase(), 'presidente');

  const info = await get(`/api/group-info/${nuevoGrupoId}`, tkMarta);
  t.status('group-info responde', info, 200);
  t.check('group-info devuelve el mismo grupo',
    JSON.stringify(info.body).includes('Caja Persistencia'), JSON.stringify(info.body).slice(0, 200));

  // ===================================================================
  t.section('PERS 3. Savings: escribir, inspeccionar la celda y releer');
  // ===================================================================
  const ahorro = await post('/api/savings',
    { groupId, tipo: 'extra', monto: 123.45, descripcion: 'aporte de prueba' }, tokens.socio1);
  t.status('se registra el ahorro', ahorro, 200);

  const filaSav = ultima('Savings');
  celdas('Savings: A=email B=grupo C=monto D=fecha E=tipo F=desc G=estado H=quien K=movId', filaSav, {
    0: users.socio1.email,
    1: groupId,
    2: (v) => r2(v) === 123.45,
    3: (v) => /^\d{4}-\d{2}-\d{2}/.test(String(v)),
    4: 'extra',
    5: 'aporte de prueba',
    6: 'pendiente',
    7: users.socio1.email,
    10: (v) => String(v) === ahorro.body.movId,
  });

  await post('/api/gob/aportes/resolver',
    { groupId, tipo: 'ahorro', movId: ahorro.body.movId, accion: 'confirmar', nota: 'recibido' }, tokens.teso);
  const filaSav2 = (fake.dumpSheet('Savings') || []).find((r) => r[10] === ahorro.body.movId);
  celdas('Savings tras confirmar: G=confirmado I=quien resolvio J=fecha L=nota', filaSav2, {
    6: 'confirmado',
    8: users.teso.email,
    9: (v) => String(v).length > 10,
    11: 'recibido',
  });

  const leido = await get(`/api/obtener-ahorros?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  t.eq('obtener-ahorros devuelve el monto intacto', r2(leido.body?.savings?.[0]?.amount), 123.45);
  const completo = await get(`/api/savings/complete?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  t.eq('savings/complete devuelve el mismo monto', r2(completo.body?.data?.totalAhorros), 123.45);
  t.eq('...con su descripcion', completo.body?.data?.historialAhorros?.[0]?.descripcion, 'aporte de prueba');
  t.eq('...y su tipo', completo.body?.data?.historialAhorros?.[0]?.tipo, 'extra');

  // ===================================================================
  t.section('PERS 4. Acciones');
  // ===================================================================
  const acc = await post('/api/registrar-acciones',
    { groupId, date: '2026-04-17', shares: 7, shareValue: 10, interestRate: 2 }, tokens.socio1);
  t.status('se registra la compra de acciones', acc, 201);

  const filaAcc = ultima('Acciones');
  celdas('Acciones: A=email B=grupo C=fecha D=cantidad E=valor F=tasa H=estado L=movId', filaAcc, {
    0: users.socio1.email,
    1: groupId,
    2: '2026-04-17',
    3: (v) => Number(v) === 7,
    4: (v) => Number(v) === 10,
    5: (v) => Number(v) === 2,
    7: 'pendiente',
    11: (v) => String(v) === acc.body.movId,
  });

  await post('/api/gob/aportes/resolver',
    { groupId, tipo: 'accion', movId: acc.body.movId, accion: 'confirmar' }, tokens.presi);
  const leidoAcc = await get(`/api/obtener-acciones?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  const sh = leidoAcc.body?.shares?.[0];
  t.eq('obtener-acciones devuelve la fecha', sh?.date, '2026-04-17');
  t.eq('...la cantidad', Number(sh?.shares), 7);
  t.eq('...el valor', Number(sh?.shareValue), 10);
  t.eq('...y la tasa', Number(sh?.interestRate), 2);

  // ===================================================================
  t.section('PERS 5. Solicitudes y Loans');
  // ===================================================================
  const sol = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 200, Detalles: 'Plazo: 5', Group: groupId },
  }, tokens.socio1);
  t.status('se registra la solicitud', sol, 201);

  const filaSol = ultima('SolicitudesPrestamos');
  celdas('SolicitudesPrestamos: B=email C=grupo E=monto F=estado H=detalles', filaSol, {
    1: users.socio1.email,
    2: groupId,
    4: (v) => r2(v) === 200,
    5: 'pendiente',
    7: 'Plazo: 5',
  });
  const solId = filaSol[0];

  const enGrupo = await get(`/api/solicitudes-grupo?groupId=${groupId}`, tokens.presi);
  t.status('solicitudes-grupo responde', enGrupo, 200);
  t.check('la solicitud aparece para la junta',
    JSON.stringify(enGrupo.body).includes(solId), JSON.stringify(enGrupo.body).slice(0, 250));

  await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tokens.presi);
  const filaVoto = ultima('AprobacionesAsamblea');
  celdas('AprobacionesAsamblea: A=solicitud B=tipo C=grupo D=quien E=rol F=decision', filaVoto, {
    0: solId,
    1: 'prestamo',
    2: groupId,
    3: users.presi.email,
    4: 'presidente',
    5: 'aprobado',
  });

  await post('/api/registrar-voto', { solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado' }, tokens.teso);
  const filaLoan = (fake.dumpSheet('Loans') || []).find((r) => r[0] === solId);
  celdas('Loans: A=id B=email C=grupo D=principal G=tasa H=estado I=plazo J=total', filaLoan, {
    0: solId,
    1: users.socio1.email,
    2: groupId,
    3: (v) => r2(v) === 200,
    6: (v) => Number(v) === 2,
    7: 'aprobado',
    8: (v) => Number(v) === 5,
    9: (v) => r2(v) === 220,   // 200 * (1 + 0,02*5)
  });

  const misPrest = await get(`/api/obtener-prestamos?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  const pr = (misPrest.body?.loans || []).find((l) => l.loanId === solId);
  t.eq('obtener-prestamos devuelve el principal', r2(pr?.amount), 200);
  t.eq('...el total con interes', r2(pr?.totalAPagar), 220);
  t.eq('...el plazo', Number(pr?.term), 5);
  t.eq('...y el saldo', r2(pr?.remainingBalance), 220);

  const todos = await get('/api/obtener-todos-prestamos', tokens.admin);
  t.check('la vista global del admin trae el mismo prestamo',
    (todos.body?.loans || []).some((l) => (l.LoanID || l.loanId) === solId),
    JSON.stringify(todos.body).slice(0, 250));

  // ===================================================================
  t.section('PERS 6. LoanPayments y Transactions');
  // ===================================================================
  const form = new FormData();
  form.append('loanId', solId);
  form.append('amount', '50.25');
  form.append('userEmail', users.socio1.email);
  form.append('groupId', groupId);
  form.append('paymentDate', '2026-08-21');
  form.append('paymentImage', new Blob([Buffer.from('img')], { type: 'image/png' }), 'comp.png');
  const resPago = await fetch(`${BASE}/api/upload-payment`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokens.socio1}` }, body: form,
  });
  t.check('se sube el comprobante', resPago.ok, `HTTP ${resPago.status}`);

  const filaPago = ultima('LoanPayments');
  celdas('LoanPayments: B=email C=prestamo D=monto E=fecha G=estado', filaPago, {
    1: users.socio1.email,
    2: solId,
    3: (v) => r2(v) === 50.25,
    4: (v) => String(v).includes('2026-08-21'),
    6: (v) => String(v).toLowerCase().includes('pend'),
  });

  const pendientesPago = await get(`/api/pending-payments?groupId=${groupId}`, tokens.teso);
  const lista = pendientesPago.body?.payments || pendientesPago.body?.pagos || [];
  t.eq('pending-payments devuelve el monto intacto', r2(lista[0]?.amount ?? lista[0]?.Amount), 50.25);
  const paymentId = lista[0]?.paymentId || lista[0]?.PaymentID || lista[0]?.id;

  t.status('la tesoreria aprueba el pago',
    await post('/api/approve-payment', { paymentId, action: 'approve' }, tokens.teso), 200);
  const trasPago = await get(`/api/obtener-prestamos?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  t.eq('el saldo baja exactamente 50.25 (220 - 50.25)',
    r2((trasPago.body?.loans || []).find((l) => l.loanId === solId)?.remainingBalance), 169.75);

  const historialPagos = await get(`/api/user-loan-payments?userEmail=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  t.status('el historial de pagos del socio responde', historialPagos, 200);
  t.check('y contiene su pago',
    JSON.stringify(historialPagos.body).includes('50.25') || JSON.stringify(historialPagos.body).includes('50,25'),
    JSON.stringify(historialPagos.body).slice(0, 250));

  const trans = await get('/api/admin/transacciones', tokens.admin);
  t.status('las transacciones del admin responden', trans, 200);
  t.check('el desembolso del prestamo quedo registrado',
    (trans.body?.transacciones || []).some((x) => r2(x.amount) === 200 && x.type === 'loan'),
    JSON.stringify((trans.body?.transacciones || []).slice(0, 3)));

  // ===================================================================
  t.section('PERS 7. MetasAhorro (crear, leer, actualizar, borrar)');
  // ===================================================================
  const meta = await post('/api/savings/goals', {
    groupId, nombre: 'Techo nuevo', montoObjetivo: 500, fechaObjetivo: '2027-01-31',
    descripcion: 'para la casa', prioridad: 'alta', categoria: 'hogar',
  }, tokens.socio1);
  t.statusIn('se crea la meta', meta, [200, 201]);

  const filaMeta = ultima('MetasAhorro');
  celdas('MetasAhorro: A=id B=email C=grupo D=nombre E=objetivo F=actual G=fecha H=desc I=prioridad J=categoria K=estado', filaMeta, {
    0: (v) => String(v).startsWith('GOAL_'),
    1: users.socio1.email,
    2: groupId,
    3: 'Techo nuevo',
    4: (v) => r2(v) === 500,
    5: (v) => r2(v) === 0,
    6: '2027-01-31',
    7: 'para la casa',
    8: 'alta',
    9: 'hogar',
    10: 'Activa',
  });

  const metas = await get(`/api/savings/goals?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  const laMeta = (metas.body?.goals || metas.body?.metas || [])[0];
  t.check('la meta se lee de vuelta', !!laMeta, JSON.stringify(metas.body).slice(0, 250));
  t.eq('con su nombre', laMeta?.nombre, 'Techo nuevo');
  t.eq('y su monto objetivo', r2(laMeta?.montoObjetivo), 500);
  t.eq('...su descripcion en el campo correcto', laMeta?.descripcion, 'para la casa');
  t.eq('...su prioridad', laMeta?.prioridad, 'alta');
  t.eq('...su categoria', laMeta?.categoria, 'hogar');
  t.eq('...y su estado real (no la descripcion)', laMeta?.estado, 'Activa');

  // Sin id, la pantalla no puede editar ni borrar: esto NO puede fallar en silencio.
  const goalId = laMeta?.goalId || laMeta?.id || laMeta?.ID;
  t.check('la lista devuelve el identificador de la meta', !!goalId && goalId === filaMeta[0],
    `goalId recibido: ${goalId} | en la hoja: ${filaMeta && filaMeta[0]}`);

  t.statusIn('se actualiza el progreso de la meta',
    await put(`/api/savings/goals/${goalId}`, { nuevoMonto: 220 }, tokens.socio1), [200]);
  const metas2 = await get(`/api/savings/goals?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  t.eq('el progreso persiste', r2((metas2.body?.goals || [])[0]?.montoActual), 220);
  t.eq('y el objetivo no cambio', r2((metas2.body?.goals || [])[0]?.montoObjetivo), 500);

  t.status('un socio ajeno NO puede actualizar la meta',
    await put(`/api/savings/goals/${goalId}`, { nuevoMonto: 999 }, tokens.socio2), 403);
  t.status('un socio ajeno NO puede borrar la meta',
    await del(`/api/savings/goals/${goalId}`, tokens.socio2), 403);
  t.statusIn('el dueno si la borra', await del(`/api/savings/goals/${goalId}`, tokens.socio1), [200]);
  const metas3 = await get(`/api/savings/goals?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  t.eq('la meta desaparece de la lista', (metas3.body?.goals || metas3.body?.metas || []).length, 0);

  // ===================================================================
  t.section('PERS 8. Actas de asamblea');
  // ===================================================================
  t.status('la secretaria registra un acta', await post('/api/registrar-acta', {
    grupoId: groupId, titulo: 'Acta de prueba', contenido: 'Se trato el punto unico.',
    asistentes: 'presi, teso, secre',
  }, tokens.secre), 201);

  const filaActa = ultima('ActasAsamblea');
  celdas('ActasAsamblea: B=grupo D=creadaPor E=titulo F=contenido G=asistentes', filaActa, {
    1: groupId,
    3: users.secre.email,
    4: 'Acta de prueba',
    5: 'Se trato el punto unico.',
    6: 'presi, teso, secre',
  });

  const actas = await get(`/api/actas-asamblea?groupId=${groupId}`, tokens.socio1);
  t.eq('el acta se lee de vuelta', actas.body?.actas?.[0]?.titulo, 'Acta de prueba');
  t.eq('con su contenido', actas.body?.actas?.[0]?.contenido, 'Se trato el punto unico.');

  // ===================================================================
  t.section('PERS 9. Hojas del control interno');
  // ===================================================================
  t.status('se guarda el reglamento',
    await post('/api/gob/reglas', { groupId, topePrestamoFactorAhorro: 2.5, quorumAsambleaPct: 60 }, tokens.presi), 200);
  const filaReglas = ultima('GrupoReglas');
  celdas('GrupoReglas: A=grupo B=aportes C=prestamos E=tope I=quorum J=quien', filaReglas, {
    0: groupId,
    1: 'si',
    2: 'si',
    4: (v) => Number(v) === 2.5,
    8: (v) => Number(v) === 60,
    9: users.presi.email,
  });
  const reglasLeidas = await get(`/api/gob/reglas?groupId=${groupId}`, tokens.socio1);
  t.eq('el tope se relee igual', reglasLeidas.body?.reglas?.topePrestamoFactorAhorro, 2.5);
  t.eq('y el quorum tambien', reglasLeidas.body?.reglas?.quorumAsambleaPct, 60);

  const asm = await post('/api/gob/asambleas', {
    groupId, titulo: 'Asamblea persistente', fechaProgramada: '2026-10-15',
    modalidad: 'mixta', agenda: 'Punto uno',
  }, tokens.presi);
  const asambleaId = asm.body?.asambleaId;
  const filaAsm = ultima('Asambleas');
  celdas('Asambleas: A=id B=grupo C=titulo D=fecha E=modalidad F=estado G=agenda H=quien', filaAsm, {
    0: asambleaId,
    1: groupId,
    2: 'Asamblea persistente',
    3: '2026-10-15',
    4: 'mixta',
    5: 'programada',
    6: 'Punto uno',
    7: users.presi.email,
  });

  await post(`/api/gob/asambleas/${asambleaId}/asistencia`, {
    registros: [
      { email: users.presi.email, estado: 'presente' },
      { email: users.teso.email, estado: 'presente' },
      { email: users.secre.email, estado: 'justificado' },
    ],
  }, tokens.secre);
  const asistencias = filasDe('AsambleaAsistencia').filter((r) => r[0] === asambleaId);
  t.eq('se guardan las 3 asistencias', asistencias.length, 3);
  celdas('AsambleaAsistencia: A=asamblea B=grupo C=email D=estado E=quien', asistencias[0], {
    0: asambleaId,
    1: groupId,
    2: users.presi.email,
    3: 'presente',
    4: users.secre.email,
  });

  await post(`/api/gob/asambleas/${asambleaId}/estado`, { estado: 'abierta' }, tokens.presi);
  const acu = await post(`/api/gob/asambleas/${asambleaId}/acuerdos`, {
    tipo: 'gasto', titulo: 'Compra de sillas', descripcion: 'para la sede',
  }, tokens.secre);
  const acuerdoId = acu.body?.acuerdoId;
  const filaAcu = ultima('Acuerdos');
  celdas('Acuerdos: A=id B=asamblea C=grupo D=tipo E=titulo F=desc H=estado I=quien', filaAcu, {
    0: acuerdoId,
    1: asambleaId,
    2: groupId,
    3: 'gasto',
    4: 'Compra de sillas',
    5: 'para la sede',
    7: 'abierto',
    8: users.secre.email,
  });

  await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' }, tokens.presi);
  const filaVotoAcu = ultima('AcuerdoVotos');
  celdas('AcuerdoVotos: A=acuerdo B=asamblea C=grupo D=email E=voto G=rol', filaVotoAcu, {
    0: acuerdoId,
    1: asambleaId,
    2: groupId,
    3: users.presi.email,
    4: 'favor',
    6: 'presidente',
  });

  const detalle = await get(`/api/gob/asambleas/${asambleaId}`, tokens.socio1);
  t.eq('el detalle relee el titulo de la asamblea', detalle.body?.asamblea?.titulo, 'Asamblea persistente');
  t.eq('...la modalidad', detalle.body?.asamblea?.modalidad, 'mixta');
  t.eq('...el acuerdo con su tipo', detalle.body?.acuerdos?.[0]?.tipo, 'gasto');
  t.eq('...y el voto emitido', detalle.body?.acuerdos?.[0]?.votos?.[0]?.voto, 'favor');
  t.eq('el quorum se calcula sobre 5 miembros al 60% = 3', detalle.body?.quorum?.requerido, 3);

  // Lote de apertura
  const lote = await post('/api/gob/apertura/lote', {
    groupId, nota: 'del cuaderno',
    filas: [{ email: users.socio2.email, ahorro: 55.5, acciones: 3, valorAccion: 10, deuda: 20, plazoDeuda: 2, nota: 'libreta 9' }],
  }, tokens.teso);
  const loteId = lote.body?.loteId;
  const filaLote = ultima('LotesApertura');
  celdas('LotesApertura: A=id B=grupo C=estado D=quien I=totalAhorro J=totalAcciones K=totalDeuda L=miembros', filaLote, {
    0: loteId,
    1: groupId,
    2: 'borrador',
    3: users.teso.email,
    8: (v) => r2(v) === 55.5,
    9: (v) => Number(v) === 3,
    10: (v) => r2(v) === 20,
    11: (v) => Number(v) === 1,
  });
  const filaDetalle = ultima('AperturaDetalle');
  celdas('AperturaDetalle: A=lote B=grupo C=email D=ahorro E=acciones F=valor G=deuda H=plazo I=nota', filaDetalle, {
    0: loteId,
    1: groupId,
    2: users.socio2.email,
    3: (v) => r2(v) === 55.5,
    4: (v) => Number(v) === 3,
    5: (v) => Number(v) === 10,
    6: (v) => r2(v) === 20,
    7: (v) => Number(v) === 2,
    8: 'libreta 9',
  });

  const loteLeido = await get(`/api/gob/apertura/lote/${loteId}`, tokens.teso);
  t.eq('el lote se relee con su total de ahorro', r2(loteLeido.body?.lote?.totalAhorro), 55.5);
  t.eq('...y su fila con la nota', loteLeido.body?.filas?.[0]?.nota, 'libreta 9');

  // Bitacora
  const bitacora = await get(`/api/gob/bitacora?groupId=${groupId}`, tokens.presi);
  const filaLog = ultima('GobernanzaLog');
  celdas('GobernanzaLog: B=grupo C=actor D=accion', filaLog, {
    1: groupId,
    2: (v) => String(v).includes('@'),
    3: (v) => String(v).length > 3,
  });
  t.check('la bitacora se lee de vuelta ordenada', (bitacora.body?.eventos || []).length > 0,
    JSON.stringify(bitacora.body).slice(0, 200));

  // ===================================================================
  t.section('PERS 10. Ninguna hoja quedo con filas huerfanas o desalineadas');
  // ===================================================================
  const hojasEsperadas = [
    'Users', 'Groups', 'UserGroupLinks', 'Savings', 'Acciones', 'Loans', 'LoanPayments',
    'Transactions', 'SolicitudesPrestamos', 'AprobacionesAsamblea', 'ActasAsamblea',
    'GrupoReglas', 'Asambleas', 'AsambleaAsistencia', 'Acuerdos', 'AcuerdoVotos',
    'LotesApertura', 'AperturaDetalle', 'GobernanzaLog',
  ];
  for (const hoja of hojasEsperadas) {
    const contenido = fake.dumpSheet(hoja);
    t.check(`la hoja ${hoja} existe y tiene cabecera`,
      Array.isArray(contenido) && contenido.length >= 1 && (contenido[0] || []).length > 0,
      `contenido: ${contenido ? contenido.length + ' filas' : 'no existe'}`);
  }

  // Ninguna fila de dinero puede quedar sin dueno o sin grupo
  const savHuerfanas = filasDe('Savings').filter((r) => !r[0] || !r[1]);
  t.eq('no hay ahorros sin email o sin grupo', savHuerfanas.length, 0);
  const accHuerfanas = filasDe('Acciones').filter((r) => !r[0] || !r[1]);
  t.eq('no hay acciones sin email o sin grupo', accHuerfanas.length, 0);
  const loanHuerfanos = filasDe('Loans').filter((r) => !r[0] || !r[1] || !r[2]);
  t.eq('no hay prestamos sin id, email o grupo', loanHuerfanos.length, 0);
  const pagosHuerfanos = filasDe('LoanPayments').filter((r) => !r[0] || !r[2]);
  t.eq('no hay pagos sin id o sin prestamo', pagosHuerfanos.length, 0);
};
