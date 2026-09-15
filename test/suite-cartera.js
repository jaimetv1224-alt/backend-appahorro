/**
 * SUITE 34 - La cartera del grupo y lo que se puede hacer con un prestamo.
 *
 * Un prestamo solo podia nacer y pagarse. Refinanciar, condonar, reprogramar,
 * anular uno mal dado y cobrar mora daban 404 los cinco, y son cosas que pasan
 * en cualquier banco comunal. Tampoco habia forma de que la tesoreria viera
 * quien debe: la unica manera de saber quien estaba atrasada era preguntarle a
 * cada socia.
 *
 * Lo que se fija aqui: que la mora se cobre sobre lo vencido y no dos veces,
 * que perdonar y reprogramar pasen SIEMPRE por la asamblea, que nadie mueva su
 * propio prestamo, y que lo que se aplica sea exactamente lo que se voto.
 */

const { PNG_PRUEBA, hoyLocal, seedWorkbook, get, post, postArchivo, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();
const foto = { campo: 'paymentImage', nombre: 'c.png', contenido: PNG_PRUEBA, tipo: 'image/png' };

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

function pago(id, email, loanId, monto, fecha) {
  fake.ensureSheet('LoanPayments').grid.push([
    id, email, loanId, monto, fecha, 'cuota', 'approved',
    '', '', '', '', new Date().toISOString(), 'teso@juntago.test', new Date().toISOString(), '',
  ]);
}

const filaLoan = (id) => fake.ensureSheet('Loans').grid.find((r) => (r[0] || '') === id) || [];

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

  /** Convoca, abre, propone el movimiento y lo vota. Devuelve el acuerdo. */
  async function hastaElAcuerdo(e, G, loanId, cuerpo, votantes) {
    const asa = await post('/api/gob/asambleas',
      { groupId: G, titulo: 'Prestamos', fechaProgramada: hoy(), modalidad: 'presencial' },
      e.tokens.presi);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/asistencia`, {
      groupId: G,
      registros: ['presi', 'teso', 'secre', 'socio1', 'socio2']
        .map((q) => ({ email: e.users[q].email, estado: 'presente' })),
    }, e.tokens.secre);
    await post(`/api/gob/asambleas/${asa.body?.asambleaId}/estado`,
      { estado: 'abierta', groupId: G }, e.tokens.presi);
    const prop = await post(`/api/gob/prestamo/${loanId}/proponer`,
      { ...cuerpo, asambleaId: asa.body?.asambleaId }, e.tokens.presi);
    for (const q of (votantes || ['presi', 'teso', 'secre', 'socio1', 'socio2'])) {
      await post(`/api/gob/acuerdos/${prop.body?.acuerdoId}/votar`, { groupId: G, voto: 'favor' }, e.tokens[q]);
    }
    hoja.invalidarTodo();
    return prop;
  }

  // ===================================================================
  t.section('CAR 1. La tesoreria ve quien debe y desde cuando');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'GK1' });
  let G = 'GK1';
  prestamo('LK_A', e.users.socio1.email, G, 300, 336, haceMeses(4), 6);   // muy atrasada
  prestamo('LK_B', e.users.socio2.email, G, 200, 224, haceMeses(1), 6);   // al dia
  prestamo('LK_C', e.users.secre.email, G, 100, 112, haceMeses(8), 6);
  pago('PK_C1', e.users.secre.email, 'LK_C', 112, haceMeses(1));          // saldado
  hoja.invalidarTodo();

  let cart = await get(`/api/gob/cartera?groupId=${G}`, e.tokens.teso);
  t.status('la tesoreria pide la cartera', cart, 200);
  t.eq('dos prestamos siguen vivos', cart.body?.resumen?.prestamosVivos, 2);
  t.near('por cobrar $560', cart.body?.resumen?.porCobrar, 560, 0.01);
  t.eq('y el saldado sale aparte', (cart.body?.cerrados || []).length, 1);
  t.eq('la mas atrasada va primero', (cart.body?.vivos || [])[0]?.loanId, 'LK_A');
  t.check('con nombre, no solo correo',
    !!(cart.body?.vivos || [])[0]?.nombre, JSON.stringify((cart.body?.vivos || [])[0] || {}));

  const carteraSocia = await get(`/api/gob/cartera?groupId=${G}`, e.tokens.socio1);
  t.status('una socia rasa no ve la cartera del grupo', carteraSocia, 403);

  // ===================================================================
  t.section('CAR 2. Sin mora acordada no se cobra mora');
  // ===================================================================
  t.near('la cartera no inventa recargos', cart.body?.resumen?.moraAcumulada, 0, 0.001);
  const sinAcordar = await post('/api/gob/prestamo/LK_A/mora', {}, e.tokens.teso);
  t.status('y cargarla se rechaza', sinAcordar, 409);
  t.eq('con su motivo', sinAcordar.body?.motivo, 'sin_mora_acordada');

  // ===================================================================
  t.section('CAR 3. La mora corre sobre lo vencido, no sobre el saldo entero');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GK3' });
  G = 'GK3';
  // $600 a 6 meses desde hace 4: cuotas de $100, cuatro vencidas.
  prestamo('LK_M', e.users.socio1.email, G, 550, 600, haceMeses(4), 6);
  await post('/api/gob/reglas',
    { groupId: G, moraPorcentajeMensual: 2, diasDeGracia: 0 }, e.tokens.presi);
  hoja.invalidarTodo();

  const ficha = await get('/api/gob/prestamo/LK_M', e.tokens.teso);
  t.status('la ficha del prestamo se lee', ficha, 200);
  t.eq('lleva cuatro cuotas vencidas', ficha.body?.prestamo?.resumen?.cuotasVencidas, 4);
  const mora = Number(ficha.body?.prestamo?.mora?.total || 0);
  t.check('y la mora es mayor que cero', mora > 0, `mora=${mora}`);
  // A mano: cuatro cuotas de $100 con 120, 90, 60 y 30 dias de retraso, al
  // 2% mensual (0,0667% al dia), son menos que la mora del saldo entero.
  t.check('pero mucho menor que la del saldo entero',
    mora < 600 * 0.02 * 4, `mora=${mora}`);
  t.eq('y se explica cuota por cuota', (ficha.body?.prestamo?.mora?.detalle || []).length, 4);

  // ===================================================================
  t.section('CAR 4. La mora se carga una vez y sube la deuda');
  // ===================================================================
  const pactado = Number(filaLoan('LK_M')[9]);
  const carga = await post('/api/gob/prestamo/LK_M/mora', {}, e.tokens.teso);
  t.status('la tesoreria carga la mora', carga, 200);
  t.near('carga exactamente lo devengado', carga.body?.cargado, mora, 0.02);
  // El recargo va en SU columna: el total pactado no se toca, para que las
  // cuotas no cambien de valor hacia atras por un retraso.
  t.near('el total pactado no se toca', Number(filaLoan('LK_M')[9]), pactado, 0.001);
  t.near('la mora queda en su columna', Number(filaLoan('LK_M')[10]), mora, 0.02);
  t.near('y lo que debe sube en esa cifra', carga.body?.totalDespues, pactado + mora, 0.02);

  hoja.invalidarTodo();
  const otraVez = await post('/api/gob/prestamo/LK_M/mora', {}, e.tokens.teso);
  t.status('cargarla otra vez el mismo dia no cobra dos veces', otraVez, 409);
  t.eq('con su motivo', otraVez.body?.motivo, 'nada_que_cargar');
  t.near('y la mora no se movio', Number(filaLoan('LK_M')[10]), mora, 0.02);

  const movs = fake.ensureSheet('PrestamoMovimientos').grid.filter((r) => (r[2] || '') === 'LK_M');
  t.eq('queda una sola fila de movimiento', movs.length, 1);
  t.eq('del tipo mora', movs[0][4], 'mora');
  t.near('que anota lo que debia', Number(movs[0][6]), pactado, 0.01);
  t.near('y lo que debe', Number(movs[0][7]), pactado + mora, 0.02);

  // Y la socia ve la misma cifra que la tesoreria, no una mas baja.
  const suyo = await get(`/api/obtener-prestamos?groupId=${G}&userEmail=${e.users.socio1.email}`,
    e.tokens.presi);
  t.near('la pantalla de la socia dice lo mismo',
    (suyo.body?.loans || [])[0]?.remainingBalance, pactado + mora, 0.02);
  t.near('con la mora nombrada aparte', (suyo.body?.loans || [])[0]?.mora, mora, 0.02);

  // ===================================================================
  t.section('CAR 5. Nadie se aplica mora a si misma');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GK5' });
  G = 'GK5';
  prestamo('LK_T', e.users.teso.email, G, 300, 336, haceMeses(4), 6);
  await post('/api/gob/reglas', { groupId: G, moraPorcentajeMensual: 2 }, e.tokens.presi);
  hoja.invalidarTodo();

  const suya = await post('/api/gob/prestamo/LK_T/mora', {}, e.tokens.teso);
  t.status('la tesorera no se carga la mora de su propio prestamo', suya, 403);
  t.eq('con su motivo', suya.body?.motivo, 'es_tu_deuda');
  const deOtra = await post('/api/gob/prestamo/LK_T/mora', {}, e.tokens.presi);
  t.status('otra persona de la junta si', deOtra, 200);

  // ===================================================================
  t.section('CAR 6. Condonar pasa por la asamblea, y con motivo escrito');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GK6' });
  G = 'GK6';
  prestamo('LK_P', e.users.socio1.email, G, 300, 336, haceMeses(3), 6);
  pago('PK_P1', e.users.socio1.email, 'LK_P', 100, haceMeses(1));
  hoja.invalidarTodo();

  const asa6 = await post('/api/gob/asambleas',
    { groupId: G, titulo: 'X', fechaProgramada: hoy(), modalidad: 'presencial' }, e.tokens.presi);
  const sinMotivo = await post('/api/gob/prestamo/LK_P/proponer',
    { tipo: 'condonacion', importe: 50, asambleaId: asa6.body?.asambleaId, motivo: 'porque si' },
    e.tokens.presi);
  t.status('sin explicar por que, no se lleva a votacion', sinMotivo, 400);
  t.eq('con su motivo', sinMotivo.body?.motivo, 'falta_motivo');

  const deMas = await post('/api/gob/prestamo/LK_P/proponer', {
    tipo: 'condonacion', importe: 999, asambleaId: asa6.body?.asambleaId,
    motivo: 'se le quemo el negocio y no puede pagar nada',
  }, e.tokens.presi);
  t.status('condonar mas de lo que debe se rechaza', deMas, 400);
  t.eq('con su motivo', deMas.body?.motivo, 'importe_excede');

  const socia = await post('/api/gob/prestamo/LK_P/proponer', {
    tipo: 'condonacion', importe: 50, asambleaId: asa6.body?.asambleaId,
    motivo: 'se le quemo el negocio y no puede pagar todo',
  }, e.tokens.socio1);
  t.status('una socia rasa no propone movimientos', socia, 403);

  const sinAcuerdo = await post('/api/gob/prestamo/LK_P/aplicar', { acuerdoId: '' }, e.tokens.presi);
  t.status('y sin acuerdo aprobado no se aplica nada', sinAcuerdo, 409);
  t.near('la deuda sigue intacta', Number(filaLoan('LK_P')[9]), 336, 0.01);

  // ===================================================================
  t.section('CAR 7. Con el acuerdo aprobado, la condonacion se aplica');
  // ===================================================================
  const prop7 = await hastaElAcuerdo(e, G, 'LK_P', {
    tipo: 'condonacion', importe: 50,
    motivo: 'se le quemo el negocio y la asamblea acuerda perdonarle una parte',
  });
  t.status('el punto se somete a la asamblea', prop7, 201);
  t.near('la propuesta dice como queda la deuda', prop7.body?.propuesta?.nuevoTotal, 286, 0.01);

  const apl7 = await post('/api/gob/prestamo/LK_P/aplicar',
    { acuerdoId: prop7.body?.acuerdoId }, e.tokens.presi);
  t.status('y se aplica', apl7, 200);
  t.near('la deuda baja de $336 a $286', Number(filaLoan('LK_P')[9]), 286, 0.01);
  t.near('asi que ya solo debe $186', apl7.body?.saldoDespues, 186, 0.01);

  hoja.invalidarTodo();
  const dosVeces = await post('/api/gob/prestamo/LK_P/aplicar',
    { acuerdoId: prop7.body?.acuerdoId }, e.tokens.presi);
  t.status('el mismo acuerdo no se ejecuta dos veces', dosVeces, 409);
  t.near('y la deuda no vuelve a bajar', Number(filaLoan('LK_P')[9]), 286, 0.01);

  // ===================================================================
  t.section('CAR 8. Reprogramar alarga el plazo sin cobrar mas');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GK8' });
  G = 'GK8';
  prestamo('LK_R', e.users.socio1.email, G, 300, 336, haceMeses(5), 6);
  pago('PK_R1', e.users.socio1.email, 'LK_R', 56, haceMeses(4));
  hoja.invalidarTodo();

  const prop8 = await hastaElAcuerdo(e, G, 'LK_R', {
    tipo: 'reprogramacion', plazoNuevo: 10,
    motivo: 'perdio el trabajo y pide mas plazo para poder ponerse al dia',
  });
  t.status('se somete la reprogramacion', prop8, 201);
  t.near('la cuota nueva es el saldo entre los meses nuevos',
    prop8.body?.propuesta?.cuotaNueva, 28, 0.01);

  await post('/api/gob/prestamo/LK_R/aplicar', { acuerdoId: prop8.body?.acuerdoId }, e.tokens.presi);
  hoja.invalidarTodo();
  t.near('la deuda total NO cambia', Number(filaLoan('LK_R')[9]), 336, 0.01);
  t.eq('el plazo pasa a 10 meses', Number(filaLoan('LK_R')[8]), 10);
  t.eq('y el calendario arranca hoy', (filaLoan('LK_R')[4] || '').slice(0, 10), hoy());

  const ficha8 = await get('/api/gob/prestamo/LK_R', e.tokens.socio1);
  t.eq('ya no arrastra cuotas vencidas', ficha8.body?.prestamo?.resumen?.cuotasVencidas, 0);
  t.eq('y la socia si puede ver su propio prestamo', ficha8.status, 200);

  const ajena = await get('/api/gob/prestamo/LK_R', e.tokens.socio2);
  t.status('pero no el de otra', ajena, 403);

  // ===================================================================
  t.section('CAR 9. Refinanciar vuelve a prestar el saldo, con interes nuevo');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GK9' });
  G = 'GK9';
  prestamo('LK_F', e.users.socio1.email, G, 300, 336, haceMeses(6), 6);
  pago('PK_F1', e.users.socio1.email, 'LK_F', 136, haceMeses(3));   // debe $200
  hoja.invalidarTodo();

  const prop9 = await hastaElAcuerdo(e, G, 'LK_F', {
    tipo: 'refinanciacion', plazoNuevo: 5,
    motivo: 'la asamblea acuerda volver a prestarle el saldo por cinco meses mas',
  });
  t.status('se somete la refinanciacion', prop9, 201);
  // $200 al 2% mensual por 5 meses son $20 de interes nuevo.
  t.near('el interes nuevo es $20', prop9.body?.propuesta?.nuevoSaldo, 220, 0.01);
  t.near('y el total pasa a $356', prop9.body?.propuesta?.nuevoTotal, 356, 0.01);
  t.check('se dice que ese interes es del grupo',
    /ganancia del grupo/i.test(prop9.body?.propuesta?.explicacion || ''),
    prop9.body?.propuesta?.explicacion);

  await post('/api/gob/prestamo/LK_F/aplicar', { acuerdoId: prop9.body?.acuerdoId }, e.tokens.presi);
  hoja.invalidarTodo();
  t.near('la hoja queda con el total nuevo', Number(filaLoan('LK_F')[9]), 356, 0.01);
  t.eq('con su plazo', Number(filaLoan('LK_F')[8]), 5);

  const rep9 = await get(`/api/gob/utilidades/reparto?groupId=${G}`, e.tokens.presi);
  t.check('y el motor de utilidades sigue cuadrando',
    Number(rep9.body?.ganancia?.total) >= 0 && rep9.status === 200,
    JSON.stringify(rep9.body?.ganancia || {}));

  // ===================================================================
  t.section('CAR 10. Anular solo vale si nunca se pago nada');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GKA' });
  G = 'GKA';
  prestamo('LK_N', e.users.socio1.email, G, 300, 336, haceMeses(2), 6);
  prestamo('LK_Y', e.users.socio2.email, G, 200, 224, haceMeses(2), 6);
  pago('PK_Y1', e.users.socio2.email, 'LK_Y', 40, haceMeses(1));
  hoja.invalidarTodo();

  const asaA = await post('/api/gob/asambleas',
    { groupId: G, titulo: 'X', fechaProgramada: hoy(), modalidad: 'presencial' }, e.tokens.presi);
  const conPagos = await post('/api/gob/prestamo/LK_Y/proponer', {
    tipo: 'anulacion', asambleaId: asaA.body?.asambleaId,
    motivo: 'se registro por error y queremos borrarlo del sistema',
  }, e.tokens.presi);
  t.status('un prestamo con pagos no se anula', conPagos, 409);
  t.eq('con su motivo', conPagos.body?.motivo, 'ya_tiene_pagos');
  t.check('y se explica que eso seria una condonacion',
    /condonacion/i.test(conPagos.body?.message || ''), conPagos.body?.message);

  const propA = await hastaElAcuerdo(e, G, 'LK_N', {
    tipo: 'anulacion',
    motivo: 'se registro el prestamo pero el dinero nunca salio de la caja',
  });
  await post('/api/gob/prestamo/LK_N/aplicar', { acuerdoId: propA.body?.acuerdoId }, e.tokens.presi);
  hoja.invalidarTodo();
  t.eq('el prestamo queda anulado', (filaLoan('LK_N')[7] || '').toLowerCase(), 'anulado');
  t.near('sin deuda', Number(filaLoan('LK_N')[9]), 0, 0.01);

  const cartA = await get(`/api/gob/cartera?groupId=${G}`, e.tokens.teso);
  t.eq('y deja de contar como prestamo vivo', cartA.body?.resumen?.prestamosVivos, 1);

  // ===================================================================
  t.section('CAR 11. No se aplica lo que ya no es cierto');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GKB' });
  G = 'GKB';
  prestamo('LK_X', e.users.socio1.email, G, 300, 336, haceMeses(3), 6);
  hoja.invalidarTodo();

  const propB = await hastaElAcuerdo(e, G, 'LK_X', {
    tipo: 'condonacion', importe: 100,
    motivo: 'la asamblea acuerda perdonarle cien dolares por su situacion',
  });
  // Entre la votacion y el pago, la tesoreria le carga mora.
  await post('/api/gob/reglas', { groupId: G, moraPorcentajeMensual: 2 }, e.tokens.presi);
  hoja.invalidarTodo();
  const cargaB = await post('/api/gob/prestamo/LK_X/mora', {}, e.tokens.teso);
  t.status('se carga mora despues de votar', cargaB, 200);
  hoja.invalidarTodo();

  const aplB = await post('/api/gob/prestamo/LK_X/aplicar',
    { acuerdoId: propB.body?.acuerdoId }, e.tokens.presi);
  t.status('lo votado ya no cuadra, asi que no se aplica a ciegas', aplB, 409);
  t.eq('con su motivo', aplB.body?.motivo, 'cuentas_cambiadas');
  t.check('y se dice que hay que volver a someterlo',
    /sometelo otra vez|vuelve a calcular/i.test(aplB.body?.message || ''), aplB.body?.message);

  // ===================================================================
  t.section('CAR 12. La socia ve su mora en lo que le toca');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GKC' });
  G = 'GKC';
  prestamo('LK_V', e.users.socio1.email, G, 300, 336, haceMeses(4), 6);
  await post('/api/gob/reglas', { groupId: G, moraPorcentajeMensual: 3 }, e.tokens.presi);
  hoja.invalidarTodo();

  const comp = await get(`/api/gob/mi-compromiso?groupId=${G}`, e.tokens.socio1);
  t.status('la socia mira lo que le toca', comp, 200);
  t.check('y ve el recargo por el retraso',
    Number(comp.body?.prestamos?.mora) > 0, JSON.stringify(comp.body?.prestamos || {}));
  t.check('nombrado en la frase',
    /mora|retraso/i.test(comp.body?.mensaje || ''), comp.body?.mensaje);

  // Y con el prestamo al dia, ni una palabra de mora.
  preparar();
  e = await baseScenario({ groupId: 'GKD' });
  prestamo('LK_W', e.users.socio1.email, 'GKD', 300, 336, hoy(), 6);
  await post('/api/gob/reglas', { groupId: 'GKD', moraPorcentajeMensual: 3 }, e.tokens.presi);
  hoja.invalidarTodo();
  const alDia = await get('/api/gob/mi-compromiso?groupId=GKD', e.tokens.socio1);
  t.near('quien esta al dia no paga recargo', alDia.body?.prestamos?.mora, 0, 0.001);
  t.check('ni se le menciona',
    !/mora/i.test(alDia.body?.mensaje || ''), alDia.body?.mensaje);

  // Un comprobante todavia sirve para pagar despues de todo esto.
  const sube = await postArchivo('/api/upload-payment',
    { loanId: 'LK_W', amount: 56, paymentDate: hoy(), description: 'cuota 1' },
    foto, e.tokens.socio1);
  t.status('y el prestamo sigue admitiendo pagos', sube, 200);

  // ===================================================================
  t.section('CAR 13. Subir la mora encarece prestamos ya dados: lo vota la asamblea');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GKE' });
  G = 'GKE';
  // Primera vez: el grupo no tenia mora, asi que fijarla es un cambio normal.
  const primera = await post('/api/gob/reglas',
    { groupId: G, moraPorcentajeMensual: 2 }, e.tokens.presi);
  t.status('la primera vez se fija sin mas', primera, 200);
  hoja.invalidarTodo();

  const alAlza = await post('/api/gob/reglas',
    { groupId: G, moraPorcentajeMensual: 8 }, e.tokens.presi);
  t.status('subirla despues necesita acuerdo', alAlza, 409);
  t.eq('con su motivo', alAlza.body?.motivo, 'mora_al_alza');
  t.check('y se dice por que, sin hablar de "relajar el control"',
    /encarece los prestamos que ya estan dados/i.test(alAlza.body?.message || ''),
    alAlza.body?.message);

  const alaBaja = await post('/api/gob/reglas',
    { groupId: G, moraPorcentajeMensual: 1 }, e.tokens.presi);
  t.status('bajarla no necesita nada: favorece a las socias', alaBaja, 200);
  t.near('y queda bajada', alaBaja.body?.reglas?.moraPorcentajeMensual, 1, 0.001);

  const tope = await post('/api/gob/reglas',
    { groupId: G, moraPorcentajeMensual: 99 }, e.tokens.presi);
  t.check('un recargo desbocado no pasa',
    tope.status !== 200 || Number(tope.body?.reglas?.moraPorcentajeMensual) <= 10,
    JSON.stringify(tope.body?.reglas || {}));
};
