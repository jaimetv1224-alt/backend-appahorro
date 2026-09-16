/**
 * SUITE 1 - Nucleo: autenticacion, aislamiento entre grupos y las cuatro
 * regresiones detectadas en la auditoria (A-1 quorum falsificado,
 * A-2 doble aprobacion, A-3 aportes auto-declarados, A-4 hoja inexistente).
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario, seedLink } = require('./scenario');
const t = require('./runner');

/** Siembra un ahorro YA CONFIRMADO (como si lo hubiera cargado la tesoreria). */
function seedAhorroConfirmado(email, groupId, monto) {
  const sheet = fake.ensureSheet('Savings');
  sheet.grid.push([
    email, groupId, monto, '2026-01-15', 'mensual', 'saldo de prueba',
    'confirmado', 'teso@juntago.test', 'teso@juntago.test', new Date().toISOString(),
    `seed_${Math.random().toString(36).slice(2, 8)}`, '',
  ]);
}

module.exports = async function run() {
  seedWorkbook();
  const { users, tokens, groupId } = await baseScenario();

  // Cupo de credito: los socios necesitan ahorro CONFIRMADO para poder pedir prestamos
  seedAhorroConfirmado(users.socio1.email, groupId, 500);
  seedAhorroConfirmado(users.socio2.email, groupId, 400);

  // -------------------------------------------------------------------
  t.section('CORE 1. Autenticacion y gate global');
  // -------------------------------------------------------------------
  t.status('ping publico responde 200', await get('/api/ping'), 200);
  t.status('endpoint protegido sin token responde 401', await get('/api/mi-perfil'), 401);
  t.status('mi-perfil con token responde 200', await get('/api/mi-perfil', tokens.socio1), 200);
  t.statusIn('login con clave incorrecta no entra',
    await post('/api/login', { email: users.socio1.email, password: 'incorrecta' }), [400, 401, 403]);
  t.status('token invalido responde 401',
    await get('/api/mi-perfil', 'esto.no.es.un.token'), 401);

  const grupos = await get(`/api/grupos-del-usuario?userEmail=${users.socio1.email}`, tokens.socio1);
  t.status('grupos-del-usuario responde 200', grupos, 200);
  t.check('el socio ve su grupo', JSON.stringify(grupos.body).includes(groupId), JSON.stringify(grupos.body).slice(0, 200));

  // -------------------------------------------------------------------
  t.section('CORE 2. A-3: los aportes auto-declarados no forman patrimonio');
  // -------------------------------------------------------------------
  const ahorroFalso = await post('/api/savings',
    { groupId, tipo: 'mensual', monto: 15000, descripcion: 'me pongo 15 mil' }, tokens.socio1);
  t.status('el socio puede DECLARAR un ahorro', ahorroFalso, 200);
  t.eq('el ahorro declarado nace PENDIENTE', ahorroFalso.body?.estado, 'pendiente');

  const completo = await get(`/api/savings/complete?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  const totalAhorros = completo.body?.data?.totalAhorros;
  t.eq('los 15000 declarados NO cuentan en el patrimonio', Number(totalAhorros), 500);
  t.eq('pero si aparecen como pendientes', Number(completo.body?.data?.pendientes?.totalAhorros), 15000);

  const accionFalsa = await post('/api/registrar-acciones',
    { groupId, date: '2026-08-01', shares: 500, shareValue: 10, interestRate: 2 }, tokens.socio1);
  t.status('el socio puede DECLARAR compra de acciones', accionFalsa, 201);
  t.eq('la compra de acciones nace PENDIENTE', accionFalsa.body?.estado, 'pendiente');

  const acciones = await get(`/api/obtener-acciones?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  t.eq('obtener-acciones no devuelve las pendientes como capital', acciones.body?.shares?.length, 0);
  t.eq('obtener-acciones si las lista aparte', acciones.body?.pendientes?.length, 1);

  const utilidades = await get(`/api/obtener-utilidades?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  t.eq('las acciones pendientes no devengan utilidades', utilidades.body?.utilities?.length, 0);

  const resumenAdmin = await get('/api/admin/resumen', tokens.admin);
  t.eq('el resumen admin no suma los aportes pendientes',
    Number(resumenAdmin.body?.resumen?.totalAhorros), 900);
  t.eq('el resumen admin reporta lo pendiente aparte',
    Number(resumenAdmin.body?.resumen?.totalAhorrosPendientes), 15000);

  // -------------------------------------------------------------------
  t.section('CORE 3. A-1: no se puede falsificar el quorum apuntando a otro grupo');
  // -------------------------------------------------------------------
  const solicitud = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 300, Detalles: 'Plazo: 6', Group: groupId },
  }, tokens.socio2);
  t.status('socio2 registra solicitud dentro de su cupo', solicitud, 201);

  const solRows = fake.dumpSheet('SolicitudesPrestamos') || [];
  const solId = solRows.length > 1 ? solRows[solRows.length - 1][0] : null;
  t.check('la solicitud quedo escrita con ID', !!solId, JSON.stringify(solRows.slice(-1)));

  // La presidenta vota "aprobado" pero declara grupoId=G2 (grupo de un solo lider)
  t.status('se registra el voto', await post('/api/registrar-voto', {
    solicitudId: solId, tipo: 'prestamo', grupoId: 'G2', decision: 'aprobado',
  }, tokens.presi), 201);

  const estadoSol = (fake.dumpSheet('SolicitudesPrestamos') || []).find((r) => r[0] === solId)?.[5];
  t.eq('con 1 voto en un grupo de 3 lideres la solicitud sigue pendiente', estadoSol, 'pendiente');
  t.eq('y no se creo ningun prestamo', (fake.dumpSheet('Loans') || []).slice(1).length, 0);

  // Segundo voto legitimo => alcanza quorum
  t.status('el tesorero emite el segundo voto', await post('/api/registrar-voto', {
    solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado',
  }, tokens.teso), 201);
  const estadoSol2 = (fake.dumpSheet('SolicitudesPrestamos') || []).find((r) => r[0] === solId)?.[5];
  t.eq('con 2 votos la solicitud queda aprobada', estadoSol2, 'aprobado');

  const prestamo = (fake.dumpSheet('Loans') || []).slice(1).find((r) => r[0] === solId);
  t.check('el prestamo se creo en Loans', !!prestamo, JSON.stringify(prestamo));
  // 300 a 6 meses al 2% mensual => 300 * (1 + 0.02*6) = 336
  t.near('el total con interes es correcto (300 a 6m al 2%)', prestamo?.[9], 336);

  t.status('un mismo lider no puede votar dos veces', await post('/api/registrar-voto', {
    solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado',
  }, tokens.presi), 409);

  t.status('un socio raso no puede votar', await post('/api/registrar-voto', {
    solicitudId: solId, tipo: 'prestamo', grupoId: groupId, decision: 'aprobado',
  }, tokens.socio1), 403);

  // -------------------------------------------------------------------
  t.section('CORE 4. A-2: la aprobacion directa es idempotente');
  // -------------------------------------------------------------------
  // Para probar la via directa se desactiva la aprobacion colegiada del grupo
  t.status('la presidenta endurece/ajusta el reglamento',
    await post('/api/gob/reglas', { groupId, requiereAprobacionPrestamos: false }, tokens.presi), 200);

  const sol2 = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 3', Group: groupId },
  }, tokens.socio1);
  t.status('socio1 registra segunda solicitud', sol2, 201);
  const rows3 = fake.dumpSheet('SolicitudesPrestamos') || [];
  const solId2 = rows3[rows3.length - 1][0];

  t.status('primera aprobacion directa responde 200',
    await post('/api/approve-loan-request', { loanId: solId2, action: 'approve' }, tokens.presi), 200);
  t.status('la segunda aprobacion se rechaza con 409',
    await post('/api/approve-loan-request', { loanId: solId2, action: 'approve' }, tokens.presi), 409);
  t.eq('no hay prestamos duplicados en Loans',
    (fake.dumpSheet('Loans') || []).slice(1).filter((r) => r[0] === solId2).length, 1);

  // -------------------------------------------------------------------
  t.section('CORE 5. A-4: la auditoria de intereses lee la hoja correcta');
  // -------------------------------------------------------------------
  // Se siembra una compra de acciones YA confirmada
  fake.ensureSheet('Acciones').grid.push([
    users.socio2.email, groupId, '2026-01-10', 20, 10, 2, new Date().toISOString(),
    'confirmado', 'teso@juntago.test', 'teso@juntago.test', new Date().toISOString(), 'seedacc', '',
  ]);
  const audit = await get(`/api/savings/audit?email=${users.socio2.email}&groupId=${groupId}`, tokens.socio2);
  const lotes = audit.body?.data?.detallesPorLote;
  t.check('savings/audit ve las acciones confirmadas',
    audit.status === 200 && Array.isArray(lotes) && lotes.length > 0,
    `HTTP ${audit.status}, detallesPorLote=${JSON.stringify(lotes)}`);

  // -------------------------------------------------------------------
  t.section('CORE 6. Aislamiento entre grupos');
  // -------------------------------------------------------------------
  t.status('un ajeno no lee solicitudes de otro grupo',
    await get(`/api/solicitudes-grupo?groupId=${groupId}`, tokens.ajeno), 403);
  t.status('un ajeno no lee actas de otro grupo',
    await get(`/api/actas-asamblea?groupId=${groupId}`, tokens.ajeno), 403);
  t.status('un socio raso no gestiona el grupo',
    await post('/api/vincular-usuario-grupo-en-sheet', {
      GroupID: groupId, UserEmail: users.ajeno.email, JoinDate: '2026-01-01', GroupRole: 'member',
    }, tokens.socio1), 403);
  t.status('un socio no registra ahorros en un grupo ajeno',
    await post('/api/savings', { groupId: 'G2', tipo: 'mensual', monto: 50 }, tokens.socio1), 403);
  t.status('un socio no consulta los aportes de otro socio',
    await get(`/api/obtener-ahorros?groupId=${groupId}&userEmail=${users.socio2.email}`, tokens.socio1), 200);

  const espia = await get(`/api/obtener-ahorros?groupId=${groupId}&userEmail=${users.socio2.email}`, tokens.socio1);
  t.eq('...y lo que recibe son SUS propios datos, no los del otro',
    espia.body?.savings?.reduce((s, x) => s + x.amount, 0), 500);

  // -------------------------------------------------------------------
  t.section('CORE 7. Validaciones de entrada');
  // -------------------------------------------------------------------
  t.statusIn('no se aceptan ahorros negativos',
    await post('/api/savings', { groupId, tipo: 'mensual', monto: -100 }, tokens.socio1), [400]);
  // El precio de la accion lo pone el grupo, no quien compra: mandar un cero se
  // rechaza por desajuste con la cifra del grupo, nunca se acepta.
  t.statusIn('no se aceptan acciones con un valor distinto del que fijo el grupo',
    await post('/api/registrar-acciones', { groupId, date: '2026-08-01', shares: 5, shareValue: 0, interestRate: 2 }, tokens.socio1), [409]);
  t.statusIn('tampoco con un interes distinto del que fijo el grupo',
    await post('/api/registrar-acciones', { groupId, date: '2026-08-01', shares: 5, shareValue: 10, interestRate: 99 }, tokens.socio1), [409]);
  t.statusIn('no se aceptan montos no numericos en solicitudes',
    await post('/api/registrar-solicitud', { tipo: 'prestamo', data: { Monto: 'muchisimo', Group: groupId } }, tokens.socio1), [400]);
  t.statusIn('no se aceptan solicitudes de tipo desconocido',
    await post('/api/registrar-solicitud', { tipo: 'hipoteca', data: { Monto: 10, Group: groupId } }, tokens.socio1), [400]);

  // Inyeccion de formulas
  seedLink(users.ajeno.email, 'G3', 'presidente');
  await post('/api/savings', { groupId, tipo: 'extra', monto: 1, descripcion: '=IMPORTXML("http://x","//a")' }, tokens.socio1);
  const savRows = fake.dumpSheet('Savings') || [];
  const inyectada = savRows.find((r) => (r[5] || '').toString().includes('IMPORTXML'));
  t.check('la descripcion con formula se guarda neutralizada con apostrofo',
    !inyectada || inyectada[5].toString().startsWith("'"),
    `valor guardado: ${inyectada ? inyectada[5] : '(no se encontro)'}`);

  // ===================================================================
  t.section('SOC. Los grupos del socio llegan con cuantas socias tienen');
  // ===================================================================
  // La pantalla de inicio decia "0 miembros" en un grupo de trece porque este
  // dato no viajaba, y el importe salia en $0,00 porque la columna
  // CurrentAmount de la hoja no la actualiza nadie (los aportes van a Savings).
  {
    const { seedWorkbook: sw2, get: g2 } = require('./harness');
    const esc2 = require('./scenario');
    const hj2 = require('../hoja');
    sw2();
    hj2.invalidarTodo();
    const e2 = await esc2.baseScenario({ groupId: 'SOC1' });
    const r2 = await g2(`/api/grupos-del-usuario?userEmail=${encodeURIComponent(e2.users.socio1.email)}`,
      e2.tokens.socio1);
    t.status('responde', r2, 200);
    const suyo = ((r2.body || {}).grupos || []).find((x) => x.groupId === 'SOC1');
    t.check('trae su grupo', !!suyo, JSON.stringify((r2.body || {}).grupos || []));
    t.eq('con el numero de socias, que son cinco', suyo && suyo.miembros, 5);
    t.check('y como NUMERO, no como lista', typeof (suyo || {}).miembros === 'number',
      typeof (suyo || {}).miembros);
  }
};
