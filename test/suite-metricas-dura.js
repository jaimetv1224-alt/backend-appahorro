/**
 * SUITE 19 - Los indicadores, contra datos sucios.
 *
 * La bateria anterior comprueba que las cuentas salen. Esta comprueba que no se
 * rompen ni mienten cuando la hoja trae lo que las hojas traen de verdad:
 * fechas escritas a mano, filas a medias, la misma persona en dos grupos,
 * relojes desajustados y celdas con texto donde deberia ir un numero.
 */

const {
  estadistica, horasEntre, adopcion, tiemposDeRespuesta, saludDelGrupo, notaDelGrupo, pct,
} = require('../metricas');
const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario, seedUser, seedLink, seedGroup, login } = require('./scenario');
const t = require('./runner');

const DIA = 24 * 3600 * 1000;
const haceDias = (d) => new Date(Date.now() - d * DIA).toISOString();
const enDias = (d) => new Date(Date.now() + d * DIA).toISOString();

module.exports = async function run() {
  // ===================================================================
  t.section('DUR 1. Fechas que no son fechas');
  // ===================================================================
  const basura = ['', null, undefined, 'proximamente', '00/00/0000', '2026-13-45',
    'null', 'undefined', 0, false, {}, [], 'NaN'];
  let rompio = null;
  for (const x of basura) {
    try {
      horasEntre(x, new Date().toISOString());
      horasEntre(new Date().toISOString(), x);
      estadistica([x]);
    } catch (e) { rompio = `${JSON.stringify(x)}: ${e.message}`; break; }
  }
  t.check('ninguna basura en una fecha revienta el calculo', rompio === null, rompio || '');
  t.eq('una fecha imposible no da un numero', horasEntre('2026-13-45', new Date().toISOString()), null);
  t.eq('ni el texto "proximamente"', horasEntre('proximamente', new Date().toISOString()), null);

  // ===================================================================
  t.section('DUR 2. Relojes desajustados y fechas del futuro');
  // ===================================================================
  const conFuturo = adopcion(
    [{ email: 'a@x.test', alta: haceDias(60) }],
    { 'a@x.test': [{ fecha: enDias(400) }] },
  );
  t.eq('una entrada fechada dentro de un año no cuenta como activa esta semana',
    conFuturo.activosUltimos7, 0);
  t.eq('ni como activa este mes', conFuturo.activosUltimos30, 0);
  t.eq('pero si consta que esa persona entro alguna vez', conFuturo.activaron, 1);

  const skew = adopcion(
    [{ email: 'b@x.test', alta: haceDias(30) }],
    { 'b@x.test': [{ fecha: new Date(Date.now() + 3600 * 1000).toISOString() }] },
  );
  t.eq('un reloj adelantado una hora se sigue considerando de hoy', skew.activosUltimos7, 1);

  // ===================================================================
  t.section('DUR 3. Nadie, y una sola persona');
  // ===================================================================
  const cero = adopcion([], {});
  t.eq('sin gente no hay division por cero', cero.tasaActivacion, 0);
  t.eq('ni entradas por persona', cero.entradasPorPersonaActiva, 0);
  t.eq('la retencion no inventa un porcentaje', cero.retencion7.pct, null);

  const uno = adopcion([{ email: 'c@x.test', alta: haceDias(1) }], {});
  t.eq('una persona que no entro: 0% de activacion', uno.tasaActivacion, 0);
  t.eq('y consta como que nunca entro', uno.nuncaEntraron, 1);

  t.eq('un porcentaje sobre cero es cero, no NaN', pct(5, 0), 0);
  t.eq('y cero sobre cero tambien', pct(0, 0), 0);

  // ===================================================================
  t.section('DUR 4. Entradas de gente que ya no esta en el grupo');
  // ===================================================================
  // El grupo tiene a una persona; el monton de accesos trae ademas a otra que
  // se salio. Sus entradas NO son del grupo y no pueden inflar el promedio.
  const mezcla = adopcion(
    [{ email: 'queda@x.test', alta: haceDias(30) }],
    {
      'queda@x.test': [{ fecha: haceDias(2) }],
      'se-fue@x.test': [{ fecha: haceDias(3) }, { fecha: haceDias(4) }, { fecha: haceDias(5) }],
    },
  );
  t.eq('solo se cuentan las entradas de quien pertenece a la lista', mezcla.entradasTotales, 1);
  t.eq('y el promedio por persona sale de esas', mezcla.entradasPorPersonaActiva, 1);

  // ===================================================================
  t.section('DUR 5. Mas votos que presentes, y otras cifras imposibles');
  // ===================================================================
  const imposible = saludDelGrupo({
    asambleas: [{ presentes: 4, miembros: 5 }],
    votos: [{ emitidos: 9, presentes: 4 }],     // el acta trae mas votos que asistentes
  });
  t.check('la participacion en votos nunca pasa del 100%',
    imposible.asambleas.participacionEnVotos <= 100,
    `${imposible.asambleas.participacionEnVotos}`);

  const masPresentes = saludDelGrupo({ asambleas: [{ presentes: 9, miembros: 5 }] });
  t.check('ni la asistencia', masPresentes.asambleas.asistenciaMedia <= 100,
    `${masPresentes.asambleas.asistenciaMedia}`);

  const notaImposible = notaDelGrupo({
    adopcion: { registradas: 3, tasaActivacion: 100 },
    salud: { aportes: { total: 5, tasaConfirmacion: 250 } },
  });
  t.check('la nota nunca pasa de 100', notaImposible.nota <= 100, `${notaImposible.nota}`);
  t.check('ni baja de 0',
    notaDelGrupo({
      adopcion: { registradas: 3, tasaActivacion: -50 },
      salud: { aportes: { total: 5, tasaConfirmacion: -10 } },
    }).nota >= 0, '');

  // ===================================================================
  t.section('DUR 6. Un prestamo sin plazo o sin fecha de inicio');
  // ===================================================================
  seedWorkbook();
  const { HOJA, CABECERA } = require('../accesos');
  fake.seedSheet(HOJA, [CABECERA]);
  const e = await baseScenario({ groupId: 'GRO' });

  const loans = fake.ensureSheet('Loans');
  loans.grid.push(['L_sin_plazo', e.users.socio1.email, 'GRO', 100, new Date().toISOString(),
    '', 2, 'aprobado', '', 110]);                    // plazo vacio
  loans.grid.push(['L_sin_inicio', e.users.socio1.email, 'GRO', 100, '',
    '', 2, 'aprobado', 6, 110]);                     // sin fecha de inicio
  loans.grid.push(['L_texto', e.users.socio1.email, 'GRO', 'cien', 'ayer',
    '', 'dos', 'aprobado', 'seis', 'ciento diez']);  // todo texto

  const r1 = await get('/api/admin/metricas', e.tokens.admin);
  t.status('el informe responde igual', r1, 200);
  const g1 = (r1.body?.grupos || []).find((x) => x.groupId === 'GRO');
  t.eq('un prestamo que no se puede juzgar no se cuenta al dia', g1?.salud?.prestamos?.alDia, 0);
  t.eq('ni atrasado', g1?.salud?.prestamos?.atrasados, 0);
  t.eq('simplemente queda fuera', g1?.salud?.prestamos?.total, 0);
  t.check('y no aparece NaN por ningun lado',
    !/NaN|Infinity/.test(JSON.stringify(r1.body)), '');

  // ===================================================================
  t.section('DUR 7. La misma persona en dos grupos');
  // ===================================================================
  seedWorkbook();
  fake.seedSheet(HOJA, [CABECERA]);
  const f = await baseScenario({ groupId: 'GA' });
  seedGroup({ id: 'GB', nombre: 'Segundo grupo', presidente: f.users.presi.email });
  seedLink(f.users.presi.email, 'GB', 'presidente');
  seedLink(f.users.socio1.email, 'GB', 'member');

  const hoy = hoyLocal();
  const enA = await post('/api/registrar-ahorros',
    { groupId: 'GA', userEmail: f.users.socio1.email, date: hoy, amount: 50 }, f.tokens.socio1);
  const enB = await post('/api/registrar-ahorros',
    { groupId: 'GB', userEmail: f.users.socio1.email, date: hoy, amount: 70 }, f.tokens.socio1);
  t.statusIn('la persona aporta en su primer grupo', enA, [200, 201]);
  t.statusIn('y en el segundo', enB, [200, 201]);

  const r2 = await get('/api/admin/metricas', f.tokens.admin);
  const gA = (r2.body?.grupos || []).find((x) => x.groupId === 'GA');
  const gB = (r2.body?.grupos || []).find((x) => x.groupId === 'GB');
  t.eq('el aporte del primer grupo se queda en el primer grupo', gA?.salud?.aportes?.total, 1);
  t.eq('y el del segundo, en el segundo', gB?.salud?.aportes?.total, 1);
  t.check('la persona cuenta en los dos grupos, como debe ser',
    gA?.adopcion?.registradas >= 1 && gB?.adopcion?.registradas >= 1, '');
  t.eq('pero en la plataforma se cuenta una sola vez',
    r2.body?.plataforma?.adopcion?.registradas,
    (fake.dumpSheet('Users') || []).length - 1);

  // ===================================================================
  t.section('DUR 8. Filas a medias y celdas de mas');
  // ===================================================================
  seedWorkbook();
  fake.seedSheet(HOJA, [CABECERA]);
  const h = await baseScenario({ groupId: 'GME' });

  const sav = fake.ensureSheet('Savings');
  sav.grid.push([h.users.socio1.email, 'GME', 40]);                       // fila cortada
  sav.grid.push([h.users.socio2.email, 'GME', 30, hoy, 'mensual', '', 'confirmado']);
  sav.grid.push([]);                                                       // fila vacia
  sav.grid.push([h.users.socio1.email, 'GME', 20, hoy, 'mensual', '', 'CONFIRMADO',
    '', '', new Date().toISOString(), 'sav_1700000000000_zz', '', 'sobra', 'sobra2']);

  const vinc = fake.ensureSheet('UserGroupLinks');
  vinc.grid.push([h.users.socio1.email, 'GME', hoy, 'member', 'activo', 'seed']); // repetida
  vinc.grid.push(['', 'GME', hoy, 'member', 'activo', 'seed']);                   // sin correo

  const r3 = await get('/api/admin/metricas', h.tokens.admin);
  t.status('el informe aguanta las filas rotas', r3, 200);
  const g3 = (r3.body?.grupos || []).find((x) => x.groupId === 'GME');
  t.check('no cuenta un integrante sin correo',
    g3?.adopcion?.registradas <= 5, `${g3?.adopcion?.registradas}`);
  t.check('la persona repetida no se cuenta dos veces en la adopcion',
    g3?.adopcion?.registradas === 5, `${g3?.adopcion?.registradas}`);
  t.eq('el estado en mayusculas se entiende igual', g3?.salud?.aportes?.confirmados, 3);
  t.check('sin NaN ni Infinity', !/NaN|Infinity/.test(JSON.stringify(r3.body)), '');

  // ===================================================================
  t.section('DUR 9. Un grupo sin nadie');
  // ===================================================================
  seedGroup({ id: 'GVACIO', nombre: 'Grupo sin miembros', presidente: '' });
  const r4 = await get('/api/admin/metricas', h.tokens.admin);
  const gv = (r4.body?.grupos || []).find((x) => x.groupId === 'GVACIO');
  t.check('un grupo sin miembros aparece igual', !!gv, '');
  t.eq('con cero integrantes', gv?.integrantes, 0);
  t.eq('cero activacion, no NaN', gv?.adopcion?.tasaActivacion, 0);
  t.eq('y sin nota', gv?.nota?.nota, null);

  // ===================================================================
  t.section('DUR 10. Muchos casos de golpe');
  // ===================================================================
  const muchos = Array.from({ length: 5000 }, (_, i) => i % 97);
  const grande = estadistica(muchos);
  t.eq('5.000 duraciones se resumen sin romperse', grande.n, 5000);
  t.check('la mediana cae dentro del rango',
    grande.mediana >= grande.min && grande.mediana <= grande.max,
    `${grande.min} <= ${grande.mediana} <= ${grande.max}`);
  t.check('y el percentil 90 esta por encima de la mediana',
    grande.p90 >= grande.mediana, `${grande.p90} vs ${grande.mediana}`);
  t.eq('el minimo es 0', grande.min, 0);
  t.eq('y el maximo, 96', grande.max, 96);
};
