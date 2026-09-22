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
 */

'use strict';

const HOJA_CAMPO = 'SeguimientoCampo';
const CABECERA_CAMPO = [
  'GroupID', 'Grupo', 'EsCAYC', 'SocializacionFecha', 'SocializacionAsistentes',
  'CapacitacionFecha', 'CapacitacionAsistentes', 'Responsable', 'Evidencia',
  'Observacion', 'ActualizadoPor', 'ActualizadoEn',
];
const CAMPO = {
  id: 0, grupo: 1, esCayc: 2, socFecha: 3, socAsistentes: 4,
  capFecha: 5, capAsistentes: 6, responsable: 7, evidencia: 8,
  observacion: 9, actualizadoPor: 10, actualizadoEn: 11,
};

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

/**
 * LA REGLA. Un grupo cuenta como digitalizado cuando los tres cimientos estan
 * puestos EN LA APP y con datos reales. No es la escalera completa de nueve
 * hitos (eso mide profundidad): es el minimo para poder decir que el grupo dejo
 * el cuaderno.
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

module.exports.register = function register(app, ctx) {
  const {
    getSheetsClient, SPREADSHEET_ID, normalizeEmailKey, normalizeGroupKey,
    normalizeGroupRole, requireAdmin, bloquear, responderSiEsCuota, linkIsActive,
    ensureSheetExists, hojaAccesos, accesoDesdeFila, sanitizeCell,
  } = ctx;

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

  // =========================================================================
  // La ficha de campo: que grupos son del proyecto, y que se hizo con cada uno
  // =========================================================================
  app.get('/api/admin/seguimiento-campo', requireAdmin, async (req, res) => {
    try {
      const sheetsClient = await getSheetsClient();
      await asegurarCampo(sheetsClient);
      const [filas, grupos] = await leerVarios(sheetsClient, [
        `${HOJA_CAMPO}!A2:L`, 'Groups!A2:R',
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
        const filas = await leer(sheetsClient, `${HOJA_CAMPO}!A2:L`);
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
          ];
          if (posicion.has(gid)) cambios.push({ fila: posicion.get(gid), valores: fila });
          else nuevas.push(fila);
          tocados.push(gid);
        }

        for (const c of cambios) {
          await sheetsClient.spreadsheets.values.update({
            spreadsheetId: SPREADSHEET_ID,
            range: `${HOJA_CAMPO}!A${c.fila}:L${c.fila}`,
            valueInputOption: 'RAW',
            resource: { values: [c.valores] },
          });
        }
        if (nuevas.length) {
          await sheetsClient.spreadsheets.values.append({
            spreadsheetId: SPREADSHEET_ID,
            range: `${HOJA_CAMPO}!A:L`,
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
        usuarios, grupos, vinculos, accesos, ahorros, acciones,
        prestamos, pagos, asambleas, campo,
      ] = await leerVarios(sheetsClient, [
        'Users!A2:I', 'Groups!A2:R', 'UserGroupLinks!A2:F', `${hojaAccesos}!A2:H`,
        'Savings!A2:L', 'Acciones!A2:M', 'Loans!A2:K', 'LoanPayments!A2:O',
        'Asambleas!A2:N', `${HOJA_CAMPO}!A2:L`,
      ]);

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
      const accesosR = incluirDemo ? accesos : accesos.filter((f) => bajo(f[7]) !== 'demo');

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
      const fichaDe = new Map();
      campo.forEach((f) => {
        const gid = normalizeGroupKey(f[CAMPO.id]);
        if (gid && !fichaDe.has(gid)) fichaDe.set(gid, f);
      });

      const nombreGrupo = new Map();
      grupos.forEach((g) => {
        const gid = normalizeGroupKey(g[GRP.id]);
        if (gid) nombreGrupo.set(gid, (g[GRP.nombre] || '').toString());
      });

      // El denominador: los grupos marcados como CAYC en la ficha de campo.
      const caycIds = [...fichaDe.entries()]
        .filter(([, f]) => bajo(f[CAMPO.esCayc]) !== 'no')
        .map(([gid]) => gid);

      // --- una fila por grupo ---------------------------------------------
      const filasGrupos = [];
      const filasNomina = [];
      const filasEvidencias = [];

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
        const usanMedible = !!ventana.desde && (!altaMasVieja || ventana.desde <= altaMasVieja);

        const cumple = {
          directiva: cargos.has('presidente') && cargos.has('tesorero'),
          usan: usanMedible ? (socias.length > 0 && entraron.length * 2 >= socias.length) : null,
          dinero: (susAhorros.length + susAcciones.length + susPrestamos.length) > 0,
        };
        // Tres estados, no dos: si, no, y sin medir. Un grupo con alguna
        // condicion sin medir NO cuenta como digitalizado (no se puede afirmar)
        // pero tampoco se le apunta como fallo.
        const hayIndeterminada = CONDICIONES.some((c) => cumple[c.clave] === null);
        const digitalizada = enLaApp && !hayIndeterminada
          && CONDICIONES.every((c) => cumple[c.clave] === true);
        const veredicto = !enLaApp ? 'no'
          : (hayIndeterminada && CONDICIONES.every((c) => cumple[c.clave] !== false)
            ? 'sin medir'
            : siNo(digitalizada));
        const leFalta = enLaApp
          ? CONDICIONES.filter((c) => cumple[c.clave] === false).map((c) => c.titulo)
            .concat(CONDICIONES.filter((c) => cumple[c.clave] === null)
              .map((c) => `${c.titulo} (SIN MEDIR: el registro de entradas empieza el `
                + `${ventana.desde || 'sin datos'} y estas socias estaban desde antes)`))
          : ['El grupo todavia no existe en la app'];

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
          'Socias que han entrado': entraron.length,
          '% de socias que han entrado': pct(entraron.length, socias.length),
          'Aportes registrados': susAhorros.length,
          'Compras de acciones': susAcciones.length,
          'Prestamos otorgados': susPrestamos.length,
          'Pagos con comprobante': susPagos.length,
          'Asambleas registradas': susAsambleas.length,
          'Uso medible': siNo(usanMedible),
          'DIGITALIZADA': veredicto,
          'Que le falta': leFalta.join('; '),
          Responsable: (ficha[CAMPO.responsable] || '').toString(),
          Evidencia: (ficha[CAMPO.evidencia] || '').toString(),
          Observacion: (ficha[CAMPO.observacion] || '').toString(),
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
      const denominador = caycIds.length;
      const numerador = filasGrupos.filter((g) => g.DIGITALIZADA === 'si').length;
      const sinMedir = filasGrupos.filter((g) => g.DIGITALIZADA === 'sin medir').length;
      const porcentaje = pct(numerador, denominador);
      const META = 50;
      // Si hay grupos que no se pueden evaluar, el porcentaje NO es el indicador:
      // es una cota inferior. Decir "0 %" cuando lo que pasa es que falta el dato
      // convierte un hueco de instrumentacion en un juicio sobre las socias.
      //
      // Y sin denominador no hay indicador en absoluto: mientras nadie marque en
      // SeguimientoCampo que grupos son CAYC, 0 de 0 no es "no cumple la meta",
      // es "todavia no se ha decidido que se mide".
      const hayDenominador = denominador > 0;
      // Y con datos sembrados dentro NUNCA es medible, aunque salgan las cuentas.
      // Las entradas sembradas arrancan en junio de 2025, asi que contarlas hace
      // que la ventana de registro parezca cubrir mas de un ano y la condicion de
      // uso pase a parecer comprobada. Es el mismo camino por el que estuve a
      // punto de reportar un cero falso, solo que por la otra puerta.
      const medible = hayDenominador && sinMedir === 0 && !incluirDemo;

      const socializados = filasGrupos.filter((g) => g['Socializacion (fecha)']).length;
      const capacitados = filasGrupos.filter((g) => g['Capacitacion (fecha)']).length;
      const usando = filasGrupos.filter((g) => Number(g['Socias que han entrado']) > 0).length;
      const sinApp = filasGrupos.filter((g) => g['Esta en la app'] === 'no').length;

      // El aviso va en la PRIMERA hoja y en la primera fila. Antes vivia solo en
      // "Como se calcula", que es la hoja que nadie abre: quien recibiera el
      // archivo veia el numerador y el porcentaje sin enterarse de que estaban
      // contando datos sembrados. Un aviso que hay que ir a buscar no es un aviso.
      const filasSembrado = sembrado.aportes + sembrado.acciones + sembrado.prestamos
        + sembrado.pagos + sembrado.asambleas + sembrado.entradas;

      const filasIndicador = [
        ...(!hayDenominador ? [{
          Concepto: 'ATENCION: todavia no hay indicador',
          Valor: 'Ningun grupo esta marcado como CAYC en la hoja SeguimientoCampo, asi que el '
               + 'denominador es 0 y no hay nada que calcular. Esto NO significa que la meta no '
               + 'se cumpla: significa que la direccion del proyecto aun no ha fijado que grupos '
               + 'entran en el indicador. Mientras tanto este documento sirve como diagnostico, '
               + 'no como medio de verificacion.',
        }] : []),
        // El aviso de los datos sembrados va ANTES que el de "sin medir": si el
        // documento se genero con datos inventados dentro, eso es lo primero que
        // tiene que saber quien lo abra, y lo demas ya da igual.
        ...(incluirDemo ? [{
          Concepto: 'AVISO',
          Valor: 'Este documento INCLUYE datos de demostracion. NO sirve como medio de '
               + 'verificacion ante el INCYT. Para el informe hay que generarlo sin ellos.',
        }] : []),
        // Y este solo cuando de verdad hay grupos sin evaluar. Colgarlo de
        // `!medible` lo disparaba tambien con los datos sembrados dentro, y
        // entonces anunciaba "0 de 10 grupos no se pueden evaluar", que no
        // significa nada.
        ...(sinMedir > 0 && hayDenominador ? [{
          Concepto: 'ATENCION: el indicador NO se puede afirmar todavia',
          Valor: `${sinMedir} de ${denominador} grupos no se pueden evaluar porque el registro `
               + `de entradas a la app empieza el ${ventana.desde || 'sin datos'} y sus socias `
               + 'estaban dadas de alta desde antes. Lo que hicieran antes de esa fecha no quedo '
               + 'anotado en ninguna parte, asi que no es un cero: es un dato que falta. '
               + 'El porcentaje de abajo es una COTA INFERIOR, no la medicion.',
        }] : []),
        ...(!incluirDemo && filasSembrado > 0 ? [{
          Concepto: 'Base del calculo',
          Valor: `Solo datos reales. Se dejaron fuera ${filasSembrado} filas sembradas para `
               + 'demostrar el funcionamiento de la app.',
        }] : []),
        { Concepto: 'Indicador', Valor: 'IN-DIBA-2026-1.2' },
        { Concepto: 'Meta', Valor: 'Porcentaje de las CAYC seleccionadas estan digitalizadas' },
        { Concepto: 'Meta cuantitativa', Valor: `${META} %` },
        { Concepto: 'NUMERADOR (grupos CAYC digitalizados)', Valor: numerador },
        { Concepto: 'DENOMINADOR (total de grupos CAYC)', Valor: denominador },
        { Concepto: 'Grupos que NO se pueden evaluar', Valor: sinMedir },
        {
          Concepto: 'RESULTADO',
          Valor: !hayDenominador ? 'sin denominador: falta marcar las CAYC en SeguimientoCampo'
            : (medible ? `${porcentaje} %` : `${porcentaje} % o mas (sin medir)`),
        },
        { Concepto: 'Cumple la meta', Valor: medible ? siNo(porcentaje >= META) : 'sin medir' },
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
        { Concepto: 'Socias en los grupos CAYC', Valor: new Set(filasNomina.map((f) => f.Correo)).size },
        { Concepto: 'Vinculos socia-grupo (una socia en dos cajas cuenta dos veces)', Valor: filasNomina.length },
        { Concepto: 'Registros de operaciones como evidencia', Valor: filasEvidencias.length },
        { Concepto: 'Fecha del corte', Valor: new Date().toISOString().slice(0, 10) },
      ];

      const filasRegla = [
        { Punto: 'Denominador', Regla: 'Los grupos marcados como CAYC en la hoja SeguimientoCampo. No se adivina: lo fija la direccion del proyecto.' },
        ...CONDICIONES.map((c, i) => ({
          Punto: `Condicion ${i + 1} para contar como digitalizada`,
          Regla: `${c.titulo}. ${c.detalle}`,
        })),
        { Punto: 'Se cumplen todas', Regla: 'Un grupo cuenta como digitalizado solo si cumple las tres. La hoja Grupos dice cual le falta a cada uno.' },
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
        archivo: `JuntaGO-instrumento-digitalizacion-${new Date().toISOString().slice(0, 10)}`
          + (incluirDemo ? '-CON-DATOS-DE-DEMOSTRACION' : ''),
        soloDatosReales: !incluirDemo,
        indicador: {
          numerador,
          denominador,
          porcentaje,
          meta: META,
          cumple: medible ? porcentaje >= META : null,
          medible,
          sinMedir,
          ventanaDeRegistro: ventana,
        },
        hojas: [
          { nombre: 'Indicador', filas: filasIndicador },
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
