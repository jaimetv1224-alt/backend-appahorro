/**
 * SUITE 4 - Compatibilidad con los datos que YA existen en la hoja de produccion.
 *
 * Las filas historicas de Savings/Acciones no tienen columna de Estado. El
 * control interno debe tratarlas como confirmadas: si no, al desplegar esta
 * version el patrimonio de todos los grupos caeria a cero.
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

/** Fila de Savings al estilo VIEJO: solo A..F, sin columnas de control. */
function seedSavingsLegacy(email, groupId, monto, fecha = '2026-01-10') {
  fake.ensureSheet('Savings').grid.push([email, groupId, monto, fecha, 'mensual', 'aporte historico']);
}

/** Fila de Acciones al estilo VIEJO: solo A..G. */
function seedAccionesLegacy(email, groupId, shares, valor, tasa = 2, fecha = '2026-01-10') {
  fake.ensureSheet('Acciones').grid.push([email, groupId, fecha, shares, valor, tasa, new Date().toISOString()]);
}

function seedSavingsConEstado(email, groupId, monto, estado, movId) {
  fake.ensureSheet('Savings').grid.push([
    email, groupId, monto, '2026-02-10', 'mensual', 'con estado',
    estado, 'teso@juntago.test', 'presi@juntago.test', new Date().toISOString(), movId, '',
  ]);
}

module.exports = async function run() {
  seedWorkbook();
  const { users, tokens, groupId } = await baseScenario();

  // ===================================================================
  t.section('COMPAT 1. Filas historicas sin columna de Estado');
  // ===================================================================
  seedSavingsLegacy(users.socio1.email, groupId, 200);
  seedSavingsLegacy(users.socio1.email, groupId, 150.75);
  seedAccionesLegacy(users.socio1.email, groupId, 20, 10);

  const completo = await get(`/api/savings/complete?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  t.status('savings/complete responde con datos historicos', completo, 200);
  t.near('los ahorros historicos SI cuentan (200 + 150.75)', completo.body?.data?.totalAhorros, 350.75);
  t.near('las acciones historicas SI cuentan (20 x 10)', completo.body?.data?.totalAcciones, 200);
  t.near('no aparecen como pendientes', completo.body?.data?.pendientes?.total, 0);

  const ahorros = await get(`/api/obtener-ahorros?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  t.eq('obtener-ahorros devuelve las 2 filas historicas', ahorros.body?.savings?.length, 2);
  t.eq('y ninguna pendiente', ahorros.body?.pendientes?.length, 0);

  const acciones = await get(`/api/obtener-acciones?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  t.eq('obtener-acciones devuelve la fila historica', acciones.body?.shares?.length, 1);

  const utilidades = await get(`/api/obtener-utilidades?groupId=${groupId}&userEmail=${users.socio1.email}`, tokens.socio1);
  t.eq('las acciones historicas devengan utilidades', utilidades.body?.utilities?.length, 1);

  const resumen = await get('/api/admin/resumen', tokens.admin);
  t.near('el resumen admin suma lo historico', Number(resumen.body?.resumen?.totalAhorros), 350.75);
  t.near('y no reporta pendientes falsos', Number(resumen.body?.resumen?.totalAhorrosPendientes), 0);

  const audit = await get(`/api/savings/audit?email=${users.socio1.email}&groupId=${groupId}`, tokens.socio1);
  t.check('la auditoria de intereses ve las acciones historicas',
    audit.status === 200 && (audit.body?.data?.detallesPorLote || []).length > 0,
    `HTTP ${audit.status}`);

  // El cupo de credito se calcula sobre el ahorro historico (3x de 350.75 = 1052.25)
  const dentro = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 1000, Detalles: 'Plazo: 6', Group: groupId },
  }, tokens.socio1);
  t.status('el socio puede pedir credito con su ahorro historico', dentro, 201);
  const fuera = await post('/api/registrar-solicitud', {
    tipo: 'prestamo', data: { Monto: 1100, Detalles: 'Plazo: 6', Group: groupId },
  }, tokens.socio1);
  t.status('pero no por encima del cupo', fuera, 409);
  t.near('el cupo informado es 3x el ahorro historico', fuera.body?.cupoMaximo, 1052.25);

  // ===================================================================
  t.section('COMPAT 2. Mezcla de estados en la misma hoja');
  // ===================================================================
  seedWorkbook();
  const e2 = await baseScenario();

  seedSavingsLegacy(e2.users.socio2.email, e2.groupId, 100);                       // historico -> cuenta
  seedSavingsConEstado(e2.users.socio2.email, e2.groupId, 50, 'confirmado', 'm1'); // confirmado -> cuenta
  seedSavingsConEstado(e2.users.socio2.email, e2.groupId, 999, 'pendiente', 'm2'); // pendiente -> NO
  seedSavingsConEstado(e2.users.socio2.email, e2.groupId, 777, 'rechazado', 'm3'); // rechazado -> NO
  seedSavingsConEstado(e2.users.socio2.email, e2.groupId, 25, '', 'm4');           // vacio -> cuenta

  const mix = await get(`/api/savings/complete?email=${e2.users.socio2.email}&groupId=${e2.groupId}`, e2.tokens.socio2);
  t.near('solo suman historico + confirmado + vacio (100 + 50 + 25)', mix.body?.data?.totalAhorros, 175);
  t.near('el pendiente se reporta aparte', mix.body?.data?.pendientes?.totalAhorros, 999);
  t.check('el rechazado no aparece en ningun total',
    Number(mix.body?.data?.totalAhorros) === 175 && Number(mix.body?.data?.pendientes?.totalAhorros) === 999,
    JSON.stringify({ total: mix.body?.data?.totalAhorros, pend: mix.body?.data?.pendientes?.totalAhorros }));

  const mios = await get(`/api/gob/mis-aportes?groupId=${e2.groupId}`, e2.tokens.socio2);
  t.near('mis-aportes reporta 175 confirmados', mios.body?.resumen?.ahorroConfirmado, 175);
  t.near('mis-aportes reporta 999 pendientes', mios.body?.resumen?.ahorroPendiente, 999);
  t.eq('el rechazado se ve con su estado',
    mios.body?.ahorros?.find((a) => a.movId === 'm3')?.estado, 'rechazado');

  const bandeja = await get(`/api/gob/aportes-pendientes?groupId=${e2.groupId}`, e2.tokens.teso);
  t.eq('la bandeja solo lista el pendiente real', bandeja.body?.ahorros?.length, 1);
  t.eq('...identificado por su movId', bandeja.body?.ahorros?.[0]?.movId, 'm2');

  const stats = await get(`/api/savings/stats?email=${e2.users.socio2.email}&groupId=${e2.groupId}`, e2.tokens.socio2);
  t.status('savings/stats responde', stats, 200);
  t.near('savings/stats solo suma lo confirmado', stats.body?.stats?.totalSavingsAmount, 175);
  t.near('savings/stats informa lo pendiente aparte', stats.body?.stats?.pendienteAmount, 999);
  t.eq('savings/stats cuenta solo las transacciones que valen', stats.body?.stats?.totalTransactions, 3);
  t.eq('savings/stats reporta el rechazado', stats.body?.stats?.rechazadoCount, 1);

  const historial = await get(`/api/savings?email=${e2.users.socio2.email}&groupId=${e2.groupId}`, e2.tokens.socio2);
  t.status('el historial de ahorros responde', historial, 200);
  const filas = historial.body?.savings || historial.body?.data || [];
  t.eq('el historial devuelve TODAS las filas (con su estado)', filas.length, 5);
  t.check('cada fila trae su estado y si cuenta',
    filas.every((f) => typeof f.estado === 'string' && typeof f.cuenta === 'boolean'),
    JSON.stringify(filas.slice(0, 2)));
  t.eq('la fila pendiente viene marcada como que no cuenta',
    filas.find((f) => f.movId === 'm2')?.cuenta, false);

  // ===================================================================
  t.section('COMPAT 3. Grupo que decide NO exigir confirmacion');
  // ===================================================================
  seedWorkbook();
  const e3 = await baseScenario();

  // Primero se fija el reglamento (grupo sin reglas guardadas: se permite crear)
  t.status('la presidenta configura el grupo sin aprobacion de aportes',
    await post('/api/gob/reglas', {
      groupId: e3.groupId, requiereAprobacionAportes: false, requiereAprobacionPrestamos: false,
    }, e3.tokens.presi), 200);

  const directo = await post('/api/savings', { groupId: e3.groupId, tipo: 'mensual', monto: 90 }, e3.tokens.socio1);
  t.eq('el aporte nace CONFIRMADO cuando el grupo no exige aprobacion', directo.body?.estado, 'confirmado');

  const total = await get(`/api/savings/complete?email=${e3.users.socio1.email}&groupId=${e3.groupId}`, e3.tokens.socio1);
  t.near('y suma de inmediato al patrimonio', total.body?.data?.totalAhorros, 90);

  const bandeja3 = await get(`/api/gob/aportes-pendientes?groupId=${e3.groupId}`, e3.tokens.teso);
  t.eq('no queda nada en la bandeja de la tesoreria', bandeja3.body?.ahorros?.length, 0);

  // Y ahora endurecer es libre (no requiere acuerdo)
  t.status('volver a exigir aprobacion no necesita acuerdo (endurecer es libre)',
    await post('/api/gob/reglas', { groupId: e3.groupId, requiereAprobacionAportes: true }, e3.tokens.presi), 200);
  const trasEndurecer = await post('/api/savings', { groupId: e3.groupId, tipo: 'mensual', monto: 30 }, e3.tokens.socio1);
  t.eq('el siguiente aporte ya nace pendiente', trasEndurecer.body?.estado, 'pendiente');

  // ===================================================================
  t.section('COMPAT 4. Dinero con coma decimal (locale es-EC)');
  // ===================================================================
  seedWorkbook();
  const e4 = await baseScenario();
  fake.store.localeDecimalComma = true; // la hoja devuelve "137,37" en vez de 137.37

  seedSavingsLegacy(e4.users.socio1.email, e4.groupId, 137.37);
  seedSavingsLegacy(e4.users.socio1.email, e4.groupId, 12.63);

  const conComa = await get(`/api/savings/complete?email=${e4.users.socio1.email}&groupId=${e4.groupId}`, e4.tokens.socio1);
  t.near('los montos con coma decimal se suman bien (137,37 + 12,63)', conComa.body?.data?.totalAhorros, 150);
  fake.store.localeDecimalComma = false;
};
