/**
 * Emulador en memoria de la Google Sheets API v4.
 * Sustituye a 'googleapis' durante las pruebas para poder ejecutar el backend
 * completo sin tocar la hoja real (ni consumir la cuota de 60 lecturas/min).
 *
 * Reproduce fielmente los comportamientos que causan bugs reales:
 *  - values.get recorta filas finales vacias y celdas finales vacias de cada fila
 *  - values.get omite la clave `values` cuando no hay datos
 *  - append escribe despues de la ultima fila con datos de la hoja
 *  - los numeros con decimales pueden volver como texto con coma (locale es-EC)
 */

const store = {
  sheets: new Map(), // title -> { sheetId, grid: any[][] }
  nextSheetId: 1,
  calls: { get: 0, update: 0, append: 0, batchGet: 0, batchUpdate: 0, clear: 0 },
  localeDecimalComma: false,
  // Latencia simulada por llamada. Con 0 las operaciones se resuelven casi
  // instantaneamente y las carreras lectura-escritura no llegan a producirse;
  // subiendola se reproducen las condiciones reales de red contra Google.
  latencyMs: 0,
  // Fallos a proposito: [{ op, patron, restantes }]. Sirven para probar que
  // pasa cuando Google acepta una escritura y rechaza la siguiente, que es
  // justo el caso en que la importacion puede dejar el trabajo a medias.
  fallos: [],
};

/** Espera la latencia simulada (si la hay) antes de responder. */
function latencia() {
  if (!store.latencyMs) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, store.latencyMs));
}

function reset() {
  store.sheets.clear();
  store.nextSheetId = 1;
  store.calls = { get: 0, update: 0, append: 0, batchGet: 0, batchUpdate: 0, clear: 0 };
  store.localeDecimalComma = false;
  store.latencyMs = 0;
  store.fallos = [];
}

/** Hace que la proxima operacion que encaje reviente, como haria Google. */
function fallarEn(op, patron, veces = 1, mensaje = null) {
  store.fallos.push({ op, patron, restantes: veces, mensaje });
}

/** Si toca fallar en esta operacion, lanza el error y consume el turno. */
function quizaFallar(op, range) {
  const i = store.fallos.findIndex((f) => (
    f.restantes > 0 && f.op === op && (!f.patron || new RegExp(f.patron).test(range || ''))
  ));
  if (i === -1) return;
  store.fallos[i].restantes -= 1;
  const err = new Error(store.fallos[i].mensaje || `Fallo simulado en ${op} sobre ${range}`);
  err.code = 500;
  throw err;
}

function ensureSheet(title) {
  if (!store.sheets.has(title)) {
    store.sheets.set(title, { sheetId: store.nextSheetId++, grid: [] });
  }
  return store.sheets.get(title);
}

function seedSheet(title, rows) {
  const s = ensureSheet(title);
  s.grid = rows.map((r) => r.map((c) => (c === undefined || c === null ? '' : c)));
  return s;
}

function dumpSheet(title) {
  const s = store.sheets.get(title);
  return s ? s.grid.map((r) => r.slice()) : null;
}

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function indexToCol(i) {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

const A1_PART = /^([A-Za-z]*)(\d*)$/;
const QUOTED_TITLE = /^'(.*)'$/;

/** Parsea notacion A1: "Hoja!A2:E", "Hoja!1:1", "Hoja", "'Mi Hoja'!A1:B2" */
function parseRange(range) {
  const raw = (range || '').toString();
  const bang = raw.lastIndexOf('!');
  let title = raw;
  let ref = null;
  if (bang >= 0) {
    title = raw.slice(0, bang);
    ref = raw.slice(bang + 1);
  }
  const quoted = QUOTED_TITLE.exec(title);
  if (quoted) title = quoted[1];
  if (!ref) return { title, startRow: 0, startCol: 0, endRow: null, endCol: null };

  const parts = ref.split(':');
  const m1 = A1_PART.exec(parts[0] || '') || ['', '', ''];
  const m2 = parts[1] === undefined ? m1 : (A1_PART.exec(parts[1]) || ['', '', '']);

  return {
    title,
    startCol: m1[1] ? colToIndex(m1[1]) : 0,
    startRow: m1[2] ? parseInt(m1[2], 10) - 1 : 0,
    endCol: m2[1] ? colToIndex(m2[1]) : null,
    endRow: m2[2] ? parseInt(m2[2], 10) - 1 : null,
  };
}

function isEmptyCell(v) {
  return v === undefined || v === null || v === '';
}

function formatOut(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number' && store.localeDecimalComma && !Number.isInteger(v)) {
    return v.toString().replace('.', ',');
  }
  return v;
}

function readValues(range) {
  const { title, startRow, startCol, endRow, endCol } = parseRange(range);
  const sheet = store.sheets.get(title);
  if (!sheet) {
    const err = new Error(`Unable to parse range: ${range}`);
    err.code = 400;
    err.status = 400;
    throw err;
  }
  const lastRow = endRow === null ? sheet.grid.length - 1 : endRow;
  const out = [];
  for (let r = startRow; r <= lastRow; r++) {
    const srcRow = sheet.grid[r] || [];
    const lastCol = endCol === null ? Math.max(srcRow.length - 1, startCol) : endCol;
    const row = [];
    for (let c = startCol; c <= lastCol; c++) row.push(formatOut(srcRow[c]));
    out.push(row);
  }
  for (const row of out) {
    while (row.length && isEmptyCell(row[row.length - 1])) row.pop();
  }
  while (out.length && out[out.length - 1].length === 0) out.pop();
  return out;
}

function writeValues(range, values, options) {
  const append = !!(options && options.append);
  const { title, startRow, startCol } = parseRange(range);
  const sheet = ensureSheet(title);
  let baseRow = startRow;
  if (append) {
    let last = -1;
    for (let r = 0; r < sheet.grid.length; r++) {
      if ((sheet.grid[r] || []).some((c) => !isEmptyCell(c))) last = r;
    }
    baseRow = last + 1;
  }
  const rows = values || [];
  for (let i = 0; i < rows.length; i++) {
    const target = baseRow + i;
    while (sheet.grid.length <= target) sheet.grid.push([]);
    const row = sheet.grid[target];
    const src = rows[i] || [];
    for (let j = 0; j < src.length; j++) {
      const col = startCol + j;
      while (row.length <= col) row.push('');
      row[col] = src[j] === undefined || src[j] === null ? '' : src[j];
    }
  }
  return {
    updatedRows: rows.length,
    updatedRange: `${title}!${indexToCol(startCol)}${baseRow + 1}`,
  };
}

function clearValues(range) {
  const { title, startRow, startCol, endRow, endCol } = parseRange(range);
  const sheet = store.sheets.get(title);
  if (!sheet) return;
  const lastRow = endRow === null ? sheet.grid.length - 1 : endRow;
  for (let r = startRow; r <= lastRow; r++) {
    const row = sheet.grid[r];
    if (!row) continue;
    const lastCol = endCol === null ? row.length - 1 : endCol;
    for (let c = startCol; c <= lastCol; c++) row[c] = '';
  }
}

const sheetsApi = {
  spreadsheets: {
    get: async ({ spreadsheetId }) => ({
      // Leer la ESTRUCTURA del libro tambien gasta cuota y no se contaba.
      data: (store.calls.estructura = (store.calls.estructura || 0) + 1) && {
        spreadsheetId,
        sheets: [...store.sheets.entries()].map(([title, s]) => ({
          properties: {
            title,
            sheetId: s.sheetId,
            gridProperties: { rowCount: Math.max(s.grid.length, 1000), columnCount: 30 },
          },
        })),
      },
    }),

    batchUpdate: async (params) => {
      quizaFallar('batchUpdate', '');
      store.calls.batchUpdate++;
      const body = params.requestBody || params.resource || {};
      const replies = [];
      for (const req of body.requests || []) {
        if (req.addSheet) {
          const title = req.addSheet.properties.title;
          if (store.sheets.has(title)) {
            const err = new Error(`A sheet with the name "${title}" already exists.`);
            err.code = 400;
            throw err;
          }
          const s = ensureSheet(title);
          replies.push({ addSheet: { properties: { title, sheetId: s.sheetId } } });
        } else if (req.deleteDimension) {
          const { range } = req.deleteDimension;
          const entry = [...store.sheets.entries()].find(([, s]) => s.sheetId === range.sheetId);
          if (entry) {
            entry[1].grid.splice(range.startIndex, range.endIndex - range.startIndex);
          }
          replies.push({});
        } else if (req.deleteSheet) {
          const entry = [...store.sheets.entries()].find(([, s]) => s.sheetId === req.deleteSheet.sheetId);
          if (entry) store.sheets.delete(entry[0]);
          replies.push({});
        } else {
          replies.push({});
        }
      }
      return { data: { replies } };
    },

    values: {
      get: async ({ range }) => {
        await latencia();
        quizaFallar('get', range);
        store.calls.get++;
        const values = readValues(range);
        return {
          data: values.length
            ? { range, majorDimension: 'ROWS', values }
            : { range, majorDimension: 'ROWS' },
        };
      },

      batchGet: async ({ ranges }) => {
        // El fallo a proposito tambien vale aqui. Antes fallarEn('batchGet')
        // se quedaba sin consumir y la prueba que lo usaba no comprobaba nada.
        quizaFallar('batchGet', (ranges || []).join('|'));
        await latencia();
        store.calls.batchGet++;
        return {
          data: {
            valueRanges: (ranges || []).map((range) => {
              const values = readValues(range);
              return values.length ? { range, values } : { range };
            }),
          },
        };
      },

      update: async (params) => {
        await latencia();
        quizaFallar('update', params.range);
        store.calls.update++;
        const body = params.requestBody || params.resource || {};
        const r = writeValues(params.range, body.values);
        return { data: { updatedRange: r.updatedRange, updatedRows: r.updatedRows } };
      },

      // Varias celdas sueltas en UNA llamada. El emulador no lo tenia, asi que
      // el codigo que lo usara habria reventado en las pruebas sin decir por
      // que. Cada rango pasa por quizaFallar('update', ...) para que un fallo
      // inyectado sobre una celda concreta siga funcionando.
      batchUpdate: async (params) => {
        await latencia();
        const body = params.requestBody || params.resource || {};
        const datos = body.data || [];
        for (const d of datos) quizaFallar('update', d.range);
        store.calls.valuesBatchUpdate = (store.calls.valuesBatchUpdate || 0) + 1;
        const responses = datos.map((d) => {
          const r = writeValues(d.range, d.values);
          return { updatedRange: r.updatedRange, updatedRows: r.updatedRows };
        });
        return {
          data: {
            totalUpdatedRows: responses.reduce((s, r) => s + (r.updatedRows || 0), 0),
            responses,
          },
        };
      },

      append: async (params) => {
        await latencia();
        quizaFallar('append', params.range);
        store.calls.append++;
        const body = params.requestBody || params.resource || {};
        const r = writeValues(params.range, body.values, { append: true });
        return { data: { updates: { updatedRange: r.updatedRange, updatedRows: r.updatedRows } } };
      },

      clear: async ({ range }) => {
        quizaFallar('clear', range);
        store.calls.clear++;
        clearValues(range);
        return { data: { clearedRange: range } };
      },
    },
  },
};

class GoogleAuth {
  constructor(opts) { this.opts = opts; }
  async getClient() { return { fake: true }; }
  async authorize() { return true; }
}

class JWTAuth {
  async authorize() { return true; }
}

const google = {
  auth: { GoogleAuth, JWT: JWTAuth },
  sheets: () => sheetsApi,
};

module.exports = {
  google,
  __fake: { store, reset, seedSheet, dumpSheet, ensureSheet, parseRange, readValues, fallarEn },
};
