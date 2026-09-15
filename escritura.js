/**
 * Escribir una fila SIN pisar la del vecino.
 *
 * EL FALLO QUE ARREGLA
 * Todo el backend hace "leer la hoja -> decidir -> escribir la fila numero N".
 * El numero N sale de la posicion que la fila tenia EN LA LECTURA. Si entre la
 * lectura y la escritura desaparece una fila de mas arriba, N ya apunta a otra
 * persona y se escribe encima de ella.
 *
 * Medido con dos grupos distintos operando a la vez (los cerrojos son por
 * grupo, asi que no se estorban): la presidencia de un grupo saco a una socia
 * del suyo, y a la vez la presidencia del otro cambio un rol. La segunda
 * escritura cayo una fila mas abajo y una tercera socia, de un grupo que no
 * tenia nada que ver, desaparecio del suyo. Ella entra a su panel y recibe
 * "El usuario no pertenece al grupo solicitado". Nadie la borro.
 *
 * En la hoja de aportes el efecto es peor: la confirmacion cae en la fila de
 * abajo y DUPLICA el movimiento. Queda una copia pendiente y otra confirmada
 * con el mismo identificador; la tesoreria ve el pendiente, lo confirma otra
 * vez, y el patrimonio del grupo sube $80 sin que entre un dolar.
 *
 * Y no hace falta que sean dos peticiones: la hoja es la base de datos, y la
 * tesorera puede estar borrando una fila duplicada desde el navegador mientras
 * alguien confirma un aporte.
 *
 * COMO SE ARREGLA
 * No se escribe en "la fila N". Se escribe en "la fila cuyo identificador es X":
 * justo antes de escribir se vuelve a leer, se comprueba que la fila sigue
 * siendo la que se creia, y si se ha movido se la busca otra vez por su clave.
 * Si ya no esta, se responde con un error claro en vez de escribir a ciegas.
 *
 * LIMITE HONESTO: entre la comprobacion y la escritura queda una ventana de
 * milisegundos que Google Sheets no permite cerrar del todo (no hay escritura
 * condicional). Antes la ventana era toda la peticion; ahora es el viaje de una
 * llamada. Para las carreras que provoca la propia app, el cerrojo por hoja
 * (`hoja:UserGroupLinks`) las serializa y la ventana desaparece.
 */

'use strict';

const normalizar = (v) => (v == null ? '' : v).toString().trim().toLowerCase();

/** A1 de una columna por su indice 0-based: 0 -> A, 26 -> AA. */
function letraDeColumna(indice) {
  let n = Number(indice) + 1;
  let salida = '';
  while (n > 0) {
    const resto = (n - 1) % 26;
    salida = String.fromCharCode(65 + resto) + salida;
    n = Math.floor((n - 1) / 26);
  }
  return salida;
}

/**
 * Actualiza una fila localizandola por su clave, no por su posicion.
 *
 * @param {object} sheetsClient  cliente de Google Sheets
 * @param {object} opciones
 *   spreadsheetId   id del libro
 *   hoja            nombre de la pestana
 *   ultimaColumna   letra de la ultima columna a leer (p. ej. 'L')
 *   indice          posicion 0-based que se creia (solo como pista)
 *   claveCol        indice 0-based de la columna que identifica la fila
 *   clave           valor que debe tener esa columna
 *   construir       (filaActual, indiceActual) => array de valores a escribir
 *   desdeColumna    letra donde empieza lo que se escribe (por defecto 'A')
 *   valueInputOption 'RAW' por defecto
 *   intentos        cuantas veces se reintenta si la fila se movio (3)
 * @returns {Promise<{indice:number, fila:Array}>}
 * @throws  error con `.motivo` 'fila_desaparecida' o 'fila_inestable'
 */
async function actualizarFilaPorClave(sheetsClient, opciones) {
  const {
    spreadsheetId,
    hoja,
    ultimaColumna,
    indice,
    claveCol,
    clave,
    construir,
    desdeColumna = 'A',
    valueInputOption = 'RAW',
    intentos = 3,
  } = opciones;

  const buscada = normalizar(clave);
  if (!buscada && !opciones.esLaFila) {
    const e = new Error(
      `No se puede escribir en ${hoja} sin saber que fila es: la clave llego vacia.`);
    e.motivo = 'clave_vacia';
    e.code = 409;
    throw e;
  }

  // Reconocer la fila puede necesitar mas de una columna: en UserGroupLinks el
  // correo se repite (una fila por grupo) y en Savings tambien (una fila por
  // aporte). Con una sola columna se escribia sobre la fila equivocada: medido,
  // un socio acabo con dos vinculos al mismo grupo, y un aporte de febrero se
  // destruyo escribiendole encima el de marzo.
  const esLaFila = typeof opciones.esLaFila === 'function'
    ? opciones.esLaFila
    : (fila) => normalizar(fila && fila[claveCol]) === buscada;

  let i = Number.isInteger(indice) && indice >= 0 ? indice : -1;

  for (let n = 0; n < intentos; n += 1) {
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId,
      range: `${hoja}!A2:${ultimaColumna}`,
      // SIN memoria: si se sirviera de la memoria corta, se comprobaria contra
      // la misma foto de la que se desconfia y la comprobacion no valdria nada.
      __sinCache: true,
    });
    const filas = resp.data.values || [];

    // La fila que creiamos, ¿sigue siendo la nuestra?
    const candidata = i >= 0 ? filas[i] : null;
    if (!candidata || !esLaFila(candidata, i)) {
      const j = filas.findIndex((r, k) => esLaFila(r, k));
      if (j < 0) {
        const e = new Error(
          `La fila ${clave} ya no esta en ${hoja}. Alguien pudo borrarla desde la hoja `
          + 'de calculo mientras se hacia esta operacion. Vuelve a cargar y revisa.');
        e.motivo = 'fila_desaparecida';
        e.code = 409;
        throw e;
      }
      i = j;
      // Con el indice corregido, se vuelve a comprobar en la siguiente vuelta
      // en vez de escribir sobre una lectura que ya puede ser vieja.
      if (n < intentos - 1) continue;
    }

    const fila = filas[i];
    const valores = construir(fila, i);
    const filaHoja = i + 2;              // +1 cabecera, +1 base 1
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId,
      range: `${hoja}!${desdeColumna}${filaHoja}:${ultimaColumna}${filaHoja}`,
      valueInputOption,
      requestBody: { values: [valores] },
    });
    return { indice: i, fila };
  }

  const e = new Error(
    `No se pudo escribir con seguridad en ${hoja}: la fila ${clave} se movio varias veces `
    + 'seguidas. Vuelve a intentarlo en un momento.');
  e.motivo = 'fila_inestable';
  e.code = 409;
  throw e;
}

/** Cerrojo compartido para las hojas de las que se borran filas fisicamente. */
const cerrojoDeHoja = (nombre) => `hoja:${nombre}`;

module.exports = { actualizarFilaPorClave, letraDeColumna, cerrojoDeHoja, normalizar };
