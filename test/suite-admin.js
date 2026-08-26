/**
 * SUITE 9 - ADMINISTRACION Y PERMISOS.
 *
 * Cubre el lado que hasta ahora ninguna bateria habia tocado: las pantallas de
 * administracion (usuarios, grupos, reportes, revision de pagos, importaciones)
 * y, sobre todo, la MATRIZ DE PERMISOS: para cada endpoint sensible se prueba
 * que responde bien sin token, con un socio raso, con alguien ajeno al grupo y
 * con el administrador.
 */

const { seedWorkbook, get, post, del, api, fake, BASE, anotar } = require('./harness');
const { baseScenario, seedUser, login } = require('./scenario');
const t = require('./runner');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

module.exports = async function run() {
  seedWorkbook();
  const { users, tokens, groupId } = await baseScenario();

  // Un poco de movimiento para que los paneles no salgan vacios
  fake.ensureSheet('Savings').grid.push([
    users.socio1.email, groupId, 500, '2026-06-01', 'mensual', 'previo',
    'confirmado', 'teso@juntago.test', 'presi@juntago.test', new Date().toISOString(), 'adm_sav_1', '',
  ]);
  fake.ensureSheet('Acciones').grid.push([
    users.socio1.email, groupId, '2026-06-01', 20, 10, 2, new Date().toISOString(),
    'confirmado', 'teso@juntago.test', 'presi@juntago.test', new Date().toISOString(), 'adm_acc_1', '',
  ]);

  // ===================================================================
  t.section('ADM 1. Matriz de permisos de los endpoints de administracion');
  // ===================================================================
  const soloAdmin = [
    ['GET', '/api/obtener-usuarios'],
    ['GET', '/api/admin/resumen'],
    ['GET', '/api/admin/transacciones'],
    ['GET', '/api/actividad-reciente'],
    ['GET', '/api/obtener-usergrouplinks'],
    ['GET', '/api/obtener-todos-prestamos'],
  ];
  for (const [metodo, ruta] of soloAdmin) {
    t.status(`${ruta} sin token -> 401`, await api(metodo, ruta), 401);
    t.status(`${ruta} con socio raso -> 403`, await api(metodo, ruta, { token: tokens.socio1 }), 403);
    t.status(`${ruta} con presidenta de grupo -> 403`, await api(metodo, ruta, { token: tokens.presi }), 403);
    t.status(`${ruta} con admin -> 200`, await api(metodo, ruta, { token: tokens.admin }), 200);
  }

  const escriturasSoloAdmin = [
    ['POST', '/api/cambiar-rol-usuario', { email: 'socio1@juntago.test', nuevoRol: 'admin' }],
    ['POST', '/api/desactivar-usuario', { email: 'socio2@juntago.test' }],
    ['POST', '/api/activar-usuario', { email: 'socio2@juntago.test' }],
    ['POST', '/api/registrar-prestamo-en-sheet', { LoanID: 'x', UserEmail: 'socio1@juntago.test', GroupID: 'G1', AmountApproved: 10 }],
  ];
  for (const [metodo, ruta, cuerpo] of escriturasSoloAdmin) {
    t.status(`${ruta} sin token -> 401`, await api(metodo, ruta, { body: cuerpo }), 401);
    t.status(`${ruta} con socio raso -> 403`, await api(metodo, ruta, { body: cuerpo, token: tokens.socio1 }), 403);
    t.status(`${ruta} con presidenta -> 403`, await api(metodo, ruta, { body: cuerpo, token: tokens.presi }), 403);
  }

  t.status('DELETE /api/eliminar-grupo con socio raso -> 403',
    await del(`/api/eliminar-grupo/${groupId}`, tokens.socio1), 403);
  t.status('DELETE /api/eliminar-grupo con la presidenta del grupo -> 403',
    await del(`/api/eliminar-grupo/${groupId}`, tokens.presi), 403);

  // ===================================================================
  t.section('ADM 2. Panel de usuarios');
  // ===================================================================
  const usuarios = await get('/api/obtener-usuarios', tokens.admin);
  t.status('el admin lista los usuarios', usuarios, 200);
  const lista = usuarios.body?.usuarios || usuarios.body?.users || usuarios.body?.data || [];
  t.eq('estan los 7 usuarios del escenario', lista.length, 7);
  t.check('ningun usuario expone su contrasena',
    !JSON.stringify(lista).toLowerCase().includes('$2b$') && !JSON.stringify(lista).includes('Clave123'),
    JSON.stringify(lista[0] || {}).slice(0, 200));

  t.status('el admin desactiva a un socio',
    await post('/api/desactivar-usuario', { email: users.socio2.email }, tokens.admin), 200);
  const filaInactiva = (fake.dumpSheet('Users') || []).find((r) => r[1] === users.socio2.email);
  t.eq('queda marcado inactivo en la hoja (columna I)', filaInactiva?.[8], 'inactivo');

  const entradaBloqueada = await post('/api/login', { email: users.socio2.email, password: 'Clave123' });
  t.statusIn('un usuario desactivado no puede entrar', entradaBloqueada, [401, 403]);

  t.status('el admin lo reactiva',
    await post('/api/activar-usuario', { email: users.socio2.email }, tokens.admin), 200);
  const tokenReactivado = await login(users.socio2.email, 'Clave123');
  t.check('y vuelve a poder entrar', !!tokenReactivado, 'no se pudo iniciar sesion tras reactivar');

  t.status('el admin cambia el rol global de un usuario',
    await post('/api/cambiar-rol-usuario', { email: users.socio1.email, nuevoRol: 'admin' }, tokens.admin), 200);
  const filaRol = (fake.dumpSheet('Users') || []).find((r) => r[1] === users.socio1.email);
  t.eq('el rol queda escrito en la hoja (columna D)', filaRol?.[3], 'admin');
  await post('/api/cambiar-rol-usuario', { email: users.socio1.email, nuevoRol: 'member' }, tokens.admin);

  t.statusIn('no se acepta un rol global inventado',
    await post('/api/cambiar-rol-usuario', { email: users.socio1.email, nuevoRol: 'superjefe' }, tokens.admin), [200, 400]);
  const filaTrasRolRaro = (fake.dumpSheet('Users') || []).find((r) => r[1] === users.socio1.email);
  t.check('y el usuario nunca queda con un rol invalido',
    ['member', 'admin'].includes(String(filaTrasRolRaro?.[3])),
    `rol en la hoja: ${filaTrasRolRaro?.[3]}`);

  // ===================================================================
  t.section('ADM 3. Perfil y contrasena del propio usuario');
  // ===================================================================
  t.status('un socio cambia su contrasena',
    await post('/api/cambiar-contrasena', { actual: 'Clave123', nueva: 'NuevaClave456' }, tokens.socio1), 200);
  t.statusIn('la contrasena vieja ya no sirve',
    await post('/api/login', { email: users.socio1.email, password: 'Clave123' }), [401, 403]);
  const conNueva = await post('/api/login', { email: users.socio1.email, password: 'NuevaClave456' });
  t.status('la nueva si sirve', conNueva, 200);
  const tokenSocio1 = conNueva.body?.token;

  t.statusIn('no se puede cambiar la contrasena sin acertar la actual',
    await post('/api/cambiar-contrasena', { actual: 'loQueSea', nueva: 'Otra123456' }, tokenSocio1), [400, 401, 403]);
  t.check('la contrasena sigue guardada como hash, nunca en claro',
    !JSON.stringify(fake.dumpSheet('Users')).includes('NuevaClave456'),
    'aparece la clave en texto plano en la hoja');

  // ===================================================================
  t.section('ADM 4. Resumen, actividad y reportes');
  // ===================================================================
  const resumen = await get('/api/admin/resumen', tokens.admin);
  t.near('el resumen suma el ahorro confirmado', resumen.body?.resumen?.totalAhorros, 500);
  t.near('y el capital en acciones (20 x 10)', resumen.body?.resumen?.totalAcciones, 200);
  t.eq('cuenta los usuarios', resumen.body?.resumen?.totalUsuarios, 7);
  t.check('cuenta los grupos', Number(resumen.body?.resumen?.totalGrupos) >= 2,
    `grupos: ${resumen.body?.resumen?.totalGrupos}`);

  const actividad = await get('/api/actividad-reciente', tokens.admin);
  t.status('la actividad reciente responde', actividad, 200);
  t.check('devuelve una lista', Array.isArray(actividad.body?.actividad || actividad.body?.actividades || actividad.body?.data),
    JSON.stringify(actividad.body).slice(0, 200));

  const enlaces = await get('/api/obtener-usergrouplinks', tokens.admin);
  t.status('los vinculos usuario-grupo responden', enlaces, 200);
  const filasEnlaces = enlaces.body?.links || enlaces.body?.userGroupLinks || enlaces.body?.data || [];
  t.check('trae los vinculos del escenario', filasEnlaces.length >= 5, `vinculos: ${filasEnlaces.length}`);

  const grupos = await get('/api/obtener-grupos', tokens.admin);
  t.status('el admin lista todos los grupos', grupos, 200);
  const gruposAdmin = grupos.body?.grupos || grupos.body?.groups || [];
  t.check('el admin ve mas de un grupo', gruposAdmin.length >= 2, `grupos: ${gruposAdmin.length}`);

  const gruposSocio = await get('/api/obtener-grupos', tokens.socio1);
  const listaSocio = gruposSocio.body?.grupos || gruposSocio.body?.groups || [];
  t.eq('un socio solo ve el suyo', listaSocio.length, 1);

  // ===================================================================
  t.section('ADM 5. Revision de pagos desde administracion');
  // ===================================================================
  await post('/api/gob/reglas', { groupId, requiereAprobacionPrestamos: false }, tokens.presi);
  await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 300, Detalles: 'Plazo: 6', Group: groupId },
  }, tokenSocio1);
  const solicitudes = fake.dumpSheet('SolicitudesPrestamos') || [];
  const loanId = solicitudes[solicitudes.length - 1][0];
  await post('/api/approve-loan-request', { loanId, action: 'approve' }, tokens.presi);

  const form = new FormData();
  form.append('loanId', loanId);
  form.append('amount', '120');
  form.append('userEmail', users.socio1.email);
  form.append('groupId', groupId);
  form.append('paymentDate', '2026-08-22');
  form.append('paymentImage', new Blob([Buffer.from('img')], { type: 'image/png' }), 'c.png');
  anotar('POST', '/api/upload-payment');
  const subida = await fetch(`${BASE}/api/upload-payment`, {
    method: 'POST', headers: { Authorization: `Bearer ${tokenSocio1}` }, body: form,
  });
  t.check('el socio sube su comprobante', subida.ok, `HTTP ${subida.status}`);

  const pendientes = await get(`/api/pending-payments?groupId=${groupId}`, tokens.admin);
  t.status('el admin ve los pagos por revisar', pendientes, 200);
  const pagos = pendientes.body?.payments || pendientes.body?.pagos || [];
  const pagoId = pagos[0]?.paymentId || pagos[0]?.PaymentID || pagos[0]?.id;
  t.check('hay un pago pendiente', !!pagoId, JSON.stringify(pagos).slice(0, 200));

  t.status('un socio ajeno no puede aprobar el pago',
    await post('/api/approve-payment', { paymentId: pagoId, action: 'approve' }, tokens.ajeno), 403);
  t.status('el admin lo rechaza',
    await post('/api/approve-payment', { paymentId: pagoId, action: 'reject', notes: 'comprobante ilegible' }, tokens.admin), 200);

  const trasRechazo = await get(`/api/obtener-prestamos?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.admin);
  const prestamo = (trasRechazo.body?.loans || []).find((l) => l.loanId === loanId);
  t.near('un pago rechazado NO baja el saldo (300 a 6m al 2% = 336)', prestamo?.remainingBalance, 336);

  t.status('un pago ya resuelto no se vuelve a procesar',
    await post('/api/approve-payment', { paymentId: pagoId, action: 'approve' }, tokens.admin), 409);
  const trasReintento = await get(`/api/obtener-prestamos?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.admin);
  t.near('el saldo no se movio con el reintento',
    (trasReintento.body?.loans || []).find((l) => l.loanId === loanId)?.remainingBalance, 336);

  // ===================================================================
  t.section('ADM 6. La imagen del comprobante');
  // ===================================================================
  // Esquema real de LoanPayments: F=Description, G=Status, H=ImageFilename, J=ImagePath, M=ApprovedBy
  const filaPago = (fake.dumpSheet('LoanPayments') || []).slice(1).find((r) => r[0] === pagoId);
  t.check('el nombre del archivo del comprobante quedo guardado (columna H)',
    !!(filaPago?.[7] || '').toString(), `valor: "${filaPago?.[7]}"`);
  t.check('y tambien su ruta en disco (columna J)',
    !!(filaPago?.[9] || '').toString(), `valor: "${filaPago?.[9]}"`);
  t.eq('el estado del comprobante quedo en la columna G', (filaPago?.[6] || '').toString(), 'rejected');
  t.eq('y consta quien lo resolvio (columna M)', (filaPago?.[12] || '').toString(), users.admin.email);

  const salida = await api('GET', '/api/payment-image/..%2F..%2Fserver.js');
  t.check('no se puede salir de la carpeta de comprobantes (path traversal)',
    salida.status >= 400 || !(salida.text || '').includes('express'),
    `HTTP ${salida.status}, cuerpo empieza con: ${(salida.text || '').slice(0, 60)}`);

  const inexistente = await api('GET', '/api/payment-image/no-existe-12345.png');
  t.check('una imagen inexistente responde error, no el contenido de otra cosa',
    inexistente.status >= 400, `HTTP ${inexistente.status}`);

  // ===================================================================
  t.section('ADM 7. Aportes del grupo (endpoint aparte)');
  // ===================================================================
  t.statusIn('un socio agrega un aporte al grupo',
    await post('/api/agregar-aporte', { groupId, email: users.socio1.email, monto: 25, fecha: '2026-08-01' }, tokenSocio1), [200, 201]);
  const aportes = await get(`/api/aportes/${groupId}`, tokenSocio1);
  t.status('y se pueden listar', aportes, 200);
  t.check('el aporte aparece en la lista',
    JSON.stringify(aportes.body).includes('25'), JSON.stringify(aportes.body).slice(0, 200));
  t.status('un ajeno no ve los aportes del grupo',
    await get(`/api/aportes/${groupId}`, tokens.ajeno), 403);

  // ===================================================================
  t.section('ADM 8. Administradores del grupo y transacciones');
  // ===================================================================
  const admins = await get(`/api/group-admins/${groupId}`, tokens.presi);
  t.status('se pueden consultar los directivos del grupo', admins, 200);
  t.check('devuelve a la presidenta',
    JSON.stringify(admins.body).includes(users.presi.email), JSON.stringify(admins.body).slice(0, 200));

  const trans = await get(`/api/obtener-transacciones?userEmail=${users.socio1.email}`, tokenSocio1);
  t.status('el socio ve sus transacciones', trans, 200);

  // El servidor NO devuelve error: reescribe la identidad con la del solicitante.
  // Lo que importa es que la transaccion nunca quede a nombre de la otra persona.
  const suplantacion = await post('/api/registrar-transaccion-en-sheet', {
    TransactionID: 'TX-SUPLANTA', UserEmail: users.presi.email, Type: 'saving',
    Amount: 9999, Date: '2026-08-22', Category: 'saving', Description: 'suplantacion',
  }, tokenSocio1);
  t.statusIn('el endpoint acepta la peticion', suplantacion, [200, 201]);
  const filasTx = (fake.dumpSheet('Transactions') || []).slice(1).filter((r) => (r[0] || '') === 'TX-SUPLANTA');
  t.eq('se escribio una sola transaccion', filasTx.length, 1);
  t.eq('a nombre de QUIEN LA PIDIO, no de la persona suplantada',
    (filasTx[0]?.[1] || '').toString(), users.socio1.email);
  t.check('la presidenta no tiene ninguna transaccion de 9999',
    !(fake.dumpSheet('Transactions') || []).slice(1)
      .some((r) => (r[1] || '') === users.presi.email && Number(r[3]) === 9999),
    'quedo escrita a nombre de la presidenta');

  // ===================================================================
  t.section('ADM 9. Eliminar un grupo (solo admin)');
  // ===================================================================
  seedWorkbook();
  const e2 = await baseScenario({ groupId: 'GX' });
  fake.ensureSheet('Savings').grid.push([
    e2.users.socio1.email, 'GX', 90, '2026-06-01', 'mensual', 'previo',
    'confirmado', 'x', 'y', new Date().toISOString(), 'gx_sav', '',
  ]);

  const miembrosGX = await get(`/api/obtener-miembros?groupId=GX`, e2.tokens.presi);
  t.status('obtener-miembros responde antes de borrar el grupo', miembrosGX, 200);

  const antes = (fake.dumpSheet('Groups') || []).slice(1).length;
  t.status('el admin elimina el grupo', await del('/api/eliminar-grupo/GX', e2.tokens.admin), 200);
  const despues = (fake.dumpSheet('Groups') || []).slice(1).length;
  t.eq('el grupo desaparece de la hoja Groups', despues, antes - 1);

  const enlacesGX = (fake.dumpSheet('UserGroupLinks') || []).slice(1).filter((r) => r[1] === 'GX');
  t.eq('y no quedan vinculos huerfanos apuntando a el', enlacesGX.length, 0);

  t.status('eliminar un grupo inexistente responde 404',
    await del('/api/eliminar-grupo/NO-EXISTE', e2.tokens.admin), 404);

  // ===================================================================
  t.section('ADM 10. Endpoints de utilidad');
  // ===================================================================
  const ping = await get('/api/ping');
  t.status('ping responde sin token', ping, 200);
  t.check('y no filtra nada sensible',
    !JSON.stringify(ping.body).toLowerCase().includes('secret')
    && !JSON.stringify(ping.body).toLowerCase().includes('credential'),
    JSON.stringify(ping.body));

  t.status('el endpoint de prueba responde', await get('/api/test-endpoint'), 200);

  const stats = await get(`/api/savings/stats?email=${e2.users.socio1.email}&groupId=GX`, e2.tokens.socio1);
  t.status('las estadisticas de ahorro responden', stats, 200);

  const misAhorros = await get(`/api/savings?email=${e2.users.socio1.email}&groupId=GX`, e2.tokens.socio1);
  t.status('el listado de ahorros responde', misAhorros, 200);

  const audit = await get(`/api/savings/audit?email=${e2.users.socio1.email}&groupId=GX`, e2.tokens.socio1);
  t.status('la auditoria de intereses responde', audit, 200);

  t.status('vincular a alguien a un grupo exige ser gestor',
    await post('/api/vincular-usuario-grupo-en-sheet', {
      GroupID: 'GX', UserEmail: e2.users.ajeno.email, JoinDate: '2026-01-01', GroupRole: 'member',
    }, e2.tokens.socio1), 403);

  t.status('asignar-usuario-grupo tambien exige permisos',
    await post('/api/asignar-usuario-grupo', { userEmail: e2.users.ajeno.email, groupId: 'GX' }, e2.tokens.socio1), 403);

  // ===================================================================
  t.section('ADM 11. Endpoints que faltaban por cubrir');
  // ===================================================================
  seedWorkbook();
  const e3 = await baseScenario({ groupId: 'GZ' });

  // -- registrar-ahorros (via alterna a POST /api/savings) --
  const alterno = await post('/api/registrar-ahorros',
    { groupId: 'GZ', userEmail: e3.users.socio1.email, date: '2026-08-01', amount: 45 }, e3.tokens.socio1);
  t.status('registrar-ahorros acepta un aporte', alterno, 200);
  t.eq('y tambien nace pendiente', alterno.body?.estado, 'pendiente');
  t.status('registrar-ahorros rechaza un monto negativo',
    await post('/api/registrar-ahorros',
      { groupId: 'GZ', userEmail: e3.users.socio1.email, date: '2026-08-01', amount: -5 }, e3.tokens.socio1), 400);
  t.status('y rechaza aportar en un grupo ajeno',
    await post('/api/registrar-ahorros',
      { groupId: 'GZ', userEmail: e3.users.ajeno.email, date: '2026-08-01', amount: 10 }, e3.tokens.ajeno), 403);

  // -- solicitudes-pendientes --
  await post('/api/gob/aportes/resolver',
    { groupId: 'GZ', tipo: 'ahorro', movId: alterno.body?.movId, accion: 'confirmar' }, e3.tokens.teso);
  await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 3', Group: 'GZ' },
  }, e3.tokens.socio1);
  const pend = await get('/api/solicitudes-pendientes?group=GZ&tipo=prestamo', e3.tokens.presi);
  t.status('solicitudes-pendientes responde a un miembro', pend, 200);
  t.check('y trae la solicitud recien creada',
    JSON.stringify(pend.body).includes('100'), JSON.stringify(pend.body).slice(0, 200));
  t.status('un ajeno no ve las solicitudes pendientes del grupo',
    await get('/api/solicitudes-pendientes?group=GZ&tipo=prestamo', e3.tokens.ajeno), 403);

  // -- gob/apertura/lotes --
  const lotes = await get('/api/gob/apertura/lotes?groupId=GZ', e3.tokens.socio1);
  t.status('la lista de lotes de apertura responde', lotes, 200);
  t.eq('todavia no hay ninguno', (lotes.body?.lotes || []).length, 0);
  t.status('un ajeno no ve los lotes del grupo',
    await get('/api/gob/apertura/lotes?groupId=GZ', e3.tokens.ajeno), 403);

  // -- actualizar-grupo-en-sheet --
  t.status('un socio raso no puede reconfigurar el grupo',
    await post('/api/actualizar-grupo-en-sheet',
      { GroupID: 'GZ', ValorAccion: 99, PorcentajeInteresMensual: 50 }, e3.tokens.socio1), 403);
  const reconfig = await post('/api/actualizar-grupo-en-sheet',
    { GroupID: 'GZ', ValorAccion: 25, PorcentajeInteresMensual: 1.5 }, e3.tokens.presi);
  t.statusIn('la presidencia si puede', reconfig, [200, 201]);
  const filaGZ = (fake.dumpSheet('Groups') || []).find((r) => r[0] === 'GZ');
  t.eq('el valor de la accion queda guardado en la columna P', Number(filaGZ?.[15]), 25);
  t.eq('y el interes mensual en la Q', Number(filaGZ?.[16]), 1.5);

  const grupoTrasCambio = await get(`/api/grupos-del-usuario?userEmail=${e3.users.socio1.email}`, e3.tokens.socio1);
  t.eq('la app lee el valor nuevo',
    Number((grupoTrasCambio.body?.grupos || [])[0]?.ValorAccion), 25);

  // ===================================================================
  t.section('ADM 12. Importar usuarios desde Excel');
  // ===================================================================
  const XLSX = require('xlsx');
  const construirExcel = (filas, cabecera) => {
    const hoja = XLSX.utils.json_to_sheet(filas, { header: cabecera });
    const libro = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(libro, hoja, 'Hoja1');
    return XLSX.write(libro, { type: 'buffer', bookType: 'xlsx' });
  };
  const subirExcel = async (ruta, buffer, token) => {
    const form = new FormData();
    form.append('file', new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }), 'usuarios.xlsx');
    anotar('POST', ruta);
    const res = await fetch(`${BASE}${ruta}`, {
      method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {}, body: form,
    });
    const texto = await res.text();
    let cuerpo = null; try { cuerpo = JSON.parse(texto); } catch (e) { cuerpo = null; }
    return { status: res.status, body: cuerpo };
  };

  const excelUsuarios = construirExcel([
    { Username: 'Ana Lopez', Email: 'ana@import.test', Password: 'Clave123', Role: 'member', Balance: 0 },
    { Username: 'Beto Cruz', Email: 'beto@import.test', Password: 'Clave123', Role: 'member', Balance: 0 },
  ], ['Username', 'Email', 'Password', 'Role', 'Balance']);

  t.status('sin token no se puede importar', (await subirExcel('/api/importar-usuarios-excel', excelUsuarios, null)), 401);
  t.status('un socio raso tampoco',
    (await subirExcel('/api/importar-usuarios-excel', excelUsuarios, e3.tokens.socio1)), 403);

  const importacion = await subirExcel('/api/importar-usuarios-excel', excelUsuarios, e3.tokens.admin);
  t.statusIn('el admin importa el archivo', importacion, [200, 201]);
  const usuariosTrasImportar = (fake.dumpSheet('Users') || []).slice(1);
  t.check('Ana quedo creada', usuariosTrasImportar.some((r) => r[1] === 'ana@import.test'),
    JSON.stringify(usuariosTrasImportar.map((r) => r[1])));
  t.check('Beto tambien', usuariosTrasImportar.some((r) => r[1] === 'beto@import.test'), '');
  const filaAna = usuariosTrasImportar.find((r) => r[1] === 'ana@import.test');
  t.check('con la contrasena cifrada, nunca en claro', /^\$2[aby]\$/.test(String(filaAna?.[2])),
    `columna C: ${filaAna?.[2]}`);
  t.eq('y con rol de socio', filaAna?.[3], 'member');

  const tokenAna = await login('ana@import.test', 'Clave123');
  t.check('la persona importada puede iniciar sesion', !!tokenAna, 'no se pudo entrar con la cuenta importada');

  // Reimportar el mismo archivo no debe duplicar cuentas
  const cuantasAntes = (fake.dumpSheet('Users') || []).slice(1).length;
  await subirExcel('/api/importar-usuarios-excel', excelUsuarios, e3.tokens.admin);
  const cuantasDespues = (fake.dumpSheet('Users') || []).slice(1).length;
  t.eq('reimportar el mismo archivo no duplica usuarios', cuantasDespues, cuantasAntes);

  // Importar usuarios CON grupo
  const excelConGrupo = construirExcel([
    { Username: 'Caro Diaz', Email: 'caro@import.test', Password: 'Clave123', Grupo: 'GZ' },
  ], ['Username', 'Email', 'Password', 'Grupo']);
  const conGrupo = await subirExcel('/api/importar-usuarios-grupos', excelConGrupo, e3.tokens.admin);
  t.statusIn('el admin importa usuarios con su grupo', conGrupo, [200, 201]);
  t.check('Caro quedo creada',
    (fake.dumpSheet('Users') || []).slice(1).some((r) => r[1] === 'caro@import.test'), '');
  const vinculoCaro = (fake.dumpSheet('UserGroupLinks') || []).slice(1)
    .filter((r) => (r[0] || '') === 'caro@import.test' && (r[1] || '') === 'GZ');
  t.eq('y quedo vinculada al grupo indicado', vinculoCaro.length, 1);
  t.eq('con rol de socia, no de directiva', (vinculoCaro[0]?.[3] || '').toString(), 'member');
};
