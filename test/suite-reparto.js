/**
 * SUITE 14 - Reparto de utilidades: lo que el grupo gana, repartido en
 * proporcion a lo que cada quien puso.
 *
 * El grupo cobra intereses por los prestamos. Ese dinero es del grupo y se
 * reparte entre los socios segun su participacion. Antes el sistema abonaba un
 * porcentaje sobre las acciones sin mirar si ese dinero habia entrado: podia
 * repartir mas de lo que existia.
 *
 * Cada comprobacion lleva la cuenta hecha a mano al lado.
 */

const { repartirUtilidades, gananciaDelGrupo, interesCobrado } = require('../reparto');
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

module.exports = async function run() {
  // ===================================================================
  t.section('REP 1. Cuanto ha ganado el grupo de verdad');
  // ===================================================================
  // $500 al 2% a 5 meses -> total $550, interes $50
  t.near('un prestamo sin pagar todavia no ha dejado nada',
    interesCobrado({ principal: 500, total: 550, pagado: 0 }), 0, 0.001);
  t.near('pagada la mitad ($275), ha dejado la mitad del interes: $25',
    interesCobrado({ principal: 500, total: 550, pagado: 275 }), 25, 0.001);
  t.near('pagado del todo, deja los $50 enteros',
    interesCobrado({ principal: 500, total: 550, pagado: 550 }), 50, 0.001);
  t.near('pagar de mas no inventa interes de mas',
    interesCobrado({ principal: 500, total: 550, pagado: 700 }), 50, 0.001);
  t.near('un prestamo sin interes no deja ganancia',
    interesCobrado({ principal: 500, total: 500, pagado: 500 }), 0, 0.001);

  const g = gananciaDelGrupo([
    { loanId: 'A', principal: 500, total: 550, pagado: 550 },   // $50
    { loanId: 'B', principal: 300, total: 336, pagado: 168 },   // $36 x 0,5 = $18
    { loanId: 'C', principal: 200, total: 224, pagado: 0 },     // $0
  ]);
  t.near('la ganancia del grupo suma $68', g.total, 68, 0.01);
  t.eq('con el detalle de los tres prestamos', g.detalle.length, 3);

  // ===================================================================
  t.section('REP 2. El reparto va en proporcion a las acciones');
  // ===================================================================
  // $100 a repartir entre quien tiene $600, $300 y $100 en acciones
  const r1 = repartirUtilidades(100, [
    { email: 'a@x.test', acciones: 600, ahorro: 1000 },
    { email: 'b@x.test', acciones: 300, ahorro: 200 },
    { email: 'c@x.test', acciones: 100, ahorro: 50 },
  ], 'acciones');
  t.near('la participacion total son $1.000 en acciones', r1.totalParticipacion, 1000, 0.01);
  t.near('quien tiene el 60% se lleva $60', r1.reparto[0].utilidad, 60, 0.01);
  t.near('quien tiene el 30% se lleva $30', r1.reparto[1].utilidad, 30, 0.01);
  t.near('quien tiene el 10% se lleva $10', r1.reparto[2].utilidad, 10, 0.01);
  t.near('y no sobra ni falta un centavo', r1.repartido, 100, 0.001);
  t.near('sin nada por repartir', r1.sinRepartir, 0, 0.001);

  // ===================================================================
  t.section('REP 3. O al ahorro, si el grupo lo decide asi');
  // ===================================================================
  const r2 = repartirUtilidades(100, [
    { email: 'a@x.test', acciones: 600, ahorro: 1000 },
    { email: 'b@x.test', acciones: 300, ahorro: 200 },
    { email: 'c@x.test', acciones: 100, ahorro: 50 },
  ], 'ahorros');
  t.near('ahora la base es el ahorro: $1.250', r2.totalParticipacion, 1250, 0.01);
  t.near('quien mas ahorro ($1.000 de $1.250 = 80%) se lleva $80',
    r2.reparto[0].utilidad, 80, 0.01);
  t.near('el segundo, $16', r2.reparto[1].utilidad, 16, 0.01);
  t.near('el tercero, $4', r2.reparto[2].utilidad, 4, 0.01);
  t.near('la suma sigue siendo exacta', r2.repartido, 100, 0.001);
  t.check('cambiar la base cambia el reparto',
    r1.reparto[0].utilidad !== r2.reparto[0].utilidad,
    'salio lo mismo con las dos bases');

  // Con las dos cosas
  const r3 = repartirUtilidades(100, [
    { email: 'a@x.test', acciones: 600, ahorro: 1000 },
    { email: 'b@x.test', acciones: 300, ahorro: 200 },
    { email: 'c@x.test', acciones: 100, ahorro: 50 },
  ], 'ambos');
  t.near('sumando acciones y ahorro la base son $2.250', r3.totalParticipacion, 2250, 0.01);
  t.near('el primero (1.600 de 2.250) se lleva $71,11', r3.reparto[0].utilidad, 71.11, 0.02);
  t.near('la suma sigue cuadrando', r3.repartido, 100, 0.001);

  // ===================================================================
  t.section('REP 4. Los centavos no se pierden ni se inventan');
  // ===================================================================
  // $10 entre tres partes iguales: 3,33 + 3,33 + 3,33 = 9,99. Falta 1 centavo
  const r4 = repartirUtilidades(10, [
    { email: 'a@x.test', acciones: 100 },
    { email: 'b@x.test', acciones: 100 },
    { email: 'c@x.test', acciones: 100 },
  ], 'acciones');
  t.near('lo repartido es exactamente $10, sin perder el centavo',
    r4.repartido, 10, 0.001);
  t.check('a alguien le toca un centavo mas, y consta',
    r4.reparto.some((x) => x.utilidad === 3.34),
    JSON.stringify(r4.reparto.map((x) => x.utilidad)));
  t.near('y no queda nada sin repartir', r4.sinRepartir, 0, 0.001);

  // Un caso feo: 0,07 entre tres
  const r5 = repartirUtilidades(0.07, [
    { email: 'a@x.test', acciones: 100 },
    { email: 'b@x.test', acciones: 100 },
    { email: 'c@x.test', acciones: 100 },
  ], 'acciones');
  t.near('siete centavos entre tres siguen siendo siete centavos',
    r5.repartido, 0.07, 0.001);

  // ===================================================================
  t.section('REP 5. Sin ganancia o sin capital, no se reparte nada');
  // ===================================================================
  const r6 = repartirUtilidades(0, [{ email: 'a@x.test', acciones: 100 }], 'acciones');
  t.near('si el grupo no cobro intereses, nadie recibe nada', r6.repartido, 0, 0.001);
  t.check('y se explica por que', /no ha cobrado/i.test(r6.motivo), r6.motivo);

  const r7 = repartirUtilidades(100, [{ email: 'a@x.test', acciones: 0, ahorro: 0 }], 'acciones');
  t.near('si nadie puso capital, no se reparte', r7.repartido, 0, 0.001);
  t.near('y el dinero queda sin repartir, no desaparece', r7.sinRepartir, 100, 0.001);

  const r8 = repartirUtilidades(50, [], 'acciones');
  t.near('sin socios tampoco se reparte', r8.repartido, 0, 0.001);
  t.eq('y la lista queda vacia, sin romperse', r8.reparto.length, 0);

  // ===================================================================
  t.section('REP 6. El grupo elige la base, y queda guardada');
  // ===================================================================
  seedWorkbook();
  const e = await baseScenario({ groupId: 'GRP' });

  const reglas0 = await get('/api/gob/reglas?groupId=GRP', e.tokens.socio1);
  t.eq('por defecto se reparte por acciones', reglas0.body?.reglas?.baseReparto, 'acciones');

  const cambio = await post('/api/gob/reglas',
    { groupId: 'GRP', baseReparto: 'ahorros' }, e.tokens.presi);
  t.status('la presidencia puede cambiar la base', cambio, 200);
  const reglas1 = await get('/api/gob/reglas?groupId=GRP', e.tokens.socio1);
  t.eq('y queda guardada', reglas1.body?.reglas?.baseReparto, 'ahorros');

  const malo = await post('/api/gob/reglas',
    { groupId: 'GRP', baseReparto: 'lo que sea' }, e.tokens.presi);
  t.statusIn('una base inventada no se acepta', malo, [200, 400]);
  const reglas2 = await get('/api/gob/reglas?groupId=GRP', e.tokens.socio1);
  t.eq('y la anterior se conserva', reglas2.body?.reglas?.baseReparto, 'ahorros');

  const socioIntenta = await post('/api/gob/reglas',
    { groupId: 'GRP', baseReparto: 'acciones' }, e.tokens.socio1);
  t.status('un socio raso no puede cambiarla', socioIntenta, 403);

  // ===================================================================
  t.section('REP 7. El reparto real del grupo, de punta a punta');
  // ===================================================================
  seedWorkbook();
  const e2 = await baseScenario({ groupId: 'GRP2' });
  await post('/api/gob/reglas', { groupId: 'GRP2', baseReparto: 'acciones' }, e2.tokens.presi);

  const socios = [e2.users.presi, e2.users.teso, e2.users.socio1];
  const acciones = [60, 30, 10];      // $600, $300, $100 a $10 la accion
  socios.forEach((u, i) => {
    fake.ensureSheet('Acciones').grid.push([
      u.email, 'GRP2', haceMeses(3), acciones[i], 10, 2, new Date().toISOString(),
      'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), `acc_r${i}`, '',
    ]);
    fake.ensureSheet('Savings').grid.push([
      u.email, 'GRP2', 100, haceMeses(3), 'mensual', 'aporte',
      'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), `sav_r${i}`, '',
    ]);
  });

  // Un prestamo de $500 al 2% a 5 meses (total $550), devuelto entero
  fake.ensureSheet('Loans').grid.push([
    'LN_REP', e2.users.socio1.email, 'GRP2', 500, haceMeses(5),
    new Date().toISOString(), 2, 'aprobado', 5, 550,
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_REP', e2.users.socio1.email, 'LN_REP', 550, haceMeses(1), 'saldado', 'approved',
    '', '', '', '', new Date().toISOString(), e2.users.teso.email, new Date().toISOString(), '',
  ]);
  // Y un pago NO aprobado, que no debe contar
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_REP_2', e2.users.socio1.email, 'LN_REP', 200, haceMeses(0), 'en revision', 'pending',
    '', '', '', '', new Date().toISOString(), '', '', '',
  ]);

  const rep = await get('/api/gob/utilidades/reparto?groupId=GRP2', e2.tokens.socio1);
  t.status('cualquier socio puede ver el reparto', rep, 200);
  t.near('el grupo gano $50 de intereses', rep.body?.ganancia?.total, 50, 0.01);
  t.eq('se reparte por acciones', rep.body?.base, 'acciones');
  t.near('la participacion total son $1.000 en acciones',
    rep.body?.totalParticipacion, 1000, 0.01);

  const porCorreo = Object.fromEntries((rep.body?.reparto || []).map((x) => [x.email, x]));
  t.near('quien tiene 60 acciones (60%) recibe $30',
    porCorreo[e2.users.presi.email]?.utilidad, 30, 0.01);
  t.near('quien tiene 30 acciones (30%) recibe $15',
    porCorreo[e2.users.teso.email]?.utilidad, 15, 0.01);
  t.near('quien tiene 10 acciones (10%) recibe $5',
    porCorreo[e2.users.socio1.email]?.utilidad, 5, 0.01);
  t.near('lo repartido es exactamente lo ganado', rep.body?.repartido, 50, 0.001);
  t.near('sin dejar nada suelto', rep.body?.sinRepartir, 0, 0.001);

  // La misma cuenta, cambiando la base al vuelo
  const repAhorro = await get('/api/gob/utilidades/reparto?groupId=GRP2&base=ahorros', e2.tokens.socio1);
  t.near('por ahorros la base son $300', repAhorro.body?.totalParticipacion, 300, 0.01);
  const porAhorro = Object.fromEntries((repAhorro.body?.reparto || []).map((x) => [x.email, x]));
  t.near('los tres ahorraron lo mismo, asi que reciben $16,67 cada uno',
    porAhorro[e2.users.presi.email]?.utilidad, 16.67, 0.02);
  t.near('y la suma sigue siendo $50', repAhorro.body?.repartido, 50, 0.001);

  // ===================================================================
  t.section('REP 8. No se reparte dinero que no ha entrado');
  // ===================================================================
  seedWorkbook();
  const e3 = await baseScenario({ groupId: 'GRP3' });
  fake.ensureSheet('Acciones').grid.push([
    e3.users.socio1.email, 'GRP3', haceMeses(3), 100, 10, 2, new Date().toISOString(),
    'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), 'acc_x', '',
  ]);
  // Prestamo aprobado pero SIN pagar nada
  fake.ensureSheet('Loans').grid.push([
    'LN_SIN', e3.users.socio1.email, 'GRP3', 1000, haceMeses(1),
    new Date().toISOString(), 3, 'aprobado', 10, 1300,
  ]);

  const rep3 = await get('/api/gob/utilidades/reparto?groupId=GRP3', e3.tokens.socio1);
  t.near('un prestamo concedido pero no cobrado no genera reparto',
    rep3.body?.ganancia?.total, 0, 0.01);
  t.near('nadie recibe nada todavia', rep3.body?.repartido, 0, 0.001);
  t.check('y se explica el motivo', /no ha cobrado/i.test(rep3.body?.motivo || ''),
    rep3.body?.motivo);

  const ajeno = await get('/api/gob/utilidades/reparto?groupId=GRP3', e3.tokens.ajeno);
  t.status('quien no es del grupo no ve su reparto', ajeno, 403);

  // ===================================================================
  t.section('REP 9. El cierre: se propone, se vota y se abona');
  // ===================================================================
  seedWorkbook();
  const e4 = await baseScenario({ groupId: 'GRP4' });
  await post('/api/gob/reglas', { groupId: 'GRP4', baseReparto: 'acciones' }, e4.tokens.presi);

  const equipo = [e4.users.presi, e4.users.teso, e4.users.socio1];
  [60, 30, 10].forEach((n, i) => {
    fake.ensureSheet('Acciones').grid.push([
      equipo[i].email, 'GRP4', haceMeses(3), n, 10, 2, new Date().toISOString(),
      'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), `acc_c${i}`, '',
    ]);
  });
  fake.ensureSheet('Loans').grid.push([
    'LN_C', e4.users.socio1.email, 'GRP4', 500, haceMeses(5),
    new Date().toISOString(), 2, 'aprobado', 5, 550,
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_C', e4.users.socio1.email, 'LN_C', 550, haceMeses(1), 'saldado', 'approved',
    '', '', '', '', new Date().toISOString(), e4.users.teso.email, new Date().toISOString(), '',
  ]);

  // --- El socio raso no puede cerrar el ejercicio ---
  t.status('un socio raso no puede crear el cierre',
    await post('/api/gob/utilidades/cierre', { groupId: 'GRP4' }, e4.tokens.socio1), 403);

  // --- La tesoreria guarda el borrador ---
  const cierre = await post('/api/gob/utilidades/cierre',
    { groupId: 'GRP4', periodo: '2026-08' }, e4.tokens.teso);
  t.status('la tesoreria guarda el cierre', cierre, 201);
  const cierreId = cierre.body?.cierreId;
  t.check('con su identificador', !!cierreId, JSON.stringify(cierre.body).slice(0, 140));
  t.near('por $50, que es lo que el grupo gano', cierre.body?.ganancia?.porRepartir, 50, 0.01);

  t.status('no se puede abrir un segundo cierre con uno sin terminar',
    await post('/api/gob/utilidades/cierre', { groupId: 'GRP4' }, e4.tokens.teso), 409);

  // --- Sin asamblea NO se abona ---
  const sinActa = await post(`/api/gob/utilidades/cierre/${cierreId}/aplicar`, {}, e4.tokens.teso);
  t.status('sin asamblea no se abona nada', sinActa, 409);

  const ahorroAntes = (await get(
    `/api/savings/complete?email=${e4.users.presi.email}&groupId=GRP4`, e4.tokens.presi))
    .body?.data?.totalAhorros || 0;

  // --- Asamblea, votacion y abono ---
  const asa = await post('/api/gob/asambleas', {
    groupId: 'GRP4', titulo: 'Cierre de agosto', fechaProgramada: '2026-09-05', modalidad: 'presencial',
  }, e4.tokens.presi);
  const asambleaId = asa.body?.asambleaId;
  await post(`/api/gob/asambleas/${asambleaId}/asistencia`, {
    registros: [e4.users.presi, e4.users.teso, e4.users.socio1]
      .map((u) => ({ email: u.email, estado: 'presente' })),
  }, e4.tokens.presi);
  await post(`/api/gob/asambleas/${asambleaId}/estado`, { estado: 'abierta' }, e4.tokens.presi);

  const prop = await post(`/api/gob/utilidades/cierre/${cierreId}/proponer`,
    { asambleaId }, e4.tokens.teso);
  t.status('el cierre se somete a la asamblea', prop, 200);
  const acuerdoId = prop.body?.acuerdoId;

  const antesDeVotar = await post(`/api/gob/utilidades/cierre/${cierreId}/aplicar`, {}, e4.tokens.teso);
  t.status('propuesto pero sin votar todavia no se abona', antesDeVotar, 409);

  for (const u of [e4.users.presi, e4.users.teso, e4.users.socio1]) {
    await post(`/api/gob/acuerdos/${acuerdoId}/votar`, { voto: 'favor' },
      u.email === e4.users.presi.email ? e4.tokens.presi
        : u.email === e4.users.teso.email ? e4.tokens.teso : e4.tokens.socio1);
  }

  const aplicado = await post(`/api/gob/utilidades/cierre/${cierreId}/aplicar`, {}, e4.tokens.teso);
  t.status('aprobado en asamblea, se abona', aplicado, 200);
  t.eq('a los 3 socios', aplicado.body?.abonado?.socios, 3);
  t.near('por un total de $50', aplicado.body?.abonado?.total, 50, 0.01);

  t.status('abonarlo dos veces no duplica nada',
    await post(`/api/gob/utilidades/cierre/${cierreId}/aplicar`, {}, e4.tokens.teso), 409);

  // --- El dinero esta en la cuenta de cada quien ---
  const presiDespues = await get(
    `/api/savings/complete?email=${e4.users.presi.email}&groupId=GRP4`, e4.tokens.presi);
  t.near('a la presidencia (60%) le entraron $30',
    presiDespues.body?.data?.totalAhorros, ahorroAntes + 30, 0.05);

  const suyos = (presiDespues.body?.data?.historialAhorros || [])
    .filter((x) => (x.tipo || '') === 'utilidad');
  t.eq('y consta como movimiento de utilidades', suyos.length, 1);
  t.near('de $30', suyos[0]?.monto, 30, 0.01);
  t.check('con el motivo escrito', /asamblea/i.test(suyos[0]?.descripcion || ''),
    suyos[0]?.descripcion);

  const socioDespues = await get(
    `/api/savings/complete?email=${e4.users.socio1.email}&groupId=GRP4`, e4.tokens.socio1);
  const suyos2 = (socioDespues.body?.data?.historialAhorros || [])
    .filter((x) => (x.tipo || '') === 'utilidad');
  t.near('al socio del 10% le entraron $5', suyos2[0]?.monto, 5, 0.01);

  // --- Y ya no queda nada por repartir ---
  const despues = await get('/api/gob/utilidades/reparto?groupId=GRP4', e4.tokens.socio1);
  t.near('lo repartido queda descontado', despues.body?.ganancia?.yaRepartido, 50, 0.01);
  t.near('y no queda nada pendiente de repartir',
    despues.body?.ganancia?.porRepartir, 0, 0.01);
  t.status('asi que no se puede abrir otro cierre sin nada que repartir',
    await post('/api/gob/utilidades/cierre', { groupId: 'GRP4' }, e4.tokens.teso), 409);

  const lista = await get('/api/gob/utilidades/cierres?groupId=GRP4', e4.tokens.socio1);
  t.eq('el cierre queda en el historial', (lista.body?.cierres || []).length, 1);
  t.eq('marcado como aplicado', (lista.body?.cierres || [])[0]?.estado, 'aplicado');

  // ===================================================================
  t.section('REP 10. Ver el detalle de un cierre y descartar un borrador');
  // ===================================================================
  seedWorkbook();
  const e5 = await baseScenario({ groupId: 'GRP5' });
  [40, 60].forEach((n, i) => {
    fake.ensureSheet('Acciones').grid.push([
      [e5.users.presi, e5.users.socio1][i].email, 'GRP5', haceMeses(3), n, 10, 2,
      new Date().toISOString(), 'confirmado', 'x@x.test', 'y@y.test',
      new Date().toISOString(), `acc_d${i}`, '',
    ]);
  });
  fake.ensureSheet('Loans').grid.push([
    'LN_D', e5.users.socio1.email, 'GRP5', 400, haceMeses(4),
    new Date().toISOString(), 2, 'aprobado', 4, 432,
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'PAY_D', e5.users.socio1.email, 'LN_D', 432, haceMeses(1), 'saldado', 'approved',
    '', '', '', '', new Date().toISOString(), e5.users.presi.email, new Date().toISOString(), '',
  ]);

  const cierre5 = await post('/api/gob/utilidades/cierre', { groupId: 'GRP5' }, e5.tokens.presi);
  t.status('se guarda un cierre', cierre5, 201);
  const id5 = cierre5.body?.cierreId;

  // --- Ver el detalle ---
  const detalle = await get(`/api/gob/utilidades/cierre/${id5}`, e5.tokens.socio1);
  t.status('cualquier socio puede ver el detalle del cierre', detalle, 200);
  // Se guarda una fila por CADA socio del grupo, tambien los que no pusieron
  // nada: asi el acta deja constancia de que se les considero y les toco cero.
  t.eq('con una fila por cada socio del grupo', (detalle.body?.filas || []).length, 5);
  t.eq('de los que solo dos reciben algo',
    (detalle.body?.filas || []).filter((f) => Number(f.utilidad) > 0).length, 2);
  t.near('la ganancia son los $32 de interes', detalle.body?.cierre?.ganancia, 32, 0.01);
  t.eq('y esta en borrador', detalle.body?.cierre?.estado, 'borrador');
  const suma5 = (detalle.body?.filas || []).reduce((a, f) => a + Number(f.utilidad), 0);
  t.near('lo repartido en el detalle cuadra con la ganancia', suma5, 32, 0.02);
  t.near('quien tiene el 60% se lleva $19,20',
    (detalle.body?.filas || []).find((f) => f.email === e5.users.socio1.email)?.utilidad, 19.20, 0.02);

  t.status('quien no es del grupo no ve el detalle',
    await get(`/api/gob/utilidades/cierre/${id5}`, e5.tokens.ajeno), 403);
  t.status('un cierre que no existe da 404',
    await get('/api/gob/utilidades/cierre/no-existe', e5.tokens.presi), 404);

  // --- Descartar ---
  t.status('un socio raso no puede descartar el cierre',
    await post(`/api/gob/utilidades/cierre/${id5}/descartar`, {}, e5.tokens.socio1), 403);

  const descarte = await post(`/api/gob/utilidades/cierre/${id5}/descartar`, {}, e5.tokens.presi);
  t.status('la presidencia lo descarta', descarte, 200);
  t.eq('y queda marcado como descartado', descarte.body?.estado, 'descartado');

  t.status('descartado, ya no se puede abonar',
    await post(`/api/gob/utilidades/cierre/${id5}/aplicar`, {}, e5.tokens.presi), 409);

  const otro = await post('/api/gob/utilidades/cierre', { groupId: 'GRP5' }, e5.tokens.presi);
  t.status('y se puede abrir otro cierre en su lugar', otro, 201);
  t.near('por la misma ganancia, que no se perdio', otro.body?.ganancia?.porRepartir, 32, 0.01);
};
