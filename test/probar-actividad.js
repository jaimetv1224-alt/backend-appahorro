#!/usr/bin/env node
/**
 * Comprueba que la app cuenta las veces que se usa, no solo los inicios de
 * sesion. Se ejecuta aparte porque necesita acortar la ventana de sesion, y
 * eso contaminaria el resto de baterias.
 *
 *   node test/probar-actividad.js
 */

'use strict';

process.env.SESION_MINUTOS = '0';   // toda peticion cuenta como vuelta nueva

const { seedWorkbook, startServer, get, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await startServer();
  seedWorkbook();
  const acc = require('../accesos');
  fake.seedSheet(acc.HOJA, [acc.CABECERA]);
  const e = await baseScenario({ groupId: 'GACT' });

  const filas = () => (fake.dumpSheet(acc.HOJA) || []).slice(1);
  const de = (correo, origen) => filas()
    .filter((r) => (r[1] || '') === correo && (r[7] || 'login') === origen).length;

  t.section('ACT 1. El inicio de sesion se anota como tal');
  t.check('la presidenta tiene su entrada de login', de(e.users.presi.email, 'login') >= 1,
    JSON.stringify(filas().slice(0, 3)));
  t.eq('y todavia ninguna vuelta', de(e.users.presi.email, 'vuelta'), 0);

  t.section('ACT 2. Volver a la app cuenta como una entrada mas');
  await get('/api/mi-perfil', e.tokens.presi);
  await dormir(300);
  const trasUna = de(e.users.presi.email, 'vuelta');
  t.check('al pedir algo despues del rato, se anota la vuelta', trasUna >= 1, `${trasUna}`);

  await get('/api/mi-perfil', e.tokens.presi);
  await get('/api/obtener-grupos', e.tokens.presi);
  await dormir(400);
  const trasTres = de(e.users.presi.email, 'vuelta');
  t.check('cada vuelta suma', trasTres > trasUna, `antes ${trasUna}, ahora ${trasTres}`);

  t.section('ACT 3. Cada persona lleva su propia cuenta');
  t.eq('el socio no hereda las vueltas de la presidenta', de(e.users.socio1.email, 'vuelta'), 0);
  await get('/api/mi-perfil', e.tokens.socio1);
  await dormir(300);
  t.check('hasta que usa la app el mismo', de(e.users.socio1.email, 'vuelta') >= 1, '');

  t.section('ACT 4. La franja del dia va en hora de Ecuador');
  // 01:30 UTC son las 20:30 del dia anterior en Salinas
  t.eq('las 20:30 de Salinas son "noche"', acc.franjaHoraria('2026-09-04T01:30:00.000Z'), 'noche');
  t.eq('las 08:00, "mañana"', acc.franjaHoraria('2026-09-03T13:00:00.000Z'), 'mañana');
  t.eq('las 15:00, "tarde"', acc.franjaHoraria('2026-09-03T20:00:00.000Z'), 'tarde');
  t.eq('las 02:00, "madrugada"', acc.franjaHoraria('2026-09-03T07:00:00.000Z'), 'madrugada');
  t.eq('una fecha ilegible no inventa franja', acc.franjaHoraria('el jueves'), 'desconocida');

  const fallos = t.summary();
  process.exit(fallos > 0 ? 1 : 0);
})().catch((err) => { console.error('FALLO:', err); process.exit(2); });
