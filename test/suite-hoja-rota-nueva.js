/**
 * SUITE 40 - Las hojas nuevas, editadas a mano.
 *
 * La base de datos de este proyecto es una hoja de cálculo que abren las
 * tesoreras. Escriben en ella, corrigen, copian y pegan, borran una fila sin
 * querer y a veces escriben "diez dólares" donde va un número. Eso no es un
 * caso raro: es el uso normal.
 *
 * Las hojas viejas ya tenían su batería. Estas son las que se añadieron
 * después — la mora en su columna, los movimientos del préstamo, la caja, los
 * avales, el cierre del grupo — y aquí se comprueba lo mismo que allí:
 *
 *   - la app NUNCA revienta con un 500;
 *   - NUNCA se inventa dinero a partir de una celda ilegible;
 *   - y dice algo que se entiende.
 *
 * Un texto en la columna de la mora tiene que valer cero, no NaN; un estado
 * escrito en mayúsculas tiene que reconocerse; y una pestaña borrada no puede
 * tumbar la pantalla de las demás.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const hoy = () => hoyLocal();

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

function prestamo(id, email, grupo, principal, total, inicio, mora) {
  fake.ensureSheet('Loans').grid.push([
    id, email, grupo, principal, inicio, '', 2, 'aprobado', 6, total, mora,
  ]);
}

/**
 * Ninguna respuesta puede ser un 500 ni traer NaN o undefined a la vista.
 *
 * `null` SI puede aparecer: `proximaCuota: null` quiere decir "no hay cuota
 * siguiente", y es la respuesta correcta. Lo que delata una celda ilegible mal
 * leida es NaN o undefined.
 */
function sano(titulo, res) {
  t.check(`${titulo}: no revienta`, res.status !== 500,
    `HTTP ${res.status} ${JSON.stringify(res.body || res.text || '').slice(0, 160)}`);
  const texto = JSON.stringify(res.body || {});
  const roto = /"(NaN|Infinity|-Infinity|undefined)"|:\s*(NaN|undefined)/.test(texto);
  t.check(`${titulo}: sin NaN ni undefined en las cifras`, !roto, texto.slice(0, 220));
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

  // ===================================================================
  t.section('ROT 1. Texto en la columna de la mora');
  // ===================================================================
  preparar();
  let e = await baseScenario({ groupId: 'GR1' });
  ahorro(e.users.socio1.email, 'GR1', 300, haceMeses(3));
  // Alguien escribio a mano en la columna que lleva los recargos.
  prestamo('LR_TXT', e.users.socio1.email, 'GR1', 200, 224, haceMeses(3), 'diez dolares');
  prestamo('LR_NEG', e.users.socio2.email, 'GR1', 100, 112, haceMeses(3), -50);
  prestamo('LR_COMA', e.users.secre.email, 'GR1', 100, 112, haceMeses(3), '3,50');
  hoja.invalidarTodo();

  const cartera = await get('/api/gob/cartera?groupId=GR1', e.tokens.teso);
  sano('la cartera con la mora ilegible', cartera);
  const porId = {};
  (cartera.body?.vivos || []).forEach((x) => { porId[x.loanId] = x; });
  t.near('el texto vale cero, no NaN', porId.LR_TXT?.moraCargada, 0, 0.001);
  t.near('y la deuda es la pactada', porId.LR_TXT?.saldo, 224, 0.01);
  t.check('una mora negativa no le regala dinero a nadie',
    Number(porId.LR_NEG?.saldo) >= 112 - 0.01, `${porId.LR_NEG?.saldo}`);
  t.near('y la coma decimal se entiende como en la hoja', porId.LR_COMA?.moraCargada, 3.5, 0.01);

  const suPrestamo = await get('/api/obtener-prestamos?groupId=GR1', e.tokens.presi);
  sano('la lista de prestamos', suPrestamo);
  const desdeLista = (suPrestamo.body?.loans || []).find((x) => x.loanId === 'LR_TXT');
  t.near('la socia ve la misma deuda que la tesoreria', desdeLista?.remainingBalance, 224, 0.01);

  const rep1 = await get('/api/gob/utilidades/reparto?groupId=GR1', e.tokens.presi);
  sano('el reparto', rep1);
  t.check('el reparto no inventa ganancia con una mora ilegible',
    Number(rep1.body?.ganancia?.total) >= 0, `${rep1.body?.ganancia?.total}`);

  // ===================================================================
  t.section('ROT 2. El reglamento con cifras imposibles');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GR2' });
  // Escrito a mano en la pestana del reglamento.
  fake.ensureSheet('GrupoReglas').grid.push([
    'GR2', 'si', 'si', 2, 3, 1, 20, 0, 60, 'x@x.test', new Date().toISOString(),
    'acciones', 'una', 'el quince', 'mucha mora', -30,
  ]);
  ahorro(e.users.socio1.email, 'GR2', 100, haceMeses(2));
  prestamo('LR2', e.users.socio1.email, 'GR2', 100, 112, haceMeses(3), '');
  hoja.invalidarTodo();

  const reglas = await get('/api/gob/reglas?groupId=GR2', e.tokens.socio1);
  sano('el reglamento', reglas);
  t.eq('"una" accion al mes se lee como cero, no como NaN',
    reglas.body?.reglas?.accionesMinimasPorMes, 0);
  t.eq('"el quince" tampoco fija un dia', reglas.body?.reglas?.diaDeAsamblea, 0);
  t.near('"mucha mora" es cero por ciento', reglas.body?.reglas?.moraPorcentajeMensual, 0, 0.001);
  t.eq('y los dias de gracia negativos son cero', reglas.body?.reglas?.diasDeGracia, 0);

  const comp = await get('/api/gob/mi-compromiso?groupId=GR2', e.tokens.socio1);
  sano('lo que me toca', comp);
  t.near('con el reglamento ilegible no se le cobra nada inventado',
    comp.body?.acciones?.aPagar, 0, 0.001);

  const mora = await post('/api/gob/prestamo/LR2/mora', {}, e.tokens.teso);
  t.status('y no se puede cargar una mora que el grupo no acordo', mora, 409);
  t.eq('con su motivo', mora.body?.motivo, 'sin_mora_acordada');

  // ===================================================================
  t.section('ROT 3. La caja con estados escritos a mano');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GR3' });
  ahorro(e.users.socio1.email, 'GR3', 100, haceMeses(2));
  prestamo('LR3', e.users.socio2.email, 'GR3', 100, 112, haceMeses(3), '');
  fake.ensureSheet('LoanPayments').grid.push([
    'LR3_P', e.users.socio2.email, 'LR3', 112, haceMeses(1), 'cuota', 'approved',
    '', '', '', '', new Date().toISOString(), 'teso@juntago.test', new Date().toISOString(), '',
  ]);
  // Filas de caja escritas a mano, con mayusculas, importes de texto y sin correo.
  const caja = fake.ensureSheet('CajaMovimientos');
  caja.grid.push(['m1', 'GR3', 'GASTO', '', 'pasajes', 'cinco', 'APLICADO',
    '', '', 'x@x.test', new Date().toISOString(), '', '', '']);
  caja.grid.push(['m2', 'GR3', 'gasto', '', 'cuaderno', 3, 'Aplicado',
    '', '', 'x@x.test', new Date().toISOString(), '', '', '']);
  caja.grid.push(['m3', 'GR3', 'multa', '', 'sin decir a quien', 2, 'cobrada',
    '', '', 'x@x.test', new Date().toISOString(), '', '', '']);
  caja.grid.push(['m4', 'GR3', 'invento', '', 'ni idea', 99, 'aplicado',
    '', '', 'x@x.test', new Date().toISOString(), '', '', '']);
  hoja.invalidarTodo();

  const verCaja = await get('/api/gob/caja?groupId=GR3', e.tokens.socio1);
  sano('la caja', verCaja);
  t.near('el gasto de "cinco" vale cero, no NaN', verCaja.body?.resumen?.gastos, 3, 0.01);

  const rep3 = await get('/api/gob/utilidades/reparto?groupId=GR3', e.tokens.presi);
  sano('el reparto con la caja rota', rep3);
  t.near('el grupo gano $12', rep3.body?.ganancia?.total, 12, 0.01);
  t.check('y lo repartible nunca sale negativo',
    Number(rep3.body?.ganancia?.porRepartir) >= 0, `${rep3.body?.ganancia?.porRepartir}`);
  t.check('un tipo inventado no mueve la caja',
    Number(rep3.body?.ganancia?.gastos) <= 5, `${rep3.body?.ganancia?.gastos}`);

  // ===================================================================
  t.section('ROT 4. Avales escritos a mano');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GR4' });
  ahorro(e.users.socio1.email, 'GR4', 300, haceMeses(2));
  const av = fake.ensureSheet('Avales');
  av.grid.push(['a1', 'GR4', e.users.socio2.email, e.users.socio1.email,
    'doscientos', 'APROBADO', '', '', 'x@x.test', new Date().toISOString(), '', '', 'sin numero']);
  av.grid.push(['a2', 'GR4', e.users.secre.email, e.users.socio1.email,
    -100, 'aprobado', '', '', 'x@x.test', new Date().toISOString(), '', '', 'negativo']);
  hoja.invalidarTodo();

  const lista = await get('/api/gob/avales?groupId=GR4', e.tokens.socio1);
  sano('la lista de avales', lista);

  const cupoAvalada = await get('/api/mi-cupo?groupId=GR4', e.tokens.socio2);
  sano('el cupo de la avalada', cupoAvalada);
  t.near('un aval de "doscientos" no le da cupo inventado',
    cupoAvalada.body?.disponible, 0, 0.01);

  const cupoAvaladora = await get('/api/mi-cupo?groupId=GR4', e.tokens.socio1);
  sano('el cupo de quien avala', cupoAvaladora);
  t.check('y a ella no le queda un cupo negativo',
    Number(cupoAvaladora.body?.disponible) >= 0, `${cupoAvaladora.body?.disponible}`);

  // ===================================================================
  t.section('ROT 5. El cierre del grupo con el detalle ilegible');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GR5' });
  ahorro(e.users.socio1.email, 'GR5', 100, haceMeses(2));
  fake.ensureSheet('CierresGrupo').grid.push([
    'cg_roto', 'GR5', 'borrador', 'x@x.test', new Date().toISOString(), '', '', '', '',
    'cinco', 'mucho', '{esto no es json', 'a mano',
  ]);
  hoja.invalidarTodo();

  const cierre = await get('/api/gob/grupo/cierre?groupId=GR5', e.tokens.presi);
  sano('el estado del cierre', cierre);
  t.check('el detalle ilegible se lee como vacio, no tumba la pantalla',
    Array.isArray(cierre.body?.abierto?.detalle), JSON.stringify(cierre.body?.abierto || {}));

  const otro = await post('/api/gob/grupo/cierre/calcular', { groupId: 'GR5' }, e.tokens.presi);
  t.status('y con uno a medias no se abre otro', otro, 409);
  t.eq('con su motivo', otro.body?.motivo, 'ya_calculado');

  // ===================================================================
  t.section('ROT 6. Una pestana borrada no tumba las demas');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GR6' });
  ahorro(e.users.socio1.email, 'GR6', 200, haceMeses(2));
  prestamo('LR6', e.users.socio1.email, 'GR6', 100, 112, haceMeses(2), '');
  hoja.invalidarTodo();

  // Alguien borro la pestana de movimientos del prestamo.
  fake.store.sheets.delete('PrestamoMovimientos');
  hoja.invalidarTodo();

  const fichaSinHoja = await get('/api/gob/prestamo/LR6', e.tokens.teso);
  sano('la ficha del prestamo sin la pestana de movimientos', fichaSinHoja);
  t.status('la pantalla sigue abriendo', fichaSinHoja, 200);

  const carteraSinHoja = await get('/api/gob/cartera?groupId=GR6', e.tokens.teso);
  t.status('y la cartera tambien', carteraSinHoja, 200);

  // Y la de caja.
  fake.store.sheets.delete('CajaMovimientos');
  hoja.invalidarTodo();
  const repSinCaja = await get('/api/gob/utilidades/reparto?groupId=GR6', e.tokens.presi);
  sano('el reparto sin la pestana de caja', repSinCaja);
  t.status('el reparto sigue respondiendo', repSinCaja, 200);
  t.near('sin descontar gastos que ya no se pueden leer',
    repSinCaja.body?.ganancia?.gastos, 0, 0.001);

  // ===================================================================
  t.section('ROT 7. Un prestamo con el estado escrito en mayusculas');
  // ===================================================================
  preparar();
  e = await baseScenario({ groupId: 'GR7' });
  ahorro(e.users.socio1.email, 'GR7', 200, haceMeses(2));
  fake.ensureSheet('Loans').grid.push([
    'LR7', e.users.socio1.email, 'GR7', 100, haceMeses(3), '', 2, 'APROBADO', 6, 112, '',
  ]);
  fake.ensureSheet('Loans').grid.push([
    'LR7B', e.users.socio2.email, 'GR7', 100, haceMeses(3), '', 2, ' Aprobado ', 6, 112, '',
  ]);
  hoja.invalidarTodo();

  const c7 = await get('/api/gob/cartera?groupId=GR7', e.tokens.teso);
  sano('la cartera con estados en mayusculas', c7);
  t.eq('los dos prestamos cuentan como vivos', c7.body?.resumen?.prestamosVivos, 2);

  const cerrar = await post('/api/gob/grupo/cierre/calcular', { groupId: 'GR7' }, e.tokens.presi);
  t.status('y frenan el cierre del grupo, como debe ser', cerrar, 409);
  t.eq('con su motivo', cerrar.body?.motivo, 'faltan_cosas');
};
