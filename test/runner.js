/** Micro framework de pruebas: secciones, aserciones y resumen final. */

const state = {
  section: '',
  results: [],
  failures: [],
  // Suites que murieron a medias. Importa mucho mas de lo que parece: cuando
  // una suite lanza, las secciones que venian detras NO se ejecutan, asi que el
  // numero de fallas deja de ser el numero de problemas. Se puede leer "1 falla"
  // cuando habia cuatro esperando dos lineas mas abajo. Sin esto, arreglar el
  // primero y ver la bateria en verde da una seguridad que no existe.
  abortadas: [],
  // Cuantas comprobaciones aporto cada suite en ESTA corrida. Se compara con lo
  // que aporto la ultima vez que todo salio limpio, y se avisa si baja.
  //
  // El aviso de suite abortada no cubre el caso peor: una suite que deja de
  // ejecutar bloques SIN lanzar nada (un `return` que se cuela, una condicion
  // que se vuelve falsa, un bucle que no entra). Eso no revienta, no sale en
  // rojo, y la bateria dice OK con veinte comprobaciones menos. Contarlas es lo
  // unico que lo enseña.
  suite: '',
  porSuite: new Map(),
};

function section(name) {
  state.section = name;
  process.stdout.write(`\n\x1b[1m--- ${name} ---\x1b[0m\n`);
}

/** Empieza una suite. Sirve para contar cuanto aporto cada una. */
function suite(name) {
  state.suite = name;
  if (!state.porSuite.has(name)) state.porSuite.set(name, 0);
}

function record(ok, title, detail) {
  state.results.push({ section: state.section, title, ok, detail });
  if (state.suite) state.porSuite.set(state.suite, (state.porSuite.get(state.suite) || 0) + 1);
  if (ok) {
    process.stdout.write(`  \x1b[32mOK\x1b[0m   ${title}\n`);
  } else {
    state.failures.push({ section: state.section, title, detail });
    process.stdout.write(`  \x1b[31mFALLA\x1b[0m ${title}\n         -> ${detail}\n`);
  }
}

function check(title, condition, detail = '') {
  record(!!condition, title, detail || 'condicion falsa');
  return !!condition;
}

function eq(title, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  record(ok, title, `esperado ${JSON.stringify(expected)}, obtenido ${JSON.stringify(actual)}`);
  return ok;
}

function near(title, actual, expected, tol = 0.011) {
  const ok = Math.abs(Number(actual) - Number(expected)) <= tol;
  record(ok, title, `esperado ~${expected}, obtenido ${actual}`);
  return ok;
}

function status(title, res, expected) {
  const ok = res.status === expected;
  record(ok, title, `esperado HTTP ${expected}, obtenido ${res.status} ${JSON.stringify(res.body || res.text || '').slice(0, 300)}`);
  return ok;
}

/** Acepta cualquiera de varios codigos (util cuando 400/403 son ambos correctos). */
function statusIn(title, res, expectedList) {
  const ok = expectedList.includes(res.status);
  record(ok, title, `esperado uno de ${expectedList.join('/')}, obtenido ${res.status} ${JSON.stringify(res.body || '').slice(0, 300)}`);
  return ok;
}

/** Una suite murio a medias: lo que venia detras no llego a ejecutarse. */
function abortada(suiteNombre, ultimaSeccion, error) {
  state.abortadas.push({ suite: suiteNombre, ultimaSeccion, error });
}

const fs = require('fs');
const path = require('path');
const BASE = path.resolve(__dirname, '.cobertura-base.json');

/** Lo que aporto cada suite la ultima vez que la bateria salio limpia. */
function leerBase() {
  try {
    return JSON.parse(fs.readFileSync(BASE, 'utf8'));
  } catch (e) {
    return null;   // primera corrida en este equipo: todavia no hay con que comparar
  }
}

/**
 * Cuando la bajada es a proposito (se retiro una prueba que ya no aplica, se
 * fundieron dos suites) hace falta poder aceptarla:
 *
 *     node test/run-all.js --aceptar-cobertura
 *
 * Sin esta salida la primera bajada legitima dejaba la bateria en rojo PARA
 * SIEMPRE, porque la foto solo se actualiza tras una corrida impecable y la
 * corrida nunca vuelve a serlo. Una salvaguarda de la que no se puede salir no
 * se respeta: se borra. Y que aceptar sea un acto explicito es justo lo que
 * hace que la bajada se mire en vez de pasar sola.
 */
const ACEPTAR = process.argv.includes('--aceptar-cobertura');

/**
 * Guarda la foto SOLO si la corrida fue impecable. Guardarla tras una corrida
 * con fallas o abortos congelaria como normal una cobertura ya degradada, que
 * es justo lo que se quiere detectar.
 */
function guardarBase() {
  try {
    fs.writeFileSync(BASE, `${JSON.stringify(Object.fromEntries(state.porSuite), null, 2)}\n`, 'utf8');
  } catch (e) { /* si no se puede escribir, se sigue: es una ayuda, no un requisito */ }
}

function summary() {
  const total = state.results.length;
  const failed = state.failures.length;
  const passed = total - failed;
  process.stdout.write(`\n\x1b[1m=================== RESUMEN ===================\x1b[0m\n`);
  if (state.abortadas.length) {
    process.stdout.write(`\n\x1b[31m\x1b[1mEJECUCION INCOMPLETA\x1b[0m\n`);
    process.stdout.write('  El numero de fallas NO es el numero de problemas: estas suites\n');
    process.stdout.write('  murieron a medias y lo que venia detras no llego a ejecutarse.\n');
    for (const a of state.abortadas) {
      process.stdout.write(`    - ${a.suite}\n`);
      process.stdout.write(`      murio en: ${a.ultimaSeccion || '(antes de la primera seccion)'}\n`);
      process.stdout.write(`      motivo:   ${a.error}\n`);
    }
    process.stdout.write('\n');
  }
  // Suites que aportaron MENOS que la ultima vez que todo salio limpio. Una
  // suite puede dejar de ejecutar bloques sin lanzar nada, y entonces no hay
  // rojo ninguno: solo faltan comprobaciones que nadie echa de menos.
  const base = leerBase();
  const menguadas = [];
  if (base) {
    for (const [nombre, antes] of Object.entries(base)) {
      const ahora = state.porSuite.get(nombre);
      if (ahora === undefined || ahora < antes) menguadas.push({ nombre, antes, ahora: ahora || 0 });
    }
  }
  if (menguadas.length) {
    const color = ACEPTAR ? '\x1b[33m' : '\x1b[31m';
    process.stdout.write(`\n${color}\x1b[1mCOBERTURA A LA BAJA${ACEPTAR ? ' (aceptada a mano)' : ''}\x1b[0m\n`);
    process.stdout.write('  Estas suites ejecutaron MENOS comprobaciones que la ultima vez que\n');
    process.stdout.write('  la bateria salio limpia. Puede que ya no esten corriendo todo.\n');
    for (const m of menguadas) {
      process.stdout.write(`    - ${m.nombre}: ${m.ahora} ahora, ${m.antes} antes\n`);
    }
    if (ACEPTAR) {
      process.stdout.write('  Se acepta por --aceptar-cobertura y pasa a ser la nueva referencia.\n');
    } else {
      process.stdout.write('  Si la bajada es a proposito: node test/run-all.js --aceptar-cobertura\n');
    }
    process.stdout.write('\n');
  }

  process.stdout.write(`  Pruebas: ${total}   \x1b[32mOK: ${passed}\x1b[0m   \x1b[31mFALLAS: ${failed}\x1b[0m\n`);
  if (failed) {
    process.stdout.write(`\n\x1b[31mFallas:\x1b[0m\n`);
    for (const f of state.failures) {
      process.stdout.write(`  [${f.section}] ${f.title}\n      ${f.detail}\n`);
    }
  }
  process.stdout.write(`\x1b[1m===============================================\x1b[0m\n`);

  // La foto de referencia solo se actualiza si TODO salio bien. Guardarla tras
  // una corrida degradada haria que la degradacion pasara a ser lo normal.
  // La unica excepcion es una bajada aceptada a mano, que es un acto explicito.
  const limpia = !failed && !state.abortadas.length;
  if (limpia && (!menguadas.length || ACEPTAR)) guardarBase();

  return failed + (ACEPTAR ? 0 : menguadas.length);
}

module.exports = { section, suite, check, eq, near, status, statusIn, summary, abortada, state };
