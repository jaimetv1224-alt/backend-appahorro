/**
 * SUITE 35 - Gastos y multas que de verdad mueven la caja.
 *
 * El acuerdo de asamblea existia y no servia para nada. Medido: se aprobaba un
 * gasto de $35 y el patrimonio del grupo seguia en $500, sin un solo apunte.
 * Era un texto en un acta.
 *
 * Ahora un gasto aprobado sale de lo que el grupo gano ANTES de repartir, y una
 * multa la debe la socia hasta que la paga: le aparece en lo que tiene que
 * llevar a la reunion, y solo cuando la tesoreria confirma el cobro entra a la
 * caja y se reparte entre todas.
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoyStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const acciones = (email, grupo, cantidad, fecha) => fake.ensureSheet('Acciones').grid.push([
  email, grupo, fecha, cantidad, 10, 2, new Date().toISOString(),
  'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(),
  `acc_${Math.random().toString(36).slice(2, 8)}`, '',
]);

function prestamo(id, email, grupo, principal, total, inicio, pagos) {
  fake.ensureSheet('Loans').grid.push([
    id, email, grupo, principal, inicio, '', 2, 'aprobado', 6, total,
  ]);
  (pagos || []).forEach(([monto, fecha], i) => fake.ensureSheet('LoanPayments').grid.push([
    `${id}_P${i}`, email, id, monto, fecha, 'cuota', 'approved',
    '', '', '', '', new Date().toISOString(), 'teso@juntago.test', new Date().toISOString(), '',
  ]));
}

module.exports = async function run() {
  const G_SHEETS = require('../governance').SHEETS;
  const { HOJA, CABECERA } = require('../accesos');
  const hoja = require('../hoja');
  const preparar = () => {
    seedWorkbook();
    Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
    fake.seedSheet(HOJA, [CABECERA]);
    hoja.invalidarTodo();
  };

  /** Convoca, abre, propone el movimiento de caja y lo vota a favor. */
  async function hastaElAcuerdo(e, G, cuerpo) {
    const asa = await post('/api/gob/asambleas',
      { groupId: G, titulo: 'Caja', fechaProgramada: hoyStr(), modalidad: 'presencial' },
      e.tokens.presi);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/asistencia`, {
      groupId: G,
      registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
        .map((q) => ({ email: e.users[q].email, estado: 'presente' })),
    }, e.tokens.secre);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/estado`,
      { estado: 'abierta', groupId: G }, e.tokens.presi);
    const prop = await post('/api/gob/caja/proponer',
      { ...cuerpo, groupId: G, asambleaId: asa.body?.asambleaId }, e.tokens.presi);
    for (const q of ['presi', 'teso', 'secre', 'socio1', 'socio2']) {
      await post(`/api/gob/acuerdos/${prop.body?.acuerdoId}/votar`, { groupId: G, voto: 'favor' }, e.tokens[q]);
    }
    hoja.invalidarTodo();
    return prop;
  }

  // ===================================================================
  t.section('CAJ 1. Un gasto sale de lo que el grupo gano');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'GJ1' });
  let G = 'GJ1';
  ['socio1', 'socio2'].forEach((q) => acciones(e.users[q].email, G, 10, '2026-01-05'));
  // Tres prestamos que dejan $20 de interes cada uno: $60 ganados.
  for (let m = 2; m <= 4; m += 1) {
    const mm = String(m).padStart(2, '0');
    prestamo(`LJ_${mm}`, e.users.socio1.email, G, 100, 120, `2026-${mm}-01`, [[120, `2026-${mm}-20`]]);
  }
  hoja.invalidarTodo();

  let rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('el grupo gano $60', rep.body?.ganancia?.total, 60, 0.01);
  t.near('y hay $60 por repartir', rep.body?.ganancia?.porRepartir, 60, 0.01);

  const prop1 = await hastaElAcuerdo(e, G, {
    tipo: 'gasto', importe: 20, concepto: 'pasajes al banco y cuaderno de actas',
  });
  t.status('la directiva propone el gasto', prop1, 201);

  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('mientras no se aplica, no descuenta nada', rep.body?.ganancia?.porRepartir, 60, 0.01);

  const apl1 = await post(`/api/gob/caja/${prop1.body?.movId}/aplicar`,
    { acuerdoId: prop1.body?.acuerdoId }, e.tokens.teso);
  t.status('con el acuerdo aprobado se aplica', apl1, 200);
  hoja.invalidarTodo();

  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('ahora quedan $40 por repartir', rep.body?.ganancia?.porRepartir, 40, 0.01);
  t.near('y el gasto se nombra', rep.body?.ganancia?.gastos, 20, 0.01);
  t.check('el aviso lo explica',
    /gastos que la asamblea aprobo/i.test(rep.body?.ganancia?.aviso || ''),
    rep.body?.ganancia?.aviso);
  t.near('el reparto que se ofrece son $40', rep.body?.repartido, 40, 0.01);

  const dosVeces = await post(`/api/gob/caja/${prop1.body?.movId}/aplicar`,
    { acuerdoId: prop1.body?.acuerdoId }, e.tokens.teso);
  t.status('el mismo gasto no se aplica dos veces', dosVeces, 409);
  hoja.invalidarTodo();
  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('y no se descuenta dos veces', rep.body?.ganancia?.porRepartir, 40, 0.01);

  // ===================================================================
  t.section('CAJ 2. Sin acuerdo aprobado no se gasta nada');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GJ2' });
  G = 'GJ2';
  ['socio1', 'socio2'].forEach((q) => acciones(e.users[q].email, G, 10, '2026-01-05'));
  prestamo('LJ_X', e.users.socio1.email, G, 100, 120, '2026-02-01', [[120, '2026-03-20']]);
  hoja.invalidarTodo();

  const asa2 = await post('/api/gob/asambleas',
    { groupId: G, titulo: 'X', fechaProgramada: hoyStr(), modalidad: 'presencial' }, e.tokens.presi);
  const sinConcepto = await post('/api/gob/caja/proponer',
    { groupId: G, tipo: 'gasto', importe: 10, concepto: 'x', asambleaId: asa2.body?.asambleaId },
    e.tokens.presi);
  t.status('sin decir en que se gasta, no pasa', sinConcepto, 400);
  t.eq('con su motivo', sinConcepto.body?.motivo, 'falta_concepto');

  const deSocia = await post('/api/gob/caja/proponer', {
    groupId: G, tipo: 'gasto', importe: 10, concepto: 'refrigerio de la reunion',
    asambleaId: asa2.body?.asambleaId,
  }, e.tokens.socio1);
  t.status('una socia rasa no propone gastos', deSocia, 403);

  const prop2 = await post('/api/gob/caja/proponer', {
    groupId: G, tipo: 'gasto', importe: 10, concepto: 'refrigerio de la reunion',
    asambleaId: asa2.body?.asambleaId,
  }, e.tokens.presi);
  t.status('la presidencia si', prop2, 201);
  const sinVotar = await post(`/api/gob/caja/${prop2.body?.movId}/aplicar`,
    { acuerdoId: prop2.body?.acuerdoId }, e.tokens.presi);
  t.status('pero sin votarlo no se aplica', sinVotar, 409);
  hoja.invalidarTodo();
  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('el dinero del grupo no se ha movido', rep.body?.ganancia?.porRepartir, 20, 0.01);

  // ===================================================================
  t.section('CAJ 3. La multa la debe la socia hasta que la paga');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GJ3' });
  G = 'GJ3';
  ['socio1', 'socio2'].forEach((q) => acciones(e.users[q].email, G, 10, '2026-01-05'));
  prestamo('LJ_M', e.users.socio2.email, G, 100, 120, '2026-02-01', [[120, '2026-03-20']]);
  hoja.invalidarTodo();

  const prop3 = await hastaElAcuerdo(e, G, {
    tipo: 'multa', importe: 5, email: e.users.socio1.email,
    concepto: 'falto a la asamblea de marzo sin avisar',
  });
  t.status('se propone la multa', prop3, 201);
  await post(`/api/gob/caja/${prop3.body?.movId}/aplicar`,
    { acuerdoId: prop3.body?.acuerdoId }, e.tokens.teso);
  hoja.invalidarTodo();

  let comp = await get(`/api/gob/mi-compromiso?groupId=${G}`, e.tokens.socio1);
  t.eq('a la socia le aparece la multa', comp.body?.multas?.pendientes, 1);
  t.near('por su importe', comp.body?.multas?.total, 5, 0.01);
  t.near('y suma a lo que tiene que llevar', comp.body?.total, 5, 0.01);
  t.check('nombrada en la frase',
    /multa/i.test(comp.body?.mensaje || ''), comp.body?.mensaje);

  const deOtra = await get(`/api/gob/mi-compromiso?groupId=${G}`, e.tokens.socio2);
  t.eq('a la que no tiene multa no le aparece', deOtra.body?.multas?.pendientes, 0);

  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('mientras no la pague, no entra a la caja', rep.body?.ganancia?.multasCobradas, 0, 0.001);
  t.near('pero se sabe que esta pendiente', rep.body?.ganancia?.multasPendientes, 5, 0.01);
  t.near('y hay $20 por repartir, no $25', rep.body?.ganancia?.porRepartir, 20, 0.01);

  // ===================================================================
  t.section('CAJ 4. Cobrada la multa, entra a la caja y se reparte');
  // ===================================================================
  const suPropia = await post(`/api/gob/caja/${prop3.body?.movId}/cobrar`, {}, e.tokens.socio1);
  t.check('la socia no firma que pago su propia multa',
    [403, 404].includes(suPropia.status), `HTTP ${suPropia.status}`);

  const cobro = await post(`/api/gob/caja/${prop3.body?.movId}/cobrar`, {}, e.tokens.teso);
  t.status('la tesoreria confirma el cobro', cobro, 200);
  hoja.invalidarTodo();

  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('ahora si entra a la caja', rep.body?.ganancia?.multasCobradas, 5, 0.01);
  t.near('y hay $25 por repartir', rep.body?.ganancia?.porRepartir, 25, 0.01);
  t.check('el aviso lo explica',
    /multas cobradas/i.test(rep.body?.ganancia?.aviso || ''), rep.body?.ganancia?.aviso);

  comp = await get(`/api/gob/mi-compromiso?groupId=${G}`, e.tokens.socio1);
  t.eq('y a la socia ya no le aparece', comp.body?.multas?.pendientes, 0);
  t.near('ni le suma nada', comp.body?.total, 0, 0.01);

  const yaCobrada = await post(`/api/gob/caja/${prop3.body?.movId}/cobrar`, {}, e.tokens.teso);
  t.status('no se cobra dos veces', yaCobrada, 409);

  // ===================================================================
  t.section('CAJ 5. Los gastos del grupo los puede mirar cualquier socia');
  // ===================================================================
  const cajaSocia = await get(`/api/gob/caja?groupId=${G}`, e.tokens.socio2);
  t.status('una socia consulta en que se gasta el dinero de todas', cajaSocia, 200);
  t.eq('y ve el movimiento', (cajaSocia.body?.movimientos || []).length, 1);
  t.near('con su importe', cajaSocia.body?.resumen?.multasCobradas, 5, 0.01);

  const fuera = await get(`/api/gob/caja?groupId=${G}`, e.tokens.ajeno);
  t.check('quien no es del grupo no', [403, 404].includes(fuera.status), `HTTP ${fuera.status}`);

  // ===================================================================
  t.section('CAJ 6. No se gasta mas de lo que el grupo tiene ganado');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GJ6' });
  G = 'GJ6';
  ['socio1', 'socio2'].forEach((q) => acciones(e.users[q].email, G, 10, '2026-01-05'));
  prestamo('LJ_6', e.users.socio1.email, G, 100, 120, '2026-02-01', [[120, '2026-03-20']]);
  hoja.invalidarTodo();

  const prop6 = await hastaElAcuerdo(e, G, {
    tipo: 'gasto', importe: 200, concepto: 'compra de sillas para el local',
  });
  await post(`/api/gob/caja/${prop6.body?.movId}/aplicar`,
    { acuerdoId: prop6.body?.acuerdoId }, e.tokens.teso);
  hoja.invalidarTodo();

  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('gastar mas de lo ganado deja el reparto en cero, no en negativo',
    rep.body?.ganancia?.porRepartir, 0, 0.001);
  t.near('y a nadie se le cobra nada', rep.body?.repartido, 0, 0.001);
  t.near('el gasto queda anotado entero', rep.body?.ganancia?.gastos, 200, 0.01);

  const cierre = await post('/api/gob/utilidades/cierre', { groupId: G }, e.tokens.presi);
  t.status('y no se puede cerrar un reparto que no existe', cierre, 409);

  // ===================================================================
  t.section('CAJ 7. Un aporte registrado es dinero, no una fila decorativa');
  // ===================================================================
  // `agregar-aporte` escribia en una pestaña `Aportes` que NO sumaba al
  // patrimonio, no daba cupo, no entraba al reparto y no salia en la libreta de
  // nadie. La tesorera creia haber guardado el dinero de la reunion y no habia
  // nada. Ahora va al libro de verdad.
  preparar();
  e = await baseScenario({ groupId: 'GJ7' });
  G = 'GJ7';
  hoja.invalidarTodo();

  const patrimonioAntes = Number(((await get(
    `/api/gob/tablero?groupId=${G}`, e.tokens.presi)).body?.aportes || {}).patrimonio || 0);

  const puesto = await post('/api/agregar-aporte', {
    GroupID: G, Email: e.users.socio1.email, Monto: 40, Fecha: hoyStr(),
  }, e.tokens.teso);
  t.statusIn('la tesoreria registra el aporte de una socia', puesto, [200, 201]);
  hoja.invalidarTodo();

  // El grupo exige confirmacion por defecto, asi que nace pendiente: todavia no
  // suma, pero YA ESTA en el libro donde se puede confirmar.
  t.eq('nace pendiente, como cualquier aporte declarado', puesto.body?.estado, 'pendiente');
  t.check('y se explica que aun no suma',
    /no suma al patrimonio/i.test(puesto.body?.message || ''), puesto.body?.message);

  const enLaHoja = fake.ensureSheet('Savings').grid
    .filter((r) => (r[1] || '') === G && (r[0] || '') === e.users.socio1.email);
  t.eq('la fila se escribio en Savings, no en la pestaña muerta', enLaHoja.length, 1);
  t.eq('la pestaña vieja no se toca',
    fake.ensureSheet('Aportes').grid.filter((r) => (r[0] || '') === G).length, 0);

  const pendiente = await get(`/api/gob/tablero?groupId=${G}`, e.tokens.presi);
  t.near('mientras esta pendiente no suma al patrimonio',
    pendiente.body?.aportes?.patrimonio, patrimonioAntes, 0.01);
  t.near('pero se ve como pendiente', pendiente.body?.aportes?.ahorroPendiente, 40, 0.01);

  // La tesoreria lo confirma y AHI SI es dinero del grupo.
  const porRevisar = await get(`/api/gob/aportes-pendientes?groupId=${G}`, e.tokens.teso);
  const movId = (porRevisar.body?.ahorros || [])[0]?.movId;
  t.check('sale en la bandeja de la tesoreria', !!movId, JSON.stringify(porRevisar.body || {}));
  // Y hereda la separacion de funciones: quien lo registro no lo confirma. En
  // la pestaña vieja no habia ningun control -- una sola persona escribia y ya.
  const ellaMisma = await post('/api/gob/aportes/resolver',
    { groupId: G, tipo: 'ahorro', movId, accion: 'confirmar' }, e.tokens.teso);
  t.status('quien lo registro no lo confirma', ellaMisma, 403);

  const resuelto = await post('/api/gob/aportes/resolver',
    { groupId: G, tipo: 'ahorro', movId, accion: 'confirmar' }, e.tokens.presi);
  t.status('otra persona de la junta si', resuelto, 200);
  hoja.invalidarTodo();

  const confirmado = await get(`/api/gob/tablero?groupId=${G}`, e.tokens.presi);
  t.near('confirmado, entra al patrimonio del grupo',
    confirmado.body?.aportes?.patrimonio, patrimonioAntes + 40, 0.01);

  // Y a la socia le cuenta: sale en su libreta y le da cupo de credito.
  const suLibreta = await get(
    `/api/obtener-ahorros?groupId=${G}&userEmail=${e.users.socio1.email}`, e.tokens.socio1);
  t.check('sale en su libreta',
    (suLibreta.body?.savings || []).some((x) => Number(x.amount) === 40),
    JSON.stringify(suLibreta.body?.savings || []));
  const cupo = await get(`/api/mi-cupo?groupId=${G}`, e.tokens.socio1);
  t.near('y le da cupo de credito: 3 veces su ahorro', cupo.body?.cupoMaximo, 120, 0.01);

  // Registrarlo dos veces no anota el dinero dos veces.
  const repetido = await post('/api/agregar-aporte', {
    GroupID: G, Email: e.users.socio1.email, Monto: 40, Fecha: hoyStr(),
  }, e.tokens.teso);
  t.statusIn('pulsar dos veces no duplica', repetido, [200, 201]);
  t.eq('se reconoce que ya estaba', repetido.body?.yaExistia, true);
  hoja.invalidarTodo();
  t.eq('y sigue habiendo una sola fila',
    fake.ensureSheet('Savings').grid
      .filter((r) => (r[1] || '') === G && (r[0] || '') === e.users.socio1.email).length, 1);

  // Lo que se escribio en la pestaña vieja se sigue viendo, pero marcado. Se
  // lee desde A2, asi que la primera fila es la cabecera.
  fake.seedSheet('Aportes', [['GroupID', 'Email', 'Monto', 'Fecha', 'CreatedAt']]);
  fake.ensureSheet('Aportes').grid.push([G, e.users.socio2.email, 99, '2025-01-10', '2025-01-10']);
  hoja.invalidarTodo();
  const listado = await get(`/api/aportes/${G}`, e.tokens.socio1);
  t.status('los aportes se listan', listado, 200);
  t.eq('uno cuenta al patrimonio', listado.body?.cuentanAlPatrimonio, 1);
  t.eq('y el viejo sale marcado como historico', listado.body?.soloHistoricos, 1);
  const viejo = (listado.body?.aportes || []).find((x) => x.Estado === 'historico');
  t.eq('sin contar como dinero del grupo', viejo?.cuenta, false);
  t.check('y avisando de lo que paso',
    /nunca sumo al patrimonio/i.test(viejo?.aviso || ''), viejo?.aviso);
};
