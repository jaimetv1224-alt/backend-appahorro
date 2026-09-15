/**
 * SUITE 15 - Auditoria adversarial de lo recien implementado.
 *
 * No comprueba que funcione el camino feliz: eso ya lo hacen las otras
 * baterias. Aqui se busca ROMPERLO. Cada seccion ataca una forma concreta de
 * que el dinero se pierda, se duplique o se cuente mal:
 *
 *   - repartir varias veces seguidas y ver si la suma se conserva
 *   - fechas y husos horarios en el cuadro de cuotas
 *   - lo que pasa si alguien entra o sale del grupo a mitad de un cierre
 *   - importes minusculos, enormes, con muchos decimales
 *   - dos operaciones a la vez sobre el mismo cierre
 */

const { repartirUtilidades, gananciaDelGrupo, interesCobrado } = require('../reparto');
const { cuadroDeCuotas } = require('../cuotas');
const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const cent = (n) => Math.round((Number(n) || 0) * 100) / 100;

function haceMeses(n) {
  const d = new Date();
  d.setDate(10);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
}

/** Suma de lo repartido, para comprobar que no se pierde nada. */
const sumaUtil = (r) => cent((r.reparto || []).reduce((s, x) => s + Number(x.utilidad), 0));

module.exports = async function run() {
  // ===================================================================
  t.section('ADV 1. La suma se conserva, se reparta como se reparta');
  // ===================================================================
  // Se prueban muchas combinaciones feas de golpe: si en alguna la suma no
  // cuadra con lo que habia que repartir, es que se pierde o se inventa dinero.
  const importes = [0.01, 0.02, 0.03, 0.07, 0.99, 1, 1.01, 3.33, 10, 99.99, 100,
    1234.56, 0.05, 7, 13.13];
  const grupos = [
    [100],
    [100, 100],
    [100, 100, 100],
    [1, 1, 1, 1, 1, 1, 1],
    [999, 1],
    [50, 30, 20],
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    [0.01, 0.01, 0.01],
    [1000000, 1],
  ];
  let descuadres = 0;
  let negativos = 0;
  let combinaciones = 0;
  for (const importe of importes) {
    for (const partes of grupos) {
      for (const base of ['acciones', 'ahorros', 'ambos']) {
        combinaciones += 1;
        const gente = partes.map((p, i) => ({
          email: `p${i}@x.test`,
          acciones: base === 'ahorros' ? 0 : p,
          ahorro: base === 'acciones' ? 0 : p,
        }));
        const r = repartirUtilidades(importe, gente, base);
        if (Math.abs(sumaUtil(r) - r.repartido) > 0.001) descuadres += 1;
        if (Math.abs(r.repartido + r.sinRepartir - cent(importe)) > 0.001) descuadres += 1;
        if ((r.reparto || []).some((x) => Number(x.utilidad) < 0)) negativos += 1;
      }
    }
  }
  t.eq(`${combinaciones} combinaciones y ninguna descuadra`, descuadres, 0);
  t.eq('ninguna produce una utilidad negativa', negativos, 0);

  // ===================================================================
  t.section('ADV 2. Repartir muchas veces seguidas no pierde centavos');
  // ===================================================================
  // Se reparte 24 veces un importe con decimales feos entre 7 socios. Al final,
  // lo entregado en total tiene que ser exactamente 24 veces el importe.
  const siete = Array.from({ length: 7 }, (_, i) => ({
    email: `s${i}@x.test`, acciones: [13, 7, 31, 5, 19, 3, 22][i],
  }));
  const acumulado = {};
  const PORPERIODO = 10.07;
  for (let mes = 0; mes < 24; mes += 1) {
    const r = repartirUtilidades(PORPERIODO, siete, 'acciones');
    r.reparto.forEach((x) => { acumulado[x.email] = cent((acumulado[x.email] || 0) + x.utilidad); });
  }
  const totalEntregado = cent(Object.values(acumulado).reduce((s, v) => s + v, 0));
  t.near('tras 24 repartos, lo entregado son 24 x $10,07 = $241,68',
    totalEntregado, cent(PORPERIODO * 24), 0.001);
  t.check('nadie se quedo en cero teniendo acciones',
    Object.values(acumulado).every((v) => v > 0), JSON.stringify(acumulado));

  // ===================================================================
  t.section('ADV 3. Fechas: el cuadro de cuotas y el huso horario');
  // ===================================================================
  // Un prestamo que empieza el ultimo dia de un mes largo
  const c1 = cuadroDeCuotas({ total: 600, term: 6, startDate: '2026-01-31' });
  t.eq('desde el 31 de enero salen 6 cuotas', c1.cuotas.length, 6);
  t.eq('la primera vence el 28 de febrero, no el 3 de marzo', c1.cuotas[0].vence, '2026-02-28');
  t.eq('la segunda el 31 de marzo', c1.cuotas[1].vence, '2026-03-31');
  t.eq('la tercera el 30 de abril', c1.cuotas[2].vence, '2026-04-30');
  t.check('ninguna fecha se repite',
    new Set(c1.cuotas.map((x) => x.vence)).size === 6,
    JSON.stringify(c1.cuotas.map((x) => x.vence)));

  // Ano bisiesto
  const c2 = cuadroDeCuotas({ total: 200, term: 2, startDate: '2028-01-31' });
  t.eq('en ano bisiesto, el 29 de febrero', c2.cuotas[0].vence, '2028-02-29');

  // La cuota que vence HOY no puede contar como vencida
  const hoyLocal = (() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const haceUnMesLocal = (() => {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const c3 = cuadroDeCuotas({ total: 300, term: 3, startDate: haceUnMesLocal });
  const laDeHoy = c3.cuotas.find((x) => x.vence === hoyLocal);
  t.check('existe una cuota que vence justo hoy', !!laDeHoy,
    JSON.stringify(c3.cuotas.map((x) => x.vence)) + ` hoy=${hoyLocal}`);
  if (laDeHoy) {
    t.check('y no se marca como vencida antes de tiempo',
      laDeHoy.estado !== 'vencida',
      `estado: ${laDeHoy.estado} (vence ${laDeHoy.vence}, hoy ${hoyLocal})`);
  }

  // ===================================================================
  t.section('ADV 4. Importes extremos no rompen el cuadro de cuotas');
  // ===================================================================
  const c4 = cuadroDeCuotas({ total: 0.03, term: 3, startDate: haceMeses(1) });
  t.near('tres centavos en tres cuotas siguen siendo tres centavos',
    c4.cuotas.reduce((s, x) => s + x.importe, 0), 0.03, 0.001);
  const c5 = cuadroDeCuotas({ total: 1000000, term: 120, startDate: haceMeses(1) });
  t.eq('un prestamo a 120 meses da 120 cuotas', c5.cuotas.length, 120);
  t.near('y la suma sigue siendo el total exacto',
    c5.cuotas.reduce((s, x) => s + x.importe, 0), 1000000, 0.001);
  const c6 = cuadroDeCuotas({ total: 100, term: 1, startDate: haceMeses(2) });
  t.eq('un solo mes da una sola cuota', c6.cuotas.length, 1);
  t.near('por el total', c6.cuotas[0].importe, 100, 0.001);

  // Pagos en desorden: el mas nuevo primero
  const c7 = cuadroDeCuotas(
    { total: 300, term: 3, startDate: haceMeses(3) },
    [{ fecha: haceMeses(0), monto: 100 }, { fecha: haceMeses(2), monto: 100 }],
  );
  t.eq('los pagos se ordenan por fecha aunque lleguen al reves',
    c7.cuotas[0].cubiertaEl, haceMeses(2));
  t.eq('y quedan 2 cuotas pagadas', c7.resumen.cuotasPagadas, 2);

  // ===================================================================
  t.section('ADV 5. El cierre no puede repartir mas de lo ganado');
  // ===================================================================
  seedWorkbook();
  const e = await baseScenario({ groupId: 'GA1' });
  const gente3 = [e.users.presi, e.users.teso, e.users.socio1];
  [30, 30, 40].forEach((n, i) => {
    fake.ensureSheet('Acciones').grid.push([
      gente3[i].email, 'GA1', haceMeses(4), n, 10, 2, new Date().toISOString(),
      'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), `acc_a${i}`, '',
    ]);
  });
  // Prestamo de $1.000 al 2% a 10 meses -> total $1.200, interes $200.
  // Pagado a medias ($600) -> el grupo ha ganado $100.
  fake.ensureSheet('Loans').grid.push([
    'LN_A', e.users.socio1.email, 'GA1', 1000, haceMeses(8),
    new Date().toISOString(), 2, 'aprobado', 10, 1200,
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_A', e.users.socio1.email, 'LN_A', 600, haceMeses(2), 'mitad', 'approved',
    '', '', '', '', new Date().toISOString(), e.users.teso.email, new Date().toISOString(), '',
  ]);

  const r1 = await get('/api/gob/utilidades/reparto?groupId=GA1', e.tokens.presi);
  t.near('el grupo ha ganado $100, la mitad del interes', r1.body?.ganancia?.total, 100, 0.01);
  t.near('y eso es lo que hay por repartir', r1.body?.ganancia?.porRepartir, 100, 0.01);
  t.near('el reparto entrega exactamente esos $100', r1.body?.repartido, 100, 0.001);

  // --- Primer cierre ---
  const c = await post('/api/gob/utilidades/cierre', { groupId: 'GA1' }, e.tokens.presi);
  t.status('se crea el cierre', c, 201);
  const id1 = c.body?.cierreId;

  const asa = await post('/api/gob/asambleas', {
    groupId: 'GA1', titulo: 'Cierre 1', fechaProgramada: '2026-09-10', modalidad: 'presencial',
  }, e.tokens.presi);
  await post(`/api/gob/asambleas/${asa.body?.asambleaId}/asistencia`, {
    registros: gente3.map((u) => ({ email: u.email, estado: 'presente' })),
  }, e.tokens.presi);
  await post(`/api/gob/asambleas/${asa.body?.asambleaId}/estado`, { estado: 'abierta' }, e.tokens.presi);
  const p1 = await post(`/api/gob/utilidades/cierre/${id1}/proponer`,
    { asambleaId: asa.body?.asambleaId }, e.tokens.presi);
  for (const [u, tok] of [[e.users.presi, e.tokens.presi], [e.users.teso, e.tokens.teso], [e.users.socio1, e.tokens.socio1]]) {
    await post(`/api/gob/acuerdos/${p1.body?.acuerdoId}/votar`, { voto: 'favor' }, tok);
  }
  const ap1 = await post(`/api/gob/utilidades/cierre/${id1}/aplicar`, {}, e.tokens.presi);
  t.status('y se abona', ap1, 200);

  // --- Lo abonado tiene que ser EXACTAMENTE lo ganado ---
  let abonado = 0;
  for (const [u, tok] of [[e.users.presi, e.tokens.presi], [e.users.teso, e.tokens.teso], [e.users.socio1, e.tokens.socio1]]) {
    const d = await get(`/api/savings/complete?email=${u.email}&groupId=GA1`, tok);
    const util = (d.body?.data?.historialAhorros || [])
      .filter((x) => (x.tipo || '') === 'utilidad')
      .reduce((s, x) => s + Number(x.monto || 0), 0);
    abonado = cent(abonado + util);
  }
  t.near('la suma de lo abonado a los socios son los $100 ganados', abonado, 100, 0.01);

  // --- Ya no queda nada ---
  const r2 = await get('/api/gob/utilidades/reparto?groupId=GA1', e.tokens.presi);
  t.near('no queda nada por repartir', r2.body?.ganancia?.porRepartir, 0, 0.01);
  t.near('y lo ya repartido consta', r2.body?.ganancia?.yaRepartido, 100, 0.01);

  // --- Se paga el resto del prestamo: aparece ganancia nueva, no la vieja ---
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_A2', e.users.socio1.email, 'LN_A', 600, haceMeses(0), 'resto', 'approved',
    '', '', '', '', new Date().toISOString(), e.users.teso.email, new Date().toISOString(), '',
  ]);
  const r3 = await get('/api/gob/utilidades/reparto?groupId=GA1', e.tokens.presi);
  t.near('al saldar el prestamo, el grupo ha ganado $200 en total',
    r3.body?.ganancia?.total, 200, 0.01);
  t.near('pero solo quedan $100 por repartir, no $200',
    r3.body?.ganancia?.porRepartir, 100, 0.01);

  const c2b = await post('/api/gob/utilidades/cierre', { groupId: 'GA1' }, e.tokens.presi);
  t.status('se abre el segundo cierre', c2b, 201);
  t.near('por los $100 que faltaban', c2b.body?.ganancia?.porRepartir, 100, 0.01);

  const asa2 = await post('/api/gob/asambleas', {
    groupId: 'GA1', titulo: 'Cierre 2', fechaProgramada: '2026-10-10', modalidad: 'presencial',
  }, e.tokens.presi);
  await post(`/api/gob/asambleas/${asa2.body?.asambleaId}/asistencia`, {
    registros: gente3.map((u) => ({ email: u.email, estado: 'presente' })),
  }, e.tokens.presi);
  await post(`/api/gob/asambleas/${asa2.body?.asambleaId}/estado`, { estado: 'abierta' }, e.tokens.presi);
  const p2 = await post(`/api/gob/utilidades/cierre/${c2b.body?.cierreId}/proponer`,
    { asambleaId: asa2.body?.asambleaId }, e.tokens.presi);
  for (const tok of [e.tokens.presi, e.tokens.teso, e.tokens.socio1]) {
    await post(`/api/gob/acuerdos/${p2.body?.acuerdoId}/votar`, { voto: 'favor' }, tok);
  }
  await post(`/api/gob/utilidades/cierre/${c2b.body?.cierreId}/aplicar`, {}, e.tokens.presi);

  let abonado2 = 0;
  for (const [u, tok] of [[e.users.presi, e.tokens.presi], [e.users.teso, e.tokens.teso], [e.users.socio1, e.tokens.socio1]]) {
    const d = await get(`/api/savings/complete?email=${u.email}&groupId=GA1`, tok);
    const util = (d.body?.data?.historialAhorros || [])
      .filter((x) => (x.tipo || '') === 'utilidad')
      .reduce((s, x) => s + Number(x.monto || 0), 0);
    abonado2 = cent(abonado2 + util);
  }
  t.near('tras los dos cierres se abonaron los $200 exactos, ni un centavo mas',
    abonado2, 200, 0.01);

  const r4 = await get('/api/gob/utilidades/reparto?groupId=GA1', e.tokens.presi);
  t.near('y ya no queda nada pendiente', r4.body?.ganancia?.porRepartir, 0, 0.01);

  // ===================================================================
  t.section('ADV 6. Un cierre que no reparte nada no se puede crear');
  // ===================================================================
  seedWorkbook();
  const e2 = await baseScenario({ groupId: 'GA2' });
  // Hay ganancia, pero NADIE tiene acciones: con base 'acciones' no hay a quien repartir
  fake.ensureSheet('Loans').grid.push([
    'LN_B', e2.users.socio1.email, 'GA2', 200, haceMeses(4),
    new Date().toISOString(), 2, 'aprobado', 4, 216,
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_B', e2.users.socio1.email, 'LN_B', 216, haceMeses(1), 'saldado', 'approved',
    '', '', '', '', new Date().toISOString(), e2.users.teso.email, new Date().toISOString(), '',
  ]);

  const rep = await get('/api/gob/utilidades/reparto?groupId=GA2', e2.tokens.presi);
  t.near('el grupo gano $16', rep.body?.ganancia?.total, 16, 0.01);
  t.near('pero no se reparte nada, porque nadie tiene acciones',
    rep.body?.repartido, 0, 0.001);
  t.near('y los $16 constan como no repartidos', rep.body?.sinRepartir, 16, 0.01);

  const cVacio = await post('/api/gob/utilidades/cierre', { groupId: 'GA2' }, e2.tokens.presi);
  t.status('crear un cierre que no reparte nada se rechaza', cVacio, 409);
  t.check('y se explica que no hay a quien repartir',
    /nadie|capital|repartir/i.test(cVacio.body?.message || ''), cVacio.body?.message);

  const listaVacia = await get('/api/gob/utilidades/cierres?groupId=GA2', e2.tokens.presi);
  t.eq('no queda ningun cierre bloqueando el grupo',
    (listaVacia.body?.cierres || []).length, 0);

  // Con la base cambiada a ahorros SI hay a quien repartir
  await post('/api/gob/reglas', { groupId: 'GA2', baseReparto: 'ahorros' }, e2.tokens.presi);
  fake.ensureSheet('Savings').grid.push([
    e2.users.presi.email, 'GA2', 500, haceMeses(3), 'mensual', 'aporte',
    'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), 'sav_a1', '',
  ]);
  const cAhorro = await post('/api/gob/utilidades/cierre', { groupId: 'GA2' }, e2.tokens.presi);
  t.status('cambiando la base a ahorros ya se puede cerrar', cAhorro, 201);
  t.near('y se reparten los $16', cAhorro.body?.repartido, 16, 0.01);

  // ===================================================================
  t.section('ADV 7. Alguien entra al grupo despues de armar el cierre');
  // ===================================================================
  // El acta se aprueba sobre una foto. Si luego entra alguien nuevo, el abono
  // tiene que seguir la foto aprobada, no la realidad de despues.
  const detalleAntes = await get(
    `/api/gob/utilidades/cierre/${cAhorro.body?.cierreId}`, e2.tokens.presi);
  const conUtilidad = (detalleAntes.body?.filas || []).filter((f) => f.utilidad > 0);
  t.eq('el cierre se guardo con una sola persona con derecho', conUtilidad.length, 1);

  // Entra capital nuevo DESPUES de armar el cierre
  fake.ensureSheet('Savings').grid.push([
    e2.users.socio1.email, 'GA2', 1500, haceMeses(0), 'mensual', 'aporte tardio',
    'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), 'sav_a2', '',
  ]);

  const asa3 = await post('/api/gob/asambleas', {
    groupId: 'GA2', titulo: 'Cierre GA2', fechaProgramada: '2026-09-15', modalidad: 'presencial',
  }, e2.tokens.presi);
  await post(`/api/gob/asambleas/${asa3.body?.asambleaId}/asistencia`, {
    registros: [e2.users.presi, e2.users.teso, e2.users.socio1]
      .map((u) => ({ email: u.email, estado: 'presente' })),
  }, e2.tokens.presi);
  await post(`/api/gob/asambleas/${asa3.body?.asambleaId}/estado`, { estado: 'abierta' }, e2.tokens.presi);
  const p3 = await post(`/api/gob/utilidades/cierre/${cAhorro.body?.cierreId}/proponer`,
    { asambleaId: asa3.body?.asambleaId }, e2.tokens.presi);
  for (const tok of [e2.tokens.presi, e2.tokens.teso, e2.tokens.socio1]) {
    await post(`/api/gob/acuerdos/${p3.body?.acuerdoId}/votar`, { voto: 'favor' }, tok);
  }
  const ap3 = await post(`/api/gob/utilidades/cierre/${cAhorro.body?.cierreId}/aplicar`, {}, e2.tokens.presi);
  t.status('se abona', ap3, 200);
  t.eq('a la unica persona que constaba en el acta', ap3.body?.abonado?.socios, 1);
  t.near('por los $16 aprobados, sin recalcular con el capital nuevo',
    ap3.body?.abonado?.total, 16, 0.01);

  const dSocio = await get(
    `/api/savings/complete?email=${e2.users.socio1.email}&groupId=GA2`, e2.tokens.socio1);
  const utilSocio = (dSocio.body?.data?.historialAhorros || [])
    .filter((x) => (x.tipo || '') === 'utilidad');
  t.eq('quien entro despues no recibe nada de este periodo', utilSocio.length, 0);

  // ===================================================================
  t.section('ADV 8. Dos operaciones a la vez sobre el mismo cierre');
  // ===================================================================
  seedWorkbook();
  const e3 = await baseScenario({ groupId: 'GA3' });
  fake.ensureSheet('Acciones').grid.push([
    e3.users.presi.email, 'GA3', haceMeses(3), 50, 10, 2, new Date().toISOString(),
    'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), 'acc_c1', '',
  ]);
  fake.ensureSheet('Loans').grid.push([
    'LN_C', e3.users.socio1.email, 'GA3', 300, haceMeses(4),
    new Date().toISOString(), 2, 'aprobado', 4, 324,
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_C', e3.users.socio1.email, 'LN_C', 324, haceMeses(1), 'saldado', 'approved',
    '', '', '', '', new Date().toISOString(), e3.users.teso.email, new Date().toISOString(), '',
  ]);

  // Dos peticiones simultaneas de creacion: solo una debe cuajar
  const dobles = await Promise.all([
    post('/api/gob/utilidades/cierre', { groupId: 'GA3' }, e3.tokens.presi),
    post('/api/gob/utilidades/cierre', { groupId: 'GA3' }, e3.tokens.teso),
  ]);
  const creados = dobles.filter((r) => r.status === 201).length;
  t.eq('dos cierres a la vez: solo uno cuaja', creados, 1);
  const listaGA3 = await get('/api/gob/utilidades/cierres?groupId=GA3', e3.tokens.presi);
  t.eq('y solo queda un cierre en el grupo', (listaGA3.body?.cierres || []).length, 1);

  const idGA3 = (listaGA3.body?.cierres || [])[0]?.cierreId;
  const asa4 = await post('/api/gob/asambleas', {
    groupId: 'GA3', titulo: 'Cierre GA3', fechaProgramada: '2026-09-20', modalidad: 'presencial',
  }, e3.tokens.presi);
  await post(`/api/gob/asambleas/${asa4.body?.asambleaId}/asistencia`, {
    registros: [e3.users.presi, e3.users.teso, e3.users.socio1]
      .map((u) => ({ email: u.email, estado: 'presente' })),
  }, e3.tokens.presi);
  await post(`/api/gob/asambleas/${asa4.body?.asambleaId}/estado`, { estado: 'abierta' }, e3.tokens.presi);
  const p4 = await post(`/api/gob/utilidades/cierre/${idGA3}/proponer`,
    { asambleaId: asa4.body?.asambleaId }, e3.tokens.presi);
  for (const tok of [e3.tokens.presi, e3.tokens.teso, e3.tokens.socio1]) {
    await post(`/api/gob/acuerdos/${p4.body?.acuerdoId}/votar`, { voto: 'favor' }, tok);
  }

  // Dos abonos simultaneos: solo uno debe abonar
  const dosAbonos = await Promise.all([
    post(`/api/gob/utilidades/cierre/${idGA3}/aplicar`, {}, e3.tokens.presi),
    post(`/api/gob/utilidades/cierre/${idGA3}/aplicar`, {}, e3.tokens.teso),
  ]);
  t.eq('dos abonos a la vez: solo uno prospera',
    dosAbonos.filter((r) => r.status === 200).length, 1);
  t.eq('el otro se rechaza', dosAbonos.filter((r) => r.status === 409).length, 1);

  const dPresi = await get(
    `/api/savings/complete?email=${e3.users.presi.email}&groupId=GA3`, e3.tokens.presi);
  const utilPresi = (dPresi.body?.data?.historialAhorros || [])
    .filter((x) => (x.tipo || '') === 'utilidad');
  t.eq('y el abono aparece UNA sola vez', utilPresi.length, 1);
  t.near('por los $24 de interes cobrado', utilPresi[0]?.monto, 24, 0.01);

  // ===================================================================
  t.section('ADV 9. El abono no descuadra el patrimonio');
  // ===================================================================
  const dFinal = await get(
    `/api/savings/complete?email=${e3.users.presi.email}&groupId=GA3`, e3.tokens.presi);
  const d = dFinal.body?.data || {};
  t.near('patrimonio = ahorros + acciones (la utilidad abonada ya va en el ahorro)',
    d.totalPatrimonio,
    cent(Number(d.totalAhorros) + Number(d.totalAcciones)), 0.01);
  t.check('la proyeccion teorica NO infla el patrimonio',
    Number(d.utilidadesEstimadas || 0) === 0
      || Math.abs(Number(d.totalPatrimonio)
        - cent(Number(d.totalAhorros) + Number(d.totalAcciones))) < 0.005,
    `estimadas: ${d.utilidadesEstimadas}, patrimonio: ${d.totalPatrimonio}`);
  t.check('el abono entro como ahorro confirmado, no como pendiente',
    Number(d.pendientes?.totalAhorros || 0) === 0,
    `pendiente: ${d.pendientes?.totalAhorros}`);
  t.check('y el patrimonio no es negativo', Number(d.totalPatrimonio) >= 0,
    `${d.totalPatrimonio}`);
};
