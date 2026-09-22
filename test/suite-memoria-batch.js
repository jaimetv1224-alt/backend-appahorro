/**
 * SUITE 51 - La memoria de lotes tambien tiene que enterarse de las escrituras.
 *
 * hoja.js guarda 12 segundos lo que lee. Cuando algo se escribe, `invalidar()`
 * borra lo guardado de ese libro, y reconoce lo que es del libro porque la
 * clave EMPIEZA por `${spreadsheetId}|`.
 *
 * La clave de `batchGet` empezaba por 'batch::'. O sea que no la reconocia:
 * **ninguna escritura borraba jamas una entrada de batchGet**. Quien guardaba
 * algo y volvia a mirar seguia viendo la foto de antes hasta 12 segundos
 * despues, sin ningun aviso y sin forma de saber por que. Es un acoplamiento a
 * distancia: leyendo `invalidar` sola, o leyendo `batchGet` sola, no se ve.
 *
 * No se veia en la bateria porque las pruebas corren con ttlMs 0, o sea sin
 * memoria. Por eso esta suite la enciende a proposito, como hace suite-produccion.
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario } = require('./scenario');
const t = require('./runner');

module.exports = async function run() {
  const hoja = require('../hoja');
  const acc = require('../accesos');
  const G = require('../governance').SHEETS;
  const { HOJA_CAMPO, CABECERA_CAMPO } = require('../instrumento');

  const antes = hoja.configurar({});
  try {
    hoja.configurar({ ttlMs: 12000, maxPorMinuto: 100000, maxPorCuenta: 100000, maxPorAdmin: 100000 });

    seedWorkbook();
    Object.values(G).forEach((d) => fake.seedSheet(d.name, [d.headers]));
    fake.seedSheet(acc.HOJA, [acc.CABECERA]);
    fake.seedSheet(HOJA_CAMPO, [CABECERA_CAMPO]);
    ['Savings', 'Acciones', 'Loans', 'LoanPayments'].forEach((n) => fake.ensureSheet(n));
    hoja.invalidarTodo();
    const e = await baseScenario({ groupId: 'MEM' });
    hoja.invalidarTodo();

    const cliente = await require('../googleSheets').getGoogleSheetsClient();
    const ID = require('../googleSheets').SPREADSHEET_ID;
    const RANGOS = ['Savings!A2:L', 'Users!A2:I'];
    const pedirLote = () => cliente.spreadsheets.values.batchGet({
      spreadsheetId: ID, ranges: RANGOS,
    });
    const lecturas = () => hoja.estadisticas().lecturas;

    // ===================================================================
    t.section('MEB 1. Un lote guardado en memoria se vuelve a servir');
    // ===================================================================
    // La barandilla: la memoria tiene que seguir sirviendo para algo.
    await pedirLote();
    const trasPrimera = lecturas();
    await pedirLote();
    t.eq('la segunda consulta identica no gasta cuota', lecturas(), trasPrimera);

    // ===================================================================
    t.section('MEB 2. Una escritura invalida tambien la memoria de lotes');
    // ===================================================================
    // ESTE es el defecto. Antes del arreglo esta seccion falla entera: la
    // escritura no tocaba la entrada de batchGet y el lote seguia devolviendo
    // la foto vieja.
    fake.ensureSheet('Savings').grid.push([
      'nueva@juntago.test', 'MEM', 99, '2026-05-01', 'mensual', 'aporte nuevo',
      'confirmado', 'nueva@juntago.test', '', '2026-05-01T10:00:00.000Z', 'sav_mem_1', '',
    ]);
    await cliente.spreadsheets.values.append({
      spreadsheetId: ID,
      range: 'Savings!A:L',
      valueInputOption: 'RAW',
      requestBody: { values: [['x@juntago.test', 'MEM', 1, '2026-05-02', 'mensual', 'x',
        'confirmado', '', '', '', 'sav_mem_2', '']] },
    });

    const antesDeRecargar = lecturas();
    const lote = await pedirLote();
    t.check('tras escribir, el lote se vuelve a leer de verdad',
      lecturas() > antesDeRecargar, `lecturas ${antesDeRecargar} -> ${lecturas()}`);

    const filasSavings = (lote.data.valueRanges || [])[0];
    const textoFilas = JSON.stringify((filasSavings && filasSavings.values) || []);
    t.check('y trae la fila nueva, no la foto anterior',
      /sav_mem_1/.test(textoFilas), textoFilas.slice(0, 160));
    t.check('incluida la que se anadio por append',
      /sav_mem_2/.test(textoFilas), textoFilas.slice(0, 160));

    // ===================================================================
    t.section('MEB 3. Un cambio de estructura tambien la invalida');
    // ===================================================================
    await pedirLote();
    const antesDeEstructura = lecturas();
    await cliente.spreadsheets.batchUpdate({
      spreadsheetId: ID,
      requestBody: { requests: [{ addSheet: { properties: { title: 'HojaNuevaMEB' } } }] },
    });
    await pedirLote();
    t.check('una escritura estructural tambien obliga a releer',
      lecturas() > antesDeEstructura, `lecturas ${antesDeEstructura} -> ${lecturas()}`);

    // ===================================================================
    t.section('MEB 4. Dos lotes distintos no comparten entrada');
    // ===================================================================
    // Si la clave no distingue las opciones, un lote devuelve lo que pidio otro.
    await cliente.spreadsheets.values.batchGet({
      spreadsheetId: ID, ranges: RANGOS, dateTimeRenderOption: 'SERIAL_NUMBER',
    });
    const antesDeOtro = lecturas();
    await cliente.spreadsheets.values.batchGet({
      spreadsheetId: ID, ranges: RANGOS, dateTimeRenderOption: 'FORMATTED_STRING',
    });
    t.check('cambiar el formato de fecha obliga a una lectura propia',
      lecturas() > antesDeOtro, `lecturas ${antesDeOtro} -> ${lecturas()}`);

    // ===================================================================
    t.section('MEB 5. De punta a punta: guardar y volver a mirar');
    // ===================================================================
    // La prueba que le importa a una persona: anoto la ficha de campo de un
    // grupo y vuelvo a pedir el instrumento. Tiene que salir lo que acabo de
    // escribir, no lo de hace doce segundos.
    let r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
    t.status('el instrumento responde', r, 200);
    t.eq('todavia sin grupos CAYC', r.body.indicador.denominador, 0);

    r = await post('/api/admin/seguimiento-campo', {
      grupos: [{ groupId: 'MEM', grupo: 'Banco Comunal Salinas', esCayc: true,
        socializacionFecha: '2026-04-01', socializacionAsistentes: 9 }],
    }, e.tokens.admin);
    t.status('se anota la ficha de campo', r, 200);

    r = await get('/api/admin/instrumento-digitalizacion', e.tokens.admin);
    t.eq('y el instrumento YA lo refleja, sin esperar a que caduque la memoria',
      r.body.indicador.denominador, 1);

    // ===================================================================
    t.section('MEB 6. Comprobar que una pestana existe no se pregunta 5 veces');
    // ===================================================================
    // ensureSheetExists se llama antes de cada anexado y pedia la estructura
    // ENTERA del libro cada vez. Cinco anexados en una peticion eran cinco
    // lecturas de estructura para averiguar cinco veces lo mismo.
    const utils = require('../sheetsUtils');
    const antesEnsure = utils.configurarEnsure(12000);
    try {
      const estructuraAntes = fake.store.calls.estructura || 0;
      const medir = () => (fake.store.calls.estructura || 0) - estructuraAntes;

      await utils.ensureSheetExists('HojaEnsureMEB', ['A', 'B'], cliente, ID);
      const trasPrimera = medir();
      t.check('la primera vez si se pregunta', trasPrimera >= 1, `${trasPrimera}`);

      for (let i = 0; i < 4; i += 1) {
        await utils.ensureSheetExists('HojaEnsureMEB', ['A', 'B'], cliente, ID);
      }
      t.eq('y las cuatro siguientes no vuelven a preguntar', medir(), trasPrimera);

      // Pero una pestana DISTINTA si se comprueba: no se memoriza de mas.
      await utils.ensureSheetExists('OtraHojaMEB', ['A'], cliente, ID);
      t.check('una pestana distinta si se comprueba', medir() > trasPrimera, `${medir()}`);

      // Y la cabecera quedo puesta, que es lo que hace visible la fila 2.
      const rejilla = (fake.store.sheets.get('HojaEnsureMEB') || { grid: [] }).grid;
      t.eq('la cabecera quedo escrita', (rejilla[0] || []).join(','), 'A,B');
    } finally {
      utils.configurarEnsure(antesEnsure);
    }
  } finally {
    hoja.configurar(antes);
    hoja.invalidarTodo();
  }
};
