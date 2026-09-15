/**
 * SUITE 38 - Un año entero del grupo, con todo funcionando a la vez.
 *
 * Cada cosa se probó por separado: la mora, el reparto parcial, los gastos, las
 * multas, la salida de una socia, el aval, el cierre del grupo. Pero un banco
 * comunal no las usa de una en una: en el mismo ciclo hay una socia atrasada a
 * la que se le carga mora, un gasto del grupo, una multa, una asamblea que
 * decide repartir solo una parte, alguien que se va, y al final el cierre.
 *
 * Aquí se corre esa vida entera de corrido, y se comprueba LO QUE TIENE QUE
 * CUADRAR PASE LO QUE PASE:
 *
 *   1. Nadie cobra dos veces lo mismo.
 *   2. El grupo nunca reparte más de lo que ganó.
 *   3. Lo que se retiene vuelve entero, a quien lo generó.
 *   4. Al cerrar, la suma de TODOS los movimientos de dinero del grupo da cero:
 *      todo lo que entró volvió a salir hacia sus dueñas. Ni un centavo
 *      atrapado, ni un centavo inventado.
 *
 * Esa cuarta es la prueba dura. Si cualquier pieza de las de arriba escribe una
 * fila de más o de menos, el cero no sale.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();
const cent = (x) => Math.round(Number(x || 0) * 100) / 100;

/** Meses hacia atrás, siempre día 1. */
function haceMeses(n) {
  const d = new Date();
  const total = (d.getFullYear() * 12) + d.getMonth() - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

const ahorro = (email, grupo, monto, fecha) => fake.ensureSheet('Savings').grid.push([
  email, grupo, monto, fecha, 'mensual', 'aporte', 'confirmado',
  'a@a.test', 'b@b.test', new Date().toISOString(),
  `sav_${Math.random().toString(36).slice(2, 9)}`, '',
]);

const acciones = (email, grupo, cantidad, fecha) => fake.ensureSheet('Acciones').grid.push([
  email, grupo, fecha, cantidad, 10, 2, new Date().toISOString(),
  'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(),
  `acc_${Math.random().toString(36).slice(2, 9)}`, '',
]);

function prestamo(id, email, grupo, principal, total, inicio, plazo, pagos) {
  fake.ensureSheet('Loans').grid.push([
    id, email, grupo, principal, inicio, '', 2, 'aprobado', plazo, total,
  ]);
  (pagos || []).forEach(([monto, fecha], i) => fake.ensureSheet('LoanPayments').grid.push([
    `${id}_P${i}`, email, id, monto, fecha, 'cuota', 'approved',
    '', '', '', '', new Date().toISOString(), 'teso@juntago.test', new Date().toISOString(), '',
  ]));
}

/** La suma de TODO el dinero anotado en Savings para el grupo. */
const saldoSavings = (grupo) => cent(fake.ensureSheet('Savings').grid
  .filter((r) => (r[1] || '') === grupo)
  .reduce((a, r) => a + Number(r[2] || 0), 0));

/** Las unidades de acción que quedan en pie en el grupo. */
const saldoAcciones = (grupo) => cent(fake.ensureSheet('Acciones').grid
  .filter((r) => (r[1] || '') === grupo)
  .reduce((a, r) => a + Number(r[3] || 0), 0));

/** Lo que el grupo lleva abonado como utilidades. */
const utilidadesAbonadas = (grupo) => cent(fake.ensureSheet('Savings').grid
  .filter((r) => (r[1] || '') === grupo && (r[4] || '') === 'utilidad')
  .reduce((a, r) => a + Number(r[2] || 0), 0));

module.exports = async function run() {
  const G_SHEETS = require('../governance').SHEETS;
  const { HOJA, CABECERA } = require('../accesos');
  const hoja = require('../hoja');

  seedWorkbook();
  Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  fake.seedSheet(HOJA, [CABECERA]);
  hoja.invalidarTodo();

  const G = 'GANO';
  const e = await baseScenario({ groupId: G });
  const quien = {
    A: e.users.socio1.email,
    B: e.users.socio2.email,
    C: e.users.secre.email,
    D: e.users.presi.email,
    E: e.users.teso.email,
  };

  /** Abre una asamblea con todas presentes y devuelve su identificador. */
  async function asamblea(titulo) {
    const a = await post('/api/gob/asambleas',
      { groupId: G, titulo, fechaProgramada: hoy(), modalidad: 'presencial' }, e.tokens.presi);
    await post(`/api/gob/asambleas/${a.body?.asambleaId}/asistencia`, {
      groupId: G,
      registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
        .map((q) => ({ email: e.users[q].email, estado: 'presente' })),
    }, e.tokens.secre);
    await post(`/api/gob/asambleas/${a.body?.asambleaId}/estado`,
      { estado: 'abierta', groupId: G }, e.tokens.presi);
    return a.body?.asambleaId;
  }

  async function votar(acuerdoId, quienes) {
    for (const q of (quienes || ['presi', 'teso', 'secre', 'socio1', 'socio2'])) {
      await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { groupId: G, voto: 'favor' }, e.tokens[q]);
    }
    hoja.invalidarTodo();
  }

  const reparto = async () => (await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi)).body;

  // ===================================================================
  t.section('ANO 1. Seis meses de aportes, acciones y dos prestamos');
  // ===================================================================
  await post('/api/gob/reglas', {
    groupId: G, aporteMinimo: 20, accionesMinimasPorMes: 1, diaDeAsamblea: 15,
    moraPorcentajeMensual: 2, diasDeGracia: 0,
  }, e.tokens.presi);

  // Cada socia pone $20 al mes durante seis meses, y una acción de $10.
  for (let m = 6; m >= 1; m -= 1) {
    for (const correo of Object.values(quien)) {
      ahorro(correo, G, 20, haceMeses(m));
      acciones(correo, G, 1, haceMeses(m));
    }
  }
  const capitalPuesto = cent(5 * 6 * 20 + 5 * 6 * 10);   // ahorro + acciones
  hoja.invalidarTodo();

  t.near('el grupo junto $900 entre las cinco', saldoSavings(G) + (saldoAcciones(G) * 10),
    capitalPuesto, 0.01);

  // A: pidio $200, los devolvio puntual -> el grupo gano $24.
  prestamo('LA', quien.A, G, 200, 224, haceMeses(5), 4, [[224, haceMeses(2)]]);
  // B: pidio $300 hace cinco meses a cuatro meses y no ha pagado nada.
  prestamo('LB', quien.B, G, 300, 324, haceMeses(5), 4, []);
  hoja.invalidarTodo();

  let r = await reparto();
  t.near('lo cobrado de intereses son $24', r?.ganancia?.total, 24, 0.01);
  t.near('y queda por cobrar el interes de B', r?.porCobrar?.total, 24, 0.01);

  // ===================================================================
  t.section('ANO 2. A la socia atrasada se le carga la mora');
  // ===================================================================
  const ficha = await get('/api/gob/prestamo/LB', e.tokens.teso);
  const moraDevengada = Number(ficha.body?.prestamo?.mora?.total || 0);
  t.check('B lleva mora devengada', moraDevengada > 0, `${moraDevengada}`);
  t.eq('por cuatro cuotas vencidas', ficha.body?.prestamo?.resumen?.cuotasVencidas, 4);

  const carga = await post('/api/gob/prestamo/LB/mora', {}, e.tokens.teso);
  t.status('la tesoreria la carga', carga, 200);
  hoja.invalidarTodo();

  t.near('su deuda sube exactamente lo devengado',
    Number((fake.ensureSheet('Loans').grid.find((x) => x[0] === 'LB') || [])[10]),
    moraDevengada, 0.02);
  t.near('el total pactado no se toca',
    Number((fake.ensureSheet('Loans').grid.find((x) => x[0] === 'LB') || [])[9]), 324, 0.001);

  r = await reparto();
  t.near('y como B no ha pagado, el grupo sigue habiendo ganado $24',
    r?.ganancia?.total, 24, 0.01);

  // ===================================================================
  t.section('ANO 3. Un gasto del grupo y una multa a una socia');
  // ===================================================================
  const a3 = await asamblea('Ordinaria de gastos');
  const gasto = await post('/api/gob/caja/proponer', {
    groupId: G, tipo: 'gasto', importe: 6,
    concepto: 'pasajes al banco y cuaderno de actas', asambleaId: a3,
  }, e.tokens.presi);
  const multa = await post('/api/gob/caja/proponer', {
    groupId: G, tipo: 'multa', importe: 4, email: quien.B,
    concepto: 'falto a dos asambleas seguidas sin avisar', asambleaId: a3,
  }, e.tokens.presi);
  t.status('se propone el gasto', gasto, 201);
  t.status('y la multa', multa, 201);
  await votar(gasto.body?.acuerdoId);
  await votar(multa.body?.acuerdoId);
  await post(`/api/gob/caja/${gasto.body?.movId}/aplicar`,
    { acuerdoId: gasto.body?.acuerdoId }, e.tokens.teso);
  await post(`/api/gob/caja/${multa.body?.movId}/aplicar`,
    { acuerdoId: multa.body?.acuerdoId }, e.tokens.teso);
  hoja.invalidarTodo();

  r = await reparto();
  t.near('el gasto baja lo repartible', r?.ganancia?.gastos, 6, 0.01);
  t.near('la multa todavia no suma porque no se ha cobrado',
    r?.ganancia?.multasCobradas, 0, 0.001);
  t.near('asi que hay $18 por repartir, no $24', r?.ganancia?.porRepartir, 18, 0.01);

  const compB = await get(`/api/gob/mi-compromiso?groupId=${G}`, e.tokens.socio2);
  t.near('a B le aparece la multa en lo que tiene que llevar',
    compB.body?.multas?.total, 4, 0.01);
  t.check('y tambien su mora',
    Number(compB.body?.prestamos?.mora) > 0, JSON.stringify(compB.body?.prestamos || {}));

  await post(`/api/gob/caja/${multa.body?.movId}/cobrar`, {}, e.tokens.teso);
  hoja.invalidarTodo();
  r = await reparto();
  t.near('cobrada la multa, hay $22 por repartir', r?.ganancia?.porRepartir, 22, 0.01);

  // ===================================================================
  t.section('ANO 4. La asamblea reparte solo la mitad y guarda el resto');
  // ===================================================================
  const antesDeRepartir = utilidadesAbonadas(G);
  const cierre1 = await post('/api/gob/utilidades/cierre',
    { groupId: G, montoARepartir: 10 }, e.tokens.presi);
  t.status('se cierra el periodo repartiendo $10', cierre1, 201);
  t.near('y se guardan $12', cierre1.body?.retenido, 12, 0.01);

  const a4 = await asamblea('Ordinaria de reparto');
  const prop4 = await post(`/api/gob/utilidades/cierre/${cierre1.body?.cierreId}/proponer`,
    { asambleaId: a4 }, e.tokens.presi);
  await votar(prop4.body?.acuerdoId);
  const apl4 = await post(`/api/gob/utilidades/cierre/${cierre1.body?.cierreId}/aplicar`,
    {}, e.tokens.presi);
  t.status('la asamblea lo aprueba y se abona', apl4, 200);
  hoja.invalidarTodo();

  t.near('a las socias les entraron $10, ni un centavo mas',
    utilidadesAbonadas(G) - antesDeRepartir, 10, 0.01);

  r = await reparto();
  t.near('y quedan $12 pendientes', r?.ganancia?.porRepartir, 12, 0.01);
  t.near('marcados como retenidos, no como comprobante tardio',
    r?.ganancia?.retenidoDeAntes, 12, 0.01);

  // ===================================================================
  t.section('ANO 5. Una socia se va, y no se lleva mas de lo suyo');
  // ===================================================================
  const salida = await post('/api/salir-grupo', { groupId: G }, e.tokens.secre);
  t.status('C pide salir', salida, 200);
  hoja.invalidarTodo();

  const calc = await post(`/api/gob/salida/${salida.body?.salidaId}/calcular`, {}, e.tokens.teso);
  t.status('la tesoreria calcula lo suyo', calc, 200);
  // Puso $120 de ahorro y $60 en acciones en seis meses, y ya cobro utilidades
  // en el reparto de la mitad: eso tambien es ahorro suyo y se lo lleva.
  t.check('recupera al menos los $120 que puso de ahorro',
    Number(calc.body?.ahorro) >= 120, `${calc.body?.ahorro}`);
  t.check('y no mas de lo que puso mas lo que cobro',
    Number(calc.body?.ahorro) <= 120 + 3, `${calc.body?.ahorro}`);
  t.near('sus acciones valen $60', calc.body?.accionesValor, 60, 0.01);

  const a5 = await asamblea('Ordinaria de salida');
  const prop5 = await post(`/api/gob/salida/${salida.body?.salidaId}/proponer`,
    { asambleaId: a5 }, e.tokens.presi);
  await votar(prop5.body?.acuerdoId, ['presi', 'teso', 'socio1', 'socio2']);
  const apl5 = await post(`/api/gob/salida/${salida.body?.salidaId}/aplicar`, {}, e.tokens.presi);
  t.status('la asamblea lo aprueba y se le paga', apl5, 200);
  hoja.invalidarTodo();

  const dosVeces = await post(`/api/gob/salida/${salida.body?.salidaId}/aplicar`, {}, e.tokens.presi);
  t.status('pagarle dos veces no pasa', dosVeces, 409);

  const rTrasSalida = await reparto();
  t.near('lo que se le liquido se descuenta de lo que queda por repartir',
    rTrasSalida?.ganancia?.yaLiquidado, Number(apl5.body?.detalle?.utilidades || 0), 0.02);

  // ===================================================================
  t.section('ANO 6. Lo retenido vuelve, y nunca se reparte de mas');
  // ===================================================================
  const ganadoDeVerdad = cent(24 - 6 + 4);   // intereses - gasto + multa cobrada
  const cierre2 = await post('/api/gob/utilidades/cierre', { groupId: G }, e.tokens.presi);
  t.status('se cierra lo que queda', cierre2, 201);
  const a6 = await asamblea('Ordinaria de cierre de periodo');
  const prop6 = await post(`/api/gob/utilidades/cierre/${cierre2.body?.cierreId}/proponer`,
    { asambleaId: a6 }, e.tokens.presi);
  await votar(prop6.body?.acuerdoId, ['presi', 'teso', 'socio1', 'socio2']);
  await post(`/api/gob/utilidades/cierre/${cierre2.body?.cierreId}/aplicar`, {}, e.tokens.presi);
  hoja.invalidarTodo();

  const totalUtilidades = utilidadesAbonadas(G);
  t.check(`el grupo repartio ${totalUtilidades} y gano ${ganadoDeVerdad}: nunca mas de lo ganado`,
    totalUtilidades <= ganadoDeVerdad + 0.02, `${totalUtilidades} > ${ganadoDeVerdad}`);

  r = await reparto();
  t.near('y ya no queda nada pendiente', r?.ganancia?.porRepartir, 0, 0.02);

  // ===================================================================
  t.section('ANO 7. B paga por fin, con su mora, y el grupo lo cuenta');
  // ===================================================================
  const filaB = fake.ensureSheet('Loans').grid.find((x) => x[0] === 'LB') || [];
  const debeB = cent(Number(filaB[9]) + Number(filaB[10]));
  fake.ensureSheet('LoanPayments').grid.push([
    'LB_FIN', quien.B, 'LB', debeB, hoy(), 'cancelacion', 'approved',
    '', '', '', '', new Date().toISOString(), 'teso@juntago.test', new Date().toISOString(), '',
  ]);
  hoja.invalidarTodo();

  r = await reparto();
  t.check('ahora el grupo ha ganado el interes de B y su mora tambien',
    Number(r?.ganancia?.total) > 24, `${r?.ganancia?.total}`);
  t.check('y eso se puede repartir',
    Number(r?.ganancia?.porRepartir) > 0, `${r?.ganancia?.porRepartir}`);

  const cierre3 = await post('/api/gob/utilidades/cierre', { groupId: G }, e.tokens.presi);
  const a7 = await asamblea('Ordinaria final');
  const prop7 = await post(`/api/gob/utilidades/cierre/${cierre3.body?.cierreId}/proponer`,
    { asambleaId: a7 }, e.tokens.presi);
  await votar(prop7.body?.acuerdoId, ['presi', 'teso', 'socio1', 'socio2']);
  await post(`/api/gob/utilidades/cierre/${cierre3.body?.cierreId}/aplicar`, {}, e.tokens.presi);
  hoja.invalidarTodo();

  r = await reparto();
  t.near('repartido todo, no queda nada', r?.ganancia?.porRepartir, 0, 0.02);

  // ===================================================================
  t.section('ANO 8. Se cierra el grupo y la caja queda EXACTAMENTE en cero');
  // ===================================================================
  const bloqueos = await get(`/api/gob/grupo/cierre?groupId=${G}`, e.tokens.presi);
  t.eq('ya no hay nada que impida cerrar', (bloqueos.body?.bloqueos || []).length, 0);

  const cg = await post('/api/gob/grupo/cierre/calcular', { groupId: G }, e.tokens.presi);
  t.status('la presidencia calcula el cierre del grupo', cg, 201);
  t.eq('quedan cuatro socias, porque C ya salio', cg.body?.socias, 4);

  const a8 = await asamblea('Extraordinaria de cierre');
  const prop8 = await post(`/api/gob/grupo/cierre/${cg.body?.cierreId}/proponer`,
    { asambleaId: a8 }, e.tokens.presi);
  await votar(prop8.body?.acuerdoId, ['presi', 'teso', 'socio1', 'socio2']);
  const apl8 = await post(`/api/gob/grupo/cierre/${cg.body?.cierreId}/aplicar`, {}, e.tokens.presi);
  t.status('la asamblea lo aprueba y se paga a todas', apl8, 200);
  hoja.invalidarTodo();

  // LA PRUEBA DURA. Todo lo que entro tiene que haber salido hacia sus duenas:
  // si cualquier pieza de las de arriba escribio una fila de mas o de menos, el
  // cero no sale.
  t.near('la suma de TODO el dinero anotado del grupo da cero', saldoSavings(G), 0, 0.02);
  t.near('y no queda ni una accion en pie', saldoAcciones(G), 0, 0.001);

  const filaGrupo = fake.ensureSheet('Groups').grid.find((x) => (x[0] || '') === G) || [];
  t.eq('el grupo queda cerrado', (filaGrupo[11] || '').toString().toLowerCase(), 'cerrado');

  const enPie = fake.ensureSheet('UserGroupLinks').grid
    .filter((x) => (x[1] || '') === G && (x[4] || '') !== 'retirada');
  t.eq('ninguna socia queda activa', enPie.length, 0);

  // Y el historial completo sigue ahi: es la prueba de todo lo anterior.
  // Treinta aportes sembrados, mas las utilidades abonadas en tres repartos,
  // mas una devolucion por cada socia liquidada. Lo que importa es que NADA se
  // borro al cerrar: siguen estando los treinta aportes originales.
  const filasDelGrupo = fake.ensureSheet('Savings').grid.filter((x) => (x[1] || '') === G);
  t.check('siguen los 30 aportes originales y las devoluciones',
    filasDelGrupo.length >= 35, `${filasDelGrupo.length} filas`);
  t.eq('con los 30 aportes intactos',
    filasDelGrupo.filter((x) => (x[4] || '') === 'mensual').length, 30);
  const suHistorial = await get(
    `/api/obtener-ahorros?groupId=${G}&userEmail=${quien.A}`, e.tokens.socio1);
  t.status('y una socia lo puede seguir consultando', suHistorial, 200);
};
