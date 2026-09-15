/**
 * Informe de evaluacion de la plataforma  ->  GET /api/admin/metricas
 *
 * Lee las hojas de calculo y las convierte en los indicadores de metricas.js.
 * Aqui solo se traduce (fila de hoja -> evento con fechas); toda la aritmetica
 * vive en metricas.js, que se prueba por separado con numeros hechos a mano.
 *
 * Un detalle que importa para el informe final: cuando una fecha no esta en la
 * hoja NO se rellena con nada. El caso se cuenta en el total pero no en el
 * tiempo medio, y por eso cada indicador viaja con su `n`. Inventar la fecha
 * que falta seria la unica forma de que el numero saliera bonito y falso.
 */

'use strict';

const met = require('./metricas');
const { cuadroDeCuotas } = require('./cuotas');
const dig = require('./digitalizacion');

// --- Donde esta cada cosa en cada hoja -------------------------------------
const USR = { nombre: 0, email: 1, rol: 3, alta: 5, estado: 8 };
const GRP = { id: 0, nombre: 1, creado: 5 };
const LINK = { email: 0, group: 1, alta: 2, rol: 3, estado: 4 };
const SAV = { email: 0, group: 1, monto: 2, fecha: 3, tipo: 4, estado: 6, resueltoEn: 9, movId: 10 };
const ACC = { email: 0, group: 1, fecha: 2, acciones: 3, creadoEn: 6, estado: 7, resueltoEn: 10, movId: 11 };
const LOAN = { id: 0, email: 1, group: 2, monto: 3, inicio: 4, estado: 7, plazo: 8, total: 9 };
const PAGO = { id: 0, email: 1, loan: 2, monto: 3, fecha: 4, estado: 6, creado: 11, revisadoEn: 13 };
const SOL = { id: 0, email: 1, group: 2, monto: 4, estado: 5, fecha: 6 };
const VOTO_SOL = { solicitud: 0, tipo: 1, group: 2, decision: 5, fecha: 6 };
const ASA = { id: 0, group: 1, programada: 3, estado: 5, creadaEn: 8, abiertaEn: 9, cerradaEn: 10 };
const ASIS = { asamblea: 0, group: 1, email: 2, estado: 3 };
const ACU = { id: 0, asamblea: 1, group: 2, estado: 7, aFavor: 12, enContra: 13, abstenciones: 14 };
const VOT = { acuerdo: 0, asamblea: 1, group: 2, email: 3 };
const LOTE = { id: 0, group: 1, estado: 2, creadoPor: 3, creadoEn: 4, asamblea: 5,
  acuerdo: 6, aplicadoEn: 7, ahorro: 8, acciones: 9, deuda: 10, miembros: 11 };
const CIERRE = { id: 0, group: 1, estado: 2, creadoPor: 3, creadoEn: 4, asamblea: 5,
  acuerdo: 6, aplicadoEn: 7, ganancia: 8, base: 9, socios: 11, periodo: 12 };

const bajo = (v) => (v == null ? '' : v).toString().trim().toLowerCase();

// El identificador de un movimiento se forma como  sav_<milisegundos>_<azar>,
// asi que lleva dentro el instante exacto en que se registro. Se usa porque la
// columna Fecha de un ahorro es solo el DIA que la persona declara haber
// entregado el dinero: medir desde ahi mezclaria la demora de la tesoreria con
// las horas que llevaba ese dia transcurridas. Si el identificador es antiguo o
// no lleva marca, se devuelve null y ese caso queda sin medir.
const MS_2020 = Date.UTC(2020, 0, 1);
const MS_2100 = Date.UTC(2100, 0, 1);
function instanteDeMovId(movId) {
  const m = (movId == null ? '' : movId).toString().match(/^[A-Za-z]+_(\d{13})_/);
  if (!m) return null;
  const ms = Number(m[1]);
  if (!(ms > MS_2020 && ms < MS_2100)) return null;
  return new Date(ms).toISOString();
}
const RESUELTAS = ['aprobado', 'aprobada', 'rechazado', 'rechazada'];
const REVISADOS = ['approved', 'aprobado', 'rejected', 'rechazado'];

module.exports.register = function register(app, ctx) {
  const {
    getSheetsClient, SPREADSHEET_ID, normalizeEmailKey, normalizeGroupKey,
    parseMoney, requireAdmin, hojaAccesos, accesoDesdeFila,
  } = ctx;

  /** Lee un rango; si la hoja aun no existe devuelve vacio en vez de reventar. */
  async function leer(sheetsClient, rango) {
    try {
      const r = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: rango,
      });
      return r.data.values || [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Lee VARIOS rangos de una sola vez.
   *
   * Es la diferencia entre gastar dieciseis lecturas de la cuota de Google y
   * gastar una. La cuota la comparte todo el grupo: cuando se agota, la app deja
   * de leer para todas, no solo para quien abrio la pantalla pesada.
   *
   * Si el `batchGet` falla entero (una hoja que no existe todavia en un libro
   * recien creado), se cae a leerlas una por una, que es lo que se hacia antes:
   * mas caro, pero nadie se queda sin sus indicadores.
   */
  async function leerVarios(sheetsClient, rangos) {
    try {
      const r = await sheetsClient.spreadsheets.values.batchGet({
        spreadsheetId: SPREADSHEET_ID, ranges: rangos,
      });
      const rangosLeidos = (r.data && r.data.valueRanges) || [];
      if (rangosLeidos.length !== rangos.length) throw new Error('respuesta incompleta');
      return rangosLeidos.map((x) => (x && x.values) || []);
    } catch (e) {
      // Un solo rango con una pestaña que no existe tumba el lote entero. En vez
      // de volver a las dieciseis lecturas, se pregunta que hay y se pide el
      // lote otra vez con lo que si existe.
      try {
        const libro = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
        const existen = new Set(((libro.data && libro.data.sheets) || [])
          .map((h) => h && h.properties && h.properties.title).filter(Boolean));
        const nombreDe = (r) => (r || '').toString().split('!')[0].replace(/^'|'$/g, '');
        const buenos = rangos.filter((r) => existen.has(nombreDe(r)));
        if (buenos.length === 0) return rangos.map(() => []);

        const r2 = await sheetsClient.spreadsheets.values.batchGet({
          spreadsheetId: SPREADSHEET_ID, ranges: buenos,
        });
        const porRango = new Map();
        ((r2.data && r2.data.valueRanges) || []).forEach((x, i) => {
          porRango.set(buenos[i], (x && x.values) || []);
        });
        return rangos.map((r) => porRango.get(r) || []);
      } catch (e2) {
        // Ni asi: se cae a leerlas una por una, que es lo que se hacia antes.
        return Promise.all(rangos.map((rango) => leer(sheetsClient, rango)));
      }
    }
  }

  // -------------------------------------------------------------------------
  // GET /api/admin/metricas
  // Como fue usada la plataforma: adopcion, tiempos de respuesta y salud de
  // cada grupo. Es lo que permite contrastar despues contra el cuaderno de
  // papel. Solo para el administrador de la plataforma.
  // -------------------------------------------------------------------------
  app.get('/api/admin/metricas', requireAdmin, async (req, res) => {
    try {
      const sheetsClient = await getSheetsClient();

      // TODAS las hojas en UNA sola lectura de la cuota, no dieciseis.
      const [
        usuarios, grupos, vinculos, accesos, ahorros, acciones,
        prestamos, pagos, solicitudes, votosSolicitud,
        asambleas, asistencias, acuerdos, votos, lotes, cierres,
      ] = await leerVarios(sheetsClient, [
        'Users!A2:I',
        'Groups!A2:R',
        'UserGroupLinks!A2:F',
        `${hojaAccesos}!A2:H`,
        'Savings!A2:L',
        'Acciones!A2:M',
        'Loans!A2:K',
        'LoanPayments!A2:O',
        'SolicitudesPrestamos!A2:J',
        'AprobacionesAsamblea!A2:H',
        'Asambleas!A2:N',
        'AsambleaAsistencia!A2:F',
        'Acuerdos!A2:O',
        'AcuerdoVotos!A2:G',
        'LotesApertura!A2:M',
        'CierresUtilidades!A2:Q',
      ]);

      // --- Entradas de cada persona ---
      const accesosPor = {};
      for (const fila of accesos) {
        const a = accesoDesdeFila(fila);
        if (!a || !a.email) continue;
        (accesosPor[a.email] = accesosPor[a.email] || []).push(a);
      }

      // --- Personas dadas de alta ---
      const personas = usuarios
        .filter((u) => normalizeEmailKey(u[USR.email]))
        .map((u) => ({
          email: normalizeEmailKey(u[USR.email]),
          nombre: (u[USR.nombre] || '').toString(),
          alta: (u[USR.alta] || '').toString(),
          rol: bajo(u[USR.rol]) || 'user',
          activa: bajo(u[USR.estado]) !== 'inactivo',
        }));

      // --- Lo pagado y aprobado de cada prestamo, para saber si va al dia ---
      const pagadoPorPrestamo = {};
      const pagosDePrestamo = {};
      for (const f of pagos) {
        const lid = (f[PAGO.loan] || '').toString().trim();
        if (!lid) continue;
        if (!['approved', 'aprobado'].includes(bajo(f[PAGO.estado]))) continue;
        pagadoPorPrestamo[lid] = (pagadoPorPrestamo[lid] || 0) + parseMoney(f[PAGO.monto]);
        (pagosDePrestamo[lid] = pagosDePrestamo[lid] || []).push({
          fecha: (f[PAGO.fecha] || '').toString(),
          monto: parseMoney(f[PAGO.monto]),
        });
      }

      // --- Cuando se resolvio cada solicitud de prestamo ---
      // La hoja de solicitudes no guarda la fecha de la decision; el ultimo
      // voto de la directiva SI la lleva, y es justo el momento en que se
      // resolvio. Si no hay voto (aprobacion directa antigua) queda sin medir.
      const resueltaEn = {};
      for (const v of votosSolicitud) {
        const id = (v[VOTO_SOL.solicitud] || '').toString().trim();
        const f = (v[VOTO_SOL.fecha] || '').toString();
        if (!id || !f) continue;
        if (!resueltaEn[id] || f > resueltaEn[id]) resueltaEn[id] = f;
      }

      const delGrupo = (filas, col, gid) => filas
        .filter((f) => normalizeGroupKey(f[col]) === gid);

      // =====================================================================
      //  Grupo por grupo
      // =====================================================================
      const salidaGrupos = grupos
        .filter((g) => normalizeGroupKey(g[GRP.id]))
        .map((g) => {
          const gid = normalizeGroupKey(g[GRP.id]);
          const links = vinculos
            .filter((v) => normalizeGroupKey(v[LINK.group]) === gid)
            .filter((v) => bajo(v[LINK.estado] || 'activo') !== 'inactivo');
          const correos = links.map((v) => normalizeEmailKey(v[LINK.email])).filter(Boolean);
          const suGente = personas.filter((p) => correos.includes(p.email));

          const susAccesos = {};
          correos.forEach((c) => { if (accesosPor[c]) susAccesos[c] = accesosPor[c]; });

          // --- Aportes: registrado -> confirmado o rechazado ---------------
          const eventosAportes = [
            ...delGrupo(ahorros, SAV.group, gid).map((f) => ({
              clase: 'ahorro',
              estado: bajo(f[SAV.estado]) || 'confirmado',
              creado: instanteDeMovId(f[SAV.movId]) || (f[SAV.fecha] || '').toString(),
              resueltoEn: (f[SAV.resueltoEn] || '').toString(),
            })),
            ...delGrupo(acciones, ACC.group, gid).map((f) => ({
              clase: 'acciones',
              estado: bajo(f[ACC.estado]) || 'confirmado',
              creado: instanteDeMovId(f[ACC.movId])
                || (f[ACC.creadoEn] || f[ACC.fecha] || '').toString(),
              resueltoEn: (f[ACC.resueltoEn] || '').toString(),
            })),
          ].map((a) => ({
            estado: a.estado,
            creado: a.creado,
            cerrado: a.estado !== 'pendiente',
            // Si no quedo registrada la hora, el caso no se mide; pero
            // resuelto sigue estando
            resuelto: a.estado !== 'pendiente' ? (a.resueltoEn || null) : null,
          }));

          // --- Solicitudes de prestamo: pedida -> resuelta -----------------
          const eventosPrestamos = delGrupo(solicitudes, SOL.group, gid).map((f) => {
            const estado = bajo(f[SOL.estado]) || 'pendiente';
            const id = (f[SOL.id] || '').toString().trim();
            return {
              estado,
              creado: (f[SOL.fecha] || '').toString(),
              cerrado: RESUELTAS.includes(estado),
              resuelto: RESUELTAS.includes(estado) ? (resueltaEn[id] || null) : null,
            };
          });

          // --- Comprobantes de pago: subido -> revisado --------------------
          const idsPrestamo = new Set(delGrupo(prestamos, LOAN.group, gid)
            .map((l) => (l[LOAN.id] || '').toString().trim()).filter(Boolean));
          const eventosPagos = pagos
            .filter((f) => idsPrestamo.has((f[PAGO.loan] || '').toString().trim()))
            .map((f) => {
              const estado = bajo(f[PAGO.estado]);
              return {
                estado,
                creado: (f[PAGO.creado] || f[PAGO.fecha] || '').toString(),
                cerrado: REVISADOS.includes(estado),
                resuelto: REVISADOS.includes(estado) ? ((f[PAGO.revisadoEn] || '').toString() || null) : null,
              };
            });

          // --- Asambleas: convocada -> celebrada ---------------------------
          const asaG = delGrupo(asambleas, ASA.group, gid);
          // Una asamblea convocada para dentro de una semana no es un atraso:
          // todavia no le toca. Solo cuenta como pendiente la que ya paso de
          // fecha y sigue sin celebrarse.
          const hoyIso = new Date().toISOString().slice(0, 10);
          const eventosAsambleas = asaG
            .filter((f) => !['cancelada'].includes(bajo(f[ASA.estado])))
            .filter((f) => {
              const estado = bajo(f[ASA.estado]);
              if (estado !== 'programada') return true;
              const cuando = (f[ASA.programada] || '').toString().slice(0, 10);
              return cuando && cuando < hoyIso;
            })
            .map((f) => {
              const estado = bajo(f[ASA.estado]);
              return {
                estado,
                creado: (f[ASA.creadaEn] || f[ASA.programada] || '').toString(),
                cerrado: ['abierta', 'cerrada'].includes(estado),
                resuelto: ['abierta', 'cerrada'].includes(estado)
                  ? ((f[ASA.abiertaEn] || '').toString() || null) : null,
              };
            });

          // --- Prestamos: al dia o con cuotas vencidas ---------------------
          const estadoPrestamos = delGrupo(prestamos, LOAN.group, gid)
            .filter((l) => !['rechazado', 'rejected', 'pagado', 'paid'].includes(bajo(l[LOAN.estado])))
            .map((l) => {
              const id = (l[LOAN.id] || '').toString().trim();
              const cuadro = cuadroDeCuotas(
                {
                  total: parseMoney(l[LOAN.total]) || parseMoney(l[LOAN.monto]),
                  term: Number(l[LOAN.plazo] || 0),
                  startDate: l[LOAN.inicio],
                },
                pagosDePrestamo[id] || [],
              );
              // Sin plazo o sin fecha de inicio no se puede juzgar: se deja fuera
              if (!cuadro.cuotas.length) return { alDia: null };
              return { alDia: cuadro.resumen.cuotasVencidas === 0 };
            })
            .filter((p) => p.alDia !== null);

          // --- Asistencia a las asambleas que se llegaron a celebrar -------
          const asisG = delGrupo(asistencias, ASIS.group, gid);
          const asambleasCelebradas = asaG
            .filter((a) => ['abierta', 'cerrada'].includes(bajo(a[ASA.estado])))
            .map((a) => {
              const id = (a[ASA.id] || '').toString().trim();
              const suyos = asisG.filter((x) => (x[ASIS.asamblea] || '').toString().trim() === id);
              return {
                id,
                presentes: suyos.filter((x) => bajo(x[ASIS.estado]) === 'presente').length,
                miembros: correos.length,
              };
            });
          const presentesEn = {};
          asambleasCelebradas.forEach((a) => { presentesEn[a.id] = a.presentes; });

          // --- Participacion en las votaciones -----------------------------
          // El recuento vive en la propia fila del acuerdo (a favor, en contra,
          // abstenciones); las papeletas sueltas son el respaldo. Se usa el
          // recuento, y si viene vacio se cuentan las papeletas.
          const votosG = delGrupo(acuerdos, ACU.group, gid).map((ac) => {
            const id = (ac[ACU.id] || '').toString().trim();
            const asambleaId = (ac[ACU.asamblea] || '').toString().trim();
            const recuento = (Number(ac[ACU.aFavor]) || 0)
              + (Number(ac[ACU.enContra]) || 0) + (Number(ac[ACU.abstenciones]) || 0);
            const papeletas = votos
              .filter((x) => (x[VOT.acuerdo] || '').toString().trim() === id).length;
            return {
              emitidos: Math.max(recuento, papeletas),
              presentes: presentesEn[asambleaId] || 0,
            };
          }).filter((x) => x.presentes > 0);

          // =============================================================
          //  Cuanto del funcionamiento del grupo vive ya en la app
          // =============================================================
          const fechasAportes = eventosAportes.map((a) => a.creado).filter(Boolean);
          const confirmadosPorOtro = [
            ...delGrupo(ahorros, SAV.group, gid).filter((r) => {
              const quienRegistro = normalizeEmailKey(r[7]);
              const quienResolvio = normalizeEmailKey(r[8]);
              return quienResolvio && quienResolvio !== quienRegistro;
            }).map((r) => (r[SAV.resueltoEn] || '').toString()),
            ...delGrupo(acciones, ACC.group, gid).filter((r) => {
              const quienRegistro = normalizeEmailKey(r[8]);
              const quienResolvio = normalizeEmailKey(r[9]);
              return quienResolvio && quienResolvio !== quienRegistro;
            }).map((r) => (r[ACC.resueltoEn] || '').toString()),
          ].filter(Boolean);

          const solResueltas = eventosPrestamos.filter((x) => x.cerrado);
          const pagosRevisados = eventosPagos.filter((x) => x.cerrado);
          const asambleasConGente = asambleasCelebradas.filter((a) => a.presentes > 0);
          const acuerdosVotados = delGrupo(acuerdos, ACU.group, gid).filter((ac) => {
            const votadas = (Number(ac[ACU.aFavor]) || 0) + (Number(ac[ACU.enContra]) || 0)
              + (Number(ac[ACU.abstenciones]) || 0);
            return votadas > 0;
          });
          const lotesG = delGrupo(lotes, LOTE.group, gid).map((l) => ({
            estado: bajo(l[LOTE.estado]),
            aplicadoEn: (l[LOTE.aplicadoEn] || '').toString(),
            totalAhorro: parseMoney(l[LOTE.ahorro]),
            totalAcciones: parseMoney(l[LOTE.acciones]),
            totalDeuda: parseMoney(l[LOTE.deuda]),
            miembros: Number(l[LOTE.miembros]) || 0,
          }));
          const cierresAplicados = delGrupo(cierres, CIERRE.group, gid)
            .filter((x) => bajo(x[CIERRE.estado]) === 'aplicado');

          const entradasDelGrupo = Object.values(susAccesos).flat();
          const laMitadEntro = correos.length > 0
            && Object.keys(susAccesos).length >= Math.ceil(correos.length / 2);

          const escalera = dig.escalera({
            existe: {
              logrado: true,
              fecha: (g[GRP.creado] || '').toString(),
              detalle: `${correos.length} integrantes`,
            },
            entraron: {
              logrado: laMitadEntro,
              fecha: dig.primeraFecha(entradasDelGrupo.map((a) => a.fecha)),
              cuenta: Object.keys(susAccesos).length,
              detalle: `${Object.keys(susAccesos).length} de ${correos.length} han entrado`,
            },
            aportes: {
              logrado: eventosAportes.length > 0,
              fecha: dig.primeraFecha(fechasAportes),
              cuenta: eventosAportes.length,
              detalle: `${eventosAportes.length} aportes registrados`,
            },
            confirmacion: {
              logrado: confirmadosPorOtro.length > 0,
              fecha: dig.primeraFecha(confirmadosPorOtro),
              cuenta: confirmadosPorOtro.length,
              detalle: `${confirmadosPorOtro.length} confirmados por alguien distinto de quien los registró`,
            },
            prestamos: {
              logrado: solResueltas.length > 0,
              fecha: dig.primeraFecha(solResueltas.map((x) => x.resuelto || x.creado)),
              cuenta: solResueltas.length,
              detalle: `${solResueltas.length} solicitudes resueltas aquí`,
            },
            comprobantes: {
              logrado: pagosRevisados.length > 0,
              fecha: dig.primeraFecha(pagosRevisados.map((x) => x.resuelto || x.creado)),
              cuenta: pagosRevisados.length,
              detalle: `${pagosRevisados.length} comprobantes revisados`,
            },
            asambleas: {
              logrado: asambleasConGente.length > 0,
              fecha: dig.primeraFecha(asaG.map((a) => (a[ASA.abiertaEn] || '').toString())),
              cuenta: asambleasConGente.length,
              detalle: `${asambleasConGente.length} asambleas con asistencia registrada`,
            },
            acuerdos: {
              logrado: acuerdosVotados.length > 0,
              fecha: dig.primeraFecha(acuerdosVotados.map((ac) => (ac[9] || '').toString())),
              cuenta: acuerdosVotados.length,
              detalle: `${acuerdosVotados.length} acuerdos con votos contados`,
            },
            reparto: {
              logrado: cierresAplicados.length > 0,
              fecha: dig.primeraFecha(cierresAplicados.map((x) => (x[CIERRE.aplicadoEn] || '').toString())),
              cuenta: cierresAplicados.length,
              detalle: `${cierresAplicados.length} repartos aplicados`,
            },
          });

          const traspasoG = dig.traspaso(lotesG, {
            tuvoActividadAntes: eventosAportes.length > 0,
          });

          const serie = dig.serieMensual([
            ...entradasDelGrupo.map((a) => ({ fecha: a.fecha, tipo: 'entradas' })),
            ...fechasAportes.map((f2) => ({ fecha: f2, tipo: 'aportes' })),
            ...eventosPrestamos.map((x) => ({ fecha: x.creado, tipo: 'prestamos' })),
            ...eventosPagos.map((x) => ({ fecha: x.creado, tipo: 'comprobantes' })),
            ...eventosAsambleas.map((x) => ({ fecha: x.creado, tipo: 'asambleas' })),
          ]);

          const ad = met.adopcion(suGente, susAccesos);
          const ti = met.tiemposDeRespuesta({
            aportes: eventosAportes,
            prestamos: eventosPrestamos,
            comprobantes: eventosPagos,
            asambleas: eventosAsambleas,
          });
          const sa = met.saludDelGrupo({
            aportes: eventosAportes,
            prestamos: estadoPrestamos,
            asambleas: asambleasCelebradas,
            votos: votosG,
          });

          return {
            groupId: gid,
            nombre: (g[GRP.nombre] || gid).toString(),
            creado: (g[GRP.creado] || '').toString(),
            integrantes: correos.length,
            adopcion: ad,
            tiempos: ti,
            salud: sa,
            nota: met.notaDelGrupo({ adopcion: ad, tiempos: ti, salud: sa }),
            digitalizacion: escalera,
            traspaso: traspasoG,
            serie,
            tendencia: dig.tendencia(serie),
          };
        })
        // Los que peor van, primero: son los que necesitan acompañamiento
        .sort((a, b) => {
          const na = a.nota && a.nota.nota;
          const nb = b.nota && b.nota.nota;
          if (na == null && nb == null) return a.nombre.localeCompare(b.nombre);
          if (na == null) return 1;
          if (nb == null) return -1;
          return na - nb;
        });

      // =====================================================================
      //  Toda la plataforma junta
      // =====================================================================
      const NOMBRES = ['confirmar un aporte', 'resolver un prestamo',
        'revisar un comprobante', 'celebrar una asamblea'];

      const plataforma = {
        grupos: salidaGrupos.length,
        adopcion: met.adopcion(personas, accesosPor),
        tiempos: {
          partes: NOMBRES.map((nombre) => {
            const trozos = salidaGrupos
              .flatMap((g) => (g.tiempos.partes || []).filter((p) => p.nombre === nombre));
            const conDato = trozos.filter((x) => x.horas.n > 0);
            return {
              nombre,
              total: trozos.reduce((s, x) => s + x.total, 0),
              resueltos: trozos.reduce((s, x) => s + x.resueltos, 0),
              pendientes: trozos.reduce((s, x) => s + x.pendientes, 0),
              gruposConDato: conDato.length,
              sinFecha: trozos.reduce((s, x) => s + (x.sinFecha || 0), 0),
              // Mediana de las medianas: cada grupo pesa lo mismo, aunque uno
              // tenga cien movimientos y otro tres
              horas: met.estadistica(conDato.map((x) => x.horas.mediana)),
            };
          }),
          pendientesTotales: salidaGrupos.reduce((s, g) => s + (g.tiempos.pendientesTotales || 0), 0),
        },
        salud: {
          aportes: salidaGrupos.reduce((s, g) => s + g.salud.aportes.total, 0),
          aportesPendientes: salidaGrupos.reduce((s, g) => s + g.salud.aportes.pendientes, 0),
          prestamosAlDia: salidaGrupos.reduce((s, g) => s + g.salud.prestamos.alDia, 0),
          prestamosAtrasados: salidaGrupos.reduce((s, g) => s + g.salud.prestamos.atrasados, 0),
          asambleasCelebradas: salidaGrupos.reduce((s, g) => s + g.salud.asambleas.celebradas, 0),
        },
        digitalizacion: {
          // Cuantos grupos han alcanzado cada hito: es la lectura de conjunto
          porHito: dig.HITOS.map((h) => {
            const cuantos = salidaGrupos
              .filter((g) => (g.digitalizacion.hitos || []).some((x) => x.clave === h.clave && x.logrado))
              .length;
            return {
              clave: h.clave,
              titulo: h.titulo,
              grupos: cuantos,
              pct: dig.pct(cuantos, salidaGrupos.length),
            };
          }),
          media: met.estadistica(salidaGrupos.map((g) => g.digitalizacion.pct)),
          conTraspaso: salidaGrupos.filter((g) => g.traspaso.hecho).length,
          // Lo que mas se atasca: el hito que mas grupos tienen como siguiente
          atasco: (() => {
            const cuenta = {};
            salidaGrupos.forEach((g) => {
              const sig = g.digitalizacion.siguiente;
              if (sig) cuenta[sig.clave] = (cuenta[sig.clave] || 0) + 1;
            });
            const top = Object.entries(cuenta).sort((a, b) => b[1] - a[1])[0];
            if (!top) return null;
            const h = dig.HITOS.find((x) => x.clave === top[0]);
            return { clave: top[0], titulo: h ? h.titulo : top[0], grupos: top[1] };
          })(),
        },
        serie: dig.serieMensual(salidaGrupos.flatMap((g) => (g.serie || [])
          .flatMap((m) => dig.TIPOS.flatMap((tipo) => Array.from({ length: m[tipo] || 0 },
            () => ({ fecha: `${m.mes}-15T12:00:00.000Z`, tipo })))))),
        notas: met.estadistica(salidaGrupos
          .map((g) => g.nota && g.nota.nota)
          .filter((n) => n !== null && n !== undefined)),
        gruposSinNota: salidaGrupos.filter((g) => !g.nota || g.nota.nota == null).length,
      };

      res.json({
        success: true,
        generado: new Date().toISOString(),
        grupos: salidaGrupos,
        plataforma,
      });
    } catch (error) {
      console.error('[ADMIN metricas]', error);
      res.status(500).json({ success: false, message: 'No se pudieron calcular los indicadores.' });
    }
  });
  // -------------------------------------------------------------------------
  // GET /api/admin/informe-proyecto
  //
  // El cuaderno de campo del proyecto, en un archivo. Hasta ahora estos datos
  // se VEIAN en la pantalla de Participantes pero no se podian descargar, asi
  // que para el informe de la UPSE habia que copiarlos a mano.
  //
  // Sale armado por hojas: el frontend solo las vuelca a Excel, no calcula
  // nada. Asi lo que se entrega es exactamente lo que se puede probar aqui.
  //
  // UNA sola lectura de la cuota para todo, igual que /api/admin/metricas: son
  // las mismas dieciseis pestanas en un unico batchGet.
  //
  // Lo que NO lleva: nada que no este en la hoja. Si una fecha falta, la celda
  // va vacia. Inventarla seria la unica forma de que el informe saliera
  // completo y falso.
  // -------------------------------------------------------------------------
  app.get('/api/admin/informe-proyecto', requireAdmin, async (req, res) => {
    try {
      const sheetsClient = await getSheetsClient();

      const [
        usuarios, grupos, vinculos, accesos, ahorros, acciones,
        prestamos, pagos, solicitudes, , asambleas, asistencias, acuerdos, votos, lotes, cierres,
      ] = await leerVarios(sheetsClient, [
        'Users!A2:I',
        'Groups!A2:R',
        'UserGroupLinks!A2:F',
        `${hojaAccesos}!A2:H`,
        'Savings!A2:L',
        'Acciones!A2:M',
        'Loans!A2:K',
        'LoanPayments!A2:O',
        'SolicitudesPrestamos!A2:J',
        'AprobacionesAsamblea!A2:H',
        'Asambleas!A2:N',
        'AsambleaAsistencia!A2:F',
        'Acuerdos!A2:O',
        'AcuerdoVotos!A2:G',
        'LotesApertura!A2:M',
        'CierresUtilidades!A2:Q',
      ]);

      const dinero = (v) => Math.round(parseMoney(v) * 100) / 100;
      const fecha = (v) => (v == null ? '' : v).toString().trim();
      const soloDia = (v) => fecha(v).slice(0, 10);
      const mesDe = (v) => fecha(v).slice(0, 7);
      // La celda vacia es 'confirmado': las filas historicas de produccion no
      // tienen columna de estado y sin esto el informe las dejaria fuera.
      const cuenta = (estado) => {
        const e = bajo(estado);
        return e === '' || e === 'confirmado';
      };

      // --- Personas -----------------------------------------------------
      const persona = {};
      for (const u of usuarios) {
        const email = normalizeEmailKey(u[USR.email]);
        if (!email) continue;
        persona[email] = {
          email,
          nombre: (u[USR.nombre] || '').toString(),
          rolPlataforma: bajo(u[USR.rol]) || 'user',
          alta: soloDia(u[USR.alta]),
          activa: bajo(u[USR.estado]) !== 'inactivo',
          grupos: [],
        };
      }

      // --- Entradas a la app --------------------------------------------
      const entradasDe = {};
      for (const fila of accesos) {
        const a = accesoDesdeFila(fila);
        if (!a || !a.email) continue;
        const e = normalizeEmailKey(a.email);
        (entradasDe[e] = entradasDe[e] || []).push(a);
      }
      const ordenadas = (e) => (entradasDe[e] || [])
        .slice()
        .sort((x, y) => new Date(x.fecha || 0) - new Date(y.fecha || 0));
      const masUsado = (e, campo) => {
        const c = {};
        (entradasDe[e] || []).forEach((a) => {
          const v = (a[campo] || '').toString().trim();
          if (v) c[v] = (c[v] || 0) + 1;
        });
        const top = Object.entries(c).sort((a, b) => b[1] - a[1])[0];
        return top ? top[0] : '';
      };

      // --- Vinculos persona-grupo ---------------------------------------
      const CARGOS = ['presidente', 'tesorero', 'secretario'];
      const miembrosDe = {};
      for (const v of vinculos) {
        const email = normalizeEmailKey(v[LINK.email]);
        const gid = normalizeGroupKey(v[LINK.group]);
        if (!email || !gid) continue;
        if (bajo(v[LINK.estado]) === 'inactivo') continue;
        const cargo = bajo(v[LINK.rol]) || 'socia';
        const reg = { email, gid, cargo, desde: soloDia(v[LINK.alta]) };
        (miembrosDe[gid] = miembrosDe[gid] || []).push(reg);
        if (persona[email]) persona[email].grupos.push(reg);
      }

      // --- Lo que hay en cada grupo -------------------------------------
      const porGrupo = (filas, idx) => {
        const m = {};
        for (const f of filas) {
          const gid = normalizeGroupKey(f[idx]);
          if (!gid) continue;
          (m[gid] = m[gid] || []).push(f);
        }
        return m;
      };
      const ahorroG = porGrupo(ahorros, SAV.group);
      const accionesG = porGrupo(acciones, ACC.group);
      const prestamosG = porGrupo(prestamos, LOAN.group);
      const solicitudesG = porGrupo(solicitudes, SOL.group);
      const asambleasG = porGrupo(asambleas, ASA.group);
      const acuerdosG = porGrupo(acuerdos, ACU.group);
      const lotesG = porGrupo(lotes, LOTE.group);
      const cierresG = porGrupo(cierres, CIERRE.group);

      const pagosDe = {};
      for (const p of pagos) {
        const id = (p[PAGO.loan] || '').toString().trim();
        if (!id) continue;
        (pagosDe[id] = pagosDe[id] || []).push(p);
      }

      // =================================================================
      // HOJA: Grupos
      // =================================================================
      const filasGrupos = [];
      const filasDirectiva = [];
      for (const g of grupos) {
        const gid = normalizeGroupKey(g[GRP.id]);
        if (!gid) continue;
        const miembros = miembrosDe[gid] || [];
        const nombreDe = (e) => (persona[e] ? persona[e].nombre : '');
        const quien = (cargo) => {
          const m = miembros.find((x) => x.cargo === cargo);
          return m ? { nombre: nombreDe(m.email), email: m.email, desde: m.desde } : null;
        };
        const presi = quien('presidente');
        const teso = quien('tesorero');
        const secre = quien('secretario');

        CARGOS.forEach((cargo) => {
          miembros.filter((m) => m.cargo === cargo).forEach((m) => {
            filasDirectiva.push({
              Grupo: (g[GRP.nombre] || '').toString(),
              GrupoID: gid,
              Cargo: cargo,
              Nombre: nombreDe(m.email),
              Correo: m.email,
              'En el cargo desde': m.desde,
              'Ha entrado a la app': (entradasDe[m.email] || []).length > 0 ? 'si' : 'no',
              Entradas: (entradasDe[m.email] || []).length,
            });
          });
        });

        const ahorroFilas = (ahorroG[gid] || []).filter((f) => cuenta(f[SAV.estado]));
        const accionesFilas = (accionesG[gid] || []).filter((f) => cuenta(f[ACC.estado]));
        const prestamosFilas = prestamosG[gid] || [];
        const vivos = prestamosFilas.filter((p) => {
          const total = dinero(p[LOAN.total]) || dinero(p[LOAN.monto]);
          const pagado = (pagosDe[(p[LOAN.id] || '').toString().trim()] || [])
            .filter((x) => bajo(x[PAGO.estado]) === 'approved')
            .reduce((s, x) => s + dinero(x[PAGO.monto]), 0);
          return total - pagado > 0.009;
        });
        const asambleasDelGrupo = asambleasG[gid] || [];
        const conEntrada = miembros.filter((m) => (entradasDe[m.email] || []).length > 0);
        const ultima = miembros
          .flatMap((m) => ordenadas(m.email).map((a) => a.fecha))
          .filter(Boolean)
          .sort()
          .pop() || '';

        filasGrupos.push({
          GrupoID: gid,
          Grupo: (g[GRP.nombre] || '').toString(),
          'Creado el': soloDia(g[GRP.creado]),
          Presidenta: presi ? presi.nombre : '',
          'Correo presidencia': presi ? presi.email : '',
          Tesoreria: teso ? teso.nombre : '',
          'Correo tesoreria': teso ? teso.email : '',
          Secretaria: secre ? secre.nombre : '',
          'Correo secretaria': secre ? secre.email : '',
          Integrantes: miembros.length,
          'Cargos cubiertos': [presi, teso, secre].filter(Boolean).length,
          'Han entrado': conEntrada.length,
          'Nunca han entrado': miembros.length - conEntrada.length,
          'Ahorro confirmado': dinero(ahorroFilas.reduce((s, f) => s + parseMoney(f[SAV.monto]), 0)),
          'Aportes registrados': ahorroFilas.length,
          'Acciones compradas': accionesFilas.reduce((s, f) => s + parseMoney(f[ACC.acciones]), 0),
          'Prestamos otorgados': prestamosFilas.length,
          'Prestamos sin terminar de pagar': vivos.length,
          'Solicitudes presentadas': (solicitudesG[gid] || []).length,
          'Asambleas convocadas': asambleasDelGrupo.length,
          'Asambleas cerradas': asambleasDelGrupo.filter((a) => bajo(a[ASA.estado]) === 'cerrada').length,
          'Puntos votados': (acuerdosG[gid] || []).length,
          'Lotes de apertura aplicados': (lotesG[gid] || []).filter((l) => bajo(l[LOTE.estado]) === 'aplicado').length,
          'Repartos de utilidades aplicados': (cierresG[gid] || []).filter((c) => bajo(c[CIERRE.estado]) === 'aplicado').length,
          'Ultima actividad en la app': ultima ? ultima.slice(0, 10) : '',
        });
      }

      // =================================================================
      // HOJA: Personas
      // =================================================================
      const filasPersonas = Object.values(persona).map((p) => {
        const ent = ordenadas(p.email);
        const nombreGrupo = (gid) => {
          const g = grupos.find((x) => normalizeGroupKey(x[GRP.id]) === gid);
          return g ? (g[GRP.nombre] || '').toString() : gid;
        };
        return {
          Nombre: p.nombre,
          Correo: p.email,
          'Rol en la plataforma': p.rolPlataforma,
          Estado: p.activa ? 'activa' : 'inactiva',
          'Se registro el': p.alta,
          'Grupos a los que pertenece': p.grupos.map((x) => nombreGrupo(x.gid)).join(' | '),
          'Cargo que ocupa': p.grupos.map((x) => x.cargo).filter((c) => CARGOS.includes(c)).join(' | '),
          'Ha entrado a la app': ent.length > 0 ? 'si' : 'no',
          'Veces que ha entrado': ent.length,
          'Primera entrada': ent.length ? fecha(ent[0].fecha).slice(0, 10) : '',
          'Ultima entrada': ent.length ? fecha(ent[ent.length - 1].fecha).slice(0, 10) : '',
          'Aparato mas usado': masUsado(p.email, 'dispositivo'),
          Sistema: masUsado(p.email, 'sistema'),
          Navegador: masUsado(p.email, 'navegador'),
        };
      });

      // =================================================================
      // HOJA: Uso de la plataforma (con que entran)
      // =================================================================
      const todos = Object.values(entradasDe).flat();
      const reparto = (campo) => {
        const c = {};
        todos.forEach((a) => {
          const v = (a[campo] || '').toString().trim();
          if (v) c[v] = (c[v] || 0) + 1;
        });
        const total = Object.values(c).reduce((s, n) => s + n, 0);
        return Object.entries(c)
          .sort((a, b) => b[1] - a[1])
          .map(([valor, veces]) => ({
            Categoria: campo,
            Valor: valor,
            Entradas: veces,
            'Porcentaje de las entradas': total ? Math.round((veces / total) * 1000) / 10 : 0,
          }));
      };
      const filasUso = [...reparto('dispositivo'), ...reparto('sistema'), ...reparto('navegador')];

      // =================================================================
      // HOJA: Actividad por mes
      // =================================================================
      const meses = {};
      const anota = (valor, campo) => {
        const m = mesDe(valor);
        if (!/^\d{4}-\d{2}$/.test(m)) return;
        meses[m] = meses[m] || {
          Mes: m, Entradas: 0, 'Aportes registrados': 0, 'Acciones compradas': 0,
          'Prestamos otorgados': 0, 'Pagos aprobados': 0, 'Asambleas convocadas': 0,
          'Puntos votados': 0,
        };
        meses[m][campo] += 1;
      };
      todos.forEach((a) => anota(a.fecha, 'Entradas'));
      ahorros.forEach((f) => anota(f[SAV.fecha], 'Aportes registrados'));
      acciones.forEach((f) => anota(f[ACC.fecha], 'Acciones compradas'));
      prestamos.forEach((f) => anota(f[LOAN.inicio], 'Prestamos otorgados'));
      pagos.filter((p) => bajo(p[PAGO.estado]) === 'approved')
        .forEach((f) => anota(f[PAGO.fecha], 'Pagos aprobados'));
      asambleas.forEach((f) => anota(f[ASA.programada] || f[ASA.creadaEn], 'Asambleas convocadas'));
      acuerdos.forEach((f) => {
        const a = asambleas.find((x) => (x[ASA.id] || '') === (f[ACU.asamblea] || ''));
        anota(a ? (a[ASA.programada] || a[ASA.creadaEn]) : '', 'Puntos votados');
      });
      const filasMeses = Object.values(meses).sort((a, b) => a.Mes.localeCompare(b.Mes));

      // =================================================================
      // HOJA: Resumen
      // =================================================================
      const totalPersonas = Object.keys(persona).length;
      const sinGrupo = Object.values(persona).filter((p) => p.grupos.length === 0).length;
      const handEntrado = Object.values(persona).filter((p) => (entradasDe[p.email] || []).length > 0).length;
      const filasResumen = [
        { Concepto: 'Fecha del informe', Valor: new Date().toISOString().slice(0, 10) },
        { Concepto: 'Grupos registrados', Valor: filasGrupos.length },
        { Concepto: 'Personas con cuenta', Valor: totalPersonas },
        { Concepto: 'Personas con cuenta y sin grupo', Valor: sinGrupo },
        { Concepto: 'Personas que han entrado alguna vez', Valor: handEntrado },
        { Concepto: 'Personas que nunca han entrado', Valor: totalPersonas - handEntrado },
        { Concepto: 'Entradas registradas', Valor: todos.length },
        { Concepto: 'Cargos de directiva cubiertos', Valor: filasDirectiva.length },
        {
          Concepto: 'Grupos con la directiva completa',
          Valor: filasGrupos.filter((g) => g['Cargos cubiertos'] === 3).length,
        },
        {
          Concepto: 'Ahorro confirmado en todos los grupos',
          Valor: Math.round(filasGrupos.reduce((s, g) => s + g['Ahorro confirmado'], 0) * 100) / 100,
        },
        {
          Concepto: 'Prestamos otorgados en total',
          Valor: filasGrupos.reduce((s, g) => s + g['Prestamos otorgados'], 0),
        },
        {
          Concepto: 'Asambleas convocadas en total',
          Valor: filasGrupos.reduce((s, g) => s + g['Asambleas convocadas'], 0),
        },
      ];

      res.json({
        success: true,
        generado: new Date().toISOString(),
        archivo: `JuntaGO-informe-${new Date().toISOString().slice(0, 10)}`,
        hojas: [
          { nombre: 'Resumen', filas: filasResumen },
          { nombre: 'Grupos', filas: filasGrupos },
          { nombre: 'Directiva', filas: filasDirectiva },
          { nombre: 'Personas', filas: filasPersonas },
          { nombre: 'Uso de la plataforma', filas: filasUso },
          { nombre: 'Actividad por mes', filas: filasMeses },
        ],
      });
    } catch (error) {
      console.error('[ADMIN informe-proyecto]', error);
      res.status(500).json({ success: false, message: 'No se pudo armar el informe del proyecto.' });
    }
  });
};
