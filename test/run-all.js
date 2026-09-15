/**
 * Ejecuta todas las baterias de prueba del backend contra el emulador de
 * Google Sheets. No toca la hoja real ni consume cuota.
 *
 *   node test/run-all.js            (silencioso)
 *   node test/run-all.js --verbose  (con los logs del servidor)
 */

const fs = require('fs');
const path = require('path');
const { startServer, cobertura } = require('./harness');
const t = require('./runner');

const SUITES = [
  ['Nucleo y regresiones', require('./suite-core')],
  ['Control interno (gobernanza)', require('./suite-gobernanza')],
  ['Ciclo completo del grupo', require('./suite-ciclo')],
  ['Compatibilidad con datos existentes', require('./suite-compat')],
  ['Consistencia entre usuarios', require('./suite-consistencia')],
  ['Concurrencia (dos personas a la vez)', require('./suite-concurrencia')],
  ['Calculos y limites numericos', require('./suite-calculos')],
  ['Persistencia en la hoja', require('./suite-persistencia')],
  ['Administracion y permisos', require('./suite-admin')],
  ['Separacion: el admin no gobierna grupos', require('./suite-separacion')],
  ['Un grupo que arranca sin tesoreria', require('./suite-sin-tesoreria')],
  ['Endurecimiento: que no la tumben', require('./suite-endurecimiento')],
  ['Autogestion: el grupo se gobierna solo', require('./suite-autogestion')],
  ['La hoja la edita gente (hoja rota)', require('./suite-hoja-rota')],
  ['Reparto mes a mes y freno de cuota', require('./suite-reparto-mensual')],
  ['Con la memoria y el freno de produccion', require('./suite-produccion')],
  ['Cierres, fechas y reglas del reglamento', require('./suite-cierres')],
  ['Traspaso desde el papel (apertura completa)', require('./suite-apertura')],
  ['Aritmetica del dinero (intereses mes a mes)', require('./suite-utilidades')],
  ['Cuadro de cuotas de los prestamos', require('./suite-cuotas')],
  ['Coherencia: la misma cifra en todas partes', require('./suite-coherencia')],
  ['Reparto de utilidades entre los socios', require('./suite-reparto')],
  ['Auditoria adversarial de lo nuevo', require('./suite-adversarial')],
  ['Seguridad: abuso, fugas e inyeccion', require('./suite-seguridad')],
  ['Accesos y participantes (panel de plataforma)', require('./suite-accesos')],
  ['Indicadores para evaluar la plataforma', require('./suite-metricas')],
  ['Indicadores contra datos sucios', require('./suite-metricas-dura')],
  ['Digitalizacion de los grupos', require('./suite-digitalizacion')],
  ['Deshacer lo mal revisado (comprobantes y puntos de asamblea)', require('./suite-anulaciones')],
  ['La socia que se va cobra lo suyo', require('./suite-salidas')],
  ['Lo que me toca este ciclo', require('./suite-compromiso')],
  ['Repartir todo, una parte, o nada', require('./suite-acumular')],
  ['El ciclo del prestamo, de punta a punta', require('./suite-prestamos-ciclo')],
  ['Cartera del grupo y movimientos del prestamo', require('./suite-cartera')],
  ['Gastos y multas que mueven la caja', require('./suite-caja')],
  ['Cerrar el grupo y avalar', require('./suite-cierre-grupo')],
  ['El paquete que se sube a Hostinger', require('./suite-empaquetado')],
  ['Retirar lo propuesto por error', require('./suite-retirar-propuestas')],
  ['Informe del proyecto (descarga admin)', require('./suite-informe-proyecto')],
  ['Un anio entero del grupo, con todo a la vez', require('./suite-anio-completo')],
  ['Blindaje de permisos de lo nuevo', require('./suite-blindaje')],
  ['Las hojas nuevas, editadas a mano', require('./suite-hoja-rota-nueva')],
];

(async () => {
  await startServer();
  const inicio = Date.now();

  for (const [nombre, run] of SUITES) {
    process.stdout.write(`\n\x1b[1m\x1b[36m########## ${nombre} ##########\x1b[0m\n`);
    try {
      await run();
    } catch (err) {
      t.section(`${nombre} (ERROR)`);
      t.check('la bateria termino sin excepciones', false, `${err.message}\n${err.stack}`);
    }
  }

  // --- Cobertura de endpoints -------------------------------------------
  const fuente = fs.readFileSync(path.resolve(__dirname, '..', 'server.js'), 'utf8')
    + fs.readFileSync(path.resolve(__dirname, '..', 'governance.js'), 'utf8')
    + fs.readFileSync(path.resolve(__dirname, '..', 'informe.js'), 'utf8');
  // digitalizacion.js y metricas.js no registran rutas: son calculo puro
  const registrados = [...fuente.matchAll(/app\.(get|post|put|delete|patch)\(\s*'([^']+)'/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`);
  const unicos = [...new Set(registrados)];
  const tocado = (ruta) => {
    const [metodo, patron] = ruta.split(' ');
    const rx = new RegExp('^' + patron.replace(/:[A-Za-z_]+/g, '[^/]+') + '$');
    return [...cobertura].some((c) => {
      const [m, u] = c.split(' ');
      return m === metodo && rx.test(u);
    });
  };
  const sinProbar = unicos.filter((r) => !tocado(r)).sort();
  const cubiertos = unicos.length - sinProbar.length;
  const pct = Math.round((cubiertos / unicos.length) * 100);

  const informe = [''];
  informe.push('\x1b[1mCobertura de endpoints: ' + cubiertos + '/' + unicos.length + ' (' + pct + '%)\x1b[0m');
  if (sinProbar.length) {
    informe.push('  Sin probar por ninguna bateria:');
    sinProbar.forEach((r) => informe.push('    ' + r));
  } else {
    informe.push('  Todos los endpoints estan cubiertos.');
  }
  process.stdout.write(informe.join('\n') + '\n');

  const segundos = ((Date.now() - inicio) / 1000).toFixed(1);
  process.stdout.write(`\nTiempo total: ${segundos}s\n`);
  const fallos = t.summary();
  process.exit(fallos > 0 ? 1 : 0);
})().catch((err) => {
  console.error('\nERROR FATAL:', err);
  process.exit(2);
});
