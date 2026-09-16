/**
 * SUITE 46 - Un correo repetido en la hoja no cuenta dos veces.
 *
 * La hoja Users tiene correos repetidos de verdad: dos altas de la misma
 * persona (medido en produccion, 181 filas para 179 correos). metricas.js
 * sumaba las entradas POR FILA, asi que cada duplicado contaba dos veces en
 * TODO el embudo del informe del proyecto: personas registradas, cuantas
 * activaron, entradas totales y la retencion. La adopcion salia exagerada, y
 * ese informe es el que se entrega al INCYT.
 *
 * Se descubrio contrastando los endpoints entre si contra la base real:
 * /api/admin/resumen decia 181 personas y /api/admin/informe-proyecto decia
 * 179; 844 entradas contra 838. Dos numeros distintos para la misma cosa
 * siempre significan que uno de los dos esta mal.
 *
 * VA LA ULTIMA DE LA BATERIA a proposito: monta su propio escenario, y el
 * registro de accesos que deja cada inicio de sesion se escribe sin esperar a
 * que termine. Puesta en medio, esas escrituras caian encima de la suite
 * siguiente y la ponian roja de forma intermitente.
 */

const { seedWorkbook, get, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

module.exports = async function run() {
  const acc = require('../accesos');
  const hoja = require('../hoja');

  // ===================================================================
  t.section('DUP 1. La misma persona dos veces en la hoja');
  // ===================================================================
  seedWorkbook();
  fake.seedSheet(acc.HOJA, [acc.CABECERA]);
  hoja.invalidarTodo();
  const e = await baseScenario({ groupId: 'DUP1' });

  // La misma persona, dos veces en Users: mismo correo, distinta fila.
  const users = fake.ensureSheet('Users');
  const suya = users.grid.find((r) => r[1] === e.users.socio1.email);
  users.grid.push([...suya]);

  // baseScenario inicia sesion con cada persona, y ENTRAR ES UN ACCESO: la
  // hoja ya trae siete antes de sembrar nada. Se vacia para medir solo lo de
  // esta prueba.
  fake.seedSheet(acc.HOJA, [acc.CABECERA]);
  for (const d of ['2026-03-01', '2026-03-05', '2026-03-09']) {
    fake.ensureSheet(acc.HOJA).grid.push(
      [`${d}T10:00:00.000Z`, e.users.socio1.email, 'movil', 'Android', 'Chrome', '1.1.1.1', 'UA', 'web']);
  }
  hoja.invalidarTodo();

  const m = await get('/api/admin/metricas', e.tokens.admin);
  t.status('las metricas responden', m, 200);
  const ad = ((m.body || {}).plataforma || {}).adopcion || {};

  t.eq('en la hoja hay ocho filas', users.grid.length - 1, 8);
  t.eq('pero se cuenta a siete personas, no a ocho', ad.registradas, 7);
  t.eq('sus tres entradas se cuentan una vez, no seis', ad.entradasTotales, 3);
  t.eq('y ella activo una sola vez', ad.activaron, 1);
  t.eq('quien nunca entro sigue siendo seis', ad.nuncaEntraron, 6);
  t.near('y la tasa de activacion sale sobre siete, no sobre ocho',
    ad.tasaActivacion, 14.3, 0.2);

  // ===================================================================
  t.section('DUP 2. El informe y el panel dicen lo mismo');
  // ===================================================================
  // Dos numeros distintos para la misma cosa significan que uno esta mal, y
  // en el informe del proyecto no se puede saber cual.
  const inf = await get('/api/admin/informe-proyecto', e.tokens.admin);
  t.status('el informe responde', inf, 200);
  const resumen = (((inf.body || {}).hojas || [])
    .find((h) => h.nombre === 'Resumen') || { filas: [] }).filas;
  const dato = (concepto) => (resumen
    .find((x) => new RegExp(concepto, 'i').test(x.Concepto)) || {}).Valor;

  t.eq('las personas con cuenta cuadran', Number(dato('Personas con cuenta$')), ad.registradas);
  t.eq('las entradas registradas cuadran', Number(dato('Entradas registradas')), ad.entradasTotales);
  t.eq('y quien ha entrado alguna vez tambien', Number(dato('han entrado alguna vez')), ad.activaron);

  const personas = (((inf.body || {}).hojas || [])
    .find((h) => h.nombre === 'Personas') || { filas: [] }).filas;
  t.eq('la hoja de personas no repite a nadie',
    new Set(personas.map((p) => String(p.Correo || '').toLowerCase())).size, personas.length);
};
