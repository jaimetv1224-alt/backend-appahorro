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

module.exports.register = function register(app, ctx) {
  const {
    getSheetsClient, SPREADSHEET_ID, normalizeEmailKey, normalizeGroupKey,
    normalizeGroupRole, requireAdmin, bloquear, responderSiEsCuota, linkIsActive,
  } = ctx;

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
        if (conDineroReal.has(gid)) {
          saltados.push({ grupo: g[GRP.nombre] || gid, motivo: 'ya tiene movimiento de verdad, no se toca' });
          continue;
        }
        // Sembrar dos veces duplicaria todo. Para rehacerlo: limpiar y sembrar.
        if (yaSembrado.has(gid)) {
          saltados.push({ grupo: g[GRP.nombre] || gid, motivo: 'ya tiene la demostracion sembrada' });
          continue;
        }

        const azar = azarDe(gid);
        orden += 1;

        // Cada grupo arranca en un mes distinto: enero, marzo, abril...
        const tope = Math.max(1, Math.min(6, hoy.getMonth() + 1));
        const mesesPosibles = [1, 2, 3, 4, 5, 6].filter((m) => m <= tope);
        const mesIni = mesesPosibles[Math.floor(azar() * mesesPosibles.length)];
        const anioIni = hoy.getFullYear();
        const meses = mesesHasta(anioIni, mesIni, hoy);

        // --- reglamento del grupo ----------------------------------------
        const filaGrupo = grupos.indexOf(g) + 2;
        cambiosGrupo.push({ fila: filaGrupo, col: GRP.valorAccion, valor: valorAccion });
        if (!Number(g[GRP.interes])) {
          cambiosGrupo.push({ fila: filaGrupo, col: GRP.interes, valor: interesMensual });
        }
        if (!Number(g[GRP.aporte])) {
          cambiosGrupo.push({ fila: filaGrupo, col: GRP.aporte, valor: aporteBase });
        }
        cambiosGrupo.push({
          fila: filaGrupo, col: GRP.inicio, valor: `${anioIni}-${dosDigitos(mesIni)}-01`,
        });

        // --- directiva, solo los puestos vacios ---------------------------
        const cargosAsignados = [];
        for (const cargo of CARGOS) {
          if (datos.cargos.has(cargo)) continue;
          const libre = datos.socias.find((s) => s.rol === 'member'
            && !cargosAsignados.some((c) => c.email === s.email));
          if (!libre) break;
          cambiosRol.push({ fila: libre.fila, rol: cargo });
          cargosAsignados.push({ cargo, email: libre.email });
          datos.cargos.set(cargo, libre.email);
          libre.rol = cargo;
        }

        // --- aportes mes a mes -------------------------------------------
        let nAportes = 0;
        const ahorroDe = new Map();
        datos.socias.forEach((s, idx) => {
          const cuota = [15, 20, 20, 25, 30][Math.floor(azar() * 5)];
          meses.forEach(({ a, m }) => {
            if (azar() < 0.08) return;            // ese mes no aporto
            const dia = 3 + Math.floor(azar() * 20);
            const id = `${PREFIJO}sav_${gid.slice(0, 6)}_${idx}_${a}${dosDigitos(m)}`;
            filasAhorro.push([
              s.email, gid, cuota, `${a}-${dosDigitos(m)}-${dosDigitos(dia)}`, 'mensual',
              `Aporte mensual ${MARCA}`, 'confirmado', s.email,
              datos.cargos.get('tesorero') || s.email, new Date().toISOString(), id, '',
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
          filasAcciones.push([
            s.email, gid, `${a}-${dosDigitos(m)}-10`, cuantas, valorAccion, interesMensual,
            new Date().toISOString(), 'confirmado', s.email,
            datos.cargos.get('tesorero') || s.email, new Date().toISOString(), id,
            `Compra de acciones ${MARCA}`,
          ]);
          nAcciones += 1;
        });

        // --- uno o dos prestamos vivos ------------------------------------
        let nPrestamos = 0;
        const candidatas = datos.socias
          .filter((s) => (ahorroDe.get(s.email) || 0) >= 60)
          .slice(0, 2 + Math.floor(azar() * 2));
        candidatas.forEach((s, idx) => {
          const principal = 50 * (1 + Math.floor(azar() * 6));      // 50..300
          const plazo = 3 + Math.floor(azar() * 4);                  // 3..6 meses
          const total = Math.round(principal * (1 + (interesMensual / 100) * plazo) * 100) / 100;
          const { a, m } = meses[Math.min(meses.length - 1, 1 + Math.floor(azar() * Math.max(1, meses.length - 2)))];
          const vence = new Date(Date.UTC(a, (m - 1) + plazo, 10)).toISOString().slice(0, 10);
          filasPrestamos.push([
            `${PREFIJO}loan_${gid.slice(0, 6)}_${idx}`, s.email, gid, principal,
            `${a}-${dosDigitos(m)}-10`, vence, interesMensual, 'aprobado', plazo, total,
          ]);
          nPrestamos += 1;
        });

        informe.push({
          grupo: g[GRP.nombre] || gid,
          desdeElMes: `${anioIni}-${dosDigitos(mesIni)}`,
          socias: datos.socias.length,
          aportes: nAportes,
          compras: nAcciones,
          prestamos: nPrestamos,
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
        await sheetsClient.spreadsheets.values.append({
          spreadsheetId: SPREADSHEET_ID, range: rango,
          valueInputOption: 'RAW', resource: { values: filas },
        });
      };
      await anexar('Savings!A:L', filasAhorro);
      await anexar('Acciones!A:M', filasAcciones);
      await anexar('Loans!A:J', filasPrestamos);

      return res.json({
        success: true,
        message: `Sembrados ${filasAhorro.length} aportes, ${filasAcciones.length} compras de acciones `
               + `y ${filasPrestamos.length} prestamos en ${informe.length} grupo(s). `
               + 'Todo va marcado como demostracion y se borra con /api/admin/demo/limpiar.',
        marca: MARCA,
        totales: {
          grupos: informe.length,
          aportes: filasAhorro.length,
          compras: filasAcciones.length,
          prestamos: filasPrestamos.length,
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
      ]) {
        const filas = await leer(sheetsClient, rango);
        // De abajo arriba: si se borra de arriba abajo, cada borrado corre las
        // filas de debajo y el siguiente indice apunta a otra persona.
        const aBorrar = [];
        filas.forEach((f, i) => { if (esDeDemo(f[colId])) aBorrar.push(i + 1); });
        aBorrar.reverse();
        const sheetId = idDeHoja(nombre);
        if (sheetId === null || !aBorrar.length) { borrados[nombre] = 0; continue; }
        for (const idx of aBorrar) {
          await sheetsClient.spreadsheets.batchUpdate({
            spreadsheetId: SPREADSHEET_ID,
            resource: {
              requests: [{
                deleteDimension: {
                  range: { sheetId, dimension: 'ROWS', startIndex: idx, endIndex: idx + 1 },
                },
              }],
            },
          });
        }
        borrados[nombre] = aBorrar.length;
      }

      return res.json({
        success: true,
        message: `Borrado lo sembrado: ${borrados.Savings} aportes, ${borrados.Acciones} compras `
               + `y ${borrados.Loans} prestamos. El reglamento y los cargos se quedan como estan.`,
        borrados,
      });
    } catch (error) {
      console.error('[DEMO LIMPIAR]', error.message);
      if (responderSiEsCuota(res, error)) return;
      return res.status(500).json({ success: false, message: 'Error al limpiar la demostracion.', error: error.message });
    }
  });
};
