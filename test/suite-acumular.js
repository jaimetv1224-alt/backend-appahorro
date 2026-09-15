/**
 * SUITE 32 - Repartir todo, una parte, o nada.
 *
 * En un banco comunal no todos los anos se reparte. Habra asambleas en que la
 * mayoria prefiera dejar el dinero dentro para prestar mas el ano siguiente, y
 * otras en que se reparta solo una parte. Hasta ahora no habia forma de decirlo:
 * el cierre repartia todo o daba error.
 *
 * Y habia una puerta falsa. El importe abonado son SIEMPRE los meses abiertos,
 * pero hasta que mes queda cerrado salia del texto del campo `periodo`. Quien
 * escribiera un periodo mas corto pagaba todo y dejaba meses abiertos cuyo
 * interes ya estaba pagado: medido, $720 ganados, $1.200 abonados en dos cierres
 * los dos legitimos, $480 inventados.
 *
 * Lo que se fija aqui: que el dinero retenido no se pierda, que vuelva al
 * siguiente reparto CON EL DERECHO DE CADA SOCIA de aquel momento (quien entre
 * despues no cobra de anos en los que no estaba), y que la suma de lo abonado
 * nunca pase de lo ganado.
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

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

/** Lo que la hoja `Savings` tiene abonado como utilidad en el grupo. */
const abonado = (grupo) => Math.round(fake.ensureSheet('Savings').grid
  .filter((r) => (r[1] || '') === grupo && (r[4] || '') === 'utilidad')
  .reduce((acc, r) => acc + Number(r[2] || 0), 0) * 100) / 100;

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

  /** Lleva un cierre desde el borrador hasta el abono, pasando por la asamblea. */
  async function hastaElAbono(e, G, cierreId) {
    const asa = await post('/api/gob/asambleas',
      { groupId: G, titulo: 'Reparto', fechaProgramada: '2026-12-15', modalidad: 'presencial' },
      e.tokens.presi);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/asistencia`, {
      groupId: G,
      registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
        .map((q) => ({ email: e.users[q].email, estado: 'presente' })),
    }, e.tokens.secre);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/estado`,
      { estado: 'abierta', groupId: G }, e.tokens.presi);
    const prop = await post(`/api/gob/utilidades/cierre/${cierreId}/proponer`,
      { asambleaId: asa.body?.asambleaId }, e.tokens.presi);
    for (const q of ['presi', 'teso', 'secre', 'socio1', 'socio2']) {
      await post(`/api/gob/acuerdos/${prop.body?.acuerdoId}/votar`, { groupId: G, voto: 'favor' }, e.tokens[q]);
    }
    hoja.invalidarTodo();
    const apl = await post(`/api/gob/utilidades/cierre/${cierreId}/aplicar`, {}, e.tokens.presi);
    hoja.invalidarTodo();
    return { acuerdo: prop, aplicar: apl };
  }

  // ===================================================================
  t.section('ACU 1. Un periodo mas corto que lo que se paga se rechaza');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'GAC1' });
  let G = 'GAC1';
  ['socio1', 'socio2', 'secre', 'presi', 'teso'].forEach(
    (q) => acciones(e.users[q].email, G, 10, '2023-01-05'));
  // Doce prestamos, uno por mes de 2023, cada uno deja $20 de interes.
  for (let m = 1; m <= 12; m += 1) {
    const mm = String(m).padStart(2, '0');
    prestamo(`L23_${mm}`, e.users.socio1.email, G, 100, 120, `2023-${mm}-01`,
      [[120, `2023-${mm}-20`]]);
  }
  // Y otros doce en 2024, con lo mismo.
  for (let m = 1; m <= 12; m += 1) {
    const mm = String(m).padStart(2, '0');
    prestamo(`L24_${mm}`, e.users.socio2.email, G, 100, 120, `2024-${mm}-01`,
      [[120, `2024-${mm}-20`]]);
  }
  hoja.invalidarTodo();

  let rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('el grupo gano $480 en dos anos', rep.body?.ganancia?.total, 480, 0.01);
  t.eq('y el periodo que toca cerrar los cubre', rep.body?.periodoSugerido, '2023-01 a 2024-12');

  const corto = await post('/api/gob/utilidades/cierre',
    { groupId: G, periodo: '2023-01 a 2023-12' }, e.tokens.presi);
  t.status('un periodo que no cubre lo que se paga se rechaza', corto, 400);
  t.eq('con su motivo', corto.body?.motivo, 'periodo_incompleto');
  t.check('y se dice cual es el periodo que si lo cubre',
    (corto.body?.message || '').includes('2023-01 a 2024-12'), corto.body?.message);

  t.eq('no quedo ningun cierre a medias',
    fake.ensureSheet('CierresUtilidades').grid.length - 1, 0);

  // El periodo completo si pasa.
  const largo = await post('/api/gob/utilidades/cierre',
    { groupId: G, periodo: '2023-01 a 2024-12' }, e.tokens.presi);
  t.status('el periodo completo se acepta', largo, 201);

  // ===================================================================
  t.section('ACU 2. Un campo de importe inventado no devuelve "hecho"');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GAC2' });
  G = 'GAC2';
  ['socio1', 'socio2'].forEach((q) => acciones(e.users[q].email, G, 10, '2026-01-05'));
  prestamo('LA2', e.users.socio1.email, G, 100, 120, '2026-02-01', [[120, '2026-03-10']]);
  hoja.invalidarTodo();

  const inventado = await post('/api/gob/utilidades/cierre',
    { groupId: G, monto: 5 }, e.tokens.presi);
  t.status('mandar "monto" no crea un cierre que lo ignore', inventado, 400);
  t.eq('con su motivo', inventado.body?.motivo, 'campo_desconocido');
  t.check('y se dice como se pide de verdad',
    /montoARepartir/.test(inventado.body?.message || ''), inventado.body?.message);

  const negativo = await post('/api/gob/utilidades/cierre',
    { groupId: G, montoARepartir: -3 }, e.tokens.presi);
  t.status('un importe negativo se rechaza', negativo, 400);
  t.eq('con su motivo', negativo.body?.motivo, 'monto_invalido');

  const pasado = await post('/api/gob/utilidades/cierre',
    { groupId: G, montoARepartir: 999 }, e.tokens.presi);
  t.status('repartir mas de lo que hay se rechaza', pasado, 400);
  t.eq('con su motivo', pasado.body?.motivo, 'monto_excede');
  t.near('y se dice cuanto hay', pasado.body?.disponible, 20, 0.01);

  // ===================================================================
  t.section('ACU 3. La asamblea reparte solo una parte y el resto queda');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GAC3' });
  G = 'GAC3';
  ['socio1', 'socio2', 'secre', 'presi', 'teso'].forEach(
    (q) => acciones(e.users[q].email, G, 10, '2026-01-05'));
  for (let m = 2; m <= 7; m += 1) {
    const mm = String(m).padStart(2, '0');
    prestamo(`L3_${mm}`, e.users.socio1.email, G, 100, 120, `2026-${mm}-01`,
      [[120, `2026-${mm}-20`]]);
  }
  hoja.invalidarTodo();

  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('el grupo gano $120', rep.body?.ganancia?.total, 120, 0.01);
  t.near('y los $120 tienen dueno', rep.body?.ganancia?.colocable, 120, 0.01);

  const mitad = await post('/api/gob/utilidades/cierre',
    { groupId: G, montoARepartir: 50 }, e.tokens.presi);
  t.status('la asamblea acuerda repartir $50 de los $120', mitad, 201);
  t.near('el cierre reparte $50', mitad.body?.repartido, 50, 0.01);
  t.near('y guarda $70', mitad.body?.retenido, 70, 0.01);

  const filaCierre = fake.ensureSheet('CierresUtilidades').grid
    .find((r) => (r[0] || '') === mitad.body?.cierreId) || [];
  t.eq('en la hoja queda escrito que se reparte solo una parte', filaCierre[16], 'reparte_parte');
  t.near('con lo que dio el periodo', Number(filaCierre[14]), 120, 0.01);
  t.near('y lo retenido', Number(filaCierre[15]), 70, 0.01);

  // Cada socia puso lo mismo, asi que a cada una le tocan $10 de los $50
  // y se le anota un devengado de $24 (su quinta parte de los $120).
  const detalle = fake.ensureSheet('CierreUtilidadesDetalle').grid
    .filter((r) => (r[0] || '') === mitad.body?.cierreId);
  t.eq('hay una fila por socia', detalle.length, 5);
  t.near('cada una cobra $10', Number(detalle[0][7]), 10, 0.01);
  t.near('y se le anota lo que le tocaba: $24', Number(detalle[0][8]), 24, 0.01);

  const paso3 = await hastaElAbono(e, G, mitad.body?.cierreId);
  t.status('la asamblea lo aprueba y se abona', paso3.aplicar, 200);
  t.near('a la caja de las socias entraron $50', abonado(G), 50, 0.01);

  // ===================================================================
  t.section('ACU 4. Lo retenido vuelve entero al reparto siguiente');
  // ===================================================================
  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('el grupo sigue habiendo ganado $120', rep.body?.ganancia?.total, 120, 0.01);
  t.near('ya repartio $50', rep.body?.ganancia?.yaRepartido, 50, 0.01);
  t.near('y quedan $70 por repartir', rep.body?.ganancia?.porRepartir, 70, 0.01);
  t.near('que son los retenidos, no un comprobante tardio',
    rep.body?.ganancia?.retenidoDeAntes, 70, 0.01);
  t.near('nada viene de un comprobante aprobado tarde',
    rep.body?.ganancia?.deComprobanteTardio, 0, 0.01);
  t.check('y el aviso lo explica',
    /cerro sin repartir del todo/i.test(rep.body?.ganancia?.aviso || ''),
    rep.body?.ganancia?.aviso);
  t.near('el reparto que se ofrece son los $70', rep.body?.repartido, 70, 0.01);

  const resto = await post('/api/gob/utilidades/cierre', { groupId: G }, e.tokens.presi);
  t.status('se cierra el resto', resto, 201);
  await hastaElAbono(e, G, resto.body?.cierreId);
  t.near('el grupo abono en total $120, ni un centavo mas', abonado(G), 120, 0.01);

  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('y ya no queda nada por repartir', rep.body?.ganancia?.porRepartir, 0, 0.01);

  // ===================================================================
  t.section('ACU 5. Lo retenido va a quien lo genero, no a quien llego despues');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GAC5' });
  G = 'GAC5';
  // Solo dos socias tienen capital en 2026.
  acciones(e.users.socio1.email, G, 10, '2026-01-05');
  acciones(e.users.socio2.email, G, 10, '2026-01-05');
  for (let m = 2; m <= 7; m += 1) {
    const mm = String(m).padStart(2, '0');
    prestamo(`L5_${mm}`, e.users.socio1.email, G, 100, 120, `2026-${mm}-01`,
      [[120, `2026-${mm}-20`]]);
  }
  hoja.invalidarTodo();

  const nada = await post('/api/gob/utilidades/cierre',
    { groupId: G, montoARepartir: 0 }, e.tokens.presi);
  t.status('la asamblea acuerda NO repartir este ano', nada, 201);
  t.near('no se reparte nada', nada.body?.repartido, 0, 0.01);
  t.near('y quedan los $120 acumulados', nada.body?.retenido, 120, 0.01);
  const filaNada = fake.ensureSheet('CierresUtilidades').grid
    .find((r) => (r[0] || '') === nada.body?.cierreId) || [];
  t.eq('en la hoja queda la decision', filaNada[16], 'no_reparte');

  const paso5 = await hastaElAbono(e, G, nada.body?.cierreId);
  t.status('la asamblea lo aprueba y el periodo queda cerrado', paso5.aplicar, 200);
  t.eq('sin abonar a nadie', paso5.aplicar.body?.decision, 'no_reparte');
  t.near('la caja de las socias no se movio', abonado(G), 0, 0.01);
  t.check('y se explica que el dinero sigue siendo del grupo',
    /siguen siendo del grupo/i.test(paso5.aplicar.body?.message || ''),
    paso5.aplicar.body?.message);

  // Al ano siguiente entra una socia nueva con MAS capital que las dos viejas.
  acciones(e.users.secre.email, G, 100, '2027-01-05');
  hoja.invalidarTodo();

  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('siguen pendientes los $120', rep.body?.ganancia?.porRepartir, 120, 0.01);
  const toca = (q) => Number((rep.body?.reparto || [])
    .find((x) => x.email === e.users[q].email)?.utilidad || 0);
  t.near('a la socia que si estaba le tocan $60', toca('socio1'), 60, 0.02);
  t.near('a la otra que estaba, otros $60', toca('socio2'), 60, 0.02);
  t.near('y a la que entro despues, nada, aunque tenga cinco veces mas capital',
    toca('secre'), 0, 0.001);

  // ===================================================================
  t.section('ACU 6. Aunque se retenga, nunca se paga mas de lo ganado');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GAC6' });
  G = 'GAC6';
  ['socio1', 'socio2', 'secre'].forEach((q) => acciones(e.users[q].email, G, 10, '2026-01-05'));
  for (let m = 2; m <= 4; m += 1) {
    const mm = String(m).padStart(2, '0');
    prestamo(`L6_${mm}`, e.users.socio1.email, G, 100, 120, `2026-${mm}-01`,
      [[120, `2026-${mm}-20`]]);
  }
  hoja.invalidarTodo();

  // Tres tandas: $10, $0 y el resto. La suma tiene que ser exactamente $60.
  const t1 = await post('/api/gob/utilidades/cierre',
    { groupId: G, montoARepartir: 10 }, e.tokens.presi);
  await hastaElAbono(e, G, t1.body?.cierreId);
  const t2 = await post('/api/gob/utilidades/cierre',
    { groupId: G, montoARepartir: 0 }, e.tokens.presi);
  await hastaElAbono(e, G, t2.body?.cierreId);
  const t3 = await post('/api/gob/utilidades/cierre', { groupId: G }, e.tokens.presi);
  await hastaElAbono(e, G, t3.body?.cierreId);

  t.near('tres tandas y el total abonado es lo ganado: $60', abonado(G), 60, 0.01);
  rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('sin nada pendiente', rep.body?.ganancia?.porRepartir, 0, 0.01);
  t.near('y sin hueco', rep.body?.ganancia?.hueco, 0, 0.01);
};
