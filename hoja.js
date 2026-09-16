/**
 * Freno y memoria para las lecturas de Google Sheets.
 *
 * La hoja es la base de datos, y Google no deja leerla sin limite: unas 60
 * peticiones por minuto para la cuenta de servicio. Como cada pantalla dispara
 * varias lecturas de hoja completa (el panel del administrador hace 16, el
 * reparto 9, el tablero 7), bastan unas treinta pulsaciones seguidas para
 * agotar la cuota. Cuando eso pasa, Google responde 429 y la aplicacion deja de
 * leer PARA TODO EL MUNDO durante un minuto: no es que se ponga lenta, es que
 * deja de funcionar para las 30 socias a la vez.
 *
 * Aqui se envuelve el cliente de Sheets con tres cosas, sin tocar las 200
 * llamadas que ya existen:
 *
 *   1. MEMORIA CORTA: la misma lectura repetida en pocos segundos se sirve de
 *      memoria. Cualquier escritura sobre ese libro la borra entera, asi que
 *      nadie ve una cifra vieja despues de un movimiento.
 *   2. UNA SOLA LECTURA A LA VEZ: si dos peticiones piden el mismo rango en el
 *      mismo instante, se hace UNA lectura y las dos esperan a la misma.
 *   3. FRENO: no se dejan salir mas de N lecturas por minuto. Si se llega al
 *      tope, la peticion espera su turno en vez de tumbar la cuota. Y si Google
 *      responde 429 de todos modos, se reintenta con espera creciente.
 *
 * En las pruebas la memoria va desactivada (ttl 0): el emulador escribe en la
 * cuadricula por debajo, sin pasar por aqui, y una cifra en memoria enmascararia
 * lo que la prueba acaba de sembrar. La bateria `suite-cuota.js` la enciende a
 * proposito para comprobar que funciona.
 */

'use strict';

const numeroDe = (valor, porDefecto) => {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0 ? n : porDefecto;
};

const enPruebas = () => process.env.NODE_ENV === 'test';

const config = {
  // Cuanto vale una lectura guardada. En pruebas, nada.
  ttlMs: numeroDe(process.env.SHEETS_CACHE_MS, enPruebas() ? 0 : 12000),
  // Lecturas por minuto que se dejan salir. Google admite unas 60.
  maxPorMinuto: numeroDe(process.env.SHEETS_MAX_POR_MINUTO, enPruebas() ? 100000 : 50),
  // Y cuantas puede gastar UNA sola cuenta. Sin este segundo tope, una persona
  // recargando pantallas pesadas agotaba el cubo global y las demas socias,
  // incluso de otros grupos, recibian 429. Medido: seis lecturas seguidas de
  // una cuenta y la victima de otro grupo se quedo sin servicio.
  maxPorCuenta: numeroDe(process.env.SHEETS_MAX_POR_CUENTA, enPruebas() ? 100000 : 20),
  // El administrador de la plataforma necesita MAS que una socia, y no por
  // capricho: medido, recorrer su panel una sola vez cuesta 22 lecturas -- el
  // tablero, los grupos, las personas, participantes, el informe y los
  // indicadores-- contra un tope de 20. O sea que chocaba sin haber hecho nada
  // raro, y la pantalla salia con "demasiadas consultas". Es UNA sola cuenta y
  // solo lee, asi que su tope es mas alto; el de las socias no se toca.
  maxPorAdmin: numeroDe(process.env.SHEETS_MAX_POR_ADMIN, enPruebas() ? 100000 : 40),
  // Lo maximo que una peticion espera su turno antes de rendirse
  esperaMaxMs: numeroDe(process.env.SHEETS_ESPERA_MAX_MS, 15000),
  // Reintentos cuando Google responde 429 pese al freno
  reintentos: numeroDe(process.env.SHEETS_REINTENTOS, 3),
};

const memoria = new Map();     // clave -> { valor, expira }
const porCuenta = new Map();   // cuenta -> instantes de sus ultimas lecturas
const enVuelo = new Map();     // clave -> { promesa, epoca }
// Cada escritura sube la epoca. Una lectura que empezo en una epoca anterior no
// se puede compartir ni guardar: es de antes del movimiento.
let epoca = 0;
const ventana = [];            // instantes de las ultimas lecturas
const stats = { lecturas: 0, aciertos: 0, compartidas: 0, frenadas: 0, reintentos: 0, esperaMs: 0 };

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Clave estable de una lectura. Dos lecturas iguales tienen la misma. */
function claveDe(params) {
  const p = params || {};
  return [
    p.spreadsheetId || '',
    p.range || '',
    p.majorDimension || '',
    p.valueRenderOption || '',
    p.dateTimeRenderOption || '',
  ].join('|');
}

/** Borra de memoria todo lo de un libro. Se llama tras cualquier escritura. */
function invalidar(spreadsheetId) {
  epoca += 1;
  const id = (spreadsheetId || '').toString();
  if (!id) { memoria.clear(); enVuelo.clear(); return; }
  for (const clave of memoria.keys()) {
    if (clave.startsWith(`${id}|`)) memoria.delete(clave);
  }
  // Tambien las lecturas en vuelo: una que empezo antes de esta escritura trae
  // la foto de antes, y engancharse a ella devolvia la cifra vieja.
  for (const clave of enVuelo.keys()) {
    if (clave.startsWith(`${id}|`)) enVuelo.delete(clave);
  }
}

function invalidarTodo() {
  epoca += 1;
  memoria.clear();
  enVuelo.clear();
  ventana.length = 0;
  porCuenta.clear();
}

/**
 * De quien es la peticion que se esta atendiendo. Lo pone el servidor con
 * `enNombreDe`, para poder repartir la cuota entre las personas en vez de
 * dejar que una sola se la lleve toda.
 */
let cuentaActual = '';
let cuentaEsAdmin = false;
const enNombreDe = (cuenta, esAdmin) => {
  cuentaActual = (cuenta || '').toString().toLowerCase();
  cuentaEsAdmin = esAdmin === true;
};

/** Limpia y devuelve la ventana del minuto de una cuenta. */
function ventanaDe(cuenta, ahora) {
  if (!porCuenta.has(cuenta)) porCuenta.set(cuenta, []);
  const v = porCuenta.get(cuenta);
  while (v.length > 0 && ahora - v[0] >= 60000) v.shift();
  if (v.length === 0 && porCuenta.size > 500) porCuenta.delete(cuenta);
  return v;
}

/** Espera a que haya hueco en la ventana del minuto. */
async function pedirTurno() {
  if (!(config.maxPorMinuto > 0)) return;
  const inicio = Date.now();
  const cuenta = cuentaActual;
  const suTope = cuentaEsAdmin ? config.maxPorAdmin : config.maxPorCuenta;
  for (;;) {
    const ahora = Date.now();
    while (ventana.length > 0 && ahora - ventana[0] >= 60000) ventana.shift();

    // El tope de la persona va PRIMERO: si se pasa, espera ella, no las demas.
    const suya = cuenta && suTope > 0 ? ventanaDe(cuenta, ahora) : null;
    const sePasoElla = suya && suya.length >= suTope;

    if (!sePasoElla && ventana.length < config.maxPorMinuto) {
      ventana.push(ahora);
      if (suya) suya.push(ahora);
      return;
    }
    // Se espera A TROZOS, no de una vez hasta que la mas antigua cumpla el
    // minuto. Con el calculo anterior, en una rafaga (que es justo para lo que
    // existe el freno) la espera calculada era casi un minuto entero, pasaba del
    // tope y se rechazaba en el acto: el freno nunca frenaba, solo rechazaba.
    const masAntigua = sePasoElla ? suya[0] : ventana[0];
    const faltaParaLiberar = Math.max(0, 60000 - (ahora - masAntigua) + 10);
    const queda = config.esperaMaxMs - (ahora - inicio);
    if (queda <= 0) {
      stats.frenadas += 1;
      const e = new Error(sePasoElla
        ? 'Estas consultando demasiado rapido. Espera unos segundos y vuelve a intentarlo.'
        : 'La hoja de calculo esta recibiendo demasiadas consultas. '
          + 'Espera unos segundos y vuelve a intentarlo.');
      e.code = 429;
      e.motivo = 'cuota_hoja';
      e.deLaCuenta = !!sePasoElla;
      throw e;
    }
    const espera = Math.max(25, Math.min(faltaParaLiberar, queda, 250));
    stats.frenadas += 1;
    stats.esperaMs += espera;
    await dormir(espera);
  }
}

/** True si el error de Google es por haber pasado la cuota. */
function esDeCuota(error) {
  if (!error) return false;
  const codigo = Number(error.code || error.status || (error.response && error.response.status));
  if (codigo === 429) return true;
  const texto = `${error.message || ''} ${JSON.stringify(error.errors || '')}`;
  return /quota|rate limit|rateLimitExceeded|userRateLimitExceeded/i.test(texto);
}

/** Ejecuta una lectura con freno y reintentos. */
async function conFreno(fn) {
  let ultimo = null;
  for (let intento = 0; intento <= config.reintentos; intento += 1) {
    await pedirTurno();
    try {
      stats.lecturas += 1;
      return await fn();
    } catch (e) {
      ultimo = e;
      if (!esDeCuota(e) || intento === config.reintentos) throw e;
      stats.reintentos += 1;
      const espera = 1000 * (2 ** intento);
      stats.esperaMs += espera;
      await dormir(espera);
    }
  }
  throw ultimo;
}

/**
 * Envuelve un cliente de Google Sheets. Devuelve otro con la misma forma:
 * `spreadsheets.values.get/update/append/batchGet/batchUpdate/clear` y
 * `spreadsheets.get/batchUpdate/create`.
 */
function envolver(cliente) {
  if (!cliente || !cliente.spreadsheets) return cliente;
  if (cliente.__conFreno) return cliente;

  const orig = cliente.spreadsheets;
  const values = orig.values || {};

  const escritura = (fn) => async function envuelta(params, ...resto) {
    invalidar(params && params.spreadsheetId);
    try {
      return await fn.call(values, params, ...resto);
    } finally {
      // Tambien despues: si la escritura cambio la hoja, lo que se leyera
      // mientras tanto ya no vale.
      invalidar(params && params.spreadsheetId);
    }
  };

  const valuesEnvueltos = { ...values };

  if (typeof values.get === 'function') {
    valuesEnvueltos.get = async function get(params, ...resto) {
      const clave = claveDe(params);
      const ahora = Date.now();
      // `sinCache` lo pide quien va a ESCRIBIR sobre lo que lee. Sin esto, la
      // comprobacion de `escritura.js` (releer para ver si la fila se movio) se
      // servia de memoria: se comprobaba contra la misma foto de la que
      // desconfiaba, y la proteccion no protegia nada.
      const sinCache = !!(params && params.__sinCache);
      const limpio = { ...params };
      delete limpio.__sinCache;

      if (config.ttlMs > 0 && !sinCache) {
        const guardado = memoria.get(clave);
        if (guardado && guardado.expira > ahora) {
          stats.aciertos += 1;
          return guardado.valor;
        }
        const yendo = enVuelo.get(clave);
        if (yendo && yendo.epoca === epoca) {
          stats.compartidas += 1;
          return yendo.promesa;
        }
      }

      const miEpoca = epoca;
      const promesa = conFreno(() => values.get.call(values, limpio, ...resto))
        .then((r) => {
          // Si hubo una escritura mientras esta lectura viajaba, lo que trae ya
          // es de antes: no se guarda.
          if (config.ttlMs > 0 && !sinCache && miEpoca === epoca) {
            memoria.set(clave, { valor: r, expira: Date.now() + config.ttlMs });
          }
          return r;
        })
        .finally(() => {
          const yendo = enVuelo.get(clave);
          if (yendo && yendo.promesa === promesa) enVuelo.delete(clave);
        });

      if (config.ttlMs > 0 && !sinCache) enVuelo.set(clave, { promesa, epoca: miEpoca });
      return promesa;
    };
  }

  for (const nombre of ['update', 'append', 'batchUpdate', 'clear', 'batchClear']) {
    if (typeof values[nombre] === 'function') {
      valuesEnvueltos[nombre] = escritura(values[nombre]);
    }
  }

  // batchGet TAMBIEN se cachea, con la misma politica de 12 s que `get`.
  //
  // Antes no: el comentario decia que "sus rangos varian mucho". Medido, es al
  // reves -- las pantallas pesadas piden SIEMPRE la misma lista: el informe del
  // proyecto y los indicadores comparten los mismos 16 rangos, obtener-grupos
  // repite tres y participantes cuatro. Sin cachear, abrir el panel de
  // administracion costaba 22 unidades de cuota contra un tope de 20 por
  // cuenta, y salia "la hoja esta recibiendo demasiadas consultas" sin que
  // nadie hubiera hecho nada raro.
  //
  // La seguridad es la misma que en `get`: cualquier escritura invalida todo
  // (`invalidar`), una lectura que viajaba durante una escritura no se guarda,
  // y `__sinCache` sigue saltandose la memoria para quien va a escribir sobre
  // lo que lee.
  if (typeof values.batchGet === 'function') {
    valuesEnvueltos.batchGet = async function batchGet(params, ...resto) {
      const p = params || {};
      const sinCache = !!p.__sinCache;
      const limpio = { ...p };
      delete limpio.__sinCache;
      const clave = [
        'batch',
        p.spreadsheetId || '',
        (p.ranges || []).join('|'),
        p.majorDimension || '',
        p.valueRenderOption || '',
      ].join('::');
      const ahora = Date.now();

      if (config.ttlMs > 0 && !sinCache) {
        const guardado = memoria.get(clave);
        if (guardado && guardado.expira > ahora) {
          stats.aciertos += 1;
          return guardado.valor;
        }
        const yendo = enVuelo.get(clave);
        if (yendo && yendo.epoca === epoca) {
          stats.compartidas += 1;
          return yendo.promesa;
        }
      }

      const miEpoca = epoca;
      const promesa = conFreno(() => values.batchGet.call(values, limpio, ...resto))
        .then((r) => {
          if (config.ttlMs > 0 && !sinCache && miEpoca === epoca) {
            memoria.set(clave, { valor: r, expira: Date.now() + config.ttlMs });
          }
          return r;
        })
        .finally(() => {
          const yendo = enVuelo.get(clave);
          if (yendo && yendo.promesa === promesa) enVuelo.delete(clave);
        });

      if (config.ttlMs > 0 && !sinCache) enVuelo.set(clave, { promesa, epoca: miEpoca });
      return promesa;
    };
  }

  const spreadsheets = { ...orig, values: valuesEnvueltos };

  if (typeof orig.get === 'function') {
    spreadsheets.get = async function get(params, ...resto) {
      return conFreno(() => orig.get.call(orig, params, ...resto));
    };
  }
  // Crear o modificar la estructura del libro (pestanas nuevas, borrar filas)
  // invalida todo lo que hubiera guardado de ese libro.
  if (typeof orig.batchUpdate === 'function') {
    spreadsheets.batchUpdate = async function batchUpdate(params, ...resto) {
      invalidar(params && params.spreadsheetId);
      try {
        return await orig.batchUpdate.call(orig, params, ...resto);
      } finally {
        invalidar(params && params.spreadsheetId);
      }
    };
  }

  return { ...cliente, spreadsheets, __conFreno: true };
}

/** Ajusta el comportamiento en caliente. Lo usan las pruebas. */
function configurar(cambios = {}) {
  if (cambios.ttlMs !== undefined) config.ttlMs = numeroDe(cambios.ttlMs, config.ttlMs);
  if (cambios.maxPorMinuto !== undefined) config.maxPorMinuto = numeroDe(cambios.maxPorMinuto, config.maxPorMinuto);
  if (cambios.esperaMaxMs !== undefined) config.esperaMaxMs = numeroDe(cambios.esperaMaxMs, config.esperaMaxMs);
  if (cambios.reintentos !== undefined) config.reintentos = numeroDe(cambios.reintentos, config.reintentos);
  if (cambios.maxPorCuenta !== undefined) config.maxPorCuenta = numeroDe(cambios.maxPorCuenta, config.maxPorCuenta);
  return { ...config };
}

const estadisticas = () => ({ ...stats, enMemoria: memoria.size, ventana: ventana.length });

const reiniciarEstadisticas = () => {
  Object.keys(stats).forEach((k) => { stats[k] = 0; });
};

module.exports = {
  enNombreDe,
  envolver,
  invalidar,
  invalidarTodo,
  configurar,
  estadisticas,
  reiniciarEstadisticas,
  esDeCuota,
};
