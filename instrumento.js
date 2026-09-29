/**
 * INSTRUMENTO DE SEGUIMIENTO DE LA DIGITALIZACION
 *
 *   GET  /api/admin/instrumento-digitalizacion
 *   GET  /api/admin/seguimiento-campo
 *   POST /api/admin/seguimiento-campo
 *
 * Es el medio de verificacion que pide la planilla del INCYT para el indicador
 * IN-DIBA-2026-1.2 ("porcentaje de las CAYC seleccionadas estan digitalizadas",
 * meta 50 %), cuya formula es:
 *
 *        numero de grupos CAYC digitalizados
 *        -----------------------------------  x 100
 *        numero total de grupos CAYC
 *
 * DOS DECISIONES QUE NO PUEDE TOMAR EL PROGRAMA SOLO, y que por eso se leen de
 * una hoja que llena la direccion del proyecto en vez de adivinarse:
 *
 *   1. QUE GRUPOS SON "LAS CAYC SELECCIONADAS" (el denominador). La plataforma
 *      tiene grupos de prueba y grupos sueltos; la nomina oficial tiene diez.
 *      Contar todos inflaria el denominador y hundiria el indicador; contar
 *      solo los que van bien lo inflaria al reves. El denominador sale de la
 *      hoja `SeguimientoCampo`: un grupo cuenta si esta ahi marcado como CAYC.
 *
 *   2. QUE ES "ESTAR DIGITALIZADA" (el numerador). Aqui se usa una regla
 *      escrita, y el instrumento la publica junto al numero para que cualquiera
 *      pueda comprobarla grupo por grupo, en vez de tener que creerse un
 *      porcentaje suelto.
 *
 * Y UNA REGLA QUE NO SE NEGOCIA: el indicador se calcula SOLO con datos
 * REALES. Todo lo sembrado por /api/admin/demo/sembrar lleva su identificador
 * con prefijo `demo_` y aqui se descarta. Un informe de avance no puede
 * alimentarse de cifras de demostracion; el instrumento ademas dice cuantas
 * filas sembradas encontro, para que se vea que las vio y las dejo fuera.
 *
 * LA METODOLOGIA ES LA DEL INFORME QUE SE ENTREGO (28-sep-2026). El "Informe de
 * cumplimiento del indicador IN-DIBA-2026-1.2" que firma la direccion define
 * digitalizado como INCORPORADO: el grupo esta en la plataforma con la nomina
 * de sus integrantes. Siete hitos llevan de la socializacion al uso, y cuatro
 * niveles acumulativos dicen cuan hondo llego cada grupo. La regla anterior de
 * este modulo (directiva + dinero + uso) no se tira: es exactamente el nivel 4,
 * y se sigue publicando con su "sin medir". Asi el documento y la plataforma
 * miden lo mismo con las mismas palabras, y la plataforma pone las cifras que
 * salen de sus datos, sean las que sean.
 */

'use strict';

const HOJA_CAMPO = 'SeguimientoCampo';
const CABECERA_CAMPO = [
  'GroupID', 'Grupo', 'EsCAYC', 'SocializacionFecha', 'SocializacionAsistentes',
  'CapacitacionFecha', 'CapacitacionAsistentes', 'Responsable', 'Evidencia',
  'Observacion', 'ActualizadoPor', 'ActualizadoEn',
  // Como se llama esta caja en el Plan Integral, cuando no se llama igual que en
  // la app. Es la columna que faltaba y sin ella el instrumento no podia decir
  // la verdad: el Plan usa nombres formales ("Caja de Ahorro Mujeres al
  // Progreso") y la plataforma los nombres con los que las socias la llaman
  // ("Mi aguinaldo"). Sin poder anotar la correspondencia, una caja que SI esta
  // digitalizada se contaba como "no esta en la app" solo porque el nombre no
  // coincidia, y al reves, cuadrar la lista obligaba a renombrar grupos en la
  // plataforma, que es tocar el dato para que encaje con el informe.
  'NombreEnElPlan',
  // De donde sale que esta caja es del proyecto: el documento, tabla o acta que
  // lo dice. Sin esto el denominador es una lista que alguien escribio, y con
  // esto es una lista que se puede comprobar.
  'FuenteDeLaSeleccion',
  // Lo que pide el registro de grupos socializados del informe, en columnas
  // nuevas AL FINAL para no mover ninguna de las anteriores:
  //   Procedencia: "Listado inicial del Plan Integral", "Identificado durante
  //     la ejecucion" o "Conformado en las jornadas del proyecto".
  //   Capacitado: si/no, cuando la capacitacion consta en el registro del
  //     equipo sin una fecha propia (la fecha, si la hay, va en su columna).
  //   FormaDeIncorporacion: como entro la nomina a la plataforma. Es el hito
  //     "Nomina levantada": vacia, el grupo NO cuenta como incorporado aunque
  //     tenga cuentas enlazadas (un grupo de una sola persona que nunca entrego
  //     su nomina no es un grupo digitalizado).
  //   Parroquia y OrdenEnElPlan: para el listado inicial del Plan Integral.
  //   Orden: el del registro que certifica la direccion.
  'Procedencia', 'Capacitado', 'FormaDeIncorporacion', 'Parroquia', 'OrdenEnElPlan', 'Orden',
];
const CAMPO = {
  id: 0, grupo: 1, esCayc: 2, socFecha: 3, socAsistentes: 4,
  capFecha: 5, capAsistentes: 6, responsable: 7, evidencia: 8,
  observacion: 9, actualizadoPor: 10, actualizadoEn: 11,
  nombrePlan: 12, fuente: 13,
  procedencia: 14, capacitado: 15, forma: 16, parroquia: 17, ordenPlan: 18, orden: 19,
};
// Ultima columna de la hoja, en letra. Se calcula para que anadir un campo mas
// no obligue a buscar todos los 'A2:L' del modulo, que es como se olvida uno.
const COL_FIN = String.fromCharCode(65 + CABECERA_CAMPO.length - 1);

// Donde esta cada cosa en cada hoja (mismos indices que informe.js).
const USR = { nombre: 0, email: 1, rol: 3, alta: 5, estado: 8 };
const GRP = { id: 0, nombre: 1, creado: 5, estado: 11 };
const LINK = { email: 0, group: 1, alta: 2, rol: 3, estado: 4 };
const SAV = { email: 0, group: 1, monto: 2, fecha: 3, desc: 5, estado: 6, id: 10 };
const ACC = { email: 0, group: 1, fecha: 2, cantidad: 3, valor: 4, estado: 7, id: 11 };
const LOAN = { id: 0, email: 1, group: 2, monto: 3, inicio: 4, estado: 7 };
const PAGO = { id: 0, email: 1, loan: 2, monto: 3, fecha: 4, estado: 6 };
const ASA = { id: 0, group: 1, titulo: 2, programada: 3, estado: 5 };

const bajo = (v) => (v == null ? '' : v).toString().trim().toLowerCase();
const esSembrado = (v) => bajo(v).startsWith('demo_');
const siNo = (b) => (b ? 'si' : 'no');
const dia = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
};
const numero = (v) => {
  const n = Number((v == null ? '' : v).toString().replace(',', '.').trim());
  return Number.isFinite(n) ? n : 0;
};
const pct = (parte, total) => (total > 0
  ? Math.round((parte / total) * 1000) / 10 : 0);
// "50,0 %", como lo escribe el informe.
const pctTexto = (p) => `${(Math.round(p * 10) / 10).toFixed(1).replace('.', ',')} %`;
const siNoTexto = (b) => (b ? 'Sí' : 'No');
const esSi = (v) => ['si', 'sí', 'true', '1', 'x'].includes(bajo(v));
// Para cotejar nombres de grupo sin que una tilde o un espacio los separe.
const claveNombre = (v) => (v == null ? '' : v).toString()
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .trim().toLowerCase().replace(/\s+/g, ' ');
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
  'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** La fecha de hoy en Ecuador (UTC-5), en letras: "28 de septiembre de 2026". */
const fechaEnLetras = (d = new Date()) => {
  const ec = new Date(d.getTime() - 5 * 3600 * 1000);
  return `${ec.getUTCDate()} de ${MESES[ec.getUTCMonth()]} de ${ec.getUTCFullYear()}`;
};
const fechaEcuador = (d = new Date()) => new Date(d.getTime() - 5 * 3600 * 1000)
  .toISOString().slice(0, 10);
const CORREO_VALIDO = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/**
 * Los datos fijos del proyecto, tal como constan en la seccion 1 del informe
 * del indicador. No salen de la hoja: son del proyecto aprobado y del sistema
 * del INCYT, y se escriben una vez aqui para que el archivo que baja la
 * plataforma y el documento firmado digan lo mismo.
 */
const PROYECTO = {
  nombre: 'Digitalización básica y sensibilización comunitaria de cajas y/o grupos de ahorro '
    + 'ubicados en la zona urbana de la ciudad de Salinas, provincia de Santa Elena',
  directora: 'Ing. Sabina Villón Perero, Msc.',
  plazo: '48 meses, de mayo de 2023 al 31 de mayo de 2027 (cuarto año en curso)',
  componente: 'C4. Implementar el plan de digitalización básica de acuerdo con las necesidades '
    + 'tecnológicas y evaluar su impacto',
  actividad: 'C4A1. Implementación de los programas dispuestos en el plan de digitalización',
  indicador: 'IN-DIBA-2026-1.2. Porcentaje de las CAYC seleccionadas que están digitalizadas',
  periodo: 'Segundo cuatrimestre de 2026',
  medio: 'Instrumento de seguimiento de los objetivos del plan',
};

/**
 * EL CRITERIO DEL INFORME. Se considera digitalizado el grupo que esta en la
 * plataforma con la nomina de sus integrantes. Los cuatro primeros hitos
 * llevan al grupo hasta su digitalizacion y los tres siguientes miden el uso.
 */
const CRITERIO = 'Se considera digitalizado el grupo de ahorro que está registrado en la '
  + 'plataforma JuntaGO! (juntago.com) con la nómina de sus integrantes. El seguimiento '
  + 'distingue siete hitos: los cuatro primeros llevan al grupo hasta su digitalización y '
  + 'los tres siguientes miden el uso de la herramienta.';
const HITOS = [
  { clave: 'socializado', nombre: 'Socializado',
    verifica: 'El grupo recibió la socialización del proyecto y conoció la herramienta' },
  { clave: 'capacitado', nombre: 'Capacitado',
    verifica: 'Recibió capacitación presencial o por videoconferencia' },
  { clave: 'nomina', nombre: 'Nómina levantada',
    verifica: 'Entregó la nómina de sus integrantes con su directiva' },
  { clave: 'incorporado', nombre: 'Incorporado',
    verifica: 'El grupo existe en la plataforma con sus socias enlazadas' },
  { clave: 'directiva', nombre: 'Con directiva',
    verifica: 'Tiene registradas una cabeza (presidencia o liderazgo) y una tesorería' },
  { clave: 'movimiento', nombre: 'Con movimiento propio',
    verifica: 'Registró al menos un aporte, acción o préstamo propio en la plataforma' },
  { clave: 'uso', nombre: 'En uso por sus socias',
    verifica: 'Además, la mitad de sus socias ha ingresado alguna vez a la plataforma' },
];
/** Cada nivel incluye al anterior. La meta se mide en el primero. */
const NIVELES = [
  { clave: 'incorporado', nombre: '1. Incorporado',
    exige: 'El grupo existe en la plataforma con su nómina de socias' },
  { clave: 'directiva', nombre: '2. Con directiva',
    exige: 'Además tiene registrada una cabeza (presidencia o liderazgo) y una tesorería' },
  { clave: 'movimiento', nombre: '3. Con movimiento propio',
    exige: 'Además registró al menos un movimiento propio en la plataforma' },
  { clave: 'uso', nombre: '4. En uso por sus socias',
    exige: 'Además la mitad de sus socias ha ingresado alguna vez' },
];

/**
 * Las tres condiciones que antes definian "digitalizada" y que ahora son el
 * NIVEL 4 (directiva + dinero + uso). Se conservan con sus textos porque son
 * lo que se le dice a cada grupo que le falta para llegar al uso pleno.
 */
const CONDICIONES = [
  {
    clave: 'directiva',
    titulo: 'El grupo existe en la app con su directiva',
    detalle: 'Al menos presidencia y tesoreria, que son quienes pueden operar la caja.',
  },
  {
    clave: 'usan',
    titulo: 'Al menos la mitad de sus socias han entrado alguna vez',
    detalle: 'Tener cuenta no es usarla: se cuenta a quien abrio la app.',
  },
  {
    clave: 'dinero',
    titulo: 'El dinero del grupo se registra en la app',
    detalle: 'Al menos un aporte, una compra de acciones o un prestamo, confirmado y real.',
  },
];

module.exports.HOJA_CAMPO = HOJA_CAMPO;
module.exports.CABECERA_CAMPO = CABECERA_CAMPO;
module.exports.CONDICIONES = CONDICIONES;
module.exports.HITOS = HITOS;
module.exports.NIVELES = NIVELES;
module.exports.PROYECTO = PROYECTO;

module.exports.register = function register(app, ctx) {
  const {
    getSheetsClient, SPREADSHEET_ID, normalizeEmailKey, normalizeGroupKey,
    normalizeGroupRole, requireAdmin, bloquear, responderSiEsCuota, linkIsActive,
    ensureSheetExists, hojaAccesos, accesoDesdeFila, sanitizeCell,
  } = ctx;

  // La lista blanca de origenes vive en accesos.js, pegada a quien los escribe.
  const { ORIGENES_REALES, ORIGEN_SEMBRADO, cabeceraCorrecta } = require('./accesos');
  const MARCA_DEMO = require('./demo').MARCA.toLowerCase();

  const hojaSinFilas = (e) => /Unable to parse range|exceeds grid limits|not found/i
    .test((e && e.message) || '');

  async function leer(sheetsClient, rango) {
    try {
      const r = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: rango,
      });
      return r.data.values || [];
    } catch (e) {
      if (hojaSinFilas(e)) return [];
      throw e;
    }
  }

  /** Lee varios rangos de una vez; si el lote falla, uno por uno. */
  async function leerVarios(sheetsClient, rangos) {
    try {
      const r = await sheetsClient.spreadsheets.values.batchGet({
        spreadsheetId: SPREADSHEET_ID, ranges: rangos,
      });
      const por = new Map();
      ((r.data && r.data.valueRanges) || []).forEach((x, i) => {
        por.set(rangos[i], (x && x.values) || []);
      });
      return rangos.map((x) => por.get(x) || []);
    } catch (e) {
      return Promise.all(rangos.map((x) => leer(sheetsClient, x)));
    }
  }

  async function asegurarCampo(sheetsClient) {
    if (typeof ensureSheetExists !== 'function') return;
    try {
      await ensureSheetExists(HOJA_CAMPO, CABECERA_CAMPO, sheetsClient, SPREADSHEET_ID);
    } catch (e) {
      console.error('[INSTRUMENTO] no se pudo asegurar', HOJA_CAMPO, e.message);
    }
  }

  /**
   * Una pestana creada con la cabecera vieja (14 columnas) no se entera sola de
   * las columnas nuevas: ensureSheetExists solo crea, nunca amplia. Los datos se
   * leen por posicion y funcionarian igual, pero quien abra la hoja veria
   * columnas sin titulo. Solo se amplia si lo que hay es un PREFIJO exacto de la
   * cabecera actual: si alguien la cambio a mano, no se pisa.
   */
  async function completarCabecera(sheetsClient) {
    const [actual = []] = await leer(sheetsClient, `${HOJA_CAMPO}!A1:${COL_FIN}1`);
    if (actual.length >= CABECERA_CAMPO.length) return;
    const esPrefijo = actual.every((c, i) => (c || '').toString().trim() === CABECERA_CAMPO[i]);
    if (!esPrefijo) return;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${HOJA_CAMPO}!A1:${COL_FIN}1`,
      valueInputOption: 'RAW',
      resource: { values: [CABECERA_CAMPO] },
    });
  }

  // =========================================================================
  // La ficha de campo: que grupos son del proyecto, y que se hizo con cada uno
  // =========================================================================
  app.get('/api/admin/seguimiento-campo', requireAdmin, async (req, res) => {
    try {
      const sheetsClient = await getSheetsClient();
      await asegurarCampo(sheetsClient);
      const [filas, grupos] = await leerVarios(sheetsClient, [
        `${HOJA_CAMPO}!A2:${COL_FIN}`, 'Groups!A2:R',
      ]);
      const nombreDe = new Map(grupos
        .filter((g) => g[GRP.id])
        .map((g) => [normalizeGroupKey(g[GRP.id]), (g[GRP.nombre] || '').toString()]));

      const anotados = filas.filter((f) => f[CAMPO.id]).map((f) => ({
        groupId: (f[CAMPO.id] || '').toString().trim(),
        grupo: (f[CAMPO.grupo] || '').toString() || nombreDe.get(normalizeGroupKey(f[CAMPO.id])) || '',
        esCayc: bajo(f[CAMPO.esCayc]) !== 'no',
        socializacion: { fecha: dia(f[CAMPO.socFecha]), asistentes: numero(f[CAMPO.socAsistentes]) },
        capacitacion: { fecha: dia(f[CAMPO.capFecha]), asistentes: numero(f[CAMPO.capAsistentes]) },
        responsable: (f[CAMPO.responsable] || '').toString(),
        evidencia: (f[CAMPO.evidencia] || '').toString(),
        observacion: (f[CAMPO.observacion] || '').toString(),
        nombreEnElPlan: (f[CAMPO.nombrePlan] || '').toString(),
        fuenteDeLaSeleccion: (f[CAMPO.fuente] || '').toString(),
        procedencia: (f[CAMPO.procedencia] || '').toString(),
        capacitado: esSi(f[CAMPO.capacitado]),
        formaDeIncorporacion: (f[CAMPO.forma] || '').toString(),
        parroquia: (f[CAMPO.parroquia] || '').toString(),
        ordenEnElPlan: numero(f[CAMPO.ordenPlan]) || null,
        orden: numero(f[CAMPO.orden]) || null,
        actualizado: dia(f[CAMPO.actualizadoEn]),
      }));

      const yaEstan = new Set(anotados.map((x) => normalizeGroupKey(x.groupId)));
      const sinAnotar = grupos
        .filter((g) => g[GRP.id] && !yaEstan.has(normalizeGroupKey(g[GRP.id])))
        .filter((g) => bajo(g[GRP.estado]) !== 'eliminado')
        .map((g) => ({
          groupId: (g[GRP.id] || '').toString().trim(),
          grupo: (g[GRP.nombre] || '').toString(),
        }));

      return res.json({ success: true, anotados, sinAnotar, cabecera: CABECERA_CAMPO });
    } catch (error) {
      console.error('[SEGUIMIENTO-CAMPO GET]', error.message);
      if (responderSiEsCuota(res, error)) return;
      return res.status(500).json({ success: false, message: 'No se pudo leer el seguimiento de campo.' });
    }
  });

  app.post('/api/admin/seguimiento-campo', requireAdmin, bloquear(() => `hoja:${HOJA_CAMPO}`),
    async (req, res) => {
      const entradas = Array.isArray(req.body?.grupos) ? req.body.grupos
        : (req.body?.groupId ? [req.body] : []);
      if (!entradas.length) {
        return res.status(400).json({
          success: false,
          message: 'Manda al menos un grupo: { groupId, esCayc, socializacionFecha, ... }.',
        });
      }
      try {
        const sheetsClient = await getSheetsClient();
        await asegurarCampo(sheetsClient);
        await completarCabecera(sheetsClient);
        const filas = await leer(sheetsClient, `${HOJA_CAMPO}!A2:${COL_FIN}`);
        const posicion = new Map();
        filas.forEach((f, i) => {
          const gid = normalizeGroupKey(f[CAMPO.id]);
          if (gid && !posicion.has(gid)) posicion.set(gid, i + 2);
        });

        const ahora = new Date().toISOString();
        const quien = normalizeEmailKey(req.user && req.user.email);
        const nuevas = [];
        const cambios = [];
        const tocados = [];

        for (const e of entradas) {
          // Una CAYC del plan puede existir EN PAPEL y no estar todavia en la
          // app. Esas cuentan en el denominador del indicador (son grupos
          // seleccionados que aun no se digitalizan), asi que se aceptan con
          // solo el nombre y se les pone una clave a partir de el.
          const nombre = (e.grupo ?? e.Grupo ?? '').toString().trim();
          const gid = normalizeGroupKey(e.groupId || e.GroupID)
            || (nombre ? `sinapp:${nombre.toLowerCase().replace(/\s+/g, ' ')}` : '');
          if (!gid) continue;
          const anterior = posicion.has(gid) ? filas[posicion.get(gid) - 2] : [];
          // Lo que no venga en la peticion se conserva: asi se puede anotar la
          // capacitacion sin borrar sin querer lo de la socializacion.
          const tomar = (nuevo, viejoIdx, max = 200) => (nuevo === undefined || nuevo === null
            ? (anterior[viejoIdx] || '')
            : sanitizeCell(nuevo.toString().trim(), max));
          const fila = [
            gid,
            tomar(e.grupo ?? e.Grupo, CAMPO.grupo, 120),
            e.esCayc === undefined ? (anterior[CAMPO.esCayc] || 'si') : (e.esCayc ? 'si' : 'no'),
            tomar(e.socializacionFecha, CAMPO.socFecha, 30),
            tomar(e.socializacionAsistentes, CAMPO.socAsistentes, 10),
            tomar(e.capacitacionFecha, CAMPO.capFecha, 30),
            tomar(e.capacitacionAsistentes, CAMPO.capAsistentes, 10),
            tomar(e.responsable, CAMPO.responsable, 120),
            tomar(e.evidencia, CAMPO.evidencia, 500),
            tomar(e.observacion, CAMPO.observacion, 500),
            quien,
            ahora,
            tomar(e.nombreEnElPlan ?? e.NombreEnElPlan, CAMPO.nombrePlan, 200),
            tomar(e.fuenteDeLaSeleccion ?? e.FuenteDeLaSeleccion, CAMPO.fuente, 300),
            tomar(e.procedencia ?? e.Procedencia, CAMPO.procedencia, 120),
            (e.capacitado ?? e.Capacitado) === undefined
              ? (anterior[CAMPO.capacitado] || '')
              : ((e.capacitado ?? e.Capacitado) === true || esSi(e.capacitado ?? e.Capacitado) ? 'si' : 'no'),
            tomar(e.formaDeIncorporacion ?? e.FormaDeIncorporacion, CAMPO.forma, 120),
            tomar(e.parroquia ?? e.Parroquia, CAMPO.parroquia, 120),
            tomar(e.ordenEnElPlan ?? e.OrdenEnElPlan, CAMPO.ordenPlan, 10),
            tomar(e.orden ?? e.Orden, CAMPO.orden, 10),
          ];
          if (posicion.has(gid)) cambios.push({ fila: posicion.get(gid), valores: fila });
          else nuevas.push(fila);
          tocados.push(gid);
        }

        // Todas las filas que cambian, en UNA llamada. Una por fila costaba 19
        // escrituras al anotar la lista entera, y cada escritura invalida la
        // memoria del libro completo, asi que ademas obligaba a releerlo 19
        // veces. Es el mismo defecto que tenia el sembrado.
        if (cambios.length) {
          await sheetsClient.spreadsheets.values.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: {
              valueInputOption: 'RAW',
              data: cambios.map((c) => ({
                range: `${HOJA_CAMPO}!A${c.fila}:${COL_FIN}${c.fila}`,
                values: [c.valores],
              })),
            },
          });
        }
        if (nuevas.length) {
          await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${HOJA_CAMPO}!A:${COL_FIN}`,
            valueInputOption: 'RAW',
            resource: { values: nuevas },
          });
        }

        return res.json({
          success: true,
          message: `Anotados ${tocados.length} grupo(s): ${nuevas.length} nuevo(s), ${cambios.length} actualizado(s).`,
          grupos: tocados,
        });
      } catch (error) {
        console.error('[SEGUIMIENTO-CAMPO POST]', error.message);
        if (responderSiEsCuota(res, error)) return;
        return res.status(500).json({ success: false, message: 'No se pudo anotar el seguimiento de campo.' });
      }
    });

  // =========================================================================
  // El instrumento
  // =========================================================================
  app.get('/api/admin/instrumento-digitalizacion', requireAdmin, async (req, res) => {
    // Por defecto SOLO datos reales. Se puede pedir con lo sembrado dentro para
    // ensenar como se veria el instrumento lleno, pero entonces lo dice en cada
    // hoja y en el nombre del archivo.
    const incluirDemo = ['1', 'true', 'si'].includes(bajo(req.query.incluirDemo));

    try {
      const sheetsClient = await getSheetsClient();
      await asegurarCampo(sheetsClient);

      const [
        usuarios, grupos, vinculos, accesosConCabecera, ahorros, acciones,
        prestamos, pagos, asambleas, campo,
      ] = await leerVarios(sheetsClient, [
        // La hoja de accesos se lee DESDE LA FILA 1: hace falta la cabecera para
        // saber si la columna Origen sigue en su sitio. Sin eso, una columna
        // movida se lee como marca vacia, el lector la convierte en 'login' y
        // pasa la lista blanca.
        'Users!A2:I', 'Groups!A2:R', 'UserGroupLinks!A2:F', `${hojaAccesos}!A1:H`,
        'Savings!A2:L', 'Acciones!A2:M', 'Loans!A2:K', 'LoanPayments!A2:O',
        'Asambleas!A2:N', `${HOJA_CAMPO}!A2:${COL_FIN}`,
      ]);

      // La primera fila es la cabecera, no un acceso.
      const cabeceraAccesos = accesosConCabecera[0] || [];
      const accesos = accesosConCabecera.slice(1);
      // Si no hay ni una fila de datos, da igual donde este la columna.
      const cabeceraAccesosOk = accesos.length === 0 || cabeceraCorrecta(cabeceraAccesos);

      // --- lo sembrado se cuenta y se deja fuera -------------------------
      const sembrado = {
        aportes: ahorros.filter((f) => esSembrado(f[SAV.id])).length,
        acciones: acciones.filter((f) => esSembrado(f[ACC.id])).length,
        prestamos: prestamos.filter((f) => esSembrado(f[LOAN.id])).length,
        pagos: pagos.filter((f) => esSembrado(f[PAGO.id])).length,
        asambleas: asambleas.filter((f) => esSembrado(f[ASA.id])).length,
        entradas: accesos.filter((f) => bajo(f[7]) === 'demo').length,
      };
      const real = (filas, col) => (incluirDemo ? filas : filas.filter((f) => !esSembrado(f[col])));
      const ahorrosR = real(ahorros, SAV.id);
      const accionesR = real(acciones, ACC.id);
      const prestamosR = real(prestamos, LOAN.id);
      const pagosR = real(pagos, PAGO.id);
      const asambleasR = real(asambleas, ASA.id);
      // LISTA BLANCA, no lista negra. Se aceptan solo los origenes que escribe
      // el sistema cuando alguien entra de verdad ('login' y 'vuelta', definidos
      // en accesos.js junto a quien los escribe). Descartar 'demo' y dar por
      // real todo lo demas falla hacia el lado peligroso: si aparece un origen
      // nuevo o la columna se desplaza, lo sembrado pasa por bueno y la ventana
      // de medicion se ensancha sin que nada lo delate.
      // Una marca vacia puede ser una fila vieja de antes de que existiera la
      // columna (y entonces es un inicio de sesion, backfill legitimo) o una
      // columna que ya no esta donde deberia. Las dos producen el MISMO valor
      // vacio, asi que sin mirar la cabecera son indistinguibles, y una de las
      // dos deja entrar lo sembrado.
      // Una fila sembrada lleva DOS marcas independientes: 'demo' en la columna
      // de origen y "[demo]" dentro del UserAgent. La segunda es la que cierra
      // el unico hueco que quedaba en este razonamiento: si apareciera una fila
      // sin marca de origen, no seria solo de tipo desconocido, seria de
      // procedencia desconocida (¿un acceso antiguo o una siembra antigua?), y
      // darla por inicio de sesion readmitiria por detras justo lo que la lista
      // blanca deja fuera. Con el rastro del UserAgent esa duda se resuelve.
      //
      // (Comprobado en el historial: la columna Origen es del 15 de septiembre
      // de 2026 y el sembrado de accesos del 16, y su primera version ya
      // escribia las dos marcas. Asi que hoy ninguna fila sembrada puede estar
      // sin marca. Esto es el cinturon por si eso deja de ser cierto.)
      const rastroDeSiembra = (f) => String(f[6] || '').toLowerCase().includes(MARCA_DEMO);
      // MANDA LO SEMBRADO. Si cualquiera de las dos marcas dice que la fila es
      // de la demostracion, queda fuera, venga la senal de donde venga.
      //
      // Antes mandaba la columna de origen y eso dejaba un hueco por el lado
      // que no se ve: una fila sembrada cuya marca de origen se hubiera
      // corrompido a un valor real ('vuelta') entraba como entrada de verdad,
      // con su rastro "[demo]" delante y sin que nadie lo mirara. Asi la regla
      // falla siempre hacia el lado conservador: como mucho deja fuera una
      // entrada real, que estrecha la ventana y hace parecer MENOS medido de lo
      // que hay, nunca mas.
      const origenDe = (f) => {
        if (rastroDeSiembra(f)) return ORIGEN_SEMBRADO;
        return bajo(f[7])
          || (cabeceraAccesosOk ? 'login' : 'columna-origen-desplazada');
      };
      const esOrigenReal = (f) => ORIGENES_REALES.includes(origenDe(f));
      const marcasDesconocidas = [...new Set(accesos.map(origenDe)
        .filter((o) => o !== ORIGEN_SEMBRADO && !ORIGENES_REALES.includes(o)))];

      const accesosR = incluirDemo ? accesos : accesos.filter(esOrigenReal);
      // Solo cuentan como supuestos si la cabecera esta bien: si no lo esta, ya
      // quedaron fuera por 'columna-origen-desplazada'.
      // Solo son supuestos los que acaban clasificados como entrada real: una
      // fila sin marca de origen pero con rastro de siembra no es un supuesto,
      // es una siembra reconocida por la otra marca.
      const supuestos = accesos
        .filter((f) => !bajo(f[7]) && ORIGENES_REALES.includes(origenDe(f))).length;
      const total = accesos.length;
      const sembrados = accesos.filter((f) => origenDe(f) === ORIGEN_SEMBRADO).length;

      // Las dos marcas tienen que decir lo mismo. Mientras coincidan, que falle
      // una no deja pasar nada, porque la otra sostiene el filtro. Si empiezan a
      // discrepar es que una se esta degradando, y hay que enterarse MIENTRAS
      // todavia queda la otra, no cuando ya no quede ninguna. Solo se compara
      // cuando la columna de origen dice algo: una marca vacia no afirma nada y
      // por tanto no puede contradecir a nadie.
      const marcasEnDesacuerdo = accesos.filter((f) => {
        const puesto = bajo(f[7]);
        if (!puesto) return false;
        return (puesto === ORIGEN_SEMBRADO) !== rastroDeSiembra(f);
      }).length;

      // Desde cuando y hasta cuando hay registro de entradas de verdad. Sin
      // esto, la condicion de uso se lee como una medicion cuando en realidad
      // puede estar preguntandole a un cuaderno que empezo la semana pasada.
      const diasDeAcceso = accesosR
        .map((f) => dia(f[0]))
        .filter(Boolean)
        .sort();
      const ventana = {
        desde: diasDeAcceso[0] || null,
        hasta: diasDeAcceso[diasDeAcceso.length - 1] || null,
        apuntes: diasDeAcceso.length,
        dias: new Set(diasDeAcceso).size,
        // Si hay marcas que este modulo no sabe clasificar, la ventana no se
        // puede dar por buena: puede estar contando como real algo que no lo es.
        //
        // OJO, no se mezcla con incluirDemo. Pedir el documento con los datos de
        // demostracion dentro sirve para ENSENAR el funcionamiento, asi que ahi
        // el uso si se calcula; lo que no se puede es presentar ese resultado
        // como una medicion, y de eso se encarga `medible` mas abajo. Si se
        // mezclaran, el modo demostracion dejaria de ensenar nada.
        // Que las marcas discrepen ya NO tumba la ventana. Con "manda lo
        // sembrado", los dos sentidos posibles de la discrepancia excluyen la
        // fila igual, asi que la cifra no cambia: lo que cambia es en que se
        // apoya, porque esas filas se clasificaron con una marca en vez de dos.
        // Eso es un supuesto mas debil, y a un supuesto se le declara, no se le
        // responde callandose. Callarse aqui seria negarse a publicar por algo
        // que no altera ningun numero.
        fiable: marcasDesconocidas.length === 0,
        marcasDesconocidas,
        // El reparto COMPLETO de las filas, para que la aritmetica del documento
        // cierre sola y nadie tenga que deducirla restando. Restar invita al
        // error: en cuanto hay supuestos o marcas sin clasificar, "las
        // restantes" deja de ser el numero que uno cree.
        total,
        sembrados,
        descartados: total - sembrados - diasDeAcceso.length,
        // Cuantos de esos apuntes tienen el origen SUPUESTO en vez de leido.
        // Una fila anterior a que existiera la columna se cuenta como inicio de
        // sesion, y es lo correcto porque asi lo documenta quien las escribio,
        // pero es un supuesto y no puede quedar escondido dentro de una cifra
        // que el INCYT va a leer como medicion. Se cuenta y se declara aparte.
        supuestos,
        marcasEnDesacuerdo,
      };

      // --- gente ----------------------------------------------------------
      const persona = new Map();
      usuarios.forEach((u) => {
        const correo = normalizeEmailKey(u[USR.email]);
        if (!correo || persona.has(correo)) return;   // una por correo, no por fila
        persona.set(correo, {
          nombre: (u[USR.nombre] || '').toString(),
          correo,
          alta: dia(u[USR.alta]),
          activa: bajo(u[USR.estado]) !== 'inactivo',
        });
      });

      const entradasDe = new Map();
      accesosR.forEach((f) => {
        const a = typeof accesoDesdeFila === 'function' ? accesoDesdeFila(f) : null;
        const correo = normalizeEmailKey(a ? a.email : f[1]);
        if (!correo) return;
        if (!entradasDe.has(correo)) entradasDe.set(correo, []);
        entradasDe.get(correo).push(dia(a ? a.fecha : f[0]));
      });

      // --- socias por grupo ------------------------------------------------
      const porGrupo = new Map();
      vinculos.forEach((v) => {
        const gid = normalizeGroupKey(v[LINK.group]);
        if (!gid || !linkIsActive(v)) return;
        if (!porGrupo.has(gid)) porGrupo.set(gid, []);
        porGrupo.get(gid).push({
          correo: normalizeEmailKey(v[LINK.email]),
          cargo: normalizeGroupRole(v[LINK.rol]),
          desde: dia(v[LINK.alta]),
        });
      });

      const deGrupo = (filas, col, gid) => filas
        .filter((f) => normalizeGroupKey(f[col]) === gid);

      // --- la ficha de campo ----------------------------------------------
      const nombreGrupo = new Map();
      grupos.forEach((g) => {
        const gid = normalizeGroupKey(g[GRP.id]);
        if (gid) nombreGrupo.set(gid, (g[GRP.nombre] || '').toString());
      });

      // Un grupo del registro que aun no estaba en la app se anota por su
      // NOMBRE ("sinapp:..."). Cuando despues se carga su nomina, el grupo
      // aparece con un identificador nuevo que nadie va a volver a copiar en la
      // ficha. Sin este paso seguiria contando como "no esta en la app" para
      // siempre. Se enlaza por nombre SOLO si hay un unico grupo vivo con ese
      // nombre y ese grupo no tiene ya su propia fila en la ficha.
      const vivosPorNombre = new Map();
      const nombresRepetidos = new Set();
      grupos
        .filter((g) => g[GRP.id] && bajo(g[GRP.estado]) !== 'eliminado')
        .forEach((g) => {
          const k = claveNombre(g[GRP.nombre]);
          if (!k) return;
          if (vivosPorNombre.has(k)) nombresRepetidos.add(k);
          else vivosPorNombre.set(k, normalizeGroupKey(g[GRP.id]));
        });
      const conId = new Set(campo.map((f) => normalizeGroupKey(f[CAMPO.id]))
        .filter((gid) => gid && !gid.startsWith('sinapp:')));
      const fichaDe = new Map();
      const enlazadosPorNombre = [];
      campo.forEach((f) => {
        let gid = normalizeGroupKey(f[CAMPO.id]);
        if (!gid) return;
        if (gid.startsWith('sinapp:')) {
          const k = claveNombre((f[CAMPO.grupo] || '').toString() || gid.slice(7));
          const enApp = vivosPorNombre.get(k);
          if (enApp && !nombresRepetidos.has(k) && !conId.has(enApp)) {
            enlazadosPorNombre.push({ ficha: gid, grupo: enApp });
            gid = enApp;
          }
        }
        if (!fichaDe.has(gid)) fichaDe.set(gid, f);
      });

      // El denominador: los grupos marcados como CAYC en la ficha de campo, en
      // el orden del registro que certifica la direccion.
      const ordenDe = (gid) => numero((fichaDe.get(gid) || [])[CAMPO.orden]) || Infinity;
      const caycIds = [...fichaDe.entries()]
        .filter(([, f]) => bajo(f[CAMPO.esCayc]) !== 'no')
        .map(([gid]) => gid)
        .sort((a, b) => (ordenDe(a) - ordenDe(b))
          || claveNombre(nombreGrupo.get(a) || a).localeCompare(claveNombre(nombreGrupo.get(b) || b)));

      // Cuantos de ellos NO dicen de donde sale que son del proyecto. Sin esto,
      // el denominador es una lista que alguien escribio y hay que creersela;
      // con esto es una lista que se puede comprobar documento por documento.
      // Importa porque el denominador es la cifra mas discutida del indicador:
      // segun cual sea la lista, el resultado cambia de 5 % a 91 %.
      const caycSinFuente = caycIds.filter((gid) => {
        const f = fichaDe.get(gid) || [];
        return !(f[CAMPO.fuente] || '').toString().trim();
      });

      // --- una fila por grupo ---------------------------------------------
      const filasGrupos = [];
      const filasNomina = [];
      const filasEvidencias = [];
      const niveles = [];

      for (const gid of caycIds) {
        const ficha = fichaDe.get(gid) || [];
        const enLaApp = nombreGrupo.has(gid);
        const socias = enLaApp ? (porGrupo.get(gid) || []) : [];
        const cargos = new Set(socias.map((s) => s.cargo).filter((c) => c !== 'member'));
        const entraron = socias.filter((s) => (entradasDe.get(s.correo) || []).length > 0);

        const susAhorros = deGrupo(ahorrosR, SAV.group, gid)
          .filter((f) => ['', 'confirmado'].includes(bajo(f[SAV.estado])));
        const susAcciones = deGrupo(accionesR, ACC.group, gid)
          .filter((f) => ['', 'confirmado'].includes(bajo(f[ACC.estado])));
        const susPrestamos = deGrupo(prestamosR, LOAN.group, gid);
        const susAsambleas = deGrupo(asambleasR, ASA.group, gid);
        const idsPrestamo = new Set(susPrestamos.map((f) => (f[LOAN.id] || '').toString().trim()));
        const susPagos = pagosR.filter((f) => idsPrestamo.has((f[PAGO.loan] || '').toString().trim()));

        // LA VENTANA DE MEDICION. El registro de entradas no existe desde
        // siempre: se programo el 3 de septiembre de 2026 y su primer apunte
        // real es del 16. Preguntar "¿ha entrado alguna vez?" a un registro que
        // empieza despues de que la socia se diera de alta no da un NO: da un
        // NO SE SABE. Contarlo como NO haria que el informe diera por inexistente
        // el trabajo de las socias durante todo el periodo anterior.
        const altaMasVieja = socias
          .map((s) => dia(s.desde))
          .filter(Boolean)
          .sort()[0] || null;
        const usanMedible = ventana.fiable && !!ventana.desde
          && (!altaMasVieja || ventana.desde <= altaMasVieja);

        const cumple = {
          directiva: cargos.has('presidente') && cargos.has('tesorero'),
          usan: usanMedible ? (socias.length > 0 && entraron.length * 2 >= socias.length) : null,
          dinero: (susAhorros.length + susAcciones.length + susPrestamos.length) > 0,
        };

        // --- los siete hitos del informe ----------------------------------
        // La forma de incorporacion es el hito "Nomina levantada". Si la
        // direccion no la anoto, el grupo NO cuenta como incorporado aunque
        // tenga cuentas enlazadas: un valor que falta no puede producir un si.
        const forma = (ficha[CAMPO.forma] || '').toString().trim();
        const hito = {
          // Estar en el registro de la direccion ES haber sido socializado:
          // es la relacion de grupos socializados que ella certifica.
          socializado: true,
          capacitado: esSi(ficha[CAMPO.capacitado]) || !!dia(ficha[CAMPO.capFecha]),
          nomina: !!forma,
          incorporado: enLaApp && socias.length > 0 && !!forma,
          directiva: cumple.directiva,
          movimiento: cumple.dinero,
          uso: cumple.usan,
        };
        // Los niveles son acumulativos: cada uno exige los anteriores. El
        // cuarto es la regla que este modulo usaba antes como "digitalizada",
        // con sus tres estados (si, no, sin medir).
        const nivel = { incorporado: hito.incorporado };
        nivel.directiva = nivel.incorporado && hito.directiva;
        nivel.movimiento = nivel.directiva && hito.movimiento;
        nivel.uso = !nivel.movimiento ? false : hito.uso;
        const veredictoUso = nivel.uso === null ? 'sin medir' : siNo(nivel.uso);

        const leFalta = [];
        if (!enLaApp) {
          leFalta.push('El grupo todavia no existe en la app');
        } else {
          if (!forma) {
            leFalta.push('Nomina levantada: la direccion no ha anotado como se incorporo '
              + 'el grupo (columna FormaDeIncorporacion de SeguimientoCampo)');
          }
          if (socias.length === 0) leFalta.push('El grupo no tiene socias enlazadas');
          CONDICIONES.filter((c) => cumple[c.clave] === false)
            .forEach((c) => leFalta.push(c.titulo));
          CONDICIONES.filter((c) => cumple[c.clave] === null)
            .forEach((c) => leFalta.push(`${c.titulo} (SIN MEDIR: el registro de entradas empieza el `
              + `${ventana.desde || 'sin datos'} y estas socias estaban desde antes)`));
        }

        filasGrupos.push({
          GrupoID: enLaApp ? gid : '(no esta en la app)',
          Grupo: nombreGrupo.get(gid) || (ficha[CAMPO.grupo] || '').toString() || gid,
          'Esta en la app': siNo(enLaApp),
          'Socias en la app': socias.length,
          'Directiva completa': siNo(cargos.size >= 3),
          'Presidencia y tesoreria': siNo(cumple.directiva),
          'Socializacion (fecha)': dia(ficha[CAMPO.socFecha]),
          'Socializacion (asistentes)': numero(ficha[CAMPO.socAsistentes]),
          'Capacitacion (fecha)': dia(ficha[CAMPO.capFecha]),
          'Capacitacion (asistentes)': numero(ficha[CAMPO.capAsistentes]),
          Capacitado: siNo(hito.capacitado),
          'Forma de incorporacion': forma,
          Procedencia: (ficha[CAMPO.procedencia] || '').toString(),
          'Socias que han entrado': entraron.length,
          '% de socias que han entrado': pct(entraron.length, socias.length),
          'Entradas de sus socias': socias
            .reduce((s, x) => s + (entradasDe.get(x.correo) || []).length, 0),
          'Aportes registrados': susAhorros.length,
          'Compras de acciones': susAcciones.length,
          'Prestamos otorgados': susPrestamos.length,
          'Pagos con comprobante': susPagos.length,
          'Asambleas registradas': susAsambleas.length,
          'Uso medible': siNo(usanMedible),
          // DIGITALIZADA es el criterio del informe: nivel 1, incorporado.
          'DIGITALIZADA': siNo(nivel.incorporado),
          'Nivel 2: con directiva': siNo(nivel.directiva),
          'Nivel 3: con movimiento propio': siNo(nivel.movimiento),
          'Nivel 4: en uso por sus socias': veredictoUso,
          'Que le falta': leFalta.join('; '),
          Responsable: (ficha[CAMPO.responsable] || '').toString(),
          Evidencia: (ficha[CAMPO.evidencia] || '').toString(),
          Observacion: (ficha[CAMPO.observacion] || '').toString(),
          // Los dos nombres juntos y en la misma fila: es lo que permite cotejar
          // el Plan con la plataforma sin preguntarle a nadie, y lo que evita
          // que alguien renombre grupos en la app para que cuadre el informe.
          'Nombre en el Plan': (ficha[CAMPO.nombrePlan] || '').toString(),
          'Fuente de la seleccion': (ficha[CAMPO.fuente] || '').toString(),
          Parroquia: (ficha[CAMPO.parroquia] || '').toString(),
          'Orden en el Plan': numero(ficha[CAMPO.ordenPlan]) || '',
        });
        // Lo que necesitan las hojas del informe, sin volver a calcularlo. El
        // nombre que se imprime es el del registro que certifica la direccion;
        // si no lo trae, el de la app.
        niveles.push({
          gid,
          nivel,
          hito,
          fila: filasGrupos[filasGrupos.length - 1],
          nombreDoc: (ficha[CAMPO.grupo] || '').toString().trim() || nombreGrupo.get(gid) || gid,
          procedencia: (ficha[CAMPO.procedencia] || '').toString().trim(),
          parroquia: (ficha[CAMPO.parroquia] || '').toString().trim(),
          nombreEnElPlan: (ficha[CAMPO.nombrePlan] || '').toString().trim(),
          ordenEnElPlan: numero(ficha[CAMPO.ordenPlan]) || 0,
          correos: socias.map((s) => s.correo),
          veredictoUso,
        });

        const orden = { presidente: 0, tesorero: 1, secretario: 2, member: 3 };
        socias
          .slice()
          .sort((a, b) => (orden[a.cargo] - orden[b.cargo])
            || (persona.get(a.correo)?.nombre || '').localeCompare(persona.get(b.correo)?.nombre || ''))
          .forEach((s, i) => {
            const p = persona.get(s.correo) || {};
            const suyas = entradasDe.get(s.correo) || [];
            filasNomina.push({
              Grupo: nombreGrupo.get(gid) || gid,
              'N.': i + 1,
              Cargo: s.cargo === 'member' ? 'socia' : s.cargo,
              Nombre: p.nombre || '',
              Correo: s.correo,
              'En el grupo desde': s.desde,
              'Cuenta creada el': p.alta || '',
              'Ha entrado a la app': siNo(suyas.length > 0),
              'Veces que ha entrado': suyas.length,
              'Primera entrada': suyas.slice().sort()[0] || '',
              'Ultima entrada': suyas.slice().sort().slice(-1)[0] || '',
            });
          });

        const anota = (tipo, filas, mapear) => filas.forEach((f) => {
          filasEvidencias.push({ Grupo: nombreGrupo.get(gid) || gid, Tipo: tipo, ...mapear(f) });
        });
        anota('aporte', susAhorros, (f) => ({
          Fecha: dia(f[SAV.fecha]), Socia: normalizeEmailKey(f[SAV.email]),
          Importe: numero(f[SAV.monto]), Detalle: (f[SAV.desc] || '').toString(),
          Registro: (f[SAV.id] || '').toString(),
        }));
        anota('compra de acciones', susAcciones, (f) => ({
          Fecha: dia(f[ACC.fecha]), Socia: normalizeEmailKey(f[ACC.email]),
          Importe: numero(f[ACC.cantidad]) * numero(f[ACC.valor]),
          Detalle: `${numero(f[ACC.cantidad])} acciones`,
          Registro: (f[ACC.id] || '').toString(),
        }));
        anota('prestamo', susPrestamos, (f) => ({
          Fecha: dia(f[LOAN.inicio]), Socia: normalizeEmailKey(f[LOAN.email]),
          Importe: numero(f[LOAN.monto]), Detalle: bajo(f[LOAN.estado]),
          Registro: (f[LOAN.id] || '').toString(),
        }));
        anota('pago de cuota', susPagos, (f) => ({
          Fecha: dia(f[PAGO.fecha]), Socia: normalizeEmailKey(f[PAGO.email]),
          Importe: numero(f[PAGO.monto]), Detalle: bajo(f[PAGO.estado]),
          Registro: (f[PAGO.id] || '').toString(),
        }));
        anota('asamblea', susAsambleas, (f) => ({
          Fecha: dia(f[ASA.programada]), Socia: '',
          Importe: '', Detalle: (f[ASA.titulo] || '').toString(),
          Registro: (f[ASA.id] || '').toString(),
        }));
      }

      filasEvidencias.sort((a, b) => String(a.Fecha).localeCompare(String(b.Fecha)));

      // --- el indicador ----------------------------------------------------
      // El criterio del informe: digitalizado = nivel 1, incorporado. No
      // depende del registro de entradas, asi que se puede afirmar aunque el uso
      // (nivel 4) quede sin medir.
      const denominador = caycIds.length;
      const numerador = niveles.filter((x) => x.nivel.incorporado).length;
      const porcentaje = pct(numerador, denominador);
      const META = 50;
      // Los cuatro niveles, cada uno sobre el mismo denominador. En el cuarto un
      // grupo puede quedar "sin medir": entonces su resultado es un intervalo,
      // de lo afirmado a lo afirmado mas lo que falta por medir. Decir "0 %"
      // cuando lo que pasa es que falta el dato convierte un hueco de
      // instrumentacion en un juicio sobre las socias.
      const resumenNiveles = NIVELES.map((n) => {
        const si = niveles.filter((x) => x.nivel[n.clave] === true).length;
        const sinMedirN = niveles.filter((x) => x.nivel[n.clave] === null).length;
        return {
          clave: n.clave,
          nombre: n.nombre,
          exige: n.exige,
          grupos: si,
          sinMedir: sinMedirN,
          porcentaje: pct(si, denominador),
          porcentajeMaximo: pct(si + sinMedirN, denominador),
        };
      });
      const sinMedir = resumenNiveles.find((n) => n.clave === 'uso').sinMedir;
      // Sin denominador no hay indicador en absoluto: mientras nadie marque en
      // SeguimientoCampo que grupos son CAYC, 0 de 0 no es "no cumple la meta",
      // es "todavia no se ha decidido que se mide".
      const hayDenominador = denominador > 0;
      // Y con datos sembrados dentro NUNCA es medible, aunque salgan las cuentas.
      // Las entradas sembradas arrancan en junio de 2025, asi que contarlas hace
      // que la ventana de registro parezca cubrir mas de un ano y la condicion de
      // uso pase a parecer comprobada. Es el mismo camino por el que estuve a
      // punto de reportar un cero falso, solo que por la otra puerta.
      const medible = hayDenominador && !incluirDemo;
      // El USO (nivel 4) es lo unico que depende del registro de entradas. Se
      // puede afirmar solo si ese registro es fiable, cubre a todos los grupos y
      // no lleva nada sembrado dentro.
      const usoMedible = medible && ventana.fiable && sinMedir === 0;

      const socializados = filasGrupos.length;
      const capacitados = filasGrupos.filter((g) => g.Capacitado === 'si').length;
      const usando = filasGrupos.filter((g) => Number(g['Socias que han entrado']) > 0).length;
      const sinApp = filasGrupos.filter((g) => g['Esta en la app'] === 'no').length;

      // DOS POBLACIONES QUE NO SE PUEDEN MEZCLAR: las socias de los grupos CAYC
      // y las socias de la plataforma. Cuando las CAYC seleccionadas no son los
      // grupos cargados, la primera cifra es mucho menor que la segunda, y eso
      // es correcto pero se lee como si faltaran datos. Peor: invita a dividir
      // una por otra, que es construir un porcentaje con el numerador de una
      // poblacion y el denominador de otra. Se publican las dos, dichas, y sin
      // porcentaje entre ellas.
      const sociasCayc = new Set(filasNomina.map((f) => f.Correo));
      const sociasPlataforma = new Set();
      [...porGrupo.values()].forEach((lista) => lista
        .forEach((x) => { if (x.correo) sociasPlataforma.add(x.correo); }));
      const sociasFuera = [...sociasPlataforma].filter((c) => !sociasCayc.has(c)).length;

      // El aviso va en la PRIMERA hoja y en la primera fila. Antes vivia solo en
      // "Como se calcula", que es la hoja que nadie abre: quien recibiera el
      // archivo veia el numerador y el porcentaje sin enterarse de que estaban
      // contando datos sembrados. Un aviso que hay que ir a buscar no es un aviso.
      const filasSembrado = sembrado.aportes + sembrado.acciones + sembrado.prestamos
        + sembrado.pagos + sembrado.asambleas + sembrado.entradas;

      // ORDEN POR SEVERIDAD, no por orden de aparicion en el codigo. Cada vez
      // que anadi un aviso nuevo lo puse donde cabia, y dos veces desplace sin
      // querer uno mas grave; las dos veces lo cazo una prueba. Con dos listas
      // separadas el orden ya no depende de donde se escriba cada bloque.
      //
      // GRAVES: el documento no se puede usar como medio de verificacion, o la
      // cifra que trae no se puede afirmar. Van primero porque quien abra el
      // archivo tiene que verlas antes que el numero.
      const graves = [];
      // AVISOS: la cifra es la que es, pero conviene saber en que se apoya.
      const avisos = [];

      if (!hayDenominador) {
        graves.push({
          Concepto: 'ATENCION: todavia no hay indicador',
          Valor: 'Ningun grupo esta marcado como CAYC en la hoja SeguimientoCampo, asi que el '
               + 'denominador es 0 y no hay nada que calcular. Esto NO significa que la meta no '
               + 'se cumpla: significa que la direccion del proyecto aun no ha fijado que grupos '
               + 'entran en el indicador. Mientras tanto este documento sirve como diagnostico, '
               + 'no como medio de verificacion.',
        });
      }
      if (incluirDemo) {
        graves.push({
          Concepto: 'AVISO',
          Valor: 'Este documento INCLUYE datos de demostracion. NO sirve como medio de '
               + 'verificacion ante el INCYT. Para el informe hay que generarlo sin ellos.',
        });
      }
      if (ventana.marcasDesconocidas.length > 0) {
        graves.push({
          Concepto: 'ATENCION: el registro de entradas trae marcas desconocidas',
          Valor: `La hoja de accesos contiene el origen ${ventana.marcasDesconocidas
            .map((m) => `"${m}"`).join(', ')}, que este instrumento no sabe clasificar. `
               + `Solo reconoce ${ORIGENES_REALES.map((m) => `"${m}"`).join(' y ')} como entradas `
               + `reales y "${ORIGEN_SEMBRADO}" como sembradas. Mientras haya marcas sin clasificar `
               + 'no se puede afirmar nada sobre el uso, porque podria estar contando como real '
               + 'algo que no lo es. Todos los grupos salen como "sin medir" en esa condicion.',
        });
      }
      // Solo cuando de verdad hay grupos sin evaluar en el nivel 4. Ya no es
      // grave: el indicador se mide en el nivel 1, que no depende del registro
      // de entradas. Lo que no se puede afirmar es el USO, y eso se dice.
      if (sinMedir > 0 && hayDenominador) {
        avisos.push({
          Concepto: 'Aviso: el nivel 4 (uso) no se puede afirmar para todos los grupos',
          Valor: `${sinMedir} de ${denominador} grupos no se pueden evaluar en el uso porque el `
               + `registro de entradas a la app empieza el ${ventana.desde || 'sin datos'} y sus `
               + 'socias estaban dadas de alta desde antes. Lo que hicieran antes de esa fecha no '
               + 'quedo anotado en ninguna parte, asi que no es un cero: es un dato que falta. '
               + 'Por eso el nivel 4 se publica como intervalo.',
        });
      }
      // Un grupo con cuentas enlazadas pero sin la nomina anotada NO cuenta. Se
      // dice cuales son, para que no parezca un olvido del programa.
      const sinForma = filasGrupos
        .filter((g) => g['Esta en la app'] === 'si' && !g['Forma de incorporacion']);
      if (sinForma.length > 0) {
        avisos.push({
          Concepto: 'Aviso: grupos en la app sin nomina anotada',
          Valor: `${sinForma.map((g) => g.Grupo).join(', ')} ${sinForma.length === 1 ? 'esta' : 'estan'} `
               + 'en la plataforma pero la direccion no ha anotado como entro su nomina (columna '
               + 'FormaDeIncorporacion). Sin ese dato no cuentan como digitalizados.',
        });
      }
      if (enlazadosPorNombre.length > 0) {
        avisos.push({
          Concepto: 'Aviso: grupos del registro enlazados por su nombre',
          Valor: `${enlazadosPorNombre.length} grupo(s) se anotaron en la ficha antes de existir en `
               + 'la app y se enlazaron con el grupo que hoy lleva el mismo nombre: '
               + `${enlazadosPorNombre.map((x) => nombreGrupo.get(x.grupo) || x.grupo).join(', ')}.`,
        });
      }

      if (sociasFuera > 0) {
        avisos.push({
          Concepto: 'Aviso: no todas las socias de la plataforma son de grupos CAYC',
          Valor: `${sociasCayc.size} socias pertenecen a los grupos CAYC de este indicador y `
               + `${sociasFuera} mas estan en la plataforma en grupos que no son CAYC. Las dos `
               + 'cifras son correctas y NO comparten denominador: dividir una por otra daria un '
               + 'porcentaje que mezcla dos poblaciones distintas. Que la primera sea menor no '
               + 'significa que falten datos, significa que las CAYC seleccionadas y los grupos '
               + 'cargados en la app no son el mismo conjunto.',
        });
      }
      if (caycSinFuente.length > 0) {
        avisos.push({
          Concepto: 'Aviso: el denominador no esta documentado por completo',
          Valor: `${caycSinFuente.length} de los ${denominador} grupos marcados como CAYC no dicen `
               + 'de donde sale que pertenecen al proyecto (columna FuenteDeLaSeleccion de la hoja '
               + 'SeguimientoCampo). El indicador se calcula igual, pero esa parte del denominador '
               + 'hay que creersela en vez de poder comprobarla. El denominador es la cifra mas '
               + 'discutida de este indicador, asi que conviene que cada grupo diga en que '
               + 'documento, tabla o acta consta.',
        });
      }
      if (ventana.marcasEnDesacuerdo > 0) {
        avisos.push({
          Concepto: 'Aviso: las dos marcas de lo sembrado no coinciden',
          Valor: `${ventana.marcasEnDesacuerdo} filas de la hoja de accesos tienen una marca de `
               + 'demostracion y la otra no. Quedan fuera igualmente, porque basta con que una '
               + 'lo diga, asi que ninguna cifra de este documento cambia por ello. Lo que '
               + 'cambia es en que se apoya: esas filas se clasificaron con una marca en vez de '
               + 'dos. Conviene arreglarlo mientras todavia queda la otra.',
        });
      }
      if (ventana.supuestos > 0) {
        avisos.push({
          Concepto: 'Aviso: entradas con el origen supuesto',
          Valor: `${ventana.supuestos} de los ${ventana.apuntes} apuntes no traen marca de `
               + 'origen. Son anteriores a que existiera esa columna y se cuentan como inicio '
               + 'de sesion, que es lo que documenta quien las escribio, pero es un SUPUESTO y '
               + 'no una lectura. Si esa diferencia importa para el informe, la decision es de '
               + 'la direccion del proyecto y no de este programa.',
        });
      }
      if (ventana.total > 0) {
        avisos.push({
          Concepto: 'Registro de entradas: como se reparten las filas',
          Valor: `${ventana.total} filas en total = ${ventana.apuntes} entradas reales `
               + `(${ventana.supuestos} de ellas con el origen supuesto) `
               + `+ ${ventana.sembrados} sembradas + ${ventana.descartados} sin clasificar. `
               + 'Las cuatro cifras se publican para que la suma cierre sin tener que restar.',
        });
      }
      if (!incluirDemo && filasSembrado > 0) {
        avisos.push({
          Concepto: 'Base del calculo',
          Valor: `Solo datos reales. Se dejaron fuera ${filasSembrado} filas sembradas para `
               + 'demostrar el funcionamiento de la app.',
        });
      }

      // --- lo que necesitan las secciones del informe ---------------------
      const digitalizados = niveles.filter((x) => x.nivel.incorporado);
      const textoNivel = (n) => (n.sinMedir > 0
        ? { grupos: `${n.grupos} a ${n.grupos + n.sinMedir}`,
          indicador: `${pctTexto(n.porcentaje)} a ${pctTexto(n.porcentajeMaximo)}` }
        : { grupos: n.grupos, indicador: pctTexto(n.porcentaje) });
      const resultadoTexto = hayDenominador
        ? `(${numerador} / ${denominador}) × 100 = ${pctTexto(porcentaje)}`
        : 'sin denominador: falta marcar las CAYC en SeguimientoCampo';
      const cumplimiento = !hayDenominador ? 'Sin denominador'
        : (incluirDemo ? 'No se afirma: el documento incluye datos de demostración'
          : (porcentaje >= META ? 'Meta alcanzada' : 'Meta no alcanzada'));
      const suma = (lista, clave) => lista.reduce((s, x) => s + Number(x.fila[clave] || 0), 0);
      const integrantes = new Set(digitalizados.flatMap((x) => x.correos).filter(Boolean));
      const entradasSocias = suma(digitalizados, 'Entradas de sus socias');
      const operaciones = {
        ahorros: suma(digitalizados, 'Aportes registrados'),
        acciones: suma(digitalizados, 'Compras de acciones'),
        prestamos: suma(digitalizados, 'Prestamos otorgados'),
      };
      operaciones.total = operaciones.ahorros + operaciones.acciones + operaciones.prestamos;
      const filasDeUsuario = usuarios.filter((u) => normalizeEmailKey(u[USR.email])).length;
      const conMovimiento = digitalizados.filter((x) => x.hito.movimiento);
      const conMitad = digitalizados.filter((x) => x.hito.uso === true);
      const delPlan = niveles.filter((x) => x.ordenEnElPlan > 0)
        .sort((a, b) => a.ordenEnElPlan - b.ordenEnElPlan);
      const procedenciaPlan = niveles.filter((x) => /plan/i.test(x.procedencia)).length;

      const filasIndicador = [
        ...graves,
        ...avisos,
        { Concepto: 'Indicador', Valor: 'IN-DIBA-2026-1.2' },
        { Concepto: 'Meta', Valor: 'Porcentaje de las CAYC seleccionadas estan digitalizadas' },
        { Concepto: 'Meta cuantitativa', Valor: `${META} %` },
        { Concepto: 'Criterio de digitalizacion', Valor: CRITERIO },
        { Concepto: 'NUMERADOR (grupos CAYC digitalizados)', Valor: numerador },
        { Concepto: 'DENOMINADOR (grupos socializados)', Valor: denominador },
        {
          Concepto: 'Denominador con su fuente documentada',
          Valor: `${denominador - caycSinFuente.length} de ${denominador}`,
        },
        { Concepto: 'RESULTADO', Valor: resultadoTexto },
        { Concepto: 'Cumple la meta', Valor: medible ? siNo(porcentaje >= META) : 'sin medir' },
        ...resumenNiveles.slice(1).map((n) => ({
          Concepto: `Nivel ${n.nombre}`,
          Valor: `${textoNivel(n).grupos} de ${denominador} (${textoNivel(n).indicador})`,
        })),
        { Concepto: 'Grupos sin medir en el nivel 4 (uso)', Valor: sinMedir },
        ...(medible ? [{
          Concepto: 'Brecha hasta la meta',
          Valor: porcentaje >= META ? '0' : `${Math.round((META - porcentaje) * 10) / 10} %`,
        }] : []),
        {
          Concepto: 'Registro de entradas: desde',
          Valor: (ventana.desde || 'no hay ningun apunte')
            // Las entradas sembradas van de junio de 2025 en adelante. Si se
            // cuentan, la ventana parece cubrir mas de un ano y la condicion de
            // uso pasa a parecer MEDIBLE cuando no lo es: justo el camino por el
            // que un hueco de instrumentacion vuelve a leerse como un cero.
            + (incluirDemo ? ' (CONTAMINADA: incluye entradas sembradas, no sirve para juzgar el uso)' : ''),
        },
        { Concepto: 'Registro de entradas: hasta', Valor: ventana.hasta || '-' },
        { Concepto: 'Registro de entradas: dias cubiertos', Valor: ventana.dias },
        { Concepto: 'Grupos a los que se socializo', Valor: `${socializados} de ${denominador}` },
        { Concepto: 'Grupos capacitados', Valor: `${capacitados} de ${denominador}` },
        { Concepto: 'Grupos con alguna socia que ya entro', Valor: `${usando} de ${denominador}` },
        { Concepto: 'CAYC seleccionadas que AUN NO estan en la app', Valor: `${sinApp} de ${denominador}` },
        // Dos cifras, no una. La nomina lleva una fila por PAREJA grupo-socia,
        // asi que una persona que pertenece a dos cajas aparece dos veces. Si
        // se publica ese total como "socias", arreglar un enlace duplicado
        // mueve la cifra del proyecto y nadie sabe explicar por que bajo.
        { Concepto: 'Socias en los grupos CAYC', Valor: sociasCayc.size },
        {
          Concepto: 'Socias de la plataforma que NO estan en grupos CAYC',
          Valor: `${sociasFuera} (de ${sociasPlataforma.size} en total en la plataforma)`,
        },
        { Concepto: 'Vinculos socia-grupo (una socia en dos cajas cuenta dos veces)', Valor: filasNomina.length },
        { Concepto: 'Registros de operaciones como evidencia', Valor: filasEvidencias.length },
        {
          Concepto: 'Listado inicial del Plan: digitalizados',
          Valor: `${delPlan.filter((x) => x.nivel.incorporado).length} de ${delPlan.length}`
            + (delPlan.some((x) => x.nivel.incorporado)
              ? ` (${delPlan.filter((x) => x.nivel.incorporado).map((x) => x.nombreDoc).join(', ')})` : ''),
        },
        { Concepto: 'Fecha del corte', Valor: fechaEcuador() },
      ];

      // --- las secciones del informe, una hoja cada una ------------------
      const filasDatos = [
        { Campo: 'Proyecto de investigación', Valor: PROYECTO.nombre },
        { Campo: 'Directora del proyecto', Valor: PROYECTO.directora },
        { Campo: 'Plazo del proyecto', Valor: PROYECTO.plazo },
        { Campo: 'Componente', Valor: PROYECTO.componente },
        { Campo: 'Actividad', Valor: PROYECTO.actividad },
        { Campo: 'Indicador', Valor: PROYECTO.indicador },
        { Campo: 'Periodo', Valor: PROYECTO.periodo },
        { Campo: 'Meta', Valor: `${META} % de las CAYC seleccionadas están digitalizadas` },
        { Campo: 'Medio de verificación', Valor: PROYECTO.medio },
        { Campo: 'Corte de la información', Valor: fechaEnLetras() },
      ];

      const filasCriterio = HITOS.map((h, i) => ({
        HITO: i + 1, NOMBRE: h.nombre, 'QUÉ SE VERIFICA': h.verifica,
      }));

      const filasResultado = [
        { Concepto: 'Grupos de ahorro socializados', Valor: denominador },
        { Concepto: 'Grupos de ahorro capacitados', Valor: capacitados },
        { Concepto: 'Grupos de ahorro digitalizados', Valor: numerador },
        { Concepto: 'Resultado del indicador', Valor: resultadoTexto },
        { Concepto: 'Meta del cuatrimestre', Valor: `${META} %` },
        { Concepto: 'Cumplimiento', Valor: cumplimiento },
      ];

      const filasNiveles = resumenNiveles.map((n) => ({
        NIVEL: n.nombre,
        'QUÉ EXIGE': n.exige,
        GRUPOS: textoNivel(n).grupos,
        INDICADOR: textoNivel(n).indicador,
      }));

      const filasDigitalizados = digitalizados.map((x, i) => ({
        'N.º': i + 1,
        'GRUPO DE AHORRO': x.nombreDoc,
        SOCIOS: Number(x.fila['Socias en la app'] || 0),
        'DIRECTIVA REGISTRADA': siNoTexto(x.hito.directiva),
        'FORMA DE INCORPORACIÓN': x.fila['Forma de incorporacion'],
      }));
      if (filasDigitalizados.length) {
        filasDigitalizados.push({
          'N.º': '', 'GRUPO DE AHORRO': 'Total', SOCIOS: suma(digitalizados, 'Socias en la app'),
          'DIRECTIVA REGISTRADA': '', 'FORMA DE INCORPORACIÓN': '',
        });
      }

      const nombres = (lista) => lista.map((x) => x.nombreDoc).join(', ');
      const filasCobertura = [
        {
          PREGUNTA: '¿A cuántos grupos se les hizo la socialización?',
          RESPUESTA: denominador,
          DETALLE: `Registro de la dirección del proyecto: ${procedenciaPlan} del listado inicial del `
            + `Plan Integral y ${denominador - procedenciaPlan} identificados o conformados durante la `
            + `ejecución. De ellos, ${numerador} están digitalizados`,
        },
        {
          PREGUNTA: '¿Cuántos grupos fueron capacitados?',
          RESPUESTA: capacitados,
          DETALLE: 'Registro del equipo del proyecto anotado en la ficha de campo: capacitación '
            + 'presencial o por videoconferencia en el uso de la plataforma',
        },
        {
          PREGUNTA: '¿Cuántos grupos registran ya aportes propios en la plataforma?',
          RESPUESTA: conMovimiento.length,
          DETALLE: conMovimiento.length
            ? `${nombres(conMovimiento)}: ${operaciones.ahorros} ahorros, ${operaciones.acciones} `
              + `acciones y ${operaciones.prestamos} préstamos, ${operaciones.total} movimientos en total`
            : 'Ningún grupo digitalizado ha registrado todavía un movimiento propio en la plataforma',
        },
        {
          PREGUNTA: '¿Cuántas entradas a la plataforma registran las socias y socios?',
          RESPUESTA: entradasSocias,
          DETALLE: (ventana.desde
            ? `Entradas de las socias y socios de los ${numerador} grupos digitalizados registradas `
              + `por el sistema desde el ${ventana.desde} hasta el ${ventana.hasta}. `
            : 'El registro de accesos todavía no tiene ninguna entrada real. ')
            + `En ${conMitad.length} grupo(s) al menos la mitad de sus integrantes ha ingresado`
            + (sinMedir > 0 ? `; en ${sinMedir} no se puede afirmar (el registro empezó después de su alta)` : ''),
        },
        {
          PREGUNTA: '¿Cuántos grupos están digitalizados?',
          RESPUESTA: numerador,
          DETALLE: `Grupos creados en el sistema con su nómina de socias enlazada: el ${pctTexto(porcentaje)} `
            + 'de los socializados',
        },
        {
          PREGUNTA: '¿Cuántas socias y socios están organizados?',
          RESPUESTA: integrantes.size,
          DETALLE: `Integrantes enlazados a alguno de los ${numerador} grupos digitalizados`,
        },
        {
          PREGUNTA: '¿Cuántas cuentas hay en la plataforma?',
          RESPUESTA: persona.size,
          // Una cuenta es un correo con el que se entra. Si la hoja trae el
          // mismo correo en dos filas, son dos registros y UNA cuenta: se
          // publican las dos cifras para que cuadren con quien cuente filas.
          DETALLE: 'Incluye las cuentas del equipo del proyecto y las abiertas para probar el sistema'
            + (filasDeUsuario > persona.size
              ? `. La hoja de usuarios tiene ${filasDeUsuario} registros: ${filasDeUsuario - persona.size} `
                + 'repiten un correo que ya tiene cuenta'
              : ''),
        },
      ];

      const filasMatriz = digitalizados.map((x) => ({
        'GRUPO DE AHORRO': x.nombreDoc,
        SOCIOS: Number(x.fila['Socias en la app'] || 0),
        INGRESOS: Number(x.fila['Entradas de sus socias'] || 0),
        CAPACITADO: siNoTexto(x.hito.capacitado),
        INCORPORADO: siNoTexto(x.nivel.incorporado),
        DIRECTIVA: siNoTexto(x.hito.directiva),
        MOVIMIENTO: siNoTexto(x.hito.movimiento),
        'EN USO': x.veredictoUso === 'sin medir' ? 'Sin medir' : siNoTexto(x.veredictoUso === 'si'),
      }));

      const filasOperaciones = digitalizados.map((x) => ({
        'GRUPO DE AHORRO': x.nombreDoc,
        AHORROS: Number(x.fila['Aportes registrados'] || 0),
        ACCIONES: Number(x.fila['Compras de acciones'] || 0),
        'PRÉSTAMOS': Number(x.fila['Prestamos otorgados'] || 0),
        TOTAL: Number(x.fila['Aportes registrados'] || 0) + Number(x.fila['Compras de acciones'] || 0)
          + Number(x.fila['Prestamos otorgados'] || 0),
      }));
      if (filasOperaciones.length) {
        filasOperaciones.push({
          'GRUPO DE AHORRO': 'TOTAL', AHORROS: operaciones.ahorros, ACCIONES: operaciones.acciones,
          'PRÉSTAMOS': operaciones.prestamos, TOTAL: operaciones.total,
        });
      }

      const filasPlan = delPlan.map((x) => ({
        'N.º': x.ordenEnElPlan,
        'GRUPO DEL LISTADO': x.nombreEnElPlan || x.nombreDoc,
        PARROQUIA: x.parroquia,
        INCORPORADO: siNoTexto(x.nivel.incorporado),
        'OBSERVACIÓN': x.nivel.incorporado
          ? `Incorporado a la plataforma con ${Number(x.fila['Socias en la app'] || 0)} socias`
          : 'N/A',
      }));

      const filasSocializados = niveles.map((x, i) => ({
        'N.º': i + 1,
        'GRUPO DE AHORRO': x.nombreDoc,
        PROCEDENCIA: x.procedencia,
        DIGITALIZADO: siNoTexto(x.nivel.incorporado),
      }));

      // --- control de consistencia: lo que un revisor comprobaria a mano ---
      const gruposDe = new Map();
      digitalizados.forEach((x) => x.correos.forEach((c) => {
        if (!c) return;
        if (!gruposDe.has(c)) gruposDe.set(c, []);
        gruposDe.get(c).push(x.nombreDoc);
      }));
      const enDos = [...gruposDe.entries()].filter(([, l]) => l.length > 1);
      const correosMalos = [...integrantes].filter((c) => !CORREO_VALIDO.test(c) || /\.$/.test(c));
      const sinDirectiva = digitalizados.filter((x) => !x.hito.directiva);
      const conforme = (ok) => (ok ? 'Conforme' : 'No conforme');
      const filasConsistencia = [
        {
          'COMPROBACIÓN': 'La suma de socios por grupo coincide con el total de integrantes',
          RESULTADO: conforme(suma(digitalizados, 'Socias en la app') === integrantes.size),
          'OBSERVACIÓN': `${suma(digitalizados, 'Socias en la app')} enlaces para `
            + `${integrantes.size} personas en ${numerador} grupos`,
        },
        {
          'COMPROBACIÓN': 'Ninguna socia figura enlazada a dos grupos a la vez',
          RESULTADO: conforme(enDos.length === 0),
          'OBSERVACIÓN': enDos.length
            ? enDos.map(([c, l]) => `${(persona.get(c) || {}).nombre || c}: ${l.join(' y ')}`).join('; ')
            : 'cada integrante pertenece a un solo grupo digitalizado',
        },
        {
          'COMPROBACIÓN': 'Cada grupo digitalizado tiene su directiva registrada',
          RESULTADO: conforme(sinDirectiva.length === 0),
          'OBSERVACIÓN': sinDirectiva.length
            ? `sin cabeza y tesorería: ${nombres(sinDirectiva)}`
            : `${numerador} de ${numerador} con cabeza y tesorería`,
        },
        {
          'COMPROBACIÓN': 'Los correos de los socios tienen forma válida',
          RESULTADO: conforme(correosMalos.length === 0),
          'OBSERVACIÓN': correosMalos.length ? correosMalos.join(', ') : 'todos los correos tienen forma válida',
        },
        {
          'COMPROBACIÓN': 'El porcentaje del indicador resulta de dividir su numerador por su denominador',
          RESULTADO: conforme(hayDenominador),
          'OBSERVACIÓN': hayDenominador ? `${numerador} entre ${denominador}: ${pctTexto(porcentaje)}` : 'sin denominador',
        },
        {
          'COMPROBACIÓN': 'El cálculo usa solo datos reales',
          RESULTADO: conforme(!incluirDemo),
          'OBSERVACIÓN': incluirDemo
            ? 'este archivo INCLUYE datos de demostración y no sirve como medio de verificación'
            : `se dejaron fuera ${filasSembrado} filas sembradas para demostrar la app`,
        },
        {
          'COMPROBACIÓN': 'Los grupos del registro que ya están en la plataforma se reconocen sin ambigüedad',
          RESULTADO: conforme(campo.every((f) => {
            const gid = normalizeGroupKey(f[CAMPO.id]);
            if (!gid.startsWith('sinapp:')) return true;
            return !nombresRepetidos.has(claveNombre((f[CAMPO.grupo] || '').toString() || gid.slice(7)));
          })),
          'OBSERVACIÓN': enlazadosPorNombre.length
            ? `${enlazadosPorNombre.length} enlazado(s) por su nombre`
            : 'todos los grupos del registro que están en la plataforma llevan su identificador',
        },
      ];

      const filasRegla = [
        { Punto: 'Denominador', Regla: 'Los grupos del registro de grupos socializados que certifica la direccion (hoja SeguimientoCampo, EsCAYC = si). No se adivina: lo fija la direccion del proyecto.' },
        { Punto: 'Criterio de digitalizacion', Regla: `${CRITERIO} La meta se mide en el nivel 1 (incorporado).` },
        ...HITOS.map((h, i) => ({ Punto: `Hito ${i + 1}: ${h.nombre}`, Regla: h.verifica })),
        ...NIVELES.map((n) => ({ Punto: `Nivel ${n.nombre}`, Regla: n.exige })),
        {
          Punto: 'Nomina levantada',
          Regla: 'Consta cuando la direccion anota en la ficha como entro la nomina del grupo '
            + '(FormaDeIncorporacion). Si falta, el grupo no cuenta como incorporado aunque tenga cuentas enlazadas.',
        },
        {
          Punto: 'Capacitado',
          Regla: 'Consta cuando la ficha trae la fecha de la capacitacion o la marca Capacitado = si '
            + '(registro del equipo del proyecto).',
        },
        ...CONDICIONES.map((c, i) => ({
          Punto: `Condicion ${i + 1} del nivel 4`,
          Regla: `${c.titulo}. ${c.detalle}`,
        })),
        { Punto: 'Uso pleno (nivel 4): se cumplen las tres', Regla: 'Un grupo esta en uso pleno solo si cumple las tres. La hoja Grupos dice cual le falta a cada uno.' },
        {
          Punto: 'Cuando una condicion no se puede medir',
          Regla: 'El registro de entradas a la app no existe desde siempre: empieza el '
               + `${ventana.desde || '(todavia no hay ningun apunte)'} y cubre ${ventana.dias} dia(s). `
               + 'Para un grupo cuyas socias se dieron de alta ANTES de esa fecha, la pregunta '
               + '"¿ha entrado alguna vez?" no tiene respuesta: lo que hicieran antes no quedo '
               + 'anotado. Esos grupos salen como "sin medir", nunca como "no". Un hueco de '
               + 'instrumentacion no es una ausencia de actividad.',
        },
        {
          Punto: 'Datos de demostracion',
          Regla: incluirDemo
            ? 'ATENCION: este instrumento se genero INCLUYENDO los datos de demostracion. NO sirve como medio de verificacion.'
            : 'Excluidos. Lo sembrado para ensenar la app lleva identificador "demo_" y no cuenta en el indicador.',
        },
      ];

      if (sembrado.aportes + sembrado.prestamos + sembrado.entradas > 0) {
        filasRegla.push({
          Punto: 'Filas de demostracion encontradas',
          Regla: `${sembrado.aportes} aportes, ${sembrado.acciones} compras, ${sembrado.prestamos} prestamos, `
               + `${sembrado.pagos} pagos, ${sembrado.asambleas} asambleas y ${sembrado.entradas} entradas. `
               + (incluirDemo ? 'CONTADAS en este documento.' : 'Dejadas fuera de este documento.'),
        });
      }

      const sinFicha = grupos
        .filter((g) => g[GRP.id] && bajo(g[GRP.estado]) !== 'eliminado')
        .filter((g) => !fichaDe.has(normalizeGroupKey(g[GRP.id])))
        .map((g) => ({
          GrupoID: (g[GRP.id] || '').toString().trim(),
          Grupo: (g[GRP.nombre] || '').toString(),
          Aviso: 'No esta en la ficha de campo, asi que NO entra en el indicador. Anotalo si es una CAYC del proyecto.',
        }));

      return res.json({
        success: true,
        generado: new Date().toISOString(),
        archivo: `JuntaGO-indicador-IN-DIBA-2026-1.2-${fechaEcuador()}`
          + (incluirDemo ? '-CON-DATOS-DE-DEMOSTRACION' : ''),
        soloDatosReales: !incluirDemo,
        indicador: {
          numerador,
          denominador,
          porcentaje,
          meta: META,
          cumple: medible ? porcentaje >= META : null,
          medible,
          usoMedible,
          sinMedir,
          caycSinFuenteDocumentada: caycSinFuente.length,
          ventanaDeRegistro: ventana,
          criterio: CRITERIO,
          socializados: denominador,
          capacitados,
          niveles: resumenNiveles,
          integrantes: integrantes.size,
          entradasDeSocias: entradasSocias,
          operaciones,
          cuentas: persona.size,
        },
        // El orden es el del informe: primero la hoja que avisa, despues las
        // secciones tal como las lee quien revisa, y al final el detalle.
        hojas: [
          { nombre: 'Indicador', filas: filasIndicador },
          { nombre: 'Datos generales', filas: filasDatos },
          { nombre: 'Criterio', filas: filasCriterio },
          { nombre: 'Resultado', filas: filasResultado },
          { nombre: 'Niveles', filas: filasNiveles },
          { nombre: 'Grupos digitalizados', filas: filasDigitalizados },
          { nombre: 'Cobertura', filas: filasCobertura },
          { nombre: 'Matriz de seguimiento', filas: filasMatriz },
          { nombre: 'Registro de operaciones', filas: filasOperaciones },
          { nombre: 'Listado inicial del Plan', filas: filasPlan },
          { nombre: 'Registro de socializados', filas: filasSocializados },
          { nombre: 'Control de consistencia', filas: filasConsistencia },
          { nombre: 'Como se calcula', filas: filasRegla },
          { nombre: 'Grupos', filas: filasGrupos },
          { nombre: 'Nomina de socias', filas: filasNomina },
          { nombre: 'Evidencias de operaciones', filas: filasEvidencias },
          { nombre: 'Grupos sin ficha de campo', filas: sinFicha },
        ],
      });
    } catch (error) {
      console.error('[INSTRUMENTO]', error.message);
      if (responderSiEsCuota(res, error)) return;
      return res.status(500).json({
        success: false,
        message: 'No se pudo armar el instrumento de seguimiento.',
      });
    }
  });
};
