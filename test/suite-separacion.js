/**
 * SUITE 21 - El administrador de la plataforma NO gobierna el dinero de nadie.
 *
 * Esta bateria existe porque la separacion era de fachada: se habian escondido
 * los botones y redirigido las rutas del navegador, pero los endpoints seguian
 * aceptando el token de administrador. Con una cuenta que no pertenece al grupo
 * se conseguian doce escrituras sobre su caja: reescribir el reglamento, cambiar
 * el valor de la accion, meter aportes a nombre de un socio, confirmarlos,
 * aprobar comprobantes, aplicar la apertura de saldos, saltarse el quorum de
 * credito y nombrarse presidente.
 *
 * La regla es simple y aqui se comprueba una por una: el administrador OBSERVA
 * (usuarios, grupos, participantes, indicadores). La directiva de cada grupo
 * FIRMA. Quien no esta en la nomina del grupo, no firma en el grupo.
 *
 * Cada caso se prueba dos veces: que al administrador se le cierre la puerta, y
 * que a quien SI le corresponde se le abra. Un 403 para todos no seria
 * separacion de poderes, seria una aplicacion rota.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario, seedUser, seedGroup, seedLink, login } = require('./scenario');
const t = require('./runner');

module.exports = async function run() {
  seedWorkbook();
  const G_SHEETS = require('../governance').SHEETS;
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  const { HOJA, CABECERA } = require('../accesos');
  fake.seedSheet(HOJA, [CABECERA]);

  const e = await baseScenario({ groupId: 'GSEP' });
  const G = 'GSEP';
  const hoy = hoyLocal();

  // El administrador NO esta vinculado a GSEP. Se comprueba, porque toda la
  // bateria descansa en ese hecho.
  const vinculos = (fake.dumpSheet('UserGroupLinks') || []).slice(1);
  t.eq('el administrador no pertenece al grupo',
    vinculos.filter((v) => (v[0] || '').includes('admin') && (v[1] || '') === G).length, 0);

  // ===================================================================
  t.section('SEP 1. El reglamento del grupo');
  // ===================================================================
  t.status('el admin no reescribe el reglamento de un grupo ajeno',
    await post('/api/gob/reglas', { groupId: G, aporteMinimo: 999, quorumPrestamos: 1 }, e.tokens.admin), 403);
  t.statusIn('la presidencia si',
    await post('/api/gob/reglas', { groupId: G, aporteMinimo: 5 }, e.tokens.presi), [200, 201]);

  // ===================================================================
  t.section('SEP 2. El valor de la accion y el interes');
  // ===================================================================
  t.status('el admin no cambia las cifras de un grupo ajeno',
    await post('/api/actualizar-grupo-en-sheet',
      { GroupID: G, ValorAccion: 777, PorcentajeInteresMensual: 44 }, e.tokens.admin), 403);
  t.statusIn('la presidencia si',
    await post('/api/actualizar-grupo-en-sheet',
      { GroupID: G, ValorAccion: 12, PorcentajeInteresMensual: 3 }, e.tokens.presi), [200, 201]);

  const grupoTras = (fake.dumpSheet('Groups') || []).slice(1).find((g) => (g[0] || '') === G) || [];
  t.near('quedo la cifra de la presidencia, no la del admin', Number(grupoTras[15]), 12, 0.001);
  t.near('y su interes', Number(grupoTras[16]), 3, 0.001);

  // Y las cifras absurdas se rechazan aunque las mande la presidencia
  t.status('un valor de accion negativo se rechaza',
    await post('/api/actualizar-grupo-en-sheet', { GroupID: G, ValorAccion: -5 }, e.tokens.presi), 400);
  t.status('un interes del 500% se rechaza',
    await post('/api/actualizar-grupo-en-sheet', { GroupID: G, PorcentajeInteresMensual: 500 }, e.tokens.presi), 400);
  t.status('y un texto donde va un numero, tambien',
    await post('/api/actualizar-grupo-en-sheet', { GroupID: G, ValorAccion: 'diez dolares' }, e.tokens.presi), 400);

  // ===================================================================
  t.section('SEP 2b. El ciclo del grupo lo fija su directiva');
  // ===================================================================
  // Meta, aporte mensual, fechas del ciclo y tope de socios solo los podia
  // poner el administrador de la plataforma. Son decisiones del grupo.
  const ciclo = {
    GroupID: G, MonthlyContribution: 25, TargetAmount: 6000,
    StartDate: '2026-01-15', EndDate: '2026-12-15', MaxMembers: 30,
  };
  t.status('el admin no fija el ciclo de un grupo ajeno',
    await post('/api/actualizar-grupo-en-sheet', ciclo, e.tokens.admin), 403);
  t.statusIn('la presidencia si',
    await post('/api/actualizar-grupo-en-sheet', ciclo, e.tokens.presi), [200, 201]);

  const gCiclo = (fake.dumpSheet('Groups') || []).slice(1).find((g) => (g[0] || '') === G) || [];
  t.near('quedo el aporte mensual', Number(gCiclo[8]), 25, 0.001);
  t.near('la meta del ciclo', Number(gCiclo[6]), 6000, 0.001);
  t.eq('la fecha de inicio', (gCiclo[9] || '').toString().slice(0, 10), '2026-01-15');
  t.eq('la de cierre', (gCiclo[10] || '').toString().slice(0, 10), '2026-12-15');
  t.near('y el tope de socios', Number(gCiclo[12]), 30, 0.001);

  const suGrupo = await get(`/api/grupos-del-usuario?email=${e.users.presi.email}`, e.tokens.presi);
  const vistoPorLaPresi = (suGrupo.body?.grupos || []).find((x) => x.groupId === G) || {};
  t.near('y la pantalla los recibe de vuelta para poder editarlos',
    Number(vistoPorLaPresi.MonthlyContribution), 25, 0.001);
  t.near('los cinco', Number(vistoPorLaPresi.MaxMembers), 30, 0.001);

  // ===================================================================
  t.section('SEP 2c. La base del reparto se elige en el reglamento');
  // ===================================================================
  for (const base of ['ahorros', 'ambos', 'acciones']) {
    const r = await post('/api/gob/reglas', { groupId: G, baseReparto: base }, e.tokens.presi);
    t.statusIn(`la presidencia elige repartir sobre ${base}`, r, [200, 201]);
    t.eq(`y queda guardado como ${base}`, r.body?.reglas?.baseReparto, base);
  }
  const basura = await post('/api/gob/reglas', { groupId: G, baseReparto: 'loquesea' }, e.tokens.presi);
  t.eq('una base inventada no se guarda: se conserva la anterior',
    basura.body?.reglas?.baseReparto, 'acciones');
  t.status('y el admin no la cambia en un grupo ajeno',
    await post('/api/gob/reglas', { groupId: G, baseReparto: 'ahorros' }, e.tokens.admin), 403);

  // ===================================================================
  t.section('SEP 3. Aportes a nombre de otra persona');
  // ===================================================================
  const ahorroAjeno = await post('/api/registrar-ahorros',
    { groupId: G, userEmail: e.users.socio2.email, date: hoy, amount: 250 }, e.tokens.admin);
  const filasAhorro = (fake.dumpSheet('Savings') || []).slice(1).filter((r) => (r[1] || '') === G);
  t.eq('un ahorro registrado por el admin nunca queda a nombre de un socio',
    filasAhorro.filter((r) => (r[0] || '') === e.users.socio2.email).length, 0);
  t.check('si el admin registra algo, es a su propio nombre',
    ahorroAjeno.status !== 200 || filasAhorro.every((r) => (r[0] || '') !== e.users.socio2.email),
    JSON.stringify(filasAhorro.slice(0, 3)));

  t.statusIn('el admin no mete un aporte a nombre de un socio',
    await post('/api/agregar-aporte',
      { GroupID: G, Email: e.users.socio2.email, Monto: 400, Fecha: hoy }, e.tokens.admin), [403]);
  t.statusIn('la tesoreria del grupo si puede',
    await post('/api/agregar-aporte',
      { GroupID: G, Email: e.users.socio2.email, Monto: 40, Fecha: hoy }, e.tokens.teso), [200, 201]);

  // ===================================================================
  t.section('SEP 4. Compra de acciones');
  // ===================================================================
  const compraAdmin = await post('/api/registrar-acciones',
    { groupId: G, userEmail: e.users.socio2.email, date: hoy, shares: 5 }, e.tokens.admin);
  const filasAcc = (fake.dumpSheet('Acciones') || []).slice(1).filter((r) => (r[1] || '') === G);
  t.eq('el admin no compra acciones a nombre de un socio',
    filasAcc.filter((r) => (r[0] || '') === e.users.socio2.email).length, 0);
  t.check('la respuesta no dice lo contrario',
    compraAdmin.status !== 201 || filasAcc.every((r) => (r[0] || '') !== e.users.socio2.email),
    JSON.stringify(compraAdmin.body || {}));

  // ===================================================================
  t.section('SEP 5. Confirmar un aporte');
  // ===================================================================
  const mov = await post('/api/registrar-ahorros',
    { groupId: G, userEmail: e.users.socio1.email, date: hoy, amount: 100 }, e.tokens.socio1);
  t.status('el admin no confirma el aporte de un grupo ajeno',
    await post('/api/gob/aportes/resolver',
      { groupId: G, tipo: 'ahorro', movId: mov.body?.movId, accion: 'confirmar' }, e.tokens.admin), 403);
  t.statusIn('la tesoreria si',
    await post('/api/gob/aportes/resolver',
      { groupId: G, tipo: 'ahorro', movId: mov.body?.movId, accion: 'confirmar' }, e.tokens.teso), [200, 201]);

  // ===================================================================
  t.section('SEP 6. El quorum del credito no lo salta nadie');
  // ===================================================================
  await post('/api/gob/reglas',
    { groupId: G, requiereAprobacionPrestamos: true, quorumPrestamos: 3 }, e.tokens.presi);
  await post('/api/registrar-solicitud',
    { tipo: 'prestamo', data: { Monto: 50, Detalles: 'Plazo: 4', Group: G } }, e.tokens.socio1);
  const sols = fake.dumpSheet('SolicitudesPrestamos') || [];
  const solId = sols[sols.length - 1][0];

  const conAdmin = await post('/api/aprobar-solicitud',
    { solicitudId: solId, tipo: 'prestamo', grupoId: G, accion: 'aprobar' }, e.tokens.admin);
  t.check('el admin no aprueba una solicitud saltandose el quorum',
    conAdmin.status >= 400, `HTTP ${conAdmin.status} ${JSON.stringify(conAdmin.body || {}).slice(0, 120)}`);
  t.eq('y no quedo ningun prestamo escrito',
    (fake.dumpSheet('Loans') || []).slice(1).filter((l) => (l[0] || '') === solId).length, 0);

  // ===================================================================
  t.section('SEP 7. Nombrar directiva y expulsar miembros');
  // ===================================================================
  t.status('el admin no se nombra presidente de un grupo ajeno',
    await post('/api/cambiar-rol-usuario-grupo',
      { GroupID: G, UserEmail: e.users.admin.email, NewGroupRole: 'presidente' }, e.tokens.admin), 403);
  const trasIntento = (fake.dumpSheet('UserGroupLinks') || []).slice(1)
    .filter((v) => (v[1] || '') === G && (v[0] || '') === e.users.admin.email);
  t.eq('y no se vinculo al grupo por la puerta de atras', trasIntento.length, 0);

  t.status('tampoco expulsa a un socio de un grupo ajeno',
    await post('/api/desvincular-usuario-grupo',
      { GroupID: G, UserEmail: e.users.socio2.email }, e.tokens.admin), 403);
  t.eq('el socio sigue en el grupo',
    (fake.dumpSheet('UserGroupLinks') || []).slice(1)
      .filter((v) => (v[1] || '') === G && (v[0] || '') === e.users.socio2.email
        && (v[4] || 'activo').toLowerCase() !== 'inactivo').length, 1);

  // ===================================================================
  t.section('SEP 8. Aplicar la apertura de saldos');
  // ===================================================================
  const lote = await post('/api/gob/apertura/lote', {
    groupId: G, filas: [{ email: e.users.socio1.email, ahorro: 500 }],
  }, e.tokens.presi);
  t.statusIn('la presidencia arma el lote', lote, [200, 201]);
  t.status('el admin no arma un lote en un grupo ajeno',
    await post('/api/gob/apertura/lote', {
      groupId: G, filas: [{ email: e.users.socio1.email, ahorro: 9999 }],
    }, e.tokens.admin), 403);
  t.status('ni lo aplica',
    await post(`/api/gob/apertura/lote/${lote.body?.loteId}/aplicar`, {}, e.tokens.admin), 403);

  // ===================================================================
  t.section('SEP 9. Comprobantes de pago');
  // ===================================================================
  // (El ciclo completo del comprobante lo cubre la bateria de administracion;
  //  aqui solo se fija que la puerta del admin quede cerrada.)
  t.status('el admin no ve los comprobantes por revisar de un grupo ajeno',
    await get(`/api/pending-payments?groupId=${G}`, e.tokens.admin), 403);
  t.statusIn('la tesoreria si',
    await get(`/api/pending-payments?groupId=${G}`, e.tokens.teso), [200, 201]);

  // ===================================================================
  t.section('SEP 10. Lo que el admin SI debe poder hacer');
  // ===================================================================
  // Cerrar puertas de mas romperia el panel del proyecto. Estas lecturas tienen
  // que seguir abiertas para el administrador de la plataforma.
  t.status('ve la lista de usuarios', await get('/api/obtener-usuarios', e.tokens.admin), 200);
  t.status('ve los participantes del proyecto', await get('/api/admin/participantes', e.tokens.admin), 200);
  t.status('ve los indicadores', await get('/api/admin/metricas', e.tokens.admin), 200);
  t.status('ve el resumen de la plataforma', await get('/api/admin/resumen', e.tokens.admin), 200);
  t.status('y desactiva una cuenta, que si es cosa suya',
    await post('/api/desactivar-usuario', { email: e.users.ajeno.email }, e.tokens.admin), 200);
  await post('/api/activar-usuario', { email: e.users.ajeno.email }, e.tokens.admin);

  // ===================================================================
  t.section('SEP 11. Un administrador que ADEMAS dirige su propio grupo');
  // ===================================================================
  // No se le quita nada por ser administrador: en SU grupo manda como cualquier
  // presidente. Lo que no puede es mandar en el de otros.
  seedGroup({ id: 'GADM', nombre: 'Grupo del administrador', presidente: e.users.admin.email });
  seedLink(e.users.admin.email, 'GADM', 'presidente');
  seedLink(e.users.socio1.email, 'GADM', 'member');

  t.statusIn('en su propio grupo si fija las cifras',
    await post('/api/actualizar-grupo-en-sheet',
      { GroupID: 'GADM', ValorAccion: 20, PorcentajeInteresMensual: 1 }, e.tokens.admin), [200, 201]);
  t.statusIn('y su reglamento',
    await post('/api/gob/reglas', { groupId: 'GADM', aporteMinimo: 10 }, e.tokens.admin), [200, 201]);
  t.status('pero sigue sin poder en el grupo ajeno',
    await post('/api/gob/reglas', { groupId: G, aporteMinimo: 1 }, e.tokens.admin), 403);
};
