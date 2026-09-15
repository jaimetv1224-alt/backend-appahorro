/**
 * SUITE 26 - Cada quien cobra de lo que se gano ESTANDO ella.
 *
 * El reparto miraba la foto de HOY: quien compraba acciones en septiembre
 * cobraba su parte de los intereses de marzo, pagados con el dinero de las
 * demas. Medido en un grupo de prueba: la que entro el ultimo mes se llevaba
 * $40 de $120, lo mismo que las dos que llevaban seis meses.
 *
 * El calculo correcto existia en un modulo (`utilidades.js`) que nadie
 * importaba, y ademas perdia dinero: si un pago venia sin fecha hacia
 * `continue` ANTES de sumar el interes. Un prestamo de $1.000 devuelto por
 * $1.120, con dos pagos de $560 y solo uno fechado, declaraba $60 ganados en
 * vez de $120: la mitad del dinero del grupo se esfumaba por una celda vacia.
 *
 * Aqui se clavan las dos cosas, y ademas:
 *   - que las utilidades ya repartidas no vuelvan a contar como capital,
 *   - que lo ya cobrado se descuente por socia y no solo del total,
 *   - que el dinero ganado en un mes sin capital se declare como no repartido
 *     en vez de decir "ya se repartio todo".
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const R = require('../reparto');
const t = require('./runner');

/** Fecha AAAA-MM-DD de hace N meses, siempre a mitad de mes. */
function haceMeses(n) {
  const d = new Date();
  d.setDate(15);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
}

const mesDe = (f) => f.slice(0, 7);

module.exports = async function run() {
  // ===================================================================
  t.section('REM 1. Ningun pago se pierde por no traer fecha');
  // ===================================================================
  const conFecha = R.gananciaPorMes([{
    principal: 1000, total: 1120, inicio: '2026-01-10',
    pagos: [{ monto: 560, fecha: '2026-03-05' }, { monto: 560, fecha: '2026-04-05' }],
  }]);
  t.near('dos pagos fechados dejan $120 de interes', conFecha.total, 120, 0.001);

  const unaSinFecha = R.gananciaPorMes([{
    principal: 1000, total: 1120, inicio: '2026-01-10',
    pagos: [{ monto: 560, fecha: '2026-03-05' }, { monto: 560, fecha: '' }],
  }]);
  t.near('y si a uno le falta la fecha, siguen siendo $120, no $60',
    unaSinFecha.total, 120, 0.001);
  t.near('el pago sin fecha se imputa al mes del prestamo',
    unaSinFecha.porMes['2026-01'], 60, 0.001);
  t.eq('y queda avisado que uno no traia fecha propia', unaSinFecha.pagosSinFecha, 1);

  const cadena = [
    ['la fecha del pago manda', { monto: 560, fecha: '2026-04-02', creado: '2026-07-01', revisado: '2026-08-01' }, '2026-04'],
    ['si falta, la de registro', { monto: 560, fecha: '', creado: '2026-07-01T10:00:00Z', revisado: '2026-08-01' }, '2026-07'],
    ['si falta, la de aprobacion', { monto: 560, fecha: '', creado: '', revisado: '2026-08-01' }, '2026-08'],
    ['y si no hay ninguna, el mes del prestamo', { monto: 560, fecha: '', creado: '', revisado: '' }, '2026-01'],
  ];
  for (const [nombre, pago, mes] of cadena) {
    const r = R.gananciaPorMes([{ principal: 1000, total: 1120, inicio: '2026-01-10', pagos: [pago] }]);
    t.near(`${nombre}: no se pierde el interes`, r.total, 60, 0.001);
    t.near(`${nombre}: y cae en ${mes}`, r.porMes[mes], 60, 0.001);
  }

  // ===================================================================
  t.section('REM 2. El mes no se corre por la zona horaria');
  // ===================================================================
  // En Ecuador (UTC-5) `new Date('2026-09-30T20:00:00')` cae el 1 de octubre en
  // UTC: un pago del 30 de septiembre contaria como ganancia de octubre y lo
  // cobrarian las que entraron en octubre.
  t.eq('el 30 de septiembre a las 20:00 sigue siendo septiembre',
    R.mesDe('2026-09-30T20:00:00'), '2026-09');
  t.eq('el 1 de enero a las 00:00 sigue siendo enero',
    R.mesDe('2026-01-01T00:00:00'), '2026-01');
  t.eq('una fecha escrita a la espanola tambien se entiende',
    R.mesDe('01/10/2026'), '2026-10');
  t.eq('y una celda vacia no inventa un mes', R.mesDe(''), '');

  // ===================================================================
  t.section('REM 3. Quien entra hoy no cobra lo de antes');
  // ===================================================================
  const prestamos = [{
    principal: 1000, total: 1120, inicio: '2026-01-05',
    pagos: [
      { monto: 280, fecha: '2026-02-10' }, { monto: 280, fecha: '2026-03-10' },
      { monto: 280, fecha: '2026-04-10' }, { monto: 280, fecha: '2026-05-10' },
    ],
  }];
  const socias = [
    { email: 'rosa@x', monto: 500, desde: '2026-01-15' },
    { email: 'luz@x', monto: 500, desde: '2026-01-15' },
    { email: 'nueva@x', monto: 500, desde: '2026-05-02' },
  ];
  const r3 = R.repartoMesAMes({ prestamos, participaciones: socias, base: 'acciones' });

  t.near('el grupo gano $120', r3.ganadoTotal, 120, 0.001);
  t.near('y se reparten los $120 enteros', r3.repartidoTotal, 120, 0.001);
  t.near('nada queda colgado', r3.sinReparto, 0, 0.001);
  t.near('Rosa, que llevaba desde enero, se lleva $55', r3.porMiembro['rosa@x'], 55, 0.001);
  t.near('Luz, igual, otros $55', r3.porMiembro['luz@x'], 55, 0.001);
  t.near('y la que entro en mayo se lleva $10: solo lo de mayo',
    r3.porMiembro['nueva@x'], 10, 0.001);
  t.check('la suma cuadra al centavo',
    Math.abs(Object.values(r3.porMiembro).reduce((a, b) => a + b, 0) - 120) < 0.005,
    JSON.stringify(r3.porMiembro));

  const plano = R.repartirUtilidades(120,
    socias.map((p) => ({ email: p.email, acciones: p.monto })), 'acciones');
  t.near('con el metodo viejo la nueva se llevaba $40',
    plano.reparto.find((x) => x.email === 'nueva@x')?.utilidad, 40, 0.001);
  t.check('es decir, $30 que no le correspondian',
    Math.abs(40 - 10 - 30) < 0.001, 'la diferencia son 30 dolares');

  // ===================================================================
  t.section('REM 4. Los centavos se reparten por mayor resto');
  // ===================================================================
  const casos = [
    ['19 entre 120/30/50/50', 19, [120, 30, 50, 50], [9.12, 2.28, 3.8, 3.8]],
    ['1 entre tres iguales', 1, [10, 10, 10], null],
    ['0,03 entre cuatro', 0.03, [1, 1, 1, 1], null],
  ];
  for (const [nombre, total, pesos, esperado] of casos) {
    const trozos = R.repartirCentavos(total,
      pesos.map((peso, i) => ({ clave: `s${i}`, peso })));
    const dio = [...trozos.values()];
    t.near(`${nombre}: la suma cuadra exactamente`,
      dio.reduce((a, b) => a + b, 0), total, 0.0001);
    if (esperado) {
      t.eq(`${nombre}: y cada quien recibe su cifra`,
        JSON.stringify(dio), JSON.stringify(esperado));
    }
    t.check(`${nombre}: nadie recibe negativo`, dio.every((v) => v >= 0), JSON.stringify(dio));
  }

  // ===================================================================
  t.section('REM 5. Un mes sin capital no se declara repartido');
  // ===================================================================
  const huerfano = R.repartoMesAMes({
    prestamos: [{
      principal: 100, total: 120, inicio: '2026-01-01',
      pagos: [{ monto: 120, fecha: '2026-02-10' }],
    }],
    participaciones: [{ email: 'tardia@x', monto: 100, desde: '2026-06-01' }],
    base: 'acciones',
  });
  t.near('el grupo gano $20', huerfano.ganadoTotal, 20, 0.001);
  t.near('pero no habia a quien repartirlos', huerfano.repartidoTotal, 0, 0.001);
  t.near('y constan enteros como no repartidos', huerfano.sinReparto, 20, 0.001);

  // ===================================================================
  t.section('REM 6. El endpoint reparte mes a mes de verdad');
  // ===================================================================
  seedWorkbook();
  const e = await baseScenario({ groupId: 'GRM' });
  const G = 'GRM';

  /** Compra de acciones YA CONFIRMADA, con su fecha. */
  const acciones = (email, cantidad, fecha) => fake.ensureSheet('Acciones').grid.push([
    email, G, fecha, cantidad, 10, 2, new Date().toISOString(),
    'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(),
    `acc_${Math.random().toString(36).slice(2, 8)}`, '',
  ]);

  // Dos socias entran hace 6 meses; la tercera, el mes pasado
  acciones(e.users.socio1.email, 50, haceMeses(6));   // $500
  acciones(e.users.socio2.email, 50, haceMeses(6));   // $500
  acciones(e.users.secre.email, 50, haceMeses(1));    // $500, recien llegada

  // Un prestamo de $1.000 devuelto por $1.120, pagado en cuatro meses
  fake.ensureSheet('Loans').grid.push([
    'LN_RM', e.users.socio1.email, G, 1000, haceMeses(6),
    new Date().toISOString(), 2, 'aprobado', 6, 1120,
  ]);
  [5, 4, 3, 2].forEach((n, i) => fake.ensureSheet('LoanPayments').grid.push([
    `PAY_RM_${i}`, e.users.socio1.email, 'LN_RM', 280, haceMeses(n), 'cuota',
    'approved', '', '', '', '', new Date().toISOString(),
    e.users.teso.email, new Date().toISOString(), '',
  ]));

  const rep = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.status('el reparto responde', rep, 200);
  t.near('el grupo gano $120', rep.body?.ganancia?.total, 120, 0.02);
  t.check('viene el detalle mes a mes', (rep.body?.porMes || []).length >= 3,
    `meses: ${(rep.body?.porMes || []).length}`);

  const cuota = (correo) => (rep.body?.reparto || [])
    .find((x) => x.email === correo)?.utilidad;
  t.check('las dos antiguas cobran mas que la recien llegada',
    cuota(e.users.socio1.email) > cuota(e.users.secre.email),
    JSON.stringify((rep.body?.reparto || []).map((x) => `${x.email}=${x.utilidad}`)));
  t.near('y las dos antiguas cobran lo mismo entre si',
    cuota(e.users.socio1.email), cuota(e.users.socio2.email), 0.02);
  t.near('la suma repartida es lo que el grupo gano',
    (rep.body?.reparto || []).reduce((s, x) => s + Number(x.utilidad), 0),
    rep.body?.ganancia?.porRepartir, 0.02);
  t.check('el periodo sugerido lleva meses de verdad',
    /^\d{4}-\d{2}( a \d{4}-\d{2})?$/.test(rep.body?.periodoSugerido || ''),
    rep.body?.periodoSugerido);

  // ===================================================================
  t.section('REM 7. Lo ya cobrado se descuenta a QUIEN lo cobro');
  // ===================================================================
  const cierre = await post('/api/gob/utilidades/cierre', { groupId: G }, e.tokens.presi);
  t.status('se crea el cierre', cierre, 201);
  t.check('el periodo del cierre lleva los meses del reparto',
    /^\d{4}-\d{2}/.test(cierre.body?.periodo || cierre.body?.periodoSugerido || ''),
    JSON.stringify(cierre.body?.periodo || cierre.body?.periodoSugerido));

  // Se aplica a mano el cierre en la hoja, como si la asamblea lo hubiera aprobado
  const cierres = fake.ensureSheet('CierresUtilidades');
  const filaCierre = cierres.grid.find((r) => (r[0] || '') === cierre.body?.cierreId);
  if (filaCierre) filaCierre[2] = 'aplicado';

  const tras = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.near('ya no queda nada por repartir', tras.body?.ganancia?.porRepartir, 0, 0.02);
  t.near('y lo repartido antes consta entero',
    tras.body?.ganancia?.yaRepartido, rep.body?.ganancia?.porRepartir, 0.02);
  for (const x of (tras.body?.reparto || [])) {
    t.near(`a ${x.email} no le queda pendiente`, x.utilidad, 0, 0.02);
  }

  const otro = await post('/api/gob/utilidades/cierre', { groupId: G }, e.tokens.presi);
  t.status('y no se puede crear otro cierre sin nueva ganancia', otro, 409);
  t.check('con el motivo correcto: ya se repartio',
    /ya se repartio|ya se repartió/i.test(otro.body?.message || ''), otro.body?.message);

  // ===================================================================
  t.section('REM 8. Las utilidades repartidas no vuelven a contar como capital');
  // ===================================================================
  seedWorkbook();
  const f = await baseScenario({ groupId: 'GRU' });
  await post('/api/gob/reglas', { groupId: 'GRU', baseReparto: 'ahorros' }, f.tokens.presi);

  const ahorro = (email, monto, fecha, tipo) => fake.ensureSheet('Savings').grid.push([
    email, 'GRU', monto, fecha, tipo, 'x', 'confirmado', 'a@a.test', 'b@b.test',
    new Date().toISOString(), `sav_${Math.random().toString(36).slice(2, 8)}`, '',
  ]);
  ahorro(f.users.socio1.email, 500, haceMeses(5), 'mensual');
  ahorro(f.users.socio2.email, 500, haceMeses(5), 'mensual');
  // A la socia1 ya se le abono un reparto anterior, que se guarda como ahorro
  ahorro(f.users.socio1.email, 200, haceMeses(2), 'utilidad');

  fake.ensureSheet('Loans').grid.push([
    'LN_U', f.users.socio1.email, 'GRU', 500, haceMeses(5),
    new Date().toISOString(), 2, 'aprobado', 5, 550,
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_U', f.users.socio1.email, 'LN_U', 550, haceMeses(1), 'saldado',
    'approved', '', '', '', '', new Date().toISOString(),
    f.users.teso.email, new Date().toISOString(), '',
  ]);

  const repU = await get('/api/gob/utilidades/reparto?groupId=GRU&base=ahorros', f.tokens.presi);
  t.status('el reparto por ahorros responde', repU, 200);
  const uno = (repU.body?.reparto || []).find((x) => x.email === f.users.socio1.email);
  const dos = (repU.body?.reparto || []).find((x) => x.email === f.users.socio2.email);
  t.near('las dos pusieron los mismos $500 de capital', uno?.participacion, 500, 0.01);
  t.near('la utilidad abonada no cuenta como capital', dos?.participacion, 500, 0.01);
  t.near('asi que cobran lo mismo', uno?.utilidad, dos?.utilidad, 0.02);

  // ===================================================================
  t.section('REM 9. El freno de la cuota de Google');
  // ===================================================================
  const hoja = require('../hoja');
  const antes = hoja.configurar({});
  try {
    hoja.invalidarTodo();
    hoja.reiniciarEstadisticas();
    hoja.configurar({ ttlMs: 4000, maxPorMinuto: 100000 });

    const g = f.users.socio1.email;
    await get(`/api/savings/complete?email=${g}&groupId=GRU`, f.tokens.socio1);
    const trasPrimera = hoja.estadisticas().lecturas;
    await get(`/api/savings/complete?email=${g}&groupId=GRU`, f.tokens.socio1);
    const trasSegunda = hoja.estadisticas().lecturas;

    t.check('la segunda consulta gasta menos lecturas de hoja que la primera',
      (trasSegunda - trasPrimera) < trasPrimera,
      `primera ${trasPrimera}, segunda ${trasSegunda - trasPrimera}`);
    t.check('y de hecho hubo aciertos de memoria', hoja.estadisticas().aciertos > 0,
      JSON.stringify(hoja.estadisticas()));

    // Una escritura tiene que tirar la memoria: nadie puede ver una cifra vieja
    // despues de registrar un movimiento. Se comprueba con el tablero, que es
    // lo que mira la tesoreria mientras la gente aporta.
    const tbAntes = await get('/api/gob/tablero?groupId=GRU', f.tokens.presi);
    const pendienteAntes = Number(tbAntes.body?.aportes?.ahorroPendiente || 0);
    await post('/api/registrar-ahorros', { groupId: 'GRU', date: haceMeses(0), amount: 77 }, f.tokens.socio1);
    const tbDespues = await get('/api/gob/tablero?groupId=GRU', f.tokens.presi);
    const pendienteDespues = Number(tbDespues.body?.aportes?.ahorroPendiente || 0);
    t.near('tras registrar un aporte, la memoria se tira y la cifra sube',
      pendienteDespues - pendienteAntes, 77, 0.01);

    // Y confirmarlo tambien: la confirmacion escribe, asi que el ahorro
    // confirmado tiene que reflejarlo en la lectura siguiente.
    const bandeja = await get('/api/gob/aportes-pendientes?groupId=GRU', f.tokens.teso);
    const nuevo = (bandeja.body?.ahorros || []).find((a) => a.monto === 77);
    const confAntes = Number(tbDespues.body?.aportes?.ahorroConfirmado || 0);
    await post('/api/gob/aportes/resolver',
      { groupId: 'GRU', tipo: 'ahorro', movId: nuevo?.movId, accion: 'confirmar' }, f.tokens.presi);
    const tbFinal = await get('/api/gob/tablero?groupId=GRU', f.tokens.presi);
    t.near('y al confirmarlo, el ahorro confirmado sube en el acto',
      Number(tbFinal.body?.aportes?.ahorroConfirmado || 0) - confAntes, 77, 0.01);

    // Con el freno muy bajo, la peticion espera en vez de tumbar la cuota
    hoja.configurar({ ttlMs: 0, maxPorMinuto: 2, esperaMaxMs: 300 });
    hoja.invalidarTodo();
    const arranque = Date.now();
    const respuestas = [];
    for (let i = 0; i < 4; i += 1) {
      respuestas.push(await get(`/api/gob/tablero?groupId=GRU`, f.tokens.presi));
    }
    const tardo = Date.now() - arranque;
    // Con la cuota agotada la respuesta es 429 con su explicacion, NO un 500
    // "Error interno": no es un fallo del programa, es que hay que esperar.
    t.check('con la cuota agotada se responde 429, no error interno',
      respuestas.every((r) => r.status === 429),
      JSON.stringify(respuestas.map((r) => r.status)));
    t.eq('con su motivo', respuestas[0]?.body?.motivo, 'cuota_hoja');
    t.check('y un mensaje que se entiende',
      /demasiadas consultas/i.test(respuestas[0]?.body?.message || ''),
      respuestas[0]?.body?.message);
    t.check('se dice cuando reintentar', Number(respuestas[0]?.body?.reintentarEn) > 0,
      JSON.stringify(respuestas[0]?.body));
    t.check('y no se queda colgada indefinidamente', tardo < 20000, `tardo ${tardo} ms`);
  } finally {
    hoja.configurar(antes);
    hoja.invalidarTodo();
  }
};
