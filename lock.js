/**
 * Exclusion mutua en memoria, por recurso.
 *
 * POR QUE HACE FALTA
 * Google Sheets no tiene transacciones ni bloqueos. Todo el backend hace
 * "leer -> decidir -> escribir". Si dos peticiones entran en esa ventana, las dos
 * leen el estado viejo y las dos escriben. Medido con latencia real:
 *   - aplicar el lote de apertura 3 veces a la vez cargaba los saldos 3 veces
 *     (un socio con $500 terminaba con $1.500),
 *   - un mismo directivo votando 3 veces alcanzaba el quorum el solo,
 *   - dos pagos simultaneos de $80 sobre una deuda de $104 pasaban ambos.
 *
 * Serializando por clave (el id del lote, de la solicitud, del prestamo...) la
 * ventana desaparece: la segunda peticion lee el estado YA escrito por la primera
 * y sus propias comprobaciones de idempotencia la rechazan con 409.
 *
 * LIMITE CONOCIDO: esto protege dentro de UN proceso Node. El backend corre como
 * una sola instancia en Render, que es el caso real. Si algun dia se escala a
 * varias instancias haria falta un bloqueo compartido (Redis o una celda testigo
 * en la propia hoja). Las comprobaciones de idempotencia por id que hay en el
 * codigo siguen siendo la segunda linea de defensa.
 */

'use strict';

const cadenas = new Map();
const TIMEOUT_MS = 30000;

/**
 * Ejecuta `fn` en exclusion mutua para `clave`. Las llamadas con la misma clave
 * se encolan; las de claves distintas corren en paralelo sin estorbarse.
 *
 * @param {string} clave  identificador del recurso (p. ej. `lote:abc123`)
 * @param {Function} fn   funcion async a ejecutar en exclusiva
 */
function conBloqueo(clave, fn) {
  const k = (clave || 'global').toString();
  const previa = cadenas.get(k) || Promise.resolve();

  // Corre tras la anterior, haya terminado bien o mal.
  const resultado = previa.then(() => ejecutarConLimite(fn), () => ejecutarConLimite(fn));

  // La cadena avanza ignorando el resultado, para no propagar errores al siguiente.
  const siguiente = resultado.then(() => {}, () => {});
  cadenas.set(k, siguiente);
  siguiente.then(() => {
    // Limpieza: si nadie mas se encolo detras, se libera la entrada del mapa.
    if (cadenas.get(k) === siguiente) cadenas.delete(k);
  });

  return resultado;
}

/** Evita que una funcion colgada bloquee para siempre esa clave. */
function ejecutarConLimite(fn) {
  return new Promise((resolve, reject) => {
    let terminado = false;
    const temporizador = setTimeout(() => {
      if (terminado) return;
      terminado = true;
      reject(new Error('La operacion excedio el tiempo maximo de bloqueo.'));
    }, TIMEOUT_MS);

    Promise.resolve()
      .then(fn)
      .then((valor) => {
        if (terminado) return;
        terminado = true;
        clearTimeout(temporizador);
        resolve(valor);
      })
      .catch((error) => {
        if (terminado) return;
        terminado = true;
        clearTimeout(temporizador);
        reject(error);
      });
  });
}

/** Numero de recursos con bloqueo activo (solo para diagnostico). */
function bloqueosActivos() {
  return cadenas.size;
}

module.exports = { conBloqueo, bloqueosActivos };
