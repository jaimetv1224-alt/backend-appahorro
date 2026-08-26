/** Micro framework de pruebas: secciones, aserciones y resumen final. */

const state = {
  section: '',
  results: [],
  failures: [],
};

function section(name) {
  state.section = name;
  process.stdout.write(`\n\x1b[1m--- ${name} ---\x1b[0m\n`);
}

function record(ok, title, detail) {
  state.results.push({ section: state.section, title, ok, detail });
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

function summary() {
  const total = state.results.length;
  const failed = state.failures.length;
  const passed = total - failed;
  process.stdout.write(`\n\x1b[1m=================== RESUMEN ===================\x1b[0m\n`);
  process.stdout.write(`  Pruebas: ${total}   \x1b[32mOK: ${passed}\x1b[0m   \x1b[31mFALLAS: ${failed}\x1b[0m\n`);
  if (failed) {
    process.stdout.write(`\n\x1b[31mFallas:\x1b[0m\n`);
    for (const f of state.failures) {
      process.stdout.write(`  [${f.section}] ${f.title}\n      ${f.detail}\n`);
    }
  }
  process.stdout.write(`\x1b[1m===============================================\x1b[0m\n`);
  return failed;
}

module.exports = { section, check, eq, near, status, statusIn, summary, state };
