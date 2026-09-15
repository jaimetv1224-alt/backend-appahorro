/**
 * SUITE 33 - El ciclo del prestamo, de punta a punta.
 *
 * Sale de una auditoria del recorrido completo: pedir, aprobar, pagar, cobrar y
 * terminar. Lo que se encontro y aqui queda fijado:
 *
 *   - La tesorera subia el comprobante de SU PROPIO prestamo y ella misma lo
 *     aprobaba: $336 de deuda a $0,00 en dos peticiones, sin que nadie mirara.
 *   - Ni la tesorera ni la presidenta podian ver quien debe en su grupo, asi que
 *     en la reunion quien cobra no tenia la lista de lo que hay que cobrar.
 *   - Un grupo que aun no fijo su interes dejaba pedir igual, y el prestamo
 *     salia al 0 %: $300 prestados, $300 a devolver.
 *   - `plazo=999` daba un credito a 83 anos con cuotas de $0,63.
 *   - Un deposito fechado en 2020 se aceptaba sobre un prestamo de 2026.
 *   - El mismo comprobante volvia a pasar en cuanto el primero se aprobaba.
 *   - El pago que registraba la tesorera desaparecia del historial de la deudora.
 *   - Un prestamo saldado seguia 'aprobado' para siempre.
 *   - Y con $224 de deuda y la cuota a cuatro dias, la app decia "estas al dia".
 */

const { PNG_PRUEBA, hoyLocal, seedWorkbook, get, post, postArchivo, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();
const foto = { campo: 'paymentImage', nombre: 'c.png', contenido: PNG_PRUEBA, tipo: 'image/png' };

/** Un dia relativo a hoy, por calendario y no por horas. */
function dia(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return hoyLocal(d);
}

/** Meses hacia atras, siempre dia 1. */
function haceMeses(n) {
  const d = new Date();
  const total = (d.getFullYear() * 12) + d.getMonth() - n;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

function prestamo(id, email, grupo, principal, total, inicio, plazo = 6, estado = 'aprobado') {
  fake.ensureSheet('Loans').grid.push([
    id, email, grupo, principal, inicio, '', 2, estado, plazo, total,
  ]);
}

const ahorro = (email, grupo, monto, fecha) => fake.ensureSheet('Savings').grid.push([
  email, grupo, monto, fecha, 'mensual', 'aporte', 'confirmado',
  'a@a.test', 'b@b.test', new Date().toISOString(),
  `sav_${Math.random().toString(36).slice(2, 8)}`, '',
]);

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

  const subir = (campos, token) => postArchivo('/api/upload-payment', campos, foto, token);

  // ===================================================================
  t.section('PRE 1. Nadie da por bueno el pago de su propia deuda');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'GP1' });
  // El prestamo es de la TESORERA, que es quien revisa los comprobantes.
  prestamo('LN_TESO', e.users.teso.email, 'GP1', 300, 336, haceMeses(1));
  hoja.invalidarTodo();

  const suyo = await subir(
    { loanId: 'LN_TESO', amount: 336, paymentDate: hoy(), description: 'mi cuota' },
    e.tokens.teso);
  t.status('la tesorera puede subir el comprobante de su prestamo', suyo, 200);

  const seLoAprueba = await post('/api/approve-payment',
    { paymentId: suyo.body?.paymentId || suyo.body?.payment?.paymentId, action: 'approve' },
    e.tokens.teso);
  t.status('pero no puede aprobarselo ella misma', seLoAprueba, 403);
  t.eq('y se dice por que', seLoAprueba.body?.motivo, 'es_tu_deuda');

  const saldoTeso = await get(`/api/obtener-prestamos?groupId=GP1&userEmail=${e.users.teso.email}`,
    e.tokens.presi);
  t.near('su deuda sigue entera', (saldoTeso.body?.loans || [])[0]?.remainingBalance, 336, 0.01);

  const otraPersona = await post('/api/approve-payment',
    { paymentId: suyo.body?.paymentId || suyo.body?.payment?.paymentId, action: 'approve' },
    e.tokens.presi);
  t.status('otra persona de la junta si lo aprueba', otraPersona, 200);
  hoja.invalidarTodo();

  // ===================================================================
  t.section('PRE 2. Quien registra un pago no lo revisa');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GP2' });
  prestamo('LN_S1', e.users.socio1.email, 'GP2', 300, 336, haceMeses(1));
  hoja.invalidarTodo();

  const registrado = await subir(
    { loanId: 'LN_S1', amount: 56, paymentDate: hoy(), description: 'efectivo en la reunion' },
    e.tokens.teso);
  t.status('la tesorera registra el efectivo que le pagaron en la reunion', registrado, 200);

  const seLoAprueba2 = await post('/api/approve-payment',
    { paymentId: registrado.body?.paymentId, action: 'approve' }, e.tokens.teso);
  t.status('pero la revision le toca a otra persona', seLoAprueba2, 403);
  t.eq('y se dice por que', seLoAprueba2.body?.motivo, 'tu_lo_registraste');

  const aprobado2 = await post('/api/approve-payment',
    { paymentId: registrado.body?.paymentId, action: 'approve' }, e.tokens.presi);
  t.status('la presidenta si lo aprueba', aprobado2, 200);
  hoja.invalidarTodo();

  // ===================================================================
  t.section('PRE 3. El pago que registra otra persona es de la deudora');
  // ===================================================================
  const historial = await get(
    `/api/user-loan-payments?groupId=GP2&userEmail=${e.users.socio1.email}`, e.tokens.socio1);
  const pagos = historial.body?.payments || [];
  t.eq('el abono aparece en el historial de la socia, no en el de la tesorera', pagos.length, 1);
  t.near('por su importe', pagos[0]?.amount, 56, 0.01);
  t.eq('y se dice que lo registro otra persona', pagos[0]?.registradoPorOtra, true);

  const deLaTesorera = await get(
    `/api/user-loan-payments?groupId=GP2&userEmail=${e.users.teso.email}`, e.tokens.teso);
  t.eq('a la tesorera no le figura como deuda suya',
    (deLaTesorera.body?.payments || []).length, 0);

  // ===================================================================
  t.section('PRE 4. La directiva ve la cartera de su grupo');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GP4' });
  prestamo('LN_A', e.users.socio1.email, 'GP4', 300, 336, haceMeses(3));
  prestamo('LN_B', e.users.socio2.email, 'GP4', 200, 224, haceMeses(1));
  hoja.invalidarTodo();

  const carteraTeso = await get('/api/obtener-prestamos?groupId=GP4', e.tokens.teso);
  t.status('la tesoreria pregunta por la cartera', carteraTeso, 200);
  t.eq('y ve los dos prestamos del grupo', (carteraTeso.body?.loans || []).length, 2);

  const carteraPresi = await get('/api/obtener-prestamos?groupId=GP4', e.tokens.presi);
  t.eq('la presidencia tambien', (carteraPresi.body?.loans || []).length, 2);

  const carteraSocia = await get('/api/obtener-prestamos?groupId=GP4', e.tokens.socio1);
  t.eq('una socia sigue viendo solo el suyo', (carteraSocia.body?.loans || []).length, 1);
  t.eq('y es el suyo', (carteraSocia.body?.loans || [])[0]?.loanId, 'LN_A');

  const ajena = await get('/api/obtener-prestamos?groupId=GP4', e.tokens.ajeno);
  t.check('quien no es del grupo no ve nada',
    [403, 404].includes(ajena.status) || (ajena.body?.loans || []).length === 0,
    `HTTP ${ajena.status}`);

  // ===================================================================
  t.section('PRE 5. Sin interes fijado no se presta');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GP5' });
  fake.ensureSheet('Groups').grid.forEach((row) => {
    if ((row[0] || '') === 'GP5') row[16] = '';    // el grupo no fijo su interes
  });
  ahorro(e.users.socio1.email, 'GP5', 200, hoy());
  hoja.invalidarTodo();

  const cupo = await get('/api/mi-cupo?groupId=GP5', e.tokens.socio1);
  t.status('la socia consulta su cupo', cupo, 200);
  t.near('y no hay cupo mientras no haya interes', cupo.body?.disponible, 0, 0.01);
  t.eq('se dice que no puede pedir', cupo.body?.puedePedir, false);
  t.check('y por que', /interés mensual/i.test(cupo.body?.motivo || ''), cupo.body?.motivo);

  const sinTasa = await post('/api/registrar-solicitud', {
    tipo: 'prestamo',
    data: { Monto: 300, Group: 'GP5', Detalles: 'Plazo: 6' },
  }, e.tokens.socio1);
  t.status('y la solicitud tampoco pasa', sinTasa, 409);
  t.eq('con su codigo', sinTasa.body?.codigo, 'SIN_TASA');

  // ===================================================================
  t.section('PRE 6. El plazo tiene tope, y lo pone el servidor');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GP6' });
  ahorro(e.users.socio1.email, 'GP6', 200, hoy());
  hoja.invalidarTodo();

  const largo = await post('/api/registrar-solicitud', {
    tipo: 'prestamo',
    data: { Monto: 30, Group: 'GP6', Detalles: 'Plazo: 999' },
  }, e.tokens.socio1);
  t.status('un plazo de 999 meses se rechaza', largo, 400);
  t.eq('con su codigo', largo.body?.codigo, 'PLAZO_INVALIDO');
  t.check('y se dice cual es el tope',
    /1 y 60 meses/.test(largo.body?.message || ''), largo.body?.message);

  const normal = await post('/api/registrar-solicitud', {
    tipo: 'prestamo',
    data: { Monto: 300, Group: 'GP6', Detalles: 'Plazo: 6' },
  }, e.tokens.socio1);
  t.statusIn('un plazo normal si pasa', normal, [200, 201]);

  // ===================================================================
  t.section('PRE 7. Un deposito no es anterior al prestamo que paga');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GP7' });
  prestamo('LN_F', e.users.socio1.email, 'GP7', 300, 336, haceMeses(1));
  hoja.invalidarTodo();

  const viejo = await subir(
    { loanId: 'LN_F', amount: 56, paymentDate: '2021-03-10', description: 'x' },
    e.tokens.socio1);
  t.status('un deposito de hace anos se rechaza', viejo, 400);
  t.eq('con su motivo', viejo.body?.motivo, 'fecha_anterior_al_prestamo');

  const alDia = await subir(
    { loanId: 'LN_F', amount: 56, paymentDate: hoy(), description: 'cuota 1' },
    e.tokens.socio1);
  t.status('y el de hoy pasa', alDia, 200);

  // ===================================================================
  t.section('PRE 8. El mismo comprobante no pasa dos veces, ni despues de aprobado');
  // ===================================================================
  const repetido = await subir(
    { loanId: 'LN_F', amount: 56, paymentDate: hoy(), description: 'cuota 1' },
    e.tokens.socio1);
  t.status('repetirlo mientras espera revision se corta', repetido, 409);

  await post('/api/approve-payment', { paymentId: alDia.body?.paymentId, action: 'approve' },
    e.tokens.teso);
  hoja.invalidarTodo();

  const trasAprobar = await subir(
    { loanId: 'LN_F', amount: 56, paymentDate: hoy(), description: 'cuota 1' },
    e.tokens.socio1);
  t.status('y repetirlo despues de aprobado, tambien', trasAprobar, 409);

  const distinto = await subir(
    { loanId: 'LN_F', amount: 56, paymentDate: hoy(), description: 'cuota 2, segundo deposito' },
    e.tokens.socio1);
  t.status('otro deposito del mismo dia con su nota si pasa', distinto, 200);

  // ===================================================================
  t.section('PRE 9. Saldado el prestamo, queda marcado pagado');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GP9' });
  prestamo('LN_Z', e.users.socio1.email, 'GP9', 100, 112, haceMeses(1), 2);
  hoja.invalidarTodo();

  const total = await subir(
    { loanId: 'LN_Z', amount: 112, paymentDate: hoy(), description: 'cancelacion' },
    e.tokens.socio1);
  t.status('la socia paga el total', total, 200);
  await post('/api/approve-payment', { paymentId: total.body?.paymentId, action: 'approve' },
    e.tokens.teso);
  hoja.invalidarTodo();

  const filaLoan = fake.ensureSheet('Loans').grid.find((r) => (r[0] || '') === 'LN_Z') || [];
  t.eq('la hoja lo marca pagado', (filaLoan[7] || '').toString().toLowerCase(), 'pagado');
  const tras = await get(`/api/obtener-prestamos?groupId=GP9&userEmail=${e.users.socio1.email}`,
    e.tokens.presi);
  t.near('con saldo cero', (tras.body?.loans || [])[0]?.remainingBalance, 0, 0.01);

  // ===================================================================
  t.section('PRE 10. Con una deuda viva no se dice "estas al dia"');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GPA' });
  // Prestamo de este mes: la primera cuota vence el mes que viene, asi que hoy
  // no hay nada vencido. Antes eso bastaba para decirle que estaba al dia.
  prestamo('LN_V', e.users.socio1.email, 'GPA', 200, 224, hoy(), 4);
  hoja.invalidarTodo();

  const comp = await get('/api/gob/mi-compromiso?groupId=GPA', e.tokens.socio1);
  t.status('la socia mira lo que le toca', comp, 200);
  t.check('no se le dice que esta al dia',
    !/estas al dia/i.test(comp.body?.mensaje || ''), comp.body?.mensaje);
  t.near('se le recuerda el saldo vivo', comp.body?.prestamos?.saldo, 224, 0.01);
  t.check('y se nombra el prestamo',
    /prestamo/i.test(comp.body?.mensaje || ''), comp.body?.mensaje);

  // Y sin deuda ninguna, ahi si.
  const limpia = await get('/api/gob/mi-compromiso?groupId=GPA', e.tokens.socio2);
  t.check('quien no debe nada si esta al dia',
    /al dia/i.test(limpia.body?.mensaje || ''), limpia.body?.mensaje);

  // ===================================================================
  t.section('PRE 11. La socia puede echarse atras de lo que ella pidio');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GPB' });
  ahorro(e.users.socio1.email, 'GPB', 200, hoy());
  hoja.invalidarTodo();

  const pedida = await post('/api/registrar-solicitud', {
    tipo: 'prestamo',
    data: { Monto: 300, Group: 'GPB', Detalles: 'Plazo: 6' },
  }, e.tokens.socio1);
  t.statusIn('pide un prestamo', pedida, [200, 201]);
  const solId = (fake.ensureSheet('SolicitudesPrestamos').grid.slice(-1)[0] || [])[0];

  const deOtra = await post('/api/retirar-solicitud',
    { tipo: 'prestamo', id: solId }, e.tokens.socio2);
  t.status('otra socia no retira lo que no es suyo', deOtra, 403);
  const deLaPresi = await post('/api/retirar-solicitud',
    { tipo: 'prestamo', id: solId }, e.tokens.presi);
  t.status('ni la presidenta: si no la quiere, la rechaza', deLaPresi, 403);

  const retiro = await post('/api/retirar-solicitud',
    { tipo: 'prestamo', id: solId }, e.tokens.socio1);
  t.status('la socia si', retiro, 200);
  t.eq('y queda retirada', retiro.body?.estado, 'retirada');
  hoja.invalidarTodo();

  const fila = fake.ensureSheet('SolicitudesPrestamos').grid.find((r) => (r[0] || '') === solId) || [];
  t.eq('la hoja lo dice', (fila[5] || '').toString().toLowerCase(), 'retirada');

  // Y lo retirado ya no se vota ni se aprueba: si no, la junta le daba igual el
  // prestamo que ella acababa de rechazar.
  const voto = await post('/api/registrar-voto', {
    solicitudId: solId, tipo: 'prestamo', grupoId: 'GPB', decision: 'aprobar',
  }, e.tokens.teso);
  t.status('lo retirado ya no se vota', voto, 409);
  t.check('y se dice por que',
    /retiro/i.test(voto.body?.message || ''), voto.body?.message);

  const otra = await post('/api/retirar-solicitud',
    { tipo: 'prestamo', id: solId }, e.tokens.socio1);
  t.status('retirarlo dos veces no hace nada', otra, 409);

  // ===================================================================
  t.section('PRE 12. El comprobante rechazado no deja su foto en el disco');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GPC' });
  prestamo('LN_R2', e.users.socio1.email, 'GPC', 200, 224, haceMeses(1));
  hoja.invalidarTodo();

  const comprobante = await subir(
    { loanId: 'LN_R2', amount: 56, paymentDate: hoy(), description: 'cuota' },
    e.tokens.socio1);
  t.status('la socia sube su comprobante', comprobante, 200);

  const fsMod = require('fs');
  const pathMod = require('path');
  const filaPago = fake.ensureSheet('LoanPayments').grid
    .find((r) => (r[0] || '') === comprobante.body?.paymentId) || [];
  const nombreFoto = (filaPago[7] || '').toString();
  const ruta = pathMod.join(__dirname, '..', 'uploads', 'payments', nombreFoto);
  t.check('la foto queda guardada', !!nombreFoto && fsMod.existsSync(ruta), ruta);

  await post('/api/approve-payment',
    { paymentId: comprobante.body?.paymentId, action: 'reject', notes: 'no se ve nada' },
    e.tokens.teso);
  t.check('rechazado, la foto se borra', !fsMod.existsSync(ruta), ruta);
  t.check('pero la fila se queda como prueba de que se reviso',
    !!fake.ensureSheet('LoanPayments').grid.find((r) => (r[0] || '') === comprobante.body?.paymentId),
    'la fila desaparecio');
};
