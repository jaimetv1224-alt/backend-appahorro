/**
 * SUITE 30 - La socia que se va cobra lo suyo.
 *
 * Antes, salir del grupo borraba la fila del vinculo y nada mas. Medido en una
 * simulacion de un ano de un banco comunal: una socia puso $210, le tocaban
 * $2,78 de utilidades por los meses en que su dinero estuvo puesto, **cobro
 * $0,00**, y sus $210 siguieron sumando en el patrimonio del grupo ($4.300
 * antes de irse y $4.300 despues). El tablero no filtraba por socias activas y
 * el reparto si: las dos cuentas miraban universos distintos.
 *
 * Ahora salir es AVISAR. La tesoreria calcula y congela lo suyo, la asamblea lo
 * aprueba, y solo entonces se le paga y se le da de baja. Lo que hay que fijar
 * aqui es que al final NI ella pierde lo suyo NI el grupo lo paga dos veces.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();

const acciones = (email, grupo, cantidad, valor, fecha) => fake.ensureSheet('Acciones').grid.push([
  email, grupo, fecha, cantidad, valor, 2, new Date().toISOString(),
  'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(),
  `acc_${Math.random().toString(36).slice(2, 8)}`, '',
]);

const ahorro = (email, grupo, monto, fecha) => fake.ensureSheet('Savings').grid.push([
  email, grupo, monto, fecha, 'mensual', 'aporte', 'confirmado',
  'a@a.test', 'b@b.test', new Date().toISOString(),
  `sav_${Math.random().toString(36).slice(2, 8)}`, '',
]);

function prestamo(id, email, grupo, principal, total, inicio, pagos) {
  fake.ensureSheet('Loans').grid.push([
    id, email, grupo, principal, inicio, new Date().toISOString(), 2, 'aprobado', 6, total,
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

  /** Lleva una salida hasta el acuerdo aprobado de la asamblea. */
  async function hastaLaAsamblea(e, G, salidaId, votantes) {
    const asa = await post('/api/gob/asambleas',
      { groupId: G, titulo: 'Salida', fechaProgramada: hoy(), modalidad: 'presencial' }, e.tokens.presi);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/asistencia`, {
      groupId: G,
      registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
        .map((q) => ({ email: e.users[q].email, estado: 'presente' })),
    }, e.tokens.secre);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/estado`,
      { estado: 'abierta', groupId: G }, e.tokens.presi);
    const prop = await post(`/api/gob/salida/${salidaId}/proponer`,
      { asambleaId: asa.body?.asambleaId }, e.tokens.presi);
    for (const q of votantes) {
      await post(`/api/gob/acuerdos/${prop.body?.acuerdoId}/votar`, { groupId: G, voto: 'favor' }, e.tokens[q]);
    }
    return prop;
  }

  const patrimonio = async (e, G) => Number(((await get(
    `/api/gob/tablero?groupId=${G}`, e.tokens.presi)).body?.aportes || {}).patrimonio);
  const cuantasSocias = async (e, G) => {
    const r = await get(`/api/obtener-miembros?groupId=${G}`, e.tokens.presi);
    return (r.body?.miembros || r.body?.members || []).length;
  };

  // ===================================================================
  t.section('SAL 1. Pedir salir no borra a nadie ni mueve la caja');
  // ===================================================================
  preparar();
  const e = await baseScenario({ groupId: 'GSAL' });
  const G = 'GSAL';
  ahorro(e.users.socio1.email, G, 210, '2026-01-10');
  acciones(e.users.socio1.email, G, 10, 10, '2026-01-10');
  ahorro(e.users.socio2.email, G, 300, '2026-01-10');
  hoja.invalidarTodo();

  const antesPat = await patrimonio(e, G);
  t.near('el grupo tiene $610 de patrimonio', antesPat, 610, 0.01);

  const pidio = await post('/api/salir-grupo', { groupId: G }, e.tokens.socio1);
  t.status('la socia pide salir', pidio, 200);
  t.eq('y queda solicitada', pidio.body?.estado, 'solicitada');
  t.check('se le explica que sigue siendo socia hasta que le paguen',
    /sigues siendo socia/i.test(pidio.body?.message || ''), pidio.body?.message);

  hoja.invalidarTodo();
  t.eq('sigue contando como socia', await cuantasSocias(e, G), 5);
  t.near('y la caja del grupo no se ha movido', await patrimonio(e, G), antesPat, 0.01);

  const repetida = await post('/api/salir-grupo', { groupId: G }, e.tokens.socio1);
  t.status('pedirlo dos veces no abre dos liquidaciones', repetida, 200);
  t.eq('devuelve la misma', repetida.body?.salidaId, pidio.body?.salidaId);

  // ===================================================================
  t.section('SAL 2. Con un prestamo vivo no se sale');
  // ===================================================================
  preparar();
  const f = await baseScenario({ groupId: 'GDEU' });
  ahorro(f.users.socio1.email, 'GDEU', 300, '2026-01-10');
  prestamo('LN_D', f.users.socio1.email, 'GDEU', 200, 224, '2026-01-05', [[100, '2026-02-10']]);
  hoja.invalidarTodo();

  const conDeuda = await post('/api/salir-grupo', { groupId: 'GDEU' }, f.tokens.socio1);
  t.status('no se sale debiendo', conDeuda, 409);
  t.eq('y se dice el motivo', conDeuda.body?.codigo, 'PRESTAMO_VIVO');

  // ===================================================================
  t.section('SAL 3. Se le paga lo que la asamblea aprobo, y solo entonces');
  // ===================================================================
  preparar();
  const g = await baseScenario({ groupId: 'GPAG' });
  const P = 'GPAG';
  // Cinco socias con $100 de acciones cada una, y el grupo gana $20 en marzo
  ['presi', 'teso', 'secre', 'socio1', 'socio2']
    .forEach((q) => acciones(g.users[q].email, P, 10, 10, '2026-01-10'));
  prestamo('LN_P', g.users.socio1.email, P, 100, 120, '2026-01-05', [[120, '2026-03-15']]);
  hoja.invalidarTodo();

  const patInicial = await patrimonio(g, P);
  t.near('el grupo tiene $500 de capital', patInicial, 500, 0.01);
  const repAntes = await get(`/api/gob/utilidades/reparto?groupId=${P}`, g.tokens.presi);
  t.near('y $20 por repartir', repAntes.body?.ganancia?.porRepartir, 20, 0.01);
  const leTocaba = Number((repAntes.body?.reparto || [])
    .find((x) => x.email === g.users.socio2.email)?.utilidad);
  t.near('a la socia que se va le tocan $4', leTocaba, 4, 0.01);

  const s3 = await post('/api/salir-grupo', { groupId: P }, g.tokens.socio2);
  const salidaId = s3.body?.salidaId;

  const sinCalcular = await post(`/api/gob/salida/${salidaId}/aplicar`, {}, g.tokens.presi);
  t.status('sin calcular ni asamblea no se paga nada', sinCalcular, 409);

  const calc = await post(`/api/gob/salida/${salidaId}/calcular`, {}, g.tokens.presi);
  t.status('la tesoreria calcula', calc, 200);
  t.near('sus $100 de capital', calc.body?.accionesValor, 100, 0.01);
  t.near('y sus $4 de utilidades', calc.body?.utilidades, 4, 0.01);
  t.near('total $104', calc.body?.total, 104, 0.01);

  const unSocio = await post(`/api/gob/salida/${salidaId}/calcular`, {}, g.tokens.socio1);
  t.status('un socio raso no calcula liquidaciones', unSocio, 403);

  const sinAcuerdo = await post(`/api/gob/salida/${salidaId}/aplicar`, {}, g.tokens.presi);
  t.status('calculada pero sin asamblea, tampoco se paga', sinAcuerdo, 409);

  await hastaLaAsamblea(g, P, salidaId, ['presi', 'teso', 'secre', 'socio1']);
  const pagada = await post(`/api/gob/salida/${salidaId}/aplicar`, {}, g.tokens.presi);
  t.status('con el acuerdo aprobado, se le paga', pagada, 200);
  t.near('cobra los $104 completos', pagada.body?.pagado, 104, 0.01);

  hoja.invalidarTodo();
  t.eq('deja de contar como socia', await cuantasSocias(g, P), 4);
  t.near('y su capital sale del patrimonio', await patrimonio(g, P), 400, 0.01);

  const suFila = (fake.dumpSheet('UserGroupLinks') || []).slice(1)
    .find((r) => (r[0] || '') === g.users.socio2.email && (r[1] || '') === P);
  t.check('su vinculo se marca, no se borra: el historial es la prueba del proyecto',
    !!suFila, 'se borro la fila del vinculo');
  t.eq('y queda como retirada', (suFila?.[4] || '').toString().toLowerCase(), 'retirada');

  // ===================================================================
  t.section('SAL 4. El grupo no paga dos veces lo mismo');
  // ===================================================================
  // Al salir deja de contar en el reparto, asi que su parte se repartiria entre
  // las demas. Si eso pasara, el grupo pagaria $24 habiendo ganado $20.
  const repTras = await get(`/api/gob/utilidades/reparto?groupId=${P}`, g.tokens.presi);
  t.near('lo que ya se le liquido consta aparte', repTras.body?.ganancia?.yaLiquidado, 4, 0.01);
  t.near('y solo quedan por repartir los $16 de las que se quedan',
    repTras.body?.ganancia?.porRepartir, 16, 0.01);
  const suma = (repTras.body?.reparto || []).reduce((acc, x) => acc + Number(x.utilidad), 0);
  t.near('la suma del reparto son esos $16', suma, 16, 0.02);
  t.near('$4 que cobro ella mas $16 de las demas son los $20 que gano el grupo',
    4 + suma, 20, 0.02);

  // ===================================================================
  t.section('SAL 5. Pagar dos veces no duplica el egreso');
  // ===================================================================
  const otraVez = await post(`/api/gob/salida/${salidaId}/aplicar`, {}, g.tokens.presi);
  t.status('el segundo pago se rechaza', otraVez, 409);
  hoja.invalidarTodo();
  t.near('y el patrimonio sigue en $400', await patrimonio(g, P), 400, 0.01);
  t.eq('con una sola fila de devolucion en la hoja',
    (fake.dumpSheet('Savings') || []).slice(1)
      .filter((r) => (r[4] || '') === 'retiro_salida' && (r[1] || '') === P).length, 1);

  // ===================================================================
  t.section('SAL 6. La retirada ya no gobierna ni aporta');
  // ===================================================================
  hoja.invalidarTodo();
  t.status('no registra ahorros en un grupo del que ya salio',
    await post('/api/registrar-ahorros',
      { groupId: P, date: hoy(), amount: 10 }, g.tokens.socio2), 403);
  t.status('ni ve el panel del grupo',
    await get(`/api/savings/complete?email=${g.users.socio2.email}&groupId=${P}`,
      g.tokens.socio2), 403);
  t.status('ni vuelve a pedir la salida', 
    await post('/api/salir-grupo', { groupId: P }, g.tokens.socio2), 409);
  t.eq('con el motivo de que ya salio',
    (await post('/api/salir-grupo', { groupId: P }, g.tokens.socio2)).body?.codigo, 'YA_RETIRADA');

  // ===================================================================
  t.section('SAL 7. Se paga lo votado, no lo que haya cambiado despues');
  // ===================================================================
  preparar();
  const h = await baseScenario({ groupId: 'GCAM' });
  const C = 'GCAM';
  ahorro(h.users.socio1.email, C, 100, '2026-01-10');
  ahorro(h.users.socio2.email, C, 100, '2026-01-10');
  hoja.invalidarTodo();

  const s6 = await post('/api/salir-grupo', { groupId: C }, h.tokens.socio1);
  await post(`/api/gob/salida/${s6.body?.salidaId}/calcular`, {}, h.tokens.presi);
  await hastaLaAsamblea(h, C, s6.body?.salidaId, ['presi', 'teso', 'secre', 'socio2']);

  // Entre la asamblea y el pago le confirman otro aporte
  ahorro(h.users.socio1.email, C, 50, '2026-02-10');
  hoja.invalidarTodo();

  const cambiada = await post(`/api/gob/salida/${s6.body?.salidaId}/aplicar`, {}, h.tokens.presi);
  t.status('si sus cuentas cambiaron, no se paga a ciegas', cambiada, 409);
  t.eq('con su motivo', cambiada.body?.motivo, 'cuentas_cambiadas');
  t.check('y se dice que hay que volver a calcular y someter',
    /volve|calc/i.test(cambiada.body?.message || ''), cambiada.body?.message);

  // ===================================================================
  t.section('SAL 8. Una salida ya aprobada no se cancela con una firma');
  // ===================================================================
  const descartar = await post(`/api/gob/salida/${s6.body?.salidaId}/descartar`,
    { motivo: 'me arrepenti' }, h.tokens.presi);
  t.status('descartar lo que la asamblea aprobo se rechaza', descartar, 409);
  t.check('y se dice que hay que anular el acuerdo en la asamblea',
    /asamblea/i.test(descartar.body?.message || ''), descartar.body?.message);

  // ===================================================================
  t.section('SAL 9. Antes de pedir la salida se puede ver cuanto se cobraria');
  // ===================================================================
  preparar();
  const k = await baseScenario({ groupId: 'GEST' });
  const D = 'GEST';
  ahorro(k.users.socio1.email, D, 150, '2026-01-10');
  acciones(k.users.socio1.email, D, 5, 10, '2026-01-10');
  ahorro(k.users.socio2.email, D, 200, '2026-01-10');
  hoja.invalidarTodo();

  // Nadie decide nada mirando: la estimacion no abre ninguna liquidacion.
  const est = await get(`/api/gob/salida/estimacion?groupId=${D}`, k.tokens.socio1);
  t.status('la socia consulta que le tocaria si se fuera', est, 200);
  t.near('su ahorro', est.body?.ahorro, 150);
  t.near('el valor de sus acciones', est.body?.accionesValor, 50);
  t.near('y el total, capital mas utilidades', est.body?.total,
    150 + 50 + Number(est.body?.utilidades || 0), 0.02);

  const listado = await get(`/api/gob/salidas?groupId=${D}`, k.tokens.presi);
  t.eq('mirar no abrio ninguna liquidacion', (listado.body?.salidas || []).length, 0);

  const ajena = await get(
    `/api/gob/salida/estimacion?groupId=${D}&email=${encodeURIComponent(k.users.socio2.email)}`,
    k.tokens.socio1);
  t.status('y una socia no calcula la salida de otra', ajena, 403);

};
