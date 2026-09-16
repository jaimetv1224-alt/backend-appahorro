/**
 * DATOS DE DEMOSTRACION  ->  POST /api/admin/demo/sembrar  y  /api/admin/demo/limpiar
 *
 * Los grupos de Salinas estan cargados con sus 152 socias reales, pero la
 * plataforma se ve muerta: cero aportes, cero prestamos, y asi no hay forma de
 * ensenarle a una directiva como funciona su caja. Esto llena los grupos con
 * un anio de movimiento verosimil para que se vea andando.
 *
 * TRES REGLAS QUE HACEN QUE ESTO NO SEA PELIGROSO:
 *
 *  1. TODO LO QUE ESCRIBE VA MARCADO. El identificador de cada fila empieza por
 *     `demo_` y la descripcion lleva "[demo]" a la vista. Nada de lo sembrado
 *     se puede confundir con un aporte de verdad, ni en la hoja ni en el
 *     informe del proyecto, y `limpiar` lo borra todo de una pasada.
 *
 *  2. NO TOCA UN GRUPO QUE YA TENGA MOVIMIENTO DE VERDAD. Si en un grupo hay
 *     un solo aporte, una accion o un prestamo que no lleve la marca, ese grupo
 *     se salta y se dice por que. Sembrar encima del dinero real de un banco
 *     comunal seria imperdonable.
 *
 *  3. LA DIRECTIVA SOLO SE RELLENA SI ESTA VACIA. Igual que en la importacion:
 *     nunca releva a quien ya ocupa un cargo.
 *
 * El azar es reproducible: sale del identificador del grupo, asi que cada grupo
 * tiene su propio patron y dos ejecuciones dan lo mismo.
 */

'use strict';

const MARCA = '[demo]';
const PREFIJO = 'demo_';
const CARGOS = ['presidente', 'tesorero', 'secretario'];

// Donde esta cada cosa en cada hoja.
const GRP = { id: 0, nombre: 1, aporte: 8, inicio: 9, estado: 11, valorAccion: 15, interes: 16 };
const LINK = { email: 0, group: 1, alta: 2, rol: 3, estado: 4 };
const SAV = { email: 0, group: 1, monto: 2, fecha: 3, desc: 5, estado: 6, id: 10 };
const ACC = { email: 0, group: 1, fecha: 2, cantidad: 3, valor: 4, estado: 7, id: 11, nota: 12 };
const LOAN = { id: 0, email: 1, group: 2, monto: 3, inicio: 4, vence: 5, tasa: 6, estado: 7 };
// SolicitudesPrestamos: ID, UserEmail, Group, GroupRole, Monto, Estado, Fecha,
// Detalles, AprobadoPor, TasaInteres. El ID es el MISMO que el del prestamo.
const SOL = { id: 0, email: 1, group: 2, monto: 4, estado: 5, fecha: 6 };

const letraDeColumna = (n) => {
  let s = '';
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
};

/** Azar reproducible a partir de un texto. */
const azarDe = (semilla) => {
  let s = 0;
  for (const c of String(semilla)) s = ((s * 31) + c.charCodeAt(0)) >>> 0;
  return () => {
    s = ((s * 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
};

const dosDigitos = (n) => (n < 10 ? `0${n}` : `${n}`);

/** Los meses desde una fecha de arranque hasta hoy, como {anio, mes}. */
const mesesHasta = (anioIni, mesIni, hoy) => {
  const out = [];
  let a = anioIni;
  let m = mesIni;
  while (a < hoy.getFullYear() || (a === hoy.getFullYear() && m <= hoy.getMonth() + 1)) {
    out.push({ a, m });
    m += 1;
    if (m > 12) { m = 1; a += 1; }
  }
  return out;
};

const esDeDemo = (valor) => (valor || '').toString().trim().toLowerCase().startsWith(PREFIJO);

/** Una fecha 'YYYY-MM-DD' mas N dias (y unas horas), como instante ISO. */
const masDias = (ymd, dias, hora = 10) => {
  const [a, m, d] = String(ymd).split('-').map(Number);
  return new Date(Date.UTC(a, m - 1, d + dias, hora, 0, 0)).toISOString();
};
const soloFecha = (iso) => String(iso).slice(0, 10);

module.exports.register = function register(app, ctx) {
  const {
    getSheetsClient, SPREADSHEET_ID, normalizeEmailKey, normalizeGroupKey,
    normalizeGroupRole, requireAdmin, bloquear, responderSiEsCuota, linkIsActive,
    ensureSheetExists, cabeceraDePagos, hojaAccesos, cabeceraAccesos,
  } = ctx;

  // TODO EL BACKEND LEE DESDE LA FILA 2. Una pestana recien creada por un
  // append no tiene cabecera, asi que su PRIMERA fila de datos queda invisible
  // para todos: el informe la salta, el panel no la cuenta, y nadie se entera.
  // Paso de verdad aqui: un prestamo aparecia con un solo voto de la directiva
  // porque el primero se habia perdido por este agujero.
  const G = require('./governance').SHEETS;
  const CABECERAS = {
    SolicitudesPrestamos: ['ID', 'UserEmail', 'Group', 'GroupRole', 'Monto', 'Estado',
      'Fecha', 'Detalles', 'AprobadoPor', 'TasaInteres'],
    AprobacionesAsamblea: ['SolicitudID', 'Tipo', 'GrupoID', 'AprobadoPor', 'RolAprobador',
      'Decision', 'Fecha', 'Comentario'],
    LoanPayments: cabeceraDePagos,
    [hojaAccesos]: cabeceraAccesos,
    [G.asambleas.name]: G.asambleas.headers,
    [G.asistencia.name]: G.asistencia.headers,
    [G.acuerdos.name]: G.acuerdos.headers,
    [G.votos.name]: G.votos.headers,
  };

  /** Deja la pestana con su cabecera antes de anadirle nada. */
  async function asegurar(sheetsClient, nombre) {
    const cab = CABECERAS[nombre];
    if (!cab || typeof ensureSheetExists !== 'function') return;
    try {
      await ensureSheetExists(nombre, cab, sheetsClient, SPREADSHEET_ID);
    } catch (e) {
      console.error('[DEMO] no se pudo asegurar la cabecera de', nombre, e.message);
    }
  }

  /** Lee un rango; si la pestana no existe devuelve vacio en vez de reventar. */
  async function leer(sheetsClient, rango) {
    try {
      const r = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID, range: rango,
      });
      return r.data.values || [];
    } catch (e) {
      if (/Unable to parse range/i.test(e && e.message)) return [];
      throw e;
    }
  }

  // =========================================================================
  app.post('/api/admin/demo/sembrar', requireAdmin, bloquear(() => 'hoja:demo'), async (req, res) => {
    const valorAccion = Number(req.body?.valorAccion) > 0 ? Number(req.body.valorAccion) : 15;
    const interesMensual = Number(req.body?.interesMensual) > 0 ? Number(req.body.interesMensual) : 2;
    const aporteBase = Number(req.body?.aporteMensual) > 0 ? Number(req.body.aporteMensual) : 20;
    const soloEstos = (req.body?.grupos || []).map((g) => normalizeGroupKey(g)).filter(Boolean);

    try {
      const sheetsClient = await getSheetsClient();

      // --- una lectura de cada cosa, y a trabajar en memoria ---------------
      const [grupos, vinculos, ahorros, acciones, prestamos] = await Promise.all([
        leer(sheetsClient, 'Groups!A2:Q'),
        leer(sheetsClient, 'UserGroupLinks!A2:F'),
        leer(sheetsClient, 'Savings!A2:L'),
        leer(sheetsClient, 'Acciones!A2:M'),
        leer(sheetsClient, 'Loans!A2:J'),
      ]);

      // Movimiento REAL (sin marca) por grupo: es el freno de seguridad.
      const conDineroReal = new Set();
      const yaSembrado = new Set();
      const clasificar = (fila, colId, colGrupo) => {
        const gid = normalizeGroupKey(fila[colGrupo]);
        if (!gid) return;
        (esDeDemo(fila[colId]) ? yaSembrado : conDineroReal).add(gid);
      };
      ahorros.forEach((f) => clasificar(f, SAV.id, SAV.group));
      acciones.forEach((f) => clasificar(f, ACC.id, ACC.group));
      prestamos.forEach((f) => clasificar(f, LOAN.id, LOAN.group));

      // Grupos donde alguien YA compro acciones. Ahi el valor de la accion no
      // se toca: cambiarlo reescribiria el patrimonio de gente real.
      const conAcciones = new Set();
      acciones.forEach((f) => {
        const gid = normalizeGroupKey(f[ACC.group]);
        if (gid && Number(f[ACC.cantidad]) > 0) conAcciones.add(gid);
      });

      // Socias y cargos por grupo.
      const porGrupo = new Map();
      vinculos.forEach((f, i) => {
        const gid = normalizeGroupKey(f[LINK.group]);
        if (!gid || !linkIsActive(f)) return;
        if (!porGrupo.has(gid)) porGrupo.set(gid, { socias: [], cargos: new Map() });
        const rol = normalizeGroupRole(f[LINK.rol]);
        porGrupo.get(gid).socias.push({ email: normalizeEmailKey(f[LINK.email]), fila: i + 2, rol });
        if (CARGOS.includes(rol)) porGrupo.get(gid).cargos.set(rol, normalizeEmailKey(f[LINK.email]));
      });

      const hoy = new Date();
      const filasAhorro = [];
      const filasAcciones = [];
      const filasPrestamos = [];
      // Un prestamo de verdad NACE de una solicitud aprobada, y el panel cuenta
      // los prestamos leyendo esa hoja, no Loans. Sembrar solo el prestamo
      // dejaba el tablero marcando $0 con 27 creditos vivos.
      const filasSolicitudes = [];
      const filasAprobaciones = [];   // AprobacionesAsamblea: da la hora de la decision
      const filasPagos = [];          // LoanPayments
      const filasAccesos = [];        // Accesos: quien entro, cuando y desde que aparato
      const filasAsambleas = [];
      const filasAsistencia = [];
      const filasAcuerdos = [];
      const filasVotos = [];
      const cambiosGrupo = [];
      const cambiosRol = [];
      const informe = [];
      const saltados = [];

      let orden = 0;
      for (const g of grupos) {
        const gid = normalizeGroupKey(g[GRP.id]);
        if (!gid) continue;
        if (soloEstos.length && !soloEstos.includes(gid)) continue;

        const datos = porGrupo.get(gid);
        if (!datos || datos.socias.length === 0) {
          saltados.push({ grupo: g[GRP.nombre] || gid, motivo: 'no tiene socias' });
          continue;
        }
        const azar = azarDe(gid);
        const filaGrupo = grupos.indexOf(g) + 2;

        // ---- EL REGLAMENTO SE PUEDE PONER SIEMPRE -------------------------
        // Configurar no es sembrar dinero. Un grupo sin valor de accion ni
        // interes no puede operar aunque tenga socias, asi que esto se aplica
        // tambien a los grupos que ya llevan movimiento de verdad. Con dos
        // salvedades: el valor de la accion NO se toca si alguien ya compro
        // acciones (le cambiaria el patrimonio), y ni el interes ni el aporte
        // pisan un valor que el grupo ya haya decidido.
        const reglamento = [];
        if (!conAcciones.has(gid) && Number(g[GRP.valorAccion]) !== valorAccion) {
          cambiosGrupo.push({ fila: filaGrupo, col: GRP.valorAccion, valor: valorAccion });
          reglamento.push(`accion $${valorAccion}`);
        }
        if (!Number(g[GRP.interes])) {
          cambiosGrupo.push({ fila: filaGrupo, col: GRP.interes, valor: interesMensual });
          reglamento.push(`interes ${interesMensual}%`);
        }
        if (!Number(g[GRP.aporte])) {
          cambiosGrupo.push({ fila: filaGrupo, col: GRP.aporte, valor: aporteBase });
          reglamento.push(`aporte $${aporteBase}`);
        }

        // ---- LA DIRECTIVA VACIA TAMBIEN ----------------------------------
        const cargosAsignados = [];
        for (const cargo of CARGOS) {
          if (datos.cargos.has(cargo)) continue;
          const libre = datos.socias.find((x) => x.rol === 'member'
            && !cargosAsignados.some((c) => c.email === x.email));
          if (!libre) break;
          cambiosRol.push({ fila: libre.fila, rol: cargo });
          cargosAsignados.push({ cargo, email: libre.email });
          datos.cargos.set(cargo, libre.email);
          libre.rol = cargo;
        }

        // ---- EL DINERO, SOLO SI EL GRUPO ESTA VIRGEN ----------------------
        if (conDineroReal.has(gid)) {
          saltados.push({
            grupo: g[GRP.nombre] || gid,
            motivo: 'ya tiene movimiento de verdad: no se le siembra nada',
            reglamento, cargosAsignados: cargosAsignados.map((c) => `${c.cargo}: ${c.email}`),
          });
          continue;
        }
        if (yaSembrado.has(gid)) {
          saltados.push({
            grupo: g[GRP.nombre] || gid,
            motivo: 'ya tiene la demostracion sembrada',
            reglamento, cargosAsignados: cargosAsignados.map((c) => `${c.cargo}: ${c.email}`),
          });
          continue;
        }

        orden += 1;

        // Cada grupo arranca en un mes distinto: enero, marzo, abril...
        const tope = Math.max(1, Math.min(6, hoy.getMonth() + 1));
        const mesesPosibles = [1, 2, 3, 4, 5, 6].filter((m) => m <= tope);
        const mesIni = mesesPosibles[Math.floor(azar() * mesesPosibles.length)];
        const anioIni = hoy.getFullYear();
        const meses = mesesHasta(anioIni, mesIni, hoy);

        // La fecha de arranque solo se pone al sembrar: en un grupo que ya
        // opera de verdad seria reescribir cuando empezo.
        cambiosGrupo.push({
          fila: filaGrupo, col: GRP.inicio, valor: `${anioIni}-${dosDigitos(mesIni)}-01`,
        });

        // --- aportes mes a mes -------------------------------------------
        let nAportes = 0;
        const ahorroDe = new Map();
        datos.socias.forEach((s, idx) => {
          const cuota = [15, 20, 20, 25, 30][Math.floor(azar() * 5)];
          meses.forEach(({ a, m }) => {
            if (azar() < 0.08) return;            // ese mes no aporto
            const dia = 3 + Math.floor(azar() * 20);
            const id = `${PREFIJO}sav_${gid.slice(0, 6)}_${idx}_${a}${dosDigitos(m)}`;
            const cuando = `${a}-${dosDigitos(m)}-${dosDigitos(dia)}`;
            // La tesoreria confirma al dia siguiente o a los dos dias. Poner
            // aqui la hora de AHORA daba medianas de noventa dias y el informe
            // concluia que la app tardaba mas que el cuaderno de papel.
            filasAhorro.push([
              s.email, gid, cuota, cuando, 'mensual',
              `Aporte mensual ${MARCA}`, 'confirmado', s.email,
              datos.cargos.get('tesorero') || s.email,
              masDias(cuando, 1 + Math.floor(azar() * 2), 9 + Math.floor(azar() * 8)), id, '',
            ]);
            ahorroDe.set(s.email, (ahorroDe.get(s.email) || 0) + cuota);
            nAportes += 1;
          });
        });

        // --- compra de acciones -------------------------------------------
        let nAcciones = 0;
        datos.socias.forEach((s, idx) => {
          if (azar() > 0.4) return;
          const cuantas = 1 + Math.floor(azar() * 4);
          const { a, m } = meses[Math.floor(azar() * meses.length)];
          const id = `${PREFIJO}acc_${gid.slice(0, 6)}_${idx}`;
          const cuandoAcc = `${a}-${dosDigitos(m)}-10`;
          filasAcciones.push([
            s.email, gid, cuandoAcc, cuantas, valorAccion, interesMensual,
            masDias(cuandoAcc, 0), 'confirmado', s.email,
            datos.cargos.get('tesorero') || s.email, masDias(cuandoAcc, 1), id,
            `Compra de acciones ${MARCA}`,
          ]);
          nAcciones += 1;
        });

        // --- uno o dos prestamos vivos ------------------------------------
        let nPrestamos = 0;
        // El reglamento pide dos de tres firmas de la directiva para aprobar un
        // credito. Un grupo que no las tiene no puede aprobar nada, asi que
        // tampoco se le siembran prestamos: saldrian con un solo voto.
        const firmantes = CARGOS
          .map((c) => ({ cargo: c, email: datos.cargos.get(c) }))
          .filter((x) => x.email);
        const candidatas = firmantes.length < 2 ? [] : datos.socias
          .filter((s) => (ahorroDe.get(s.email) || 0) >= 60)
          .slice(0, 2 + Math.floor(azar() * 2));
        candidatas.forEach((s, idx) => {
          const principal = 50 * (1 + Math.floor(azar() * 6));      // 50..300
          const plazo = 3 + Math.floor(azar() * 4);                  // 3..6 meses
          const total = Math.round(principal * (1 + (interesMensual / 100) * plazo) * 100) / 100;
          const { a, m } = meses[Math.min(meses.length - 1, 1 + Math.floor(azar() * Math.max(1, meses.length - 2)))];
          const vence = new Date(Date.UTC(a, (m - 1) + plazo, 10)).toISOString().slice(0, 10);
          const idPrestamo = `${PREFIJO}loan_${gid.slice(0, 6)}_${idx}`;
          const fechaPrestamo = `${a}-${dosDigitos(m)}-10`;
          filasPrestamos.push([
            idPrestamo, s.email, gid, principal,
            fechaPrestamo, vence, interesMensual, 'aprobado', plazo, total,
          ]);
          filasSolicitudes.push([
            idPrestamo, s.email, gid, 'member', principal, 'aprobado', fechaPrestamo,
            `Prestamo a ${plazo} meses ${MARCA}`,
            datos.cargos.get('presidente') || s.email, interesMensual,
          ]);
          // La hoja de solicitudes no guarda cuando se decidio: esa hora vive
          // en el voto de la directiva, y sin ella el informe no puede medir
          // cuanto se tarda en resolver un prestamo.
          const decidido = 1 + Math.floor(azar() * 3);
          const cuantasFirmas = Math.min(firmantes.length, 2 + Math.floor(azar() * 2));
          firmantes.slice(0, cuantasFirmas).forEach((f) => {
            filasAprobaciones.push([
              idPrestamo, 'prestamo', gid, f.email, f.cargo, 'aprobado',
              masDias(fechaPrestamo, decidido, 18), `Aprobado en asamblea ${MARCA}`,
            ]);
          });

          // Cuotas ya pagadas, con su comprobante revisado.
          const cuotasPagadas = Math.min(plazo - 1, 1 + Math.floor(azar() * 3));
          const cuota = Math.round((total / plazo) * 100) / 100;
          for (let k = 1; k <= cuotasPagadas; k += 1) {
            const fPago = soloFecha(masDias(fechaPrestamo, 30 * k));
            filasPagos.push([
              `${PREFIJO}pay_${gid.slice(0, 6)}_${idx}_${k}`, s.email, idPrestamo, cuota, fPago,
              `Cuota ${k} de ${plazo} ${MARCA}`, 'approved', '', '', '', '',
              masDias(fPago, 0, 9), datos.cargos.get('tesorero') || s.email,
              masDias(fPago, 1, 11), `Revisado ${MARCA}`,
            ]);
          }
          nPrestamos += 1;
        });

        // --- quien entro a la app, cuando y desde donde -------------------
        // Sin esto el informe decia "0 de 19 grupos han entrado" y el embudo de
        // adopcion, que es el indicador central del proyecto, salia vacio.
        const APARATOS = [['movil', 'Android', 'Chrome'], ['movil', 'Android', 'Chrome'],
          ['movil', 'iOS', 'Safari'], ['escritorio', 'Windows 10/11', 'Chrome']];
        let nEntradas = 0;
        let nQueEntraron = 0;
        datos.socias.forEach((s, idx) => {
          if (azar() > 0.72) return;                    // no todas llegan a entrar
          nQueEntraron += 1;
          const aparato = APARATOS[Math.floor(azar() * APARATOS.length)];
          const primera = 2 + Math.floor(azar() * 25);  // dias desde que arranco el grupo
          const cuantas = 1 + Math.floor(azar() * 14);
          const constante = azar() < 0.55;              // si sigue entrando hasta hoy
          const diasDeVida = Math.round((hoy - new Date(`${anioIni}-${dosDigitos(mesIni)}-01T00:00:00Z`)) / 86400000);
          const ventana = constante ? diasDeVida : Math.round(diasDeVida * (0.3 + azar() * 0.4));
          for (let k = 0; k < cuantas; k += 1) {
            const dia = Math.min(diasDeVida - 1, primera + Math.floor((ventana - primera) * (k / Math.max(1, cuantas - 1))));
            if (dia < 0) continue;
            filasAccesos.push([
              masDias(`${anioIni}-${dosDigitos(mesIni)}-01`, dia, 7 + Math.floor(azar() * 13)),
              s.email, aparato[0], aparato[1], aparato[2], '190.0.0.1',
              `${aparato[2]} ${MARCA}`, 'demo',
            ]);
            nEntradas += 1;
          }
        });

        // --- una asamblea cerrada, con su asistencia y su acuerdo votado ---
        const presi = datos.cargos.get('presidente');
        let nAsambleas = 0;
        if (presi && meses.length >= 2) {
          const { a: aA, m: mA } = meses[Math.max(0, meses.length - 2)];
          const fAsa = `${aA}-${dosDigitos(mA)}-15`;
          const idAsa = `${PREFIJO}asa_${gid.slice(0, 6)}`;
          filasAsambleas.push([
            idAsa, gid, `Asamblea mensual ${MARCA}`, fAsa, 'presencial', 'cerrada',
            'Aportes, prestamos y utilidades', presi, masDias(fAsa, -7),
            masDias(fAsa, 0, 18), masDias(fAsa, 0, 20), presi, '', MARCA,
          ]);
          let asistentes = 0;
          datos.socias.forEach((s) => {
            const vino = azar() < 0.78;
            if (vino) asistentes += 1;
            filasAsistencia.push([
              idAsa, gid, s.email, vino ? 'presente' : 'ausente', presi, masDias(fAsa, 0, 18),
            ]);
          });
          const idAcu = `${PREFIJO}acu_${gid.slice(0, 6)}`;
          const aFavor = Math.max(1, Math.round(asistentes * 0.85));
          filasAcuerdos.push([
            idAcu, idAsa, gid, 'cambio_reglas', `Confirmar el reglamento del ciclo ${MARCA}`,
            `Valor de la accion en $${valorAccion} e interes del ${interesMensual}% mensual`,
            '{}', 'aprobado', presi, masDias(fAsa, -2), masDias(fAsa, 0, 19), masDias(fAsa, 0, 19),
            aFavor, Math.max(0, asistentes - aFavor), 0,
          ]);
          datos.socias.slice(0, asistentes).forEach((s) => {
            filasVotos.push([
              idAcu, idAsa, gid, s.email, azar() < 0.85 ? 'a_favor' : 'en_contra',
              masDias(fAsa, 0, 19), normalizeGroupRole(s.rol),
            ]);
          });
          nAsambleas = 1;
        }

        informe.push({
          grupo: g[GRP.nombre] || gid,
          desdeElMes: `${anioIni}-${dosDigitos(mesIni)}`,
          socias: datos.socias.length,
          aportes: nAportes,
          compras: nAcciones,
          prestamos: nPrestamos,
          entraronALaApp: `${nQueEntraron} de ${datos.socias.length}`,
          entradas: nEntradas,
          asambleas: nAsambleas,
          cargosAsignados: cargosAsignados.map((c) => `${c.cargo}: ${c.email}`),
        });
      }

      // --- a escribir, una vez cada cosa ---------------------------------
      for (const c of cambiosGrupo) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `Groups!${letraDeColumna(c.col + 1)}${c.fila}`,
          valueInputOption: 'RAW',
          resource: { values: [[c.valor]] },
        });
      }
      for (const c of cambiosRol) {
        await sheetsClient.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `UserGroupLinks!D${c.fila}`,
          valueInputOption: 'RAW',
          resource: { values: [[c.rol]] },
        });
      }
      const anexar = async (rango, filas) => {
        if (!filas.length) return;
        await asegurar(sheetsClient, rango.split('!')[0]);
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID, range: rango,
          valueInputOption: 'RAW', resource: { values: filas },
        });
      };
      await anexar('Savings!A:L', filasAhorro);
      await anexar('Acciones!A:M', filasAcciones);
      await anexar('Loans!A:J', filasPrestamos);
      await anexar('SolicitudesPrestamos!A:J', filasSolicitudes);
      await anexar('AprobacionesAsamblea!A:H', filasAprobaciones);
      await anexar('LoanPayments!A:O', filasPagos);
      await anexar('Accesos!A:H', filasAccesos);
      await anexar('Asambleas!A:N', filasAsambleas);
      await anexar('AsambleaAsistencia!A:F', filasAsistencia);
      await anexar('Acuerdos!A:O', filasAcuerdos);
      await anexar('AcuerdoVotos!A:G', filasVotos);

      return res.json({
        success: true,
        message: `Sembrados ${filasAhorro.length} aportes, ${filasAcciones.length} compras de acciones `
               + `y ${filasPrestamos.length} prestamos (con su solicitud aprobada) en ${informe.length} grupo(s). `
               + 'Todo va marcado como demostracion y se borra con /api/admin/demo/limpiar.',
        marca: MARCA,
        totales: {
          grupos: informe.length,
          aportes: filasAhorro.length,
          compras: filasAcciones.length,
          prestamos: filasPrestamos.length,
          pagosDeCuota: filasPagos.length,
          entradasALaApp: filasAccesos.length,
          asambleas: filasAsambleas.length,
          votos: filasVotos.length,
        },
        grupos: informe,
        saltados,
      });
    } catch (error) {
      console.error('[DEMO SEMBRAR]', error.message);
      if (responderSiEsCuota(res, error)) return;
      return res.status(500).json({ success: false, message: 'Error al sembrar la demostracion.', error: error.message });
    }
  });

  // =========================================================================
  app.post('/api/admin/demo/limpiar', requireAdmin, bloquear(() => 'hoja:demo'), async (req, res) => {
    try {
      const sheetsClient = await getSheetsClient();
      const libro = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
      const idDeHoja = (nombre) => {
        const h = (libro.data.sheets || []).find((s) => s.properties.title === nombre);
        return h ? h.properties.sheetId : null;
      };

      const borrados = {};
      for (const [nombre, rango, colId] of [
        ['Savings', 'Savings!A2:L', SAV.id],
        ['Acciones', 'Acciones!A2:M', ACC.id],
        ['Loans', 'Loans!A2:J', LOAN.id],
        ['SolicitudesPrestamos', 'SolicitudesPrestamos!A2:J', SOL.id],
        ['AprobacionesAsamblea', 'AprobacionesAsamblea!A2:H', 0],
        ['LoanPayments', 'LoanPayments!A2:O', 0],
        ['Asambleas', 'Asambleas!A2:N', 0],
        ['AsambleaAsistencia', 'AsambleaAsistencia!A2:F', 0],
        ['Acuerdos', 'Acuerdos!A2:O', 0],
        ['AcuerdoVotos', 'AcuerdoVotos!A2:G', 0],
        // La hoja de accesos no tiene identificador: la marca va en Origen.
        ['Accesos', 'Accesos!A2:H', 7],
      ]) {
        const filas = await leer(sheetsClient, rango);
        // De abajo arriba: si se borra de arriba abajo, cada borrado corre las
        // filas de debajo y el siguiente indice apunta a otra persona.
        const aBorrar = [];
        const esMio = nombre === 'Accesos'
          ? (f) => (f[colId] || '').toString().trim().toLowerCase() === 'demo'
          : (f) => esDeDemo(f[colId]);
        filas.forEach((f, i) => { if (esMio(f)) aBorrar.push(i + 1); });
        const sheetId = idDeHoja(nombre);
        if (sheetId === null || !aBorrar.length) { borrados[nombre] = 0; continue; }

        // Las filas sembradas van seguidas (se anadieron de una vez), asi que
        // se juntan en TRAMOS. Borrar de una en una eran mas de mil llamadas a
        // Google para una sola limpieza: no terminaba nunca.
        const tramos = [];
        for (const idx of aBorrar) {
          const ultimo = tramos[tramos.length - 1];
          if (ultimo && idx === ultimo.fin) ultimo.fin = idx + 1;
          else tramos.push({ ini: idx, fin: idx + 1 });
        }
        // De abajo arriba: si se borra de arriba abajo, cada borrado corre las
        // filas de debajo y el tramo siguiente apunta a otra gente.
        tramos.reverse();
        await sheetsClient.spreadsheets.batchUpdate({
          spreadsheetId: SPREADSHEET_ID,
          resource: {
            requests: tramos.map((t) => ({
              deleteDimension: {
                range: { sheetId, dimension: 'ROWS', startIndex: t.ini, endIndex: t.fin },
              },
            })),
          },
        });
        borrados[nombre] = aBorrar.length;
      }

      return res.json({
        success: true,
        message: `Borrado lo sembrado: ${borrados.Savings} aportes, ${borrados.Acciones} compras, `
               + `${borrados.Loans} prestamos, ${borrados.LoanPayments} pagos, `
               + `${borrados.Accesos} entradas a la app y ${borrados.Asambleas} asamblea(s). `
               + 'El reglamento y los cargos se quedan como estan.',
        borrados,
      });
    } catch (error) {
      console.error('[DEMO LIMPIAR]', error.message);
      if (responderSiEsCuota(res, error)) return;
      return res.status(500).json({ success: false, message: 'Error al limpiar la demostracion.', error: error.message });
    }
  });
};
