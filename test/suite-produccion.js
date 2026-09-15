/**
 * SUITE 27 - Con la memoria y el freno ENCENDIDOS, como en produccion.
 *
 * El resto de las baterias corre con la memoria corta apagada (ttl 0) y el
 * freno practicamente desactivado, porque el emulador escribe en la cuadricula
 * por debajo y una cifra guardada enmascararia lo que la prueba acaba de
 * sembrar. El problema es que ASI NO SE PRUEBA LO QUE CORRE DE VERDAD: en
 * Render la memoria dura 12 segundos y el freno son 50 lecturas por minuto.
 *
 * Una auditoria encontro que, con esos valores, dos arreglos se anulaban entre
 * si: la comprobacion que hace `escritura.js` antes de escribir vuelve a leer la
 * hoja, y esa relectura se servia DE LA MEMORIA. Es decir, se comprobaba contra
 * la misma foto de la que se desconfiaba. Medido con la memoria encendida:
 *   - un aporte de $500 se duplicaba,
 *   - una socia acababa con dos vinculos al mismo grupo y su rol se cambiaba en
 *     el grupo equivocado,
 *   - y todo con HTTP 200.
 *
 * Aqui se repite lo mismo con los valores de produccion. Si alguien vuelve a
 * poner la relectura en memoria, esta bateria se pone roja.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario, seedUser, seedGroup, seedLink, login } = require('./scenario');
const hoja = require('../hoja');
const t = require('./runner');

const hoy = () => hoyLocal();

/** Mete una fila de Savings TAL CUAL, como la teclearia una tesorera. */
function filaAMano(campos) {
  const fila = new Array(12).fill('');
  Object.entries(campos).forEach(([i, v]) => { fila[Number(i)] = v; });
  fake.ensureSheet('Savings').grid.push(fila);
  return fila;
}

module.exports = async function run() {
  const G_SHEETS = require('../governance').SHEETS;
  const { HOJA, CABECERA } = require('../accesos');
  const preparar = () => {
    seedWorkbook();
    Object.values(G_SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
    fake.seedSheet(HOJA, [CABECERA]);
    hoja.invalidarTodo();
  };

  const antes = hoja.configurar({});
  try {
    // La MEMORIA con el valor real de produccion, que es lo que esta bateria
    // viene a probar. El freno se deja holgado a proposito: montar cada
    // escenario (siete inicios de sesion, sembrar las hojas) gasta mas lecturas
    // que un grupo entero en un dia, y lo que se prueba aqui no es la cuota
    // sino que la memoria no enmascare una fila que se movio. El freno tiene su
    // propia prueba en REM 9.
    hoja.configurar({ ttlMs: 12000, maxPorMinuto: 100000, esperaMaxMs: 15000 });

    // =================================================================
    t.section('PROD 1. La memoria no enmascara una fila que se movio');
    // =================================================================
    preparar();
    const e = await baseScenario({ groupId: 'GPR' });
    await post('/api/gob/reglas', { groupId: 'GPR', requiereAprobacionAportes: true }, e.tokens.presi);

    filaAMano({ 0: e.users.socio1.email, 1: 'GPR', 2: 10, 3: hoy(), 4: 'mensual', 6: 'confirmado', 10: 'P_VIEJO' });
    filaAMano({ 0: e.users.socio1.email, 1: 'GPR', 2: 500, 3: hoy(), 4: 'mensual', 6: 'confirmado', 10: 'P_GRANDE' });
    filaAMano({ 0: e.users.socio2.email, 1: 'GPR', 2: 80, 3: hoy(), 4: 'mensual', 6: 'pendiente', 10: 'P_ELSA' });

    // Se calienta la memoria leyendo la hoja
    await get('/api/gob/aportes-pendientes?groupId=GPR', e.tokens.teso);
    await get('/api/gob/tablero?groupId=GPR', e.tokens.presi);

    // Y AHORA la tesorera borra a mano la fila de arriba, desde la hoja
    const hojaSav = fake.ensureSheet('Savings');
    hojaSav.grid = hojaSav.grid.filter((r) => (r[10] || '') !== 'P_VIEJO');

    const r1 = await post('/api/gob/aportes/resolver',
      { groupId: 'GPR', tipo: 'ahorro', movId: 'P_ELSA', accion: 'confirmar' }, e.tokens.presi);
    t.status('el aporte se confirma', r1, 200);

    const filas = (fake.dumpSheet('Savings') || []).slice(1).filter((r) => (r[1] || '') === 'GPR');
    t.eq('siguen siendo dos filas, no tres', filas.length, 2);
    t.eq('la de Elsa consta UNA vez',
      filas.filter((r) => (r[10] || '') === 'P_ELSA').length, 1);
    t.eq('y esta confirmada',
      (filas.find((r) => (r[10] || '') === 'P_ELSA')?.[6] || '').toLowerCase(), 'confirmado');
    t.near('el aporte de $500 no se toco',
      Number(filas.find((r) => (r[10] || '') === 'P_GRANDE')?.[2]), 500, 0.01);

    // =================================================================
    t.section('PROD 2. Cambiar el rol en un grupo no lo cambia en el otro');
    // =================================================================
    preparar();
    const f = await baseScenario({ groupId: 'GA' });
    const doble = seedUser({ nombre: 'Socia de dos grupos', email: 'dos@prod.test' });
    seedGroup({ id: 'GB', nombre: 'El segundo', presidente: f.users.presi.email });
    seedLink(f.users.presi.email, 'GB', 'presidente');
    seedLink(doble.email, 'GA', 'member');
    seedLink(doble.email, 'GB', 'member');

    // Memoria caliente
    await get(`/api/grupos-del-usuario?email=${doble.email}`, f.tokens.presi);

    const cambio = await post('/api/cambiar-rol-usuario-grupo',
      { UserEmail: doble.email, GroupID: 'GB', NewGroupRole: 'tesorero' }, f.tokens.presi);
    t.statusIn('el cambio de rol responde', cambio, [200, 201]);

    const links = (fake.dumpSheet('UserGroupLinks') || []).slice(1)
      .filter((r) => (r[0] || '') === doble.email);
    t.eq('sigue teniendo exactamente dos vinculos, uno por grupo', links.length, 2);
    t.eq('en GB queda como tesorera',
      (links.find((r) => (r[1] || '') === 'GB')?.[3] || '').toLowerCase(), 'tesorero');
    t.eq('y en GA sigue siendo socia, sin tocar',
      (links.find((r) => (r[1] || '') === 'GA')?.[3] || '').toLowerCase(), 'member');

    // =================================================================
    t.section('PROD 3. Confirmar el aporte de marzo no destruye el de febrero');
    // =================================================================
    preparar();
    const g = await baseScenario({ groupId: 'GMES' });
    await post('/api/gob/reglas', { groupId: 'GMES', requiereAprobacionAportes: true }, g.tokens.presi);

    // Dos aportes de la MISMA socia, sin identificador, como los teclearia
    // alguien al pasar el cuaderno mes a mes
    filaAMano({ 0: g.users.socio1.email, 1: 'GMES', 2: 20, 3: '2026-02-10', 4: 'mensual', 6: 'pendiente' });
    filaAMano({ 0: g.users.socio1.email, 1: 'GMES', 2: 500, 3: '2026-03-10', 4: 'mensual', 6: 'pendiente' });

    const bandeja = await get('/api/gob/aportes-pendientes?groupId=GMES', g.tokens.teso);
    const marzo = (bandeja.body?.ahorros || []).find((a) => a.monto === 500);
    t.check('la bandeja distingue el aporte de marzo', !!marzo,
      JSON.stringify(bandeja.body?.ahorros));

    const rMarzo = await post('/api/gob/aportes/resolver',
      { groupId: 'GMES', tipo: 'ahorro', movId: marzo?.movId, accion: 'confirmar', sena: marzo?.sena },
      g.tokens.presi);
    t.status('se confirma el de marzo', rMarzo, 200);

    const delGrupo = (fake.dumpSheet('Savings') || []).slice(1).filter((r) => (r[1] || '') === 'GMES');
    t.eq('siguen estando los dos aportes', delGrupo.length, 2);
    t.eq('el de febrero sigue intacto y pendiente',
      delGrupo.filter((r) => Number(r[2]) === 20 && (r[6] || '').toLowerCase() === 'pendiente').length, 1);
    t.eq('y el de marzo confirmado',
      delGrupo.filter((r) => Number(r[2]) === 500 && (r[6] || '').toLowerCase() === 'confirmado').length, 1);

    const tb3 = await get('/api/gob/tablero?groupId=GMES', g.tokens.presi);
    t.near('el patrimonio son los 500 de marzo', tb3.body?.aportes?.ahorroConfirmado, 500, 0.01);
    t.near('y los 20 de febrero siguen esperando', tb3.body?.aportes?.ahorroPendiente, 20, 0.01);

    // =================================================================
    t.section('PROD 4. Si la fila se movio, no se confirma la de otra socia');
    // =================================================================
    preparar();
    const h = await baseScenario({ groupId: 'GMOV' });
    await post('/api/gob/reglas', { groupId: 'GMOV', requiereAprobacionAportes: true }, h.tokens.presi);
    filaAMano({ 0: h.users.socio1.email, 1: 'GMOV', 2: 5, 3: hoy(), 4: 'mensual', 6: 'pendiente' });
    filaAMano({ 0: h.users.socio1.email, 1: 'GMOV', 2: 25, 3: hoy(), 4: 'mensual', 6: 'pendiente' });
    filaAMano({ 0: h.users.socio2.email, 1: 'GMOV', 2: 900, 3: hoy(), 4: 'mensual', 6: 'pendiente' });

    const b4 = await get('/api/gob/aportes-pendientes?groupId=GMOV', h.tokens.teso);
    const losVeinticinco = (b4.body?.ahorros || []).find((a) => a.monto === 25);
    t.check('la tesoreria ve los $25 en la bandeja', !!losVeinticinco,
      JSON.stringify(b4.body?.ahorros));

    // Alguien borra la primera fila mientras la tesoreria mira la bandeja
    const hs = fake.ensureSheet('Savings');
    hs.grid = hs.grid.filter((r) => !(Number(r[2]) === 5 && (r[1] || '') === 'GMOV'));

    const pulsa = await post('/api/gob/aportes/resolver',
      { groupId: 'GMOV', tipo: 'ahorro', movId: losVeinticinco?.movId,
        accion: 'confirmar', sena: losVeinticinco?.sena }, h.tokens.presi);
    t.status('se sigue confirmando LO QUE ELLA PULSO', pulsa, 200);

    const trasPulsar = (fake.dumpSheet('Savings') || []).slice(1).filter((r) => (r[1] || '') === 'GMOV');
    t.eq('los $25 quedan confirmados',
      (trasPulsar.find((r) => Number(r[2]) === 25)?.[6] || '').toLowerCase(), 'confirmado');
    t.eq('y los $900 de la otra socia siguen pendientes, sin que nadie los firmara',
      (trasPulsar.find((r) => Number(r[2]) === 900)?.[6] || '').toLowerCase(), 'pendiente');

    const tb4 = await get('/api/gob/tablero?groupId=GMOV', h.tokens.presi);
    t.near('el patrimonio subio 25, no 900', tb4.body?.aportes?.ahorroConfirmado, 25, 0.01);

    // =================================================================
    t.section('PROD 5. Una fecha con formato de Excel no deja a nadie fuera');
    // =================================================================
    preparar();
    const k = await baseScenario({ groupId: 'GEX' });

    // Dos socias, mismo capital, misma fecha. A una le formatearon la celda.
    fake.ensureSheet('Acciones').grid.push([
      k.users.socio1.email, 'GEX', '2026-01-15', 50, 10, 2, new Date().toISOString(),
      'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), 'acc_normal', '',
    ]);
    fake.ensureSheet('Acciones').grid.push([
      k.users.socio2.email, 'GEX', 46037, 50, 10, 2, new Date().toISOString(),
      'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), 'acc_excel', '',
    ]);
    fake.ensureSheet('Loans').grid.push([
      'LN_EX', k.users.socio1.email, 'GEX', 1000, '2026-01-05',
      new Date().toISOString(), 2, 'aprobado', 6, 1120,
    ]);
    fake.ensureSheet('LoanPayments').grid.push([
      'PAY_EX', k.users.socio1.email, 'LN_EX', 1120, '2026-06-10', 'saldado',
      'approved', '', '', '', '', new Date().toISOString(),
      k.users.teso.email, new Date().toISOString(), '',
    ]);

    const rep = await get('/api/gob/utilidades/reparto?groupId=GEX', k.tokens.presi);
    t.status('el reparto responde', rep, 200);
    const cuota = (correo) => Number((rep.body?.reparto || [])
      .find((x) => x.email === correo)?.utilidad);
    t.check('la socia con la fecha en formato de Excel NO se queda sin nada',
      cuota(k.users.socio2.email) > 0,
      JSON.stringify((rep.body?.reparto || []).map((x) => `${x.email}=${x.utilidad}`)));
    t.near('cobra lo mismo que la otra, que puso igual',
      cuota(k.users.socio2.email), cuota(k.users.socio1.email), 0.02);
    t.check('el periodo del cierre lleva meses de verdad, no el ano 45000',
      /^(19|20|21)\d{2}-(0[1-9]|1[0-2])/.test(rep.body?.periodoSugerido || ''),
      rep.body?.periodoSugerido);
    for (const m of (rep.body?.porMes || [])) {
      t.check(`el mes ${m.mes} es un mes real`,
        /^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(m.mes), m.mes);
    }

    // =================================================================
    t.section('PROD 6. Lo cobrado en un cierre queda anotado a cada socia');
    // =================================================================
    const cierre = await post('/api/gob/utilidades/cierre', { groupId: 'GEX' }, k.tokens.presi);
    t.status('se crea el cierre', cierre, 201);

    const detalle = (fake.dumpSheet('CierreUtilidadesDetalle') || [])
      .filter((r) => (r[0] || '') === cierre.body?.cierreId);
    t.check('queda el detalle por socia', detalle.length >= 2, `filas: ${detalle.length}`);

    // Se da por aprobado en asamblea, escribiendo el estado en la hoja
    const cierres = fake.ensureSheet('CierresUtilidades');
    const filaCierre = cierres.grid.find((r) => (r[0] || '') === cierre.body?.cierreId);
    if (filaCierre) filaCierre[2] = 'aplicado';
    hoja.invalidarTodo();

    const tras = await get('/api/gob/utilidades/reparto?groupId=GEX', k.tokens.presi);
    for (const x of (tras.body?.reparto || [])) {
      t.check(`a ${x.email} se le anota lo que ya cobro`,
        Number(x.yaCobrado) > 0 || Number(x.acumulado) === 0,
        `acumulado ${x.acumulado}, cobrado ${x.yaCobrado}`);
      t.near(`y no le queda pendiente`, Number(x.utilidad), 0, 0.02);
    }
    t.near('no queda nada por repartir', tras.body?.ganancia?.porRepartir, 0, 0.02);

    // =================================================================
    t.section('PROD 7. Tras una escritura, nadie ve la cifra vieja');
    // =================================================================
    preparar();
    const m = await baseScenario({ groupId: 'GCA' });
    await post('/api/gob/reglas', { groupId: 'GCA', requiereAprobacionAportes: true }, m.tokens.presi);

    // Memoria bien caliente: varias lecturas seguidas
    for (let i = 0; i < 3; i += 1) await get('/api/gob/tablero?groupId=GCA', m.tokens.presi);
    const inicial = Number((await get('/api/gob/tablero?groupId=GCA', m.tokens.presi))
      .body?.aportes?.ahorroPendiente || 0);

    await post('/api/registrar-ahorros', { groupId: 'GCA', date: hoy(), amount: 64 }, m.tokens.socio1);
    const justoDespues = Number((await get('/api/gob/tablero?groupId=GCA', m.tokens.presi))
      .body?.aportes?.ahorroPendiente || 0);
    t.near('el aporte aparece en el acto, no dentro de doce segundos',
      justoDespues - inicial, 64, 0.01);

    const band = await get('/api/gob/aportes-pendientes?groupId=GCA', m.tokens.teso);
    const nuevo = (band.body?.ahorros || []).find((a) => a.monto === 64);
    t.check('y la bandeja de la tesoreria tambien lo ve', !!nuevo,
      JSON.stringify(band.body?.ahorros));

    await post('/api/gob/aportes/resolver',
      { groupId: 'GCA', tipo: 'ahorro', movId: nuevo?.movId, accion: 'confirmar' }, m.tokens.presi);
    const trasConfirmar = await get('/api/gob/tablero?groupId=GCA', m.tokens.presi);
    t.near('al confirmarlo, pasa a confirmado en el acto',
      trasConfirmar.body?.aportes?.ahorroConfirmado, 64, 0.01);
    t.near('y deja de estar pendiente',
      Number(trasConfirmar.body?.aportes?.ahorroPendiente) - inicial, 0, 0.01);

    // =================================================================
    t.section('PROD 8. Un reenvio tras un corte de red no duplica el aporte');
    // =================================================================
    // Con datos moviles la peticion llega y la respuesta se pierde: la app dice
    // "no se pudo confirmar", la persona vuelve a pulsar, y sin esto su ahorro
    // del mes quedaba contado dos veces en la caja del grupo.
    preparar();
    const n2 = await baseScenario({ groupId: 'GREN' });
    await post('/api/gob/reglas', { groupId: 'GREN', requiereAprobacionAportes: true }, n2.tokens.presi);

    const clave = 'envio-de-esta-pantalla-1';
    const primero = await post('/api/savings',
      { groupId: 'GREN', tipo: 'mensual', monto: 33, clave }, n2.tokens.socio1);
    t.statusIn('el primer envio se registra', primero, [200, 201]);

    const segundo = await post('/api/savings',
      { groupId: 'GREN', tipo: 'mensual', monto: 33, clave }, n2.tokens.socio1);
    t.statusIn('el reenvio responde bien', segundo, [200, 201]);
    t.check('y dice que ya estaba', segundo.body?.repetido === true, JSON.stringify(segundo.body));
    t.eq('con el MISMO identificador', segundo.body?.movId, primero.body?.movId);

    const treintaytres = (fake.dumpSheet('Savings') || []).slice(1)
      .filter((r) => (r[1] || '') === 'GREN' && Number(r[2]) === 33);
    t.eq('en la hoja hay UNA sola fila de $33', treintaytres.length, 1);

    // Un envio DISTINTO (otra clave) si se registra: no se bloquea a la persona
    const otro = await post('/api/savings',
      { groupId: 'GREN', tipo: 'mensual', monto: 33, clave: 'envio-de-esta-pantalla-2' },
      n2.tokens.socio1);
    t.statusIn('un aporte nuevo del mismo importe si entra', otro, [200, 201]);
    t.eq('ahora si hay dos filas',
      (fake.dumpSheet('Savings') || []).slice(1)
        .filter((r) => (r[1] || '') === 'GREN' && Number(r[2]) === 33).length, 2);

    // La clave de una persona no colisiona con la de otra
    const deOtra = await post('/api/savings',
      { groupId: 'GREN', tipo: 'mensual', monto: 33, clave }, n2.tokens.socio2);
    t.statusIn('la misma clave de OTRA socia registra su propio aporte', deOtra, [200, 201]);
    t.check('con un identificador distinto', deOtra.body?.movId !== primero.body?.movId,
      `${deOtra.body?.movId} vs ${primero.body?.movId}`);
    t.check('y no marcado como repetido', !deOtra.body?.repetido, JSON.stringify(deOtra.body));

    // Y lo mismo con la compra de acciones
    const c1 = await post('/api/registrar-acciones',
      { groupId: 'GREN', date: hoy(), shares: 3, clave: 'compra-1' }, n2.tokens.socio1);
    const c2 = await post('/api/registrar-acciones',
      { groupId: 'GREN', date: hoy(), shares: 3, clave: 'compra-1' }, n2.tokens.socio1);
    t.statusIn('la compra se registra', c1, [200, 201]);
    t.check('y el reenvio dice que ya estaba', c2.body?.repetido === true, JSON.stringify(c2.body));
    t.eq('con una sola fila de acciones',
      (fake.dumpSheet('Acciones') || []).slice(1)
        .filter((r) => (r[1] || '') === 'GREN' && Number(r[3]) === 3).length, 1);
  } finally {
    hoja.configurar(antes);
    hoja.invalidarTodo();
  }
};
