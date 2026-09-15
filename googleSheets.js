/**
 * googleSheets.js
 * Cliente compartido de la API de Google Sheets.
 *
 * Antes este archivo era un resto de una version vieja: exportaba solo `findUser`
 * (que nadie usaba) con un SPREADSHEET_ID de ejemplo. `services/loansService.js`
 * importaba de aqui `getGoogleSheetsClient` y `SPREADSHEET_ID`, que no existian,
 * asi que TODO loansService fallaba con "getGoogleSheetsClient is not a function":
 * los endpoints /api/obtener-todos-prestamos y /api/registrar-prestamo-en-sheet
 * respondian 500 siempre.
 */

const { google } = require('googleapis');
const { envolver: envolverHoja } = require('./hoja');
const path = require('path');
const fs = require('fs');

const SPREADSHEET_ID = process.env.SPREADSHEET_ID || '1xWRnnSp5WjveWHvFJFcNO7bCfB1jyADtawmdXPQJtEA';

/** Credenciales: variable de entorno (produccion) o credentials.json (local). */
function cargarCredenciales() {
  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      return JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } catch (e) {
      console.error('[GOOGLE SHEETS] GOOGLE_CREDENTIALS no es un JSON valido:', e.message);
    }
  }
  const archivo = path.resolve(__dirname, 'credentials.json');
  if (fs.existsSync(archivo)) {
    try {
      return JSON.parse(fs.readFileSync(archivo, 'utf8'));
    } catch (e) {
      console.error('[GOOGLE SHEETS] credentials.json no es un JSON valido:', e.message);
    }
  }
  return null;
}

let clientePromesa = null;

/** Devuelve (y memoriza) el cliente autenticado de Sheets. */
async function getGoogleSheetsClient() {
  if (clientePromesa) return clientePromesa;
  clientePromesa = (async () => {
    const credenciales = cargarCredenciales();
    if (!credenciales) {
      throw new Error('No hay credenciales de Google (define GOOGLE_CREDENTIALS o coloca credentials.json).');
    }
    const auth = new google.auth.GoogleAuth({
      credentials: credenciales,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    return envolverHoja(google.sheets({ version: 'v4', auth: await auth.getClient() }));
  })().catch((error) => {
    clientePromesa = null; // permite reintentar en la siguiente llamada
    throw error;
  });
  return clientePromesa;
}

module.exports = { getGoogleSheetsClient, SPREADSHEET_ID };
