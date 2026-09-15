/**
 * SUITE 31 - Lo que me toca este ciclo.
 *
 * En la reunion de un banco comunal la tesorera pasa lista y cada socia pone lo
 * suyo: el ahorro del mes, la accion que se comprometio a comprar y la cuota de
 * su prestamo. En la app eso estaba en tres sitios distintos y ninguno lo decia
 * junto; la fecha de la proxima reunion se la inventaba el navegador sumando un
 * mes al ultimo movimiento con `setMonth` (el 31 de enero mas un mes daba el 3
 * de marzo) y la hora estaba escrita a mano.
 *
 * Aqui se fija que la app diga UNA frase correcta: cuando es la reunion y cuanto
 * hay que llevar, sumando bien las tres cosas y sin cobrar de mas.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();
const cicloDeHoy = () => hoyLocal().slice(0, 7);
const diaDelCiclo = (d) => `${cicloDeHoy()}-${String(d).padStart(2, '0')}`;

const ahorro = (email, grupo, monto, fecha, estado = 'confirmado') => fake.ensureSheet('Savings').grid.push([
  email, grupo, monto, fecha, 'mensual', 'aporte', estado,
  'a@a.test', 'b@b.test', new Date().toISOString(),
  `sav_${Math.random().toString(36).slice(2, 8)}`, '',
]);

const acciones = (email, grupo, cantidad, valor, fecha, estado = 'confirmado') => fake.ensureSheet('Acciones').grid.push([
  email, grupo, fecha, cantidad, valor, 2, new Date().toISOString(),
  estado, 'x@x.test', 'y@y.test', new Date().toISOString(),
  `acc_${Math.random().toString(36).slice(2, 8)}`, '',
]);

function prestamo(id, email, grupo, principal, total, inicio, plazo, pagos, estado = 'aprobado') {
  fake.ensureSheet('Loans').grid.push([
    id, email, grupo, principal, inicio, '', 2, estado, plazo, total,
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

  const compromiso = async (e, G, quien, token) => get(
    `/api/gob/mi-compromiso?groupId=${G}${quien ? `&email=${encodeURIComponent(quien)}` : ''}`,
    token);

  // ===================================================================
  t.section('COM 1. Sin reglamento no se inventa nada');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'GC1' });
  hoja.invalidarTodo();

  let r = await compromiso(e, 'GC1', null, e.tokens.socio1);
  t.status('la socia puede consultar lo suyo', r, 200);
  t.near('sin aporte minimo acordado no se le cobra ahorro', r.body?.aporte?.falta, 0);
  t.eq('sin acciones minimas acordadas no se le cobran acciones', r.body?.acciones?.faltan, 0);
  t.near('y el total es cero', r.body?.total, 0);
  t.check('se le dice que esta al dia',
    /al dia/i.test(r.body?.mensaje || ''), r.body?.mensaje);
  t.eq('no se inventa una fecha de reunion', r.body?.proximaAsamblea?.fecha, '');

  // ===================================================================
  t.section('COM 2. El aporte minimo del reglamento se recuerda y se descuenta');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GC2' });
  await post('/api/gob/reglas', { groupId: 'GC2', aporteMinimo: 20 }, e.tokens.presi);
  hoja.invalidarTodo();

  r = await compromiso(e, 'GC2', null, e.tokens.socio1);
  t.near('sin haber puesto nada, debe los $20 enteros', r.body?.aporte?.falta, 20);
  t.near('y el total es $20', r.body?.total, 20);
  t.check('la frase dice cuanto llevar de ahorro',
    /\$20\.00 de ahorro/.test(r.body?.mensaje || ''), r.body?.mensaje);

  ahorro(e.users.socio1.email, 'GC2', 12, diaDelCiclo(3));
  hoja.invalidarTodo();
  r = await compromiso(e, 'GC2', null, e.tokens.socio1);
  t.near('si ya puso $12, le faltan $8', r.body?.aporte?.falta, 8);
  t.near('y lo confirmado se ve', r.body?.aporte?.confirmado, 12);

  ahorro(e.users.socio1.email, 'GC2', 8, diaDelCiclo(4));
  hoja.invalidarTodo();
  r = await compromiso(e, 'GC2', null, e.tokens.socio1);
  t.near('completado el minimo, no debe nada', r.body?.aporte?.falta, 0);
  t.check('y se le dice que esta al dia',
    /al dia/i.test(r.body?.mensaje || ''), r.body?.mensaje);

  // ===================================================================
  t.section('COM 3. Lo entregado y sin confirmar no se cobra dos veces');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GC3' });
  await post('/api/gob/reglas', { groupId: 'GC3', aporteMinimo: 20 }, e.tokens.presi);
  ahorro(e.users.socio1.email, 'GC3', 20, diaDelCiclo(5), 'pendiente');
  hoja.invalidarTodo();

  r = await compromiso(e, 'GC3', null, e.tokens.socio1);
  t.near('el aporte por confirmar se ve aparte', r.body?.aporte?.porConfirmar, 20);
  t.near('y no se le vuelve a cobrar por el retraso de la tesoreria',
    r.body?.aporte?.falta, 0);

  // Un aporte rechazado si vuelve a deberse: no entro a la caja.
  ahorro(e.users.socio2.email, 'GC3', 20, diaDelCiclo(5), 'rechazado');
  hoja.invalidarTodo();
  r = await compromiso(e, 'GC3', null, e.tokens.socio2);
  t.near('un aporte rechazado no cuenta como puesto', r.body?.aporte?.falta, 20);

  // ===================================================================
  t.section('COM 4. El aporte de otro mes no tapa el de este');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GC4' });
  await post('/api/gob/reglas', { groupId: 'GC4', aporteMinimo: 20 }, e.tokens.presi);
  ahorro(e.users.socio1.email, 'GC4', 60, '2024-01-10');
  hoja.invalidarTodo();

  r = await compromiso(e, 'GC4', null, e.tokens.socio1);
  t.near('lo puesto hace dos anos no cubre el mes en curso', r.body?.aporte?.falta, 20);
  t.eq('y el ciclo que se mide es el mes de hoy', r.body?.ciclo, cicloDeHoy());

  // ===================================================================
  t.section('COM 5. Las acciones que el grupo acordo comprar');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GC5' });     // valorAccion = 10
  await post('/api/gob/reglas', { groupId: 'GC5', accionesMinimasPorMes: 2 }, e.tokens.presi);
  hoja.invalidarTodo();

  r = await compromiso(e, 'GC5', null, e.tokens.socio1);
  t.eq('le faltan las 2 acciones del mes', r.body?.acciones?.faltan, 2);
  t.near('a $10 cada una son $20', r.body?.acciones?.aPagar, 20);
  t.near('y ese es su total', r.body?.total, 20);
  t.check('la frase las nombra en plural',
    /\$20\.00 de 2 acciones/.test(r.body?.mensaje || ''), r.body?.mensaje);

  acciones(e.users.socio1.email, 'GC5', 1, 10, diaDelCiclo(8));
  hoja.invalidarTodo();
  r = await compromiso(e, 'GC5', null, e.tokens.socio1);
  t.eq('comprada una, le falta una', r.body?.acciones?.faltan, 1);
  t.near('que son $10', r.body?.acciones?.aPagar, 10);
  t.check('y la frase la nombra en singular',
    /de 1 accion/.test(r.body?.mensaje || ''), r.body?.mensaje);

  acciones(e.users.socio2.email, 'GC5', 5, 10, diaDelCiclo(8));
  hoja.invalidarTodo();
  r = await compromiso(e, 'GC5', null, e.tokens.socio2);
  t.eq('quien compra de mas no queda con acciones negativas', r.body?.acciones?.faltan, 0);
  t.near('ni con un cobro negativo', r.body?.acciones?.aPagar, 0);

  // ===================================================================
  t.section('COM 6. La cuota del prestamo entra en lo que hay que llevar');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GC6' });
  // Prestamo de $200 a 4 meses al 2 % mensual: total $216, cuota $54.
  // Empezo hace tres meses, asi que hay cuotas vencidas.
  const haceMeses = (n) => {
    const hoyD = new Date();
    const total = (hoyD.getFullYear() * 12) + hoyD.getMonth() - n;
    return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
  };
  const inicio = haceMeses(3);
  prestamo('LN_C6', e.users.socio1.email, 'GC6', 200, 216, inicio, 4, []);
  hoja.invalidarTodo();

  r = await compromiso(e, 'GC6', null, e.tokens.socio1);
  t.eq('se le ve un prestamo activo', r.body?.prestamos?.activos, 1);
  t.near('con saldo de $216', r.body?.prestamos?.detalle?.[0]?.saldo, 216);
  t.check('y la proxima cuota tiene fecha',
    /^\d{4}-\d{2}-\d{2}$/.test(r.body?.prestamos?.detalle?.[0]?.proximaCuota?.vence || ''),
    JSON.stringify(r.body?.prestamos?.detalle?.[0]?.proximaCuota));
  t.eq('lleva tres cuotas vencidas', r.body?.prestamos?.cuotasVencidas, 3);
  t.near('que suman $162', r.body?.prestamos?.aPagar, 162, 0.02);

  // Lo que se lleva a la reunion es lo exigible EN LA REUNION, no hoy: si la
  // asamblea cae despues del vencimiento de la cuota siguiente, esa tambien va.
  await post('/api/gob/asambleas', {
    groupId: 'GC6', titulo: 'Reunion', modalidad: 'presencial',
    fechaProgramada: (() => {
      const d = new Date();
      d.setDate(d.getDate() + 45);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    })(),
  }, e.tokens.presi);
  hoja.invalidarTodo();
  r = await compromiso(e, 'GC6', null, e.tokens.socio1);
  t.near('con la reunion a mes y medio entra tambien la cuota siguiente',
    r.body?.prestamos?.aPagar, 216, 0.02);

  // ===================================================================
  t.section('COM 7. Una solicitud sin aprobar no es una deuda');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GC7' });
  prestamo('LN_C7', e.users.socio1.email, 'GC7', 200, 216, '2026-01-05', 4, [], 'pendiente');
  hoja.invalidarTodo();

  r = await compromiso(e, 'GC7', null, e.tokens.socio1);
  t.eq('un prestamo que la asamblea aun no aprobo no se cobra', r.body?.prestamos?.activos, 0);
  t.near('ni suma al total', r.body?.total, 0);

  // Y el ya pagado tampoco reaparece.
  preparar();
  e = await baseScenario({ groupId: 'GC7B' });
  prestamo('LN_C7B', e.users.socio1.email, 'GC7B', 200, 216, '2026-01-05', 4,
    [[216, '2026-02-10']]);
  hoja.invalidarTodo();
  r = await compromiso(e, 'GC7B', null, e.tokens.socio1);
  t.eq('un prestamo saldado ya no aparece', r.body?.prestamos?.activos, 0);

  // ===================================================================
  t.section('COM 8. Las tres cosas juntas suman una sola cifra');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GC8' });
  await post('/api/gob/reglas',
    { groupId: 'GC8', aporteMinimo: 20, accionesMinimasPorMes: 1 }, e.tokens.presi);
  prestamo('LN_C8', e.users.socio1.email, 'GC8', 200, 216, inicio, 4, []);
  hoja.invalidarTodo();

  r = await compromiso(e, 'GC8', null, e.tokens.socio1);
  const cuota = Number(r.body?.prestamos?.aPagar || 0);
  // Empezado hace tres meses y sin pagar nada: tres cuotas de $54 vencidas.
  t.near('arrastra las tres cuotas vencidas', cuota, 162, 0.02);
  t.eq('y se dice cuantas van vencidas', r.body?.prestamos?.cuotasVencidas, 3);
  t.near('el total es ahorro + accion + cuota', r.body?.total, 20 + 10 + cuota, 0.02);
  t.check('y la frase nombra las tres cosas',
    /de ahorro/.test(r.body?.mensaje || '')
    && /accion/.test(r.body?.mensaje || '')
    && /prestamo/.test(r.body?.mensaje || ''), r.body?.mensaje);

  // ===================================================================
  t.section('COM 9. La fecha de la reunion sale de la asamblea convocada');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GC9' });
  const cuando = (() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const asa = await post('/api/gob/asambleas',
    { groupId: 'GC9', titulo: 'Reunion de octubre', fechaProgramada: cuando, modalidad: 'presencial' },
    e.tokens.presi);
  t.status('la presidenta convoca', asa, 201);
  hoja.invalidarTodo();

  r = await compromiso(e, 'GC9', null, e.tokens.socio1);
  t.eq('la fecha es la convocada, no una inventada', r.body?.proximaAsamblea?.fecha, cuando);
  t.eq('y se dice que esta convocada de verdad', r.body?.proximaAsamblea?.convocada, true);
  t.eq('con su titulo', r.body?.proximaAsamblea?.titulo, 'Reunion de octubre');

  // ===================================================================
  t.section('COM 10. Sin convocatoria se estima con el dia acordado, y se dice que es estimada');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GCA' });
  await post('/api/gob/reglas', { groupId: 'GCA', diaDeAsamblea: 15 }, e.tokens.presi);
  hoja.invalidarTodo();

  r = await compromiso(e, 'GCA', null, e.tokens.socio1);
  const f = r.body?.proximaAsamblea?.fecha || '';
  t.check('la fecha estimada cae el dia 15', f.endsWith('-15'), f);
  t.check('y nunca en el pasado', f >= hoy(), `${f} vs ${hoy()}`);
  t.eq('se dice que es una estimacion', r.body?.proximaAsamblea?.estimada, true);
  t.eq('y que no esta convocada', r.body?.proximaAsamblea?.convocada, false);

  // El reglamento se relee: cambiar el dia cambia la fecha.
  await post('/api/gob/reglas', { groupId: 'GCA', diaDeAsamblea: 28 }, e.tokens.presi);
  hoja.invalidarTodo();
  r = await compromiso(e, 'GCA', null, e.tokens.socio1);
  t.check('cambiado el dia, cambia la fecha',
    (r.body?.proximaAsamblea?.fecha || '').endsWith('-28'), r.body?.proximaAsamblea?.fecha);

  // ===================================================================
  t.section('COM 11. Cada quien ve lo suyo y nada mas');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GCB' });
  await post('/api/gob/reglas', { groupId: 'GCB', aporteMinimo: 20 }, e.tokens.presi);
  ahorro(e.users.socio2.email, 'GCB', 20, diaDelCiclo(2));
  hoja.invalidarTodo();

  // Esta seccion es el recordatorio personal de cada socia. No se consulta la
  // de otra: ni una socia a otra, ni la directiva a sus socias. Poner el correo
  // ajeno en la direccion no cambia de quien son las cuentas que salen.
  const espia = await compromiso(e, 'GCB', e.users.socio2.email, e.tokens.socio1);
  t.status('pedir el correo de otra no falla', espia, 200);
  t.eq('pero lo que sale es lo de quien pregunta', espia.body?.email, e.users.socio1.email);
  t.near('con SUS cuentas, no las de la otra', espia.body?.aporte?.confirmado, 0);

  const dePresidenta = await compromiso(e, 'GCB', e.users.socio2.email, e.tokens.presi);
  t.status('ni la presidenta consulta aqui lo de una socia', dePresidenta, 200);
  t.eq('a ella tambien le sale lo suyo', dePresidenta.body?.email, e.users.presi.email);

  const suyo = await compromiso(e, 'GCB', null, e.tokens.socio2);
  t.near('y la socia si ve su propio aporte', suyo.body?.aporte?.confirmado, 20);

  const fuera = await compromiso(e, 'GCB', null, e.tokens.ajeno);
  t.check('quien no es del grupo no entra', [403, 404].includes(fuera.status),
    `HTTP ${fuera.status}`);

  const sinToken = await compromiso(e, 'GCB', null, null);
  t.status('y sin sesion tampoco', sinToken, 401);

  // ===================================================================
  t.section('COM 12. Sin valor de accion configurado no se inventa un cobro');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GCC' });
  fake.ensureSheet('Groups').grid.forEach((row) => {
    if ((row[0] || '') === 'GCC') row[15] = '';   // el grupo aun no fijo el valor
  });
  await post('/api/gob/reglas', { groupId: 'GCC', accionesMinimasPorMes: 2 }, e.tokens.presi);
  hoja.invalidarTodo();

  r = await compromiso(e, 'GCC', null, e.tokens.socio1);
  t.eq('se sabe que le faltan 2 acciones', r.body?.acciones?.faltan, 2);
  t.near('pero no se cobra un valor inventado', r.body?.acciones?.aPagar, 0);
  t.near('ni entra al total', r.body?.total, 0);
  t.check('y se explica por que',
    /todavia no fijo cuanto vale/i.test(r.body?.mensaje || ''), r.body?.mensaje);

  // ===================================================================
  t.section('COM 13. Quienes mas han puesto, en orden');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GCD' });
  ahorro(e.users.socio1.email, 'GCD', 300, diaDelCiclo(2));
  acciones(e.users.socio1.email, 'GCD', 5, 10, diaDelCiclo(2));      // 300 + 50 = 350
  ahorro(e.users.socio2.email, 'GCD', 120, diaDelCiclo(2));          // 120
  acciones(e.users.presi.email, 'GCD', 20, 10, diaDelCiclo(2));      // 200
  // Una utilidad abonada no es "lo que puso": mide el esfuerzo, no el saldo.
  fake.ensureSheet('Savings').grid.push([
    e.users.socio2.email, 'GCD', 500, diaDelCiclo(3), 'utilidad', 'reparto', 'confirmado',
    'a@a.test', 'b@b.test', new Date().toISOString(), 'uti_x', '',
  ]);
  hoja.invalidarTodo();

  const podio = await get('/api/gob/ahorradores?groupId=GCD', e.tokens.socio1);
  t.status('cualquier socia puede ver el libro del grupo', podio, 200);
  const top = podio.body?.top || [];
  t.eq('salen las cinco socias del grupo', podio.body?.socias, 5);
  t.near('la primera puso $350', top[0]?.total, 350, 0.01);
  t.near('la segunda $200', top[1]?.total, 200, 0.01);
  t.near('la tercera $120, sin contarle la utilidad que cobro', top[2]?.total, 120, 0.01);
  t.eq('y van numeradas', top.map((x) => x.puesto).slice(0, 3), [1, 2, 3]);
  t.eq('quien pregunta se reconoce en la lista', top[0]?.soyYo, true);
  t.near('el total del grupo cuadra con la suma', podio.body?.totalDelGrupo, 670, 0.01);
  t.check('no se publica el correo de nadie',
    !JSON.stringify(top).includes('@'), JSON.stringify(top).slice(0, 200));

  const fuera2 = await get('/api/gob/ahorradores?groupId=GCD', e.tokens.ajeno);
  t.check('quien no es del grupo no lo consulta', [403, 404].includes(fuera2.status),
    `HTTP ${fuera2.status}`);

  // ===================================================================
  t.section('COM 14. Una asamblea que ya paso no recorta lo que hay que llevar');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GCE' });
  await post('/api/gob/reglas', { groupId: 'GCE', aporteMinimo: 20 }, e.tokens.presi);
  // Convocada para AYER y sin cerrar. Antes servia de corte, asi que todo lo que
  // vencia despues caia fuera y a la socia se le decia que no debia nada.
  const ayer = (() => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  await post('/api/gob/asambleas',
    { groupId: 'GCE', titulo: 'La de ayer', fechaProgramada: ayer, modalidad: 'presencial' },
    e.tokens.presi);
  hoja.invalidarTodo();

  r = await compromiso(e, 'GCE', null, e.tokens.socio1);
  t.eq('la asamblea atrasada se sigue viendo', r.body?.proximaAsamblea?.fecha, ayer);
  t.eq('marcada como que ya paso', r.body?.proximaAsamblea?.yaPaso, true);
  t.near('pero el aporte del mes se sigue debiendo', r.body?.aporte?.falta, 20);
  t.check('y la frase no promete una fecha que ya paso',
    !(r.body?.mensaje || '').includes(ayer), r.body?.mensaje);
};
