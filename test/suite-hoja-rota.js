/**
 * SUITE 25 - La hoja es la base de datos, y la edita gente.
 *
 * Google Sheets no es una base de datos escondida: la tesorera la abre, teclea
 * una fila, borra otra que estaba duplicada, marca una casilla. Una auditoria
 * monto ocho escenarios de hoja "rota" y encontro que las 1.694 pruebas
 * anteriores pasaban con TODOS estos fallos dentro:
 *
 *   - Marcar la casilla de "requiere aprobacion" escribia VERDADERO, que el
 *     codigo no reconocia: se leia como FALSO y se apagaba el control interno
 *     del grupo entero. Cualquier socio declaraba y su declaracion pasaba a
 *     patrimonio sin la firma de nadie.
 *   - Escribir la fila de un aporte a mano la dejaba pendiente PARA SIEMPRE: la
 *     bandeja le inventaba un identificador que el boton de confirmar no
 *     reconocia, y devolvia 404.
 *   - Con el mismo identificador en dos filas, la segunda quedaba atrapada.
 *   - Borrar una fila mientras alguien confirmaba un aporte duplicaba el
 *     movimiento y el patrimonio del grupo subia sin que entrara un dolar.
 *   - Un importe escrito "1,234.56" se leia como un dolar con veintitres.
 *   - Una fecha guardada como numero de serie de Excel tumbaba el panel del
 *     socio con un 500.
 *   - Marcar a alguien como inactivo no le cerraba ninguna puerta.
 */

const { hoyLocal, seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario, seedUser, seedLink, login } = require('./scenario');
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
  };

  // ===================================================================
  t.section('ROTA 1. VERDADERO es verdadero, tambien en espanol');
  // ===================================================================
  preparar();
  const e = await baseScenario({ groupId: 'GHR' });

  /** Deja el reglamento con la celda de aprobacion escrita a mano y aporta. */
  const conCelda = async (valor) => {
    const hoja = fake.ensureSheet(G_SHEETS.reglas.name);
    hoja.grid = [G_SHEETS.reglas.headers];
    const idx = G_SHEETS.reglas.headers.findIndex((h) => /aprobacionaportes/i.test(h));
    const fila = new Array(G_SHEETS.reglas.headers.length).fill('');
    fila[0] = 'GHR';
    fila[idx] = valor;
    hoja.grid.push(fila);
    fake.seedSheet('Savings', [[
      'UserEmail', 'GroupID', 'Amount', 'Date', 'Type', 'Description',
      'Estado', 'RegistradoPor', 'ResueltoPor', 'FechaEstado', 'MovID', 'Nota']]);
    await post('/api/registrar-ahorros',
      { groupId: 'GHR', date: hoy(), amount: 33 }, e.tokens.socio1);
    const fila2 = (fake.dumpSheet('Savings') || []).slice(-1)[0] || [];
    return (fila2[6] || '').toString().trim().toLowerCase();
  };

  const idxApro = G_SHEETS.reglas.headers.findIndex((h) => /aprobacionaportes/i.test(h));
  t.check('la columna de aprobacion de aportes existe en el reglamento', idxApro >= 0,
    JSON.stringify(G_SHEETS.reglas.headers));

  t.eq('con "si" el aporte queda pendiente de firma', await conCelda('si'), 'pendiente');
  t.eq('con "TRUE" tambien', await conCelda('TRUE'), 'pendiente');
  t.eq('y con VERDADERO, que es lo que escribe Sheets en espanol',
    await conCelda('VERDADERO'), 'pendiente');
  t.eq('con FALSO el grupo si decide no pedir firma', await conCelda('FALSO'), 'confirmado');
  t.eq('y con "no" igual', await conCelda('no'), 'confirmado');

  // ===================================================================
  t.section('ROTA 2. Una fila escrita a mano se puede confirmar');
  // ===================================================================
  preparar();
  const f = await baseScenario({ groupId: 'GHM' });
  await post('/api/gob/reglas', { groupId: 'GHM', requiereAprobacionAportes: true }, f.tokens.presi);

  // La tesorera traspasa el cuaderno tecleando la fila: sin MovID, sin autor
  filaAMano({ 0: f.users.socio1.email, 1: 'GHM', 2: 50, 3: hoy(), 4: 'mensual', 6: 'pendiente' });

  const bandeja = await get('/api/gob/aportes-pendientes?groupId=GHM', f.tokens.teso);
  t.status('la bandeja responde', bandeja, 200);
  const suelta = (bandeja.body?.ahorros || []).find((a) => a.monto === 50);
  t.check('la fila tecleada aparece en la bandeja', !!suelta, JSON.stringify(bandeja.body?.ahorros));
  t.check('con un identificador provisional', /^SAVROW_\d+$/.test(suelta?.movId || ''), suelta?.movId);

  t.check('y con la sena que la distingue (correo, importe y fecha)',
    /@/.test(suelta?.sena || ''), suelta?.sena);

  const sinSena = await post('/api/gob/aportes/resolver',
    { groupId: 'GHM', tipo: 'ahorro', movId: suelta?.movId, accion: 'confirmar' }, f.tokens.teso);
  t.status('sin la sena NO se resuelve a ciegas por la posicion', sinSena, 409);
  t.eq('y se pide recargar la bandeja', sinSena.body?.motivo, 'falta_sena');

  const confirmada = await post('/api/gob/aportes/resolver',
    { groupId: 'GHM', tipo: 'ahorro', movId: suelta?.movId, accion: 'confirmar', sena: suelta?.sena },
    f.tokens.teso);
  t.status('y se confirma con el identificador que dio la propia app', confirmada, 200);

  const trasConfirmar = (fake.dumpSheet('Savings') || []).slice(1)
    .find((r) => Number(r[2]) === 50 && r[1] === 'GHM');
  t.eq('la fila queda confirmada', (trasConfirmar?.[6] || '').toLowerCase(), 'confirmado');
  t.check('y se le pone un identificador de verdad, para poder tocarla despues',
    /^sav_/.test((trasConfirmar?.[10] || '').toString()), trasConfirmar?.[10]);

  const tablero = await get('/api/gob/tablero?groupId=GHM', f.tokens.presi);
  t.near('y los $50 cuentan en el patrimonio del grupo',
    tablero.body?.aportes?.ahorroConfirmado, 50, 0.01);

  // ===================================================================
  t.section('ROTA 3. Nadie confirma su propia fila tecleada a mano');
  // ===================================================================
  preparar();
  const g = await baseScenario({ groupId: 'GHA' });
  await post('/api/gob/reglas', { groupId: 'GHA', requiereAprobacionAportes: true }, g.tokens.presi);
  // La tesorera escribe en la hoja un aporte A SU NOMBRE, sin autor
  filaAMano({ 0: g.users.teso.email, 1: 'GHA', 2: 500, 3: hoy(), 4: 'mensual', 6: 'pendiente' });

  const b3 = await get('/api/gob/aportes-pendientes?groupId=GHA', g.tokens.teso);
  const suyo = (b3.body?.ahorros || []).find((a) => a.monto === 500);
  const autoconfirma = await post('/api/gob/aportes/resolver',
    { groupId: 'GHA', tipo: 'ahorro', movId: suyo?.movId, accion: 'confirmar', sena: suyo?.sena },
    g.tokens.teso);
  t.status('la tesorera no se confirma a si misma una fila sin autor', autoconfirma, 403);
  t.eq('y se dice por que', autoconfirma.body?.motivo, 'fila_sin_autor');

  t.status('pero la presidencia si puede revisarla',
    await post('/api/gob/aportes/resolver',
      { groupId: 'GHA', tipo: 'ahorro', movId: suyo?.movId, accion: 'confirmar', sena: suyo?.sena },
      g.tokens.presi),
    200);

  // ===================================================================
  t.section('ROTA 4. Dos filas con el mismo identificador se avisan');
  // ===================================================================
  preparar();
  const h = await baseScenario({ groupId: 'GHD' });
  await post('/api/gob/reglas', { groupId: 'GHD', requiereAprobacionAportes: true }, h.tokens.presi);
  filaAMano({ 0: h.users.socio1.email, 1: 'GHD', 2: 10, 3: hoy(), 4: 'mensual', 6: 'pendiente', 10: 'MOVX' });
  filaAMano({ 0: h.users.socio2.email, 1: 'GHD', 2: 999, 3: hoy(), 4: 'mensual', 6: 'pendiente', 10: 'MOVX' });

  const duplicado = await post('/api/gob/aportes/resolver',
    { groupId: 'GHD', tipo: 'ahorro', movId: 'MOVX', accion: 'confirmar' }, h.tokens.teso);
  t.status('con el identificador repetido no se resuelve a ciegas', duplicado, 409);
  t.eq('y se dice que la hoja tiene dos', duplicado.body?.motivo, 'movid_duplicado');
  t.check('el mensaje dice donde mirar', /Savings/.test(duplicado.body?.message || ''),
    duplicado.body?.message);

  const tras4 = await get('/api/gob/tablero?groupId=GHD', h.tokens.presi);
  t.near('y no se confirmo ninguno de los dos', tras4.body?.aportes?.ahorroConfirmado, 0, 0.01);

  // ===================================================================
  t.section('ROTA 5. Borrar una fila no hace que se escriba en la de al lado');
  // ===================================================================
  preparar();
  const i = await baseScenario({ groupId: 'GHB' });
  await post('/api/gob/reglas', { groupId: 'GHB', requiereAprobacionAportes: true }, i.tokens.presi);

  filaAMano({ 0: i.users.socio1.email, 1: 'GHB', 2: 10, 3: hoy(), 4: 'mensual', 6: 'confirmado', 10: 'MOV_VIEJO' });
  filaAMano({ 0: i.users.socio1.email, 1: 'GHB', 2: 500, 3: hoy(), 4: 'mensual', 6: 'confirmado', 10: 'MOV_GRANDE' });
  filaAMano({ 0: i.users.socio2.email, 1: 'GHB', 2: 80, 3: hoy(), 4: 'mensual', 6: 'pendiente', 10: 'MOV_ELSA' });

  // La tesorera borra a mano la fila duplicada de arriba, desde la hoja
  const hojaSav = fake.ensureSheet('Savings');
  hojaSav.grid = hojaSav.grid.filter((r) => (r[10] || '') !== 'MOV_VIEJO');

  const resuelto = await post('/api/gob/aportes/resolver',
    { groupId: 'GHB', tipo: 'ahorro', movId: 'MOV_ELSA', accion: 'confirmar' }, i.tokens.presi);
  t.status('el aporte de Elsa se confirma igual', resuelto, 200);

  const filas = (fake.dumpSheet('Savings') || []).slice(1).filter((r) => (r[1] || '') === 'GHB');
  t.eq('siguen siendo dos filas, no tres', filas.length, 2);
  t.eq('la de Elsa consta UNA vez',
    filas.filter((r) => (r[10] || '') === 'MOV_ELSA').length, 1);
  t.eq('y esta confirmada',
    (filas.find((r) => (r[10] || '') === 'MOV_ELSA')?.[6] || '').toLowerCase(), 'confirmado');
  t.near('el aporte de $500 sigue intacto',
    Number(filas.find((r) => (r[10] || '') === 'MOV_GRANDE')?.[2]), 500, 0.01);

  const tb5 = await get('/api/gob/tablero?groupId=GHB', i.tokens.presi);
  t.near('y el patrimonio son 580, no 660 ni 1.080',
    tb5.body?.aportes?.ahorroConfirmado, 580, 0.01);

  // ===================================================================
  t.section('ROTA 6. Cambiar un rol no borra a nadie de otro grupo');
  // ===================================================================
  preparar();
  const j = await baseScenario({ groupId: 'GX1' });
  const otroPresi = seedUser({ nombre: 'Presi de otro', email: 'presi2@hr.test' });
  const otroSocio = seedUser({ nombre: 'Socia de otro', email: 'socia2@hr.test' });
  const { seedGroup } = require('./scenario');
  seedGroup({ id: 'GX2', nombre: 'El otro grupo', presidente: otroPresi.email });
  seedLink(otroPresi.email, 'GX2', 'presidente');
  seedLink(otroSocio.email, 'GX2', 'member');
  const tkOtro = await login(otroPresi.email);

  // El presidente del otro grupo saca a su socia; a la vez, el de este cambia un rol
  const [, cambio] = await Promise.all([
    post('/api/desvincular-usuario-grupo',
      { UserEmail: otroSocio.email, GroupID: 'GX2' }, tkOtro),
    post('/api/cambiar-rol-usuario-grupo',
      { UserEmail: j.users.socio1.email, GroupID: 'GX1', NewGroupRole: 'tesorero' }, j.tokens.presi),
  ]);
  t.statusIn('el cambio de rol se aplica', cambio, [200, 201, 409]);

  const links = (fake.dumpSheet('UserGroupLinks') || []).slice(1);
  const enGX1 = links.filter((r) => (r[1] || '') === 'GX1').map((r) => (r[0] || ''));
  t.check('el socio2 de GX1 sigue en su grupo', enGX1.includes(j.users.socio2.email),
    JSON.stringify(enGX1));
  t.check('y el socio1 tambien', enGX1.includes(j.users.socio1.email), JSON.stringify(enGX1));
  t.eq('nadie quedo con dos vinculos al mismo grupo',
    enGX1.length, new Set(enGX1).size, JSON.stringify(enGX1));

  const suPanel = await get(
    `/api/savings/complete?email=${j.users.socio2.email}&groupId=GX1`, j.tokens.socio2);
  t.status('y el socio2 sigue pudiendo entrar a su panel', suPanel, 200);

  // ===================================================================
  t.section('ROTA 7. Importes y fechas raros de la hoja');
  // ===================================================================
  preparar();
  const k = await baseScenario({ groupId: 'GHT' });
  filaAMano({ 0: k.users.socio1.email, 1: 'GHT', 2: '1,234.56', 3: hoy(), 4: 'mensual', 6: 'confirmado', 10: 'M_ANGLO' });
  filaAMano({ 0: k.users.socio1.email, 1: 'GHT', 2: '1.000,44', 3: hoy(), 4: 'mensual', 6: 'confirmado', 10: 'M_ESP' });
  // Una fecha como numero de serie de Excel, que es lo que sale al formatear la celda
  filaAMano({ 0: k.users.socio1.email, 1: 'GHT', 2: 10, 3: 45000, 4: 'mensual', 6: 'confirmado', 10: 'M_SERIE' });

  const panel = await get(
    `/api/savings/complete?email=${k.users.socio1.email}&groupId=GHT`, k.tokens.socio1);
  t.status('una fecha en formato de Excel no tumba el panel del socio', panel, 200);
  t.near('1,234.56 son mil doscientos treinta y cuatro, no uno con veintitres',
    panel.body?.data?.totalAhorros, 1234.56 + 1000.44 + 10, 0.02);

  // ===================================================================
  t.section('ROTA 8. Un vinculo dado de baja cierra las puertas');
  // ===================================================================
  preparar();
  const m = await baseScenario({ groupId: 'GHV' });
  filaAMano({ 0: m.users.socio1.email, 1: 'GHV', 2: 500, 3: hoy(), 4: 'mensual', 6: 'confirmado', 10: 'M_BAJA' });

  const antes = await get('/api/obtener-miembros?groupId=GHV', m.tokens.presi);
  const cuantosAntes = (antes.body?.members || antes.body?.miembros || antes.body || []).length;

  // La directiva lo marca de baja escribiendo en la hoja
  const hojaLinks = fake.ensureSheet('UserGroupLinks');
  hojaLinks.grid.forEach((r) => {
    if ((r[0] || '') === m.users.socio1.email && (r[1] || '') === 'GHV') r[4] = 'baja';
  });

  const despues = await get('/api/obtener-miembros?groupId=GHV', m.tokens.presi);
  const listaDespues = (despues.body?.members || despues.body?.miembros || despues.body || []);
  t.eq('deja de aparecer en la lista de miembros', listaDespues.length, cuantosAntes - 1);

  const tb8 = await get('/api/gob/tablero?groupId=GHV', m.tokens.presi);
  t.eq('y el tablero cuenta los mismos que la lista',
    tb8.body?.miembros?.activos, listaDespues.length);

  t.status('ya no registra ahorros en ese grupo',
    await post('/api/registrar-ahorros',
      { groupId: 'GHV', date: hoy(), amount: 10 }, m.tokens.socio1), 403);
  t.status('ni ve su panel del grupo',
    await get(`/api/savings/complete?email=${m.users.socio1.email}&groupId=GHV`, m.tokens.socio1), 403);

  // ===================================================================
  t.section('ROTA 9. Acciones: unidades y dolares no se mezclan');
  // ===================================================================
  preparar();
  const n = await baseScenario({ groupId: 'GHC' });
  fake.ensureSheet('Acciones').grid.push([
    n.users.socio1.email, 'GHC', hoy(), 30, 10, 2, new Date().toISOString(),
    'confirmado', 'x@x.test', 'y@y.test', new Date().toISOString(), 'acc_1', '',
  ]);
  filaAMano({ 0: n.users.socio1.email, 1: 'GHC', 2: 200, 3: hoy(), 4: 'mensual', 6: 'confirmado', 10: 'M_C' });

  const tb9 = await get('/api/gob/tablero?groupId=GHC', n.tokens.presi);
  t.near('el tablero declara 30 acciones', tb9.body?.aportes?.accionesUnidades, 30, 0.001);
  t.near('y su valor son $300', tb9.body?.aportes?.accionesValor, 300, 0.01);
  t.near('el patrimonio del grupo son 200 + 300', tb9.body?.aportes?.patrimonio, 500, 0.01);
  t.near('que es exactamente ahorro mas acciones',
    Number(tb9.body?.aportes?.ahorroConfirmado) + Number(tb9.body?.aportes?.accionesValor),
    tb9.body?.aportes?.patrimonio, 0.001);

  const stats = await get(
    `/api/savings/stats?email=${n.users.socio1.email}&groupId=GHC`, n.tokens.socio1);
  const st = stats.body?.stats || stats.body?.data || {};
  t.near('y las estadisticas cuentan 30 acciones, no 1 fila de compra',
    st.totalShares, 30, 0.001);

  // ===================================================================
  t.section('ROTA 10. Sin la pestana de comprobantes, el saldo no miente');
  // ===================================================================
  preparar();
  const o = await baseScenario({ groupId: 'GHP' });
  await post('/api/gob/reglas', { groupId: 'GHP', requiereAprobacionPrestamos: false }, o.tokens.presi);
  filaAMano({ 0: o.users.socio1.email, 1: 'GHP', 2: 300, 3: hoy(), 4: 'mensual', 6: 'confirmado', 10: 'M_P' });
  await post('/api/registrar-solicitud',
    { tipo: 'prestamo', data: { Monto: 100, Detalles: 'Plazo: 4', Group: 'GHP' } }, o.tokens.socio1);
  const sols = fake.dumpSheet('SolicitudesPrestamos') || [];
  await post('/api/approve-loan-request',
    { loanId: sols[sols.length - 1][0], action: 'approve' }, o.tokens.presi);

  const conPestana = await get(
    `/api/obtener-prestamos?groupId=GHP&userEmail=${o.users.socio1.email}`, o.tokens.socio1);
  const saldoInicial = Number((conPestana.body?.loans || [])[0]?.remainingBalance);
  t.check('el prestamo tiene saldo', saldoInicial > 0, `saldo: ${saldoInicial}`);

  // Alguien borra la pestana de comprobantes desde la hoja
  require('../test/fake-googleapis').__fake.store.sheets.delete('LoanPayments');

  const sinPestana = await get(
    `/api/obtener-prestamos?groupId=GHP&userEmail=${o.users.socio1.email}`, o.tokens.socio1);
  t.status('la consulta sigue respondiendo', sinPestana, 200);
  t.near('y el saldo es el mismo, porque no habia pagos',
    Number((sinPestana.body?.loans || [])[0]?.remainingBalance), saldoInicial, 0.01);
  t.check('la pestana se recreo sola', !!fake.dumpSheet('LoanPayments'),
    'LoanPayments no volvio');
};
