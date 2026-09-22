/**
 * Registro de accesos: quien entra, cuando y desde que aparato.
 *
 * Sirve al proyecto de investigacion para saber como se usa la app en campo:
 * con que frecuencia entran los grupos, si lo hacen desde el telefono o desde
 * una computadora, y a que horas.
 *
 * Solo se guarda lo necesario para eso. Nada de esto se le muestra a los demas
 * socios: solo al administrador de la plataforma, en su panel.
 *
 * No depende de Google Sheets ni de Express: la parte de interpretar el
 * navegador se puede probar sola.
 */

'use strict';

const HOJA = 'Accesos';
const CABECERA = ['Fecha', 'Email', 'Dispositivo', 'Sistema', 'Navegador', 'IP', 'UserAgent', 'Origen'];

// Cuanto tiene que estar callada una persona para que su siguiente peticion
// cuente como una entrada nueva. Media hora es lo habitual para separar
// sesiones: abrir la app por la mañana y por la tarde son dos entradas; estar
// diez minutos dando vueltas por las pantallas es una sola.
// Configurable con SESION_MINUTOS para poder probarlo sin esperar media hora.
const MINUTOS_DE_SESION = (() => {
  const n = Number(process.env.SESION_MINUTOS);
  return Number.isFinite(n) && n >= 0 ? n : 30;
})();

/**
 * Traduce la cadena que manda el navegador a algo legible.
 * Se hace a mano y no con una libreria: es poca cosa y evita una dependencia
 * mas que mantener y auditar.
 */
function interpretarNavegador(ua) {
  const s = (ua || '').toString();
  if (!s) return { dispositivo: 'desconocido', sistema: 'desconocido', navegador: 'desconocido' };

  // --- Sistema ---
  let sistema = 'desconocido';
  if (/Windows NT 10/.test(s)) sistema = 'Windows 10/11';
  else if (/Windows NT/.test(s)) sistema = 'Windows';
  else if (/Android (\d+)/.test(s)) sistema = `Android ${s.match(/Android (\d+)/)[1]}`;
  else if (/Android/.test(s)) sistema = 'Android';
  else if (/iPhone OS (\d+)/.test(s)) sistema = `iOS ${s.match(/iPhone OS (\d+)/)[1]}`;
  else if (/iPad|iPhone|iPod/.test(s)) sistema = 'iOS';
  else if (/Mac OS X/.test(s)) sistema = 'macOS';
  else if (/CrOS/.test(s)) sistema = 'ChromeOS';
  else if (/Linux/.test(s)) sistema = 'Linux';

  // --- Aparato ---
  let dispositivo = 'escritorio';
  if (/iPad|Tablet|PlayBook|Silk/.test(s) || (/Android/.test(s) && !/Mobile/.test(s))) {
    dispositivo = 'tableta';
  } else if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry/.test(s)) {
    dispositivo = 'movil';
  }

  // --- Navegador (el orden importa: Chrome tambien dice Safari) ---
  let navegador = 'otro';
  if (/Edg\//.test(s)) navegador = 'Edge';
  else if (/OPR\/|Opera/.test(s)) navegador = 'Opera';
  else if (/SamsungBrowser/.test(s)) navegador = 'Samsung Internet';
  else if (/Firefox\//.test(s)) navegador = 'Firefox';
  else if (/Chrome\//.test(s)) navegador = 'Chrome';
  else if (/Safari\//.test(s)) navegador = 'Safari';
  else if (/curl|wget|node|axios|python/i.test(s)) navegador = 'programa';

  return { dispositivo, sistema, navegador };
}

// La zona del piloto. La franja del dia se calculaba con getHours(), que es la
// hora LOCAL DEL SERVIDOR: en Render, que va en UTC, una entrada de las 20:30
// en Salinas salia como "madrugada" y las cuatro franjas del informe quedaban
// corridas cinco horas.
const ZONA = 'America/Guayaquil';

/** La hora del dia en Ecuador, 0-23, sea cual sea el reloj del servidor. */
function horaEnEcuador(fecha) {
  const d = new Date(fecha);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const partes = new Intl.DateTimeFormat('en-US', {
      timeZone: ZONA, hour: 'numeric', hour12: false,
    }).formatToParts(d);
    const h = Number((partes.find((x) => x.type === 'hour') || {}).value);
    // Intl puede devolver 24 para la medianoche segun el motor
    return Number.isFinite(h) ? (h % 24) : null;
  } catch (e) {
    // Si el entorno no trae los datos de zona horaria, se cae al desfase fijo
    // de Ecuador (UTC-5, sin horario de verano)
    return (d.getUTCHours() + 24 - 5) % 24;
  }
}

/** Franja del dia, para ver a que horas usa la gente la app. */
function franjaHoraria(fecha) {
  const h = horaEnEcuador(fecha);
  if (h === null) return 'desconocida';
  if (h < 6) return 'madrugada';
  if (h < 12) return 'mañana';
  if (h < 19) return 'tarde';
  return 'noche';
}

/**
 * Resume los accesos de una persona: cuantas veces entro, cuando fue la
 * ultima, desde que aparatos y a que horas suele hacerlo.
 */
function resumirAccesos(filas = []) {
  const lista = (Array.isArray(filas) ? filas : []).filter(Boolean);
  if (lista.length === 0) {
    return {
      entradas: 0, ultimo: null, primero: null, dispositivos: [], navegadores: [],
      sistemas: [], franjas: {}, diasDistintos: 0, entradasUltimos30: 0,
    };
  }

  // El porcentaje se calcula aqui, no en la pantalla: asi hay un solo sitio
  // donde mirar si una cifra del informe se pone en duda.
  const cuenta = (valores) => {
    const c = {};
    const utiles = valores.filter(Boolean);
    utiles.forEach((v) => { c[v] = (c[v] || 0) + 1; });
    return Object.entries(c)
      .sort((a, b) => b[1] - a[1])
      .map(([nombre, veces]) => ({
        nombre,
        veces,
        pct: utiles.length ? Math.round((veces / utiles.length) * 1000) / 10 : 0,
      }));
  };

  const fechas = lista.map((f) => f.fecha).filter(Boolean).sort();
  const hace30 = new Date();
  hace30.setDate(hace30.getDate() - 30);

  const franjas = {};
  lista.forEach((f) => {
    if (!f.fecha) return;
    const fr = franjaHoraria(f.fecha);
    franjas[fr] = (franjas[fr] || 0) + 1;
  });

  return {
    entradas: lista.length,
    primero: fechas[0] || null,
    ultimo: fechas[fechas.length - 1] || null,
    dispositivos: cuenta(lista.map((f) => f.dispositivo)),
    navegadores: cuenta(lista.map((f) => f.navegador)),
    sistemas: cuenta(lista.map((f) => f.sistema)),
    franjas,
    diasDistintos: new Set(fechas.map((f) => String(f).split('T')[0])).size,
    entradasUltimos30: lista.filter((f) => f.fecha && new Date(f.fecha) >= hace30).length,
  };
}

/**
 * Los origenes que escribe el SISTEMA cuando alguien entra de verdad. Vive aqui,
 * pegado a quien los escribe, para que no se pueda desincronizar.
 *
 * Quien lea esta hoja para medir el uso tiene que aceptar SOLO estos, no
 * descartar los que sabe que son sembrados. La diferencia importa: una lista
 * negra falla hacia el lado peligroso. Si manana aparece un origen nuevo, o si
 * la columna se desplaza, descartar 'demo' deja pasar como real todo lo demas y
 * la ventana de medicion se ensancha sin que nada lo delate. Medido: contando
 * lo sembrado, el registro aparenta 193 dias desde junio de 2025 en vez de los
 * 3 dias que cubre de verdad, y con eso el uso parece comprobado.
 */
const ORIGENES_REALES = Object.freeze(['login', 'vuelta']);
const ORIGEN_SEMBRADO = 'demo';

/** La fila tal como se guarda en la hoja. */
function filaDeAcceso(email, ua, ip, fecha = new Date().toISOString(), origen = 'login') {
  const { dispositivo, sistema, navegador } = interpretarNavegador(ua);
  return [
    fecha,
    (email || '').toString().trim().toLowerCase(),
    dispositivo,
    sistema,
    navegador,
    (ip || '').toString().slice(0, 45),
    (ua || '').toString().slice(0, 300),
    // 'login' = escribio su clave; 'vuelta' = volvio a abrir la app despues de
    // un rato. Sin esta distincion no se podia saber cuantas veces se usa de
    // verdad: la sesion dura 30 dias y solo se anotaba el login.
    origen,
  ];
}

/** Fila de la hoja -> objeto. */
function accesoDesdeFila(row) {
  if (!row) return null;
  return {
    fecha: row[0] || '',
    email: (row[1] || '').toString().trim().toLowerCase(),
    dispositivo: row[2] || 'desconocido',
    sistema: row[3] || 'desconocido',
    navegador: row[4] || 'desconocido',
    ip: row[5] || '',
    // Las filas anteriores a esta columna son todas de inicio de sesion
    origen: (row[7] || 'login').toString().trim().toLowerCase(),
  };
}

module.exports = {
  HOJA, CABECERA, MINUTOS_DE_SESION, interpretarNavegador, franjaHoraria,
  horaEnEcuador, resumirAccesos, filaDeAcceso, accesoDesdeFila,
  ORIGENES_REALES, ORIGEN_SEMBRADO,
};
