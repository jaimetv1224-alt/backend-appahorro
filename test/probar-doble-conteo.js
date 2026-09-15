#!/usr/bin/env node
/**
 * Comprueba si las utilidades se cuentan DOS VECES.
 *
 * El sistema tiene dos cosas que se llaman igual:
 *   1. `calcularUtilidadesProgresivas`, que abona un % teorico sobre las
 *      acciones mes a mes. Es lo que devuelve `totalUtilidades`.
 *   2. El reparto real de lo que el grupo gano prestando, que se abona como
 *      filas de ahorro tipo 'utilidad' y por tanto entra en `totalAhorros`.
 *
 * Si las dos siguen activas, el patrimonio de cada socio suma el mismo dinero
 * por partida doble.
 */

process.env.TEST_PORT = '3994';

const { seedWorkbook, startServer, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const { SHEETS } = require('../governance');
const fs = require('fs');

// process.exit() corta lo que queda por escribir en pantalla: se acumula
// todo y se vuelca de golpe a un archivo antes de salir.
const salida = [];
const log = (t = '') => { salida.push(t); };

const hace = (n) => {
  const d = new Date();
  d.setDate(10);
  d.setMonth(d.getMonth() - n);
  return d.toISOString().split('T')[0];
};

(async () => {
  seedWorkbook();
  Object.values(SHEETS).forEach((d) => fake.seedSheet(d.name, [d.headers]));
  await startServer();

  const e = await baseScenario({ groupId: 'GX' });
  const presi = e.users.presi;

  // La presidencia tiene 50 acciones de $10 = $500
  fake.ensureSheet('Acciones').grid.push([
    presi.email, 'GX', hace(4), 50, 10, 2, new Date().toISOString(),
    'confirmado', 'x@x', 'y@y', new Date().toISOString(), 'a1', '',
  ]);
  // Un prestamo saldado que dejo $50 de interes al grupo
  fake.ensureSheet('Loans').grid.push([
    'L1', e.users.socio1.email, 'GX', 500, hace(6),
    new Date().toISOString(), 2, 'aprobado', 5, 550,
  ]);
  fake.ensureSheet('LoanPayments').grid.push([
    'P1', e.users.socio1.email, 'L1', 550, hace(1), 'ok', 'approved',
    '', '', '', '', new Date().toISOString(), e.users.teso.email, new Date().toISOString(), '',
  ]);

  const leer = async () => {
    const r = await get(`/api/savings/complete?email=${presi.email}&groupId=GX`, e.tokens.presi);
    return r.body.data;
  };

  const antes = await leer();
  log('\n=== ANTES de abonar el reparto ===');
  log(`   ahorros:              $${antes.totalAhorros}`);
  log(`   acciones:             $${antes.totalAcciones}`);
  log(`   utilidades TEORICAS:  $${antes.totalUtilidades}   <- % mensual sobre acciones`);
  log(`   PATRIMONIO:           $${antes.totalPatrimonio}`);

  const rep = await get('/api/gob/utilidades/reparto?groupId=GX', e.tokens.presi);
  const leToca = (rep.body.reparto.find((x) => x.email === presi.email) || {}).utilidad;
  log(`\n   El grupo gano $${rep.body.ganancia.total} prestando.`);
  log(`   A la presidencia le tocan $${leToca} del reparto REAL.`);

  // Cierre completo
  const c = await post('/api/gob/utilidades/cierre', { groupId: 'GX' }, e.tokens.presi);
  const asa = await post('/api/gob/asambleas', {
    groupId: 'GX', titulo: 'Cierre', fechaProgramada: '2026-09-30', modalidad: 'presencial',
  }, e.tokens.presi);
  await post(`/api/gob/asambleas/${asa.body.asambleaId}/asistencia`, {
    registros: [e.users.presi, e.users.teso, e.users.socio1].map((u) => ({ email: u.email, estado: 'presente' })),
  }, e.tokens.presi);
  await post(`/api/gob/asambleas/${asa.body.asambleaId}/estado`, { estado: 'abierta' }, e.tokens.presi);
  const p = await post(`/api/gob/utilidades/cierre/${c.body.cierreId}/proponer`,
    { asambleaId: asa.body.asambleaId }, e.tokens.presi);
  for (const tok of [e.tokens.presi, e.tokens.teso, e.tokens.socio1]) {
    await post(`/api/gob/acuerdos/${p.body.acuerdoId}/votar`, { voto: 'favor' }, tok);
  }
  await post(`/api/gob/utilidades/cierre/${c.body.cierreId}/aplicar`, {}, e.tokens.presi);

  const despues = await leer();
  log('\n=== DESPUES de abonar el reparto ===');
  log(`   ahorros:              $${despues.totalAhorros}   <- aqui entro el abono real`);
  log(`   acciones:             $${despues.totalAcciones}`);
  log(`   utilidades TEORICAS:  $${despues.totalUtilidades}   <- sigue calculandose aparte`);
  log(`   PATRIMONIO:           $${despues.totalPatrimonio}`);

  const subioAhorro = Math.round((despues.totalAhorros - antes.totalAhorros) * 100) / 100;
  const subioPatrimonio = Math.round((despues.totalPatrimonio - antes.totalPatrimonio) * 100) / 100;

  log('\n=== VEREDICTO ===');
  log(`   El ahorro subio     $${subioAhorro}  (deberia ser $${leToca})`);
  log(`   El patrimonio subio $${subioPatrimonio}  (deberia ser $${leToca})`);

  // La prueba de fuego: el patrimonio tiene que ser exactamente lo que la
  // persona TIENE. Las utilidades abonadas son filas de ahorro, asi que ya
  // estan dentro de totalAhorros; sumarlas otra vez seria contarlas dos veces.
  const debeSer = Math.round((Number(despues.totalAhorros) + Number(despues.totalAcciones)) * 100) / 100;
  const sobra = Math.round((Number(despues.totalPatrimonio) - debeSer) * 100) / 100;
  const dobleConteo = Math.abs(sobra) > 0.005 || Math.abs(subioPatrimonio - Number(leToca)) > 0.005;

  log(`\n   patrimonio = ahorros + acciones  = $${debeSer}`);
  log(`   el sistema dice                  = $${despues.totalPatrimonio}`);
  log(`   utilidades abonadas (ya dentro del ahorro) = $${despues.totalUtilidades}`);
  if (despues.utilidadesEstimadas !== undefined) {
    log(`   proyeccion teorica, aparte y NO sumada     = $${despues.utilidadesEstimadas}`);
  }

  if (dobleConteo) {
    log(`\n   PROBLEMA: el patrimonio tiene $${sobra} de mas.`);
    log('   Se esta contando el mismo dinero dos veces.');
  } else {
    log('\n   OK: cada dolar se cuenta una sola vez.');
  }
  const informe = salida.join(String.fromCharCode(10));
  fs.writeFileSync(
    require('path').join(require('os').tmpdir(), 'doble-conteo.txt'),
    informe, 'utf8');
  process.stdout.write(informe + String.fromCharCode(10));
  setTimeout(() => process.exit(dobleConteo ? 1 : 0), 200);
})().catch((e) => { process.stderr.write('FALLO: ' + e.message + String.fromCharCode(10)); process.exit(2); });
