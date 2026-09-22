/**
 * SUITE 49 - Reconstruccion de la produccion, para medir el indicador en vez de suponerlo.
 *
 * Afirme en un informe que el numerador del indicador IN-DIBA-2026-1.2 era CERO.
 * Esa afirmacion era una inferencia, no una medicion, y al construir el caso aqui
 * se ve que no es exacta: el numerador depende de DONDE estan las 18 entradas
 * reales a la app, y eso no se puede deducir desde fuera.
 *
 * Esta suite reconstruye la forma de la base real a 22 de septiembre de 2026:
 *   - 10 grupos de la nomina y 152 socias, con la distribucion conocida.
 *   - Directiva completa (presidencia y tesoreria) en 8 de los 10.
 *   - Dos aportes propios, los unicos: Juntos Crecemos 10 USD y cofrecito 300 USD.
 *   - 18 entradas reales a la app, frente a 821 sembradas.
 *   - 899 aportes sembrados, que no deben contar para nada.
 *
 *   REC 1: la base tal como esta -> numerador 0, y se ve POR QUE.
 *   REC 2: que haria falta para mover el indicador (hipotetico, no es la base).
 *   REC 3: si lo sembrado contara, el indicador se dispararia. Por eso no cuenta.
 *   REC 4: cuanto dinero propio hay de verdad en los diez grupos.
 *
 * La conclusion para el informe: el indicador es 0 %, y no porque falten
 * operaciones ni directivas (hay 9 de 10 completas) sino porque NINGUNA socia
 * ha abierto la aplicacion todavia. De las 844 entradas registradas, 821 son
 * sembradas y las 23 restantes son de una cuenta del equipo sin grupo activo.
 * Eso dice exactamente donde hay que poner el esfuerzo de campo.
 */

const { seedWorkbook, get, post, fake } = require('./harness');
const { baseScenario, seedUser, seedGroup, seedLink } = require('./scenario');
const t = require('./runner');

const dato = (r, concepto) => ((((r.body && r.body.hojas) || [])
  .find((h) => h.nombre === 'Indicador') || {}).filas || [])
  .find((x) => new RegExp(concepto, 'i').test(String(x.Concepto)));

/**
 * La nomina real, LEIDA de la base el 22 de septiembre de 2026 (no inventada):
 * enlaces activos por grupo y si tiene presidencia Y tesoreria. Suman 152.
 * cofrecito es un caso de verdad raro: una sola socia, con presidencia y sin
 * tesoreria, y aun asi tiene un aporte propio de 300 USD.
 */
const NOMINA = [
  { id: 'g_aguinaldo', nombre: 'Mi aguinaldo', socias: 52, directiva: true },
  { id: 'g_banquio', nombre: 'Banquio de ahorros', socias: 17, directiva: true },
  { id: 'g_juntos', nombre: 'Juntos Crecemos', socias: 16, directiva: true },
  { id: 'g_amanecer', nombre: 'Nuevo Amanecer', socias: 13, directiva: true },
  { id: 'g_family', nombre: 'Family Bank', socias: 12, directiva: true },
  { id: 'g_manos', nombre: 'Manos Unidas', socias: 11, directiva: true },
  { id: 'g_semilla', nombre: 'Semilla de Ahorro', socias: 11, directiva: true },
  { id: 'g_mar', nombre: 'Mar y Progreso', socias: 10, directiva: true },
  { id: 'g_unidos', nombre: 'Unidos por Salinas', socias: 9, directiva: true },
  { id: 'g_cofrecito', nombre: 'cofrecito', socias: 1, directiva: false },
];

const TOTAL_SOCIAS = NOMINA.reduce((s, g) => s + g.socias, 0);

module.exports = async function run() {
  const hoja = require('../hoja');
  const acc = require('../accesos');
  const G = require('../governance').SHEETS;
  const { HOJA_CAMPO, CABECERA_CAMPO } = require('../instrumento');

  /** Correo sintetico estable de la socia n del grupo g. */
  const correo = (gid, n) => `${gid}_s${n}@nomina.test`;

  const entrar = (email, fechaIso, origen) => fake.ensureSheet(acc.HOJA).grid
    .push([fechaIso, email, 'movil', 'Android', 'Chrome', '1.1.1.1', 'UA', origen]);

  const aportar = (email, gid, monto, fecha, id, descripcion) => fake.ensureSheet('Savings').grid.push([
    email, gid, monto, fecha, 'mensual', descripcion, 'confirmado',
    email, email, `${fecha}T10:00:00.000Z`, id, '',
  ]);

  /**
   * Monta la base entera. `entradasReales` es una lista de [idGrupo, cuantas]
   * que dice donde caen las 18 entradas propias: es la unica incognita.
   */
  const montarProduccion = async (entradasReales) => {
    seedWorkbook();
    Object.values(G).forEach((d) => fake.seedSheet(d.name, [d.headers]));
    fake.seedSheet(acc.HOJA, [acc.CABECERA]);
    fake.seedSheet(HOJA_CAMPO, [CABECERA_CAMPO]);
    ['Savings', 'Acciones', 'Loans', 'LoanPayments'].forEach((n) => fake.ensureSheet(n));

    const e = await baseScenario({ groupId: 'ADMIN_AUX' });

    for (const g of NOMINA) {
      for (let n = 1; n <= g.socias; n += 1) {
        seedUser({ nombre: `Socia ${n} ${g.nombre}`, email: correo(g.id, n) });
      }
      seedGroup({ id: g.id, nombre: g.nombre, presidente: correo(g.id, 1), valorAccion: 15 });
      // Presidencia siempre; tesoreria solo en los 8 que la tienen completa.
      seedLink(correo(g.id, 1), g.id, 'presidente');
      if (g.directiva) seedLink(correo(g.id, 2), g.id, 'tesorero');
      const desde = g.directiva ? 3 : 2;
      for (let n = desde; n <= g.socias; n += 1) seedLink(correo(g.id, n), g.id, 'member');
    }

    // --- Lo REAL: los dos unicos aportes propios de los 10 grupos ---
    aportar(correo('g_juntos', 3), 'g_juntos', 10, '2026-07-08', 'sav_real_juntos', 'Aporte mensual de ahorro');
    aportar(correo('g_cofrecito', 1), 'g_cofrecito', 300, '2026-08-02', 'sav_real_cofre', 'ahorro base');

    // --- Lo REAL: las 23 entradas no sembradas ---
    // En la base de verdad las 23 son de UNA sola cuenta del equipo, que ni
    // siquiera tiene grupo activo. Aqui se puede simular cualquier reparto para
    // medir que pasaria; `entradasReales` lo dice.
    let puestas = 0;
    for (const [gid, cuantas] of entradasReales) {
      for (let n = 1; n <= cuantas; n += 1) {
        const quien = gid === 'equipo' ? 'jaimejavitorres@equipo.test' : correo(gid, n);
        entrar(quien, `2026-09-${String(1 + (n % 20)).padStart(2, '0')}T10:00:00.000Z`, 'vuelta');
        puestas += 1;
      }
    }

    // --- Lo SEMBRADO: 821 entradas y 899 aportes, todos marcados ---
    let sembradas = 0;
    for (const g of NOMINA) {
      for (let n = 1; n <= g.socias; n += 1) {
        for (let k = 0; k < 6 && sembradas < 821; k += 1) {
          entrar(correo(g.id, n), `2026-0${(k % 6) + 3}-15T10:00:00.000Z`, 'demo');
          sembradas += 1;
        }
      }
    }
    let aportesDemo = 0;
    for (const g of NOMINA) {
      for (let n = 1; n <= g.socias && aportesDemo < 899; n += 1) {
        for (let k = 0; k < 6 && aportesDemo < 899; k += 1) {
          aportar(correo(g.id, n), g.id, 20, `2026-0${(k % 6) + 3}-20`,
            `demo_sav_${g.id}_${n}_${k}`, 'aporte mensual [demo]');
          aportesDemo += 1;
        }
      }
    }

    hoja.invalidarTodo();

    // La ficha de campo marca los 10 como CAYC: es el denominador que se esta usando.
    const r = await post('/api/admin/seguimiento-campo', {
      grupos: NOMINA.map((g) => ({
        groupId: g.id, grupo: g.nombre, esCayc: true,
        socializacionFecha: '2026-08-15', socializacionAsistentes: g.socias,
        responsable: 'Sabina Villon',
      })),
    }, e.tokens.admin);
    hoja.invalidarTodo();
    return { e, r, puestas, sembradas, aportesDemo };
  };

  // ===================================================================
  t.section('REC 1. La base tal como esta: ninguna socia ha entrado nunca');
  // ===================================================================
  // Lo medido el 22 de septiembre de 2026: de las 844 entradas registradas,
  // 821 son sembradas y las 23 restantes son TODAS de una cuenta del equipo
  // que ni siquiera tiene grupo activo. Ni una sola socia de los diez grupos
  // ha abierto la aplicacion.
  let m = await montarProduccion([['equipo', 23]]);
  t.status('la ficha de campo de los 10 grupos se anota', m.r, 200);
  t.eq('la nomina reconstruida tiene 152 socias', TOTAL_SOCIAS, 152);
  t.eq('se pusieron las 23 entradas reales', m.puestas, 23);
  t.eq('y 821 sembradas', m.sembradas, 821);
  t.eq('y 899 aportes sembrados', m.aportesDemo, 899);
  t.eq('nueve de los diez grupos tienen directiva completa',
    NOMINA.filter((g) => g.directiva).length, 9);

  let r = await get('/api/admin/instrumento-digitalizacion', m.e.tokens.admin);
  t.status('el instrumento responde', r, 200);
  t.eq('el denominador son los 10 grupos marcados como CAYC', r.body.indicador.denominador, 10);
  t.eq('el numerador es CERO', r.body.indicador.numerador, 0);
  t.eq('o sea 0 %', r.body.indicador.porcentaje, 0);
  t.eq('y no llega a la meta', r.body.indicador.cumple, false);

  // Y el documento dice de que base sale, para que nadie crea que la app esta vacia:
  // hay 1.720 filas sembradas debajo que quedaron fuera a proposito.
  const base = dato(r, 'Base del calculo');
  t.check('el documento declara que dejo fuera lo sembrado',
    !!base && /Solo datos reales/i.test(String(base.Valor)), JSON.stringify(base));
  t.check('y dice cuantas filas dejo fuera',
    !!base && Number((String(base.Valor).match(/(\d+) filas/) || [])[1]) > 1000,
    JSON.stringify(base));

  const grupos = ((r.body.hojas || []).find((h) => h.nombre === 'Grupos') || {}).filas || [];
  t.eq('salen los 10 grupos con su detalle', grupos.length, 10);
  t.check('ninguno figura digitalizado', grupos.every((g) => g.DIGITALIZADA === 'no'),
    JSON.stringify(grupos.filter((g) => g.DIGITALIZADA === 'si')));
  t.check('a todos se les dice que les falta', grupos.every((g) => String(g['Que le falta'] || '').length > 0), '');

  // Lo que de verdad frena a los dos grupos que si tienen dinero propio: no es
  // que falte dinero, es que nadie entra. Eso cambia la recomendacion entera.
  const juntos = grupos.find((g) => g.GrupoID === 'g_juntos');
  const cofre = grupos.find((g) => g.GrupoID === 'g_cofrecito');
  t.check('Juntos Crecemos falla por falta de uso, no por falta de dinero',
    /mitad/i.test(String(juntos && juntos['Que le falta'])), JSON.stringify(juntos));
  t.check('cofrecito ademas no tiene tesoreria',
    /directiva|tesoreria|presidencia/i.test(String(cofre && cofre['Que le falta'])), JSON.stringify(cofre));
  t.check('a los diez les falta la condicion de uso',
    grupos.every((g) => /mitad/i.test(String(g['Que le falta']))), '');
  t.eq('y ninguna socia figura como que haya entrado',
    grupos.reduce((s, g) => s + Number(g['Socias que han entrado'] || 0), 0), 0);

  // ===================================================================
  t.section('REC 2. Que haria falta para mover el indicador');
  // ===================================================================
  // Escenario hipotetico, NO es la base actual. Si la mitad de las socias de
  // los grupos que ya tienen dinero propio entrara por primera vez, esos grupos
  // pasarian a contar. Sirve para saber donde poner el esfuerzo de campo.
  // Juntos Crecemos tiene 16 socias: hacen falta 8. cofrecito tiene 1, pero le
  // falta tesoreria, asi que no puede contar por mucho que entre.
  m = await montarProduccion([['g_juntos', 8], ['g_cofrecito', 1]]);
  t.status('se monta el caso favorable', m.r, 200);
  t.eq('entran 8 socias de Juntos Crecemos y la unica de cofrecito', m.puestas, 9);

  r = await get('/api/admin/instrumento-digitalizacion', m.e.tokens.admin);
  t.status('el instrumento responde', r, 200);
  t.eq('el denominador no cambia', r.body.indicador.denominador, 10);
  t.eq('el numerador sube a 1', r.body.indicador.numerador, 1);
  t.eq('o sea 10 %', r.body.indicador.porcentaje, 10);
  t.eq('y SIGUE sin llegar a la meta del 50 %', r.body.indicador.cumple, false);

  const grupos2 = ((r.body.hojas || []).find((h) => h.nombre === 'Grupos') || {}).filas || [];
  const siDigit = grupos2.filter((g) => g.DIGITALIZADA === 'si').map((g) => g.GrupoID).sort();
  t.eq('y es solo Juntos Crecemos', siDigit.join(','), 'g_juntos');

  // cofrecito tiene dinero y su unica socia entro, pero sin tesoreria no cuenta:
  // la condicion de directiva existe para que la caja tenga control interno.
  const cofre2 = grupos2.find((g) => g.GrupoID === 'g_cofrecito');
  t.eq('cofrecito no cuela sin tesoreria', cofre2 && cofre2.DIGITALIZADA, 'no');
  t.check('y se dice exactamente eso',
    /directiva|tesoreria|presidencia/i.test(String(cofre2 && cofre2['Que le falta'])),
    JSON.stringify(cofre2));

  // Mi aguinaldo tiene 52 socias y ninguna entro: sigue sin contar.
  const aguinaldo = grupos2.find((g) => g.GrupoID === 'g_aguinaldo');
  t.eq('el grupo grande sigue sin contar', aguinaldo && aguinaldo.DIGITALIZADA, 'no');

  // ===================================================================
  t.section('REC 3. Por que lo sembrado no puede contar');
  // ===================================================================
  // Mismo libro, misma base. Solo cambia si se cuentan los datos de demostracion.
  r = await get('/api/admin/instrumento-digitalizacion?incluirDemo=1', m.e.tokens.admin);
  t.status('el instrumento responde tambien con lo sembrado', r, 200);
  t.check('con lo sembrado el indicador se dispara',
    r.body.indicador.numerador > 2, `numerador=${r.body.indicador.numerador}`);
  t.eq('pero el archivo se renombra para que nadie lo confunda',
    /CON-DATOS-DE-DEMOSTRACION/.test(String(r.body.archivo)), true);
  t.eq('y deja de declararse como solo datos reales', r.body.soloDatosReales, false);

  // El aviso tiene que estar en la hoja que se lee PRIMERO y arriba del todo,
  // no escondido en "Como se calcula".
  const filasInd = (((r.body.hojas || [])
    .find((h) => h.nombre === 'Indicador') || {}).filas || []);
  t.eq('el aviso es la PRIMERA fila de la hoja Indicador',
    String(filasInd[0] && filasInd[0].Concepto), 'AVISO');
  t.check('y dice que no sirve como medio de verificacion',
    /no sirve como medio de verificacion/i.test(String(filasInd[0] && filasInd[0].Valor)),
    JSON.stringify(filasInd[0]));
  t.check('la hoja Indicador va la primera del libro',
    String((r.body.hojas || [])[0] && (r.body.hojas || [])[0].nombre) === 'Indicador',
    JSON.stringify((r.body.hojas || []).map((h) => h.nombre)));

  // Y lo mas fino: con lo sembrado dentro, la VENTANA DE REGISTRO tambien queda
  // contaminada. Las entradas sembradas arrancan en 2025, asi que la condicion
  // de uso pasaria a parecer comprobada y el documento afirmaria sobre el uso de
  // las socias apoyandose en datos inventados. Es el mismo error del cero falso,
  // entrando por la otra puerta.
  t.eq('con lo sembrado, el indicador NO se declara medible',
    r.body.indicador.medible, false);
  t.eq('ni se afirma si cumple la meta', r.body.indicador.cumple, null);
  const filaDesde = (((r.body.hojas || [])
    .find((h) => h.nombre === 'Indicador') || {}).filas || [])
    .find((x) => /Registro de entradas: desde/.test(String(x.Concepto)));
  t.check('y la ventana se marca como contaminada',
    /CONTAMINADA/.test(String(filaDesde && filaDesde.Valor)), JSON.stringify(filaDesde));

  // ===================================================================
  t.section('REC 4. Cuanto dinero propio hay de verdad en los diez grupos');
  // ===================================================================
  // La condicion de dinero solo la pueden cumplir los grupos con movimiento
  // propio. En los diez grupos de la nomina hay exactamente dos operaciones.
  // (En toda la plataforma hay mas, pero estan en Grupo ADE y Prueba 2, que
  // son grupos de ensayo y no entran en el denominador del indicador.)
  r = await get('/api/admin/instrumento-digitalizacion', m.e.tokens.admin);
  const evidencias = ((r.body.hojas || [])
    .find((h) => h.nombre === 'Evidencias de operaciones') || {}).filas || [];
  t.eq('en toda la base hay exactamente 2 operaciones propias', evidencias.length, 2);

  const gruposConDinero = [...new Set(evidencias.map((x) => x.GrupoID || x.Grupo))].sort();
  t.eq('repartidas en exactamente 2 grupos', gruposConDinero.length, 2);
  t.check('y son Juntos Crecemos y cofrecito',
    gruposConDinero.every((g) => /juntos|cofrecito/i.test(String(g))),
    JSON.stringify(gruposConDinero));

  t.check('los importes son los dos reales, 10 y 300',
    evidencias.map((x) => Number(x.Importe)).sort((a, b) => a - b).join(',') === '10,300',
    JSON.stringify(evidencias.map((x) => x.Importe)));

  // De ahi sale el techo: 8 de los 10 grupos NO pueden cumplir la tercera
  // condicion, se repartan como se repartan las entradas a la app.
  t.check('por tanto 8 de 10 grupos no pueden cumplir la condicion de dinero',
    NOMINA.length - gruposConDinero.length === 8, `${NOMINA.length} - ${gruposConDinero.length}`);

  // ===================================================================
  t.section('REC 5. Un hueco de registro NO es una ausencia de actividad');
  // ===================================================================
  // ESTE ES EL CASO DE PRODUCCION. El registro de entradas se programo el 3 de
  // septiembre de 2026 y su primer apunte real es del 16; las socias estaban
  // dadas de alta desde mucho antes. Preguntarle a ese registro "¿ha entrado
  // alguna vez?" no da un NO, da un NO SE SABE. Contarlo como NO daria por
  // inexistente el trabajo de las socias durante todo el periodo anterior, que
  // es el error mas grave que podria cometer este instrumento.
  m = await montarProduccion([['equipo', 23]]);

  // Se retrasan las altas de los vinculos a mucho antes del primer acceso.
  const rejilla = fake.ensureSheet('UserGroupLinks').grid;
  for (const f of rejilla) {
    if (f[1] && NOMINA.some((g) => g.id === f[1])) f[2] = '2026-01-15T10:00:00.000Z';
  }
  hoja.invalidarTodo();

  r = await get('/api/admin/instrumento-digitalizacion', m.e.tokens.admin);
  t.status('el instrumento responde', r, 200);
  t.eq('y declara que NO se puede medir', r.body.indicador.medible, false);
  t.eq('el numerador sigue siendo 0', r.body.indicador.numerador, 0);
  t.eq('pero ya no se afirma que incumple la meta', r.body.indicador.cumple, null);

  const g5 = ((r.body.hojas || []).find((h) => h.nombre === 'Grupos') || {}).filas || [];
  // La distincion fina, y es la que importa: un grupo que falla una condicion
  // MEDIBLE sigue siendo un "no" definitivo. Solo queda "sin medir" aquel al que
  // unicamente le falta lo que no se puede saber. Juntos Crecemos tiene dinero y
  // directiva, asi que su unica incognita es el uso: ese es el que no se afirma.
  t.eq('solo queda sin medir el grupo al que unicamente le falta lo inmedible',
    r.body.indicador.sinMedir, 1);
  const enDuda = g5.filter((g) => g.DIGITALIZADA === 'sin medir').map((g) => g.GrupoID);
  t.eq('y es Juntos Crecemos', enDuda.join(','), 'g_juntos');
  t.check('los que fallan por dinero o directiva siguen siendo un no claro',
    g5.filter((g) => g.DIGITALIZADA === 'no').length === 9,
    JSON.stringify(g5.map((g) => `${g.Grupo}:${g.DIGITALIZADA}`)));
  t.check('al que esta en duda se le dice por que no se pudo medir',
    /SIN MEDIR/.test(String((g5.find((g) => g.GrupoID === 'g_juntos') || {})['Que le falta'])),
    JSON.stringify(g5.find((g) => g.GrupoID === 'g_juntos')));
  t.eq('y la columna de uso medible dice que no para todos',
    g5.every((g) => g['Uso medible'] === 'no'), true);

  const ind5 = ((r.body.hojas || []).find((h) => h.nombre === 'Indicador') || {}).filas || [];
  t.check('el aviso encabeza la hoja Indicador',
    /no se puede afirmar/i.test(String(ind5[0] && ind5[0].Concepto)), JSON.stringify(ind5[0]));
  t.check('y el resultado se presenta como cota inferior, no como medicion',
    /sin medir/i.test(String((ind5.find((x) => x.Concepto === 'RESULTADO') || {}).Valor)),
    JSON.stringify(ind5.find((x) => x.Concepto === 'RESULTADO')));
  t.check('se publica desde cuando hay registro',
    !!(ind5.find((x) => /desde/i.test(String(x.Concepto))) || {}).Valor, '');

  // El contraste: si el registro empezara ANTES de las altas, si se puede medir.
  for (const f of rejilla) {
    if (f[1] && NOMINA.some((g) => g.id === f[1])) f[2] = '2026-09-20T10:00:00.000Z';
  }
  hoja.invalidarTodo();
  r = await get('/api/admin/instrumento-digitalizacion', m.e.tokens.admin);
  t.eq('con el registro cubriendo el periodo, vuelve a ser medible',
    r.body.indicador.medible, true);
  t.eq('y entonces si se puede afirmar que no llega a la meta',
    r.body.indicador.cumple, false);

  // ===================================================================
  t.section('REC 7. Una marca de acceso desconocida no pasa por real');
  // ===================================================================
  // El filtro de accesos era una LISTA NEGRA: descartaba 'demo' y daba por real
  // todo lo demas. Eso falla hacia el lado peligroso. Si manana aparece un
  // origen nuevo, o si la columna se desplaza, lo sembrado pasa por bueno y la
  // ventana se ensancha sin que nada lo delate: medido contra la base real,
  // de 3 dias a 193. Ahora es lista blanca y lo que no se sabe clasificar
  // bloquea la afirmacion en vez de colarse.
  m = await montarProduccion([['g_juntos', 8]]);

  // Se cambia la marca de TODO lo sembrado por una que el sistema nunca escribe,
  // que es exactamente lo que pasaria si el filtro se quedara obsoleto.
  const accesos = fake.ensureSheet(acc.HOJA).grid;
  let cambiadas = 0;
  for (const f of accesos) {
    if (String(f[7]).toLowerCase() === 'demo') { f[7] = 'sincronizacion'; cambiadas += 1; }
  }
  hoja.invalidarTodo();
  t.check('se disfrazaron las entradas sembradas', cambiadas > 500, `${cambiadas}`);

  r = await get('/api/admin/instrumento-digitalizacion', m.e.tokens.admin);
  t.status('el instrumento responde igual', r, 200);
  t.eq('pero NO se declara medible', r.body.indicador.medible, false);
  // Las 821 disfrazadas van de marzo a agosto. Si se colaran, la ventana se
  // ensancharia hacia atras y los apuntes se irian a varios cientos. Lo que
  // queda son las entradas de verdad del escenario, todas de septiembre.
  t.check('ninguna de las 821 disfrazadas se cuenta como real',
    r.body.indicador.ventanaDeRegistro.apuntes < 100,
    JSON.stringify(r.body.indicador.ventanaDeRegistro));
  // Y con las 821 fuera de las tres categorias buenas, la suma sigue cerrando:
  // van a parar a "sin clasificar", que es donde tienen que estar.
  const v7 = r.body.indicador.ventanaDeRegistro;
  t.eq('la suma cierra tambien cuando hay marcas raras',
    v7.apuntes + v7.sembrados + v7.descartados, v7.total);
  t.check('y las disfrazadas caen en "sin clasificar"',
    v7.descartados > 500, JSON.stringify(v7));
  t.check('y la ventana no se ensancha hacia atras',
    String(r.body.indicador.ventanaDeRegistro.desde) >= '2026-09-01',
    JSON.stringify(r.body.indicador.ventanaDeRegistro));
  t.eq('la ventana se marca como no fiable',
    r.body.indicador.ventanaDeRegistro.fiable, false);
  t.check('y se dice QUE marca no se supo leer',
    (r.body.indicador.ventanaDeRegistro.marcasDesconocidas || []).includes('sincronizacion'),
    JSON.stringify(r.body.indicador.ventanaDeRegistro.marcasDesconocidas));

  const ind7 = ((r.body.hojas || []).find((h) => h.nombre === 'Indicador') || {}).filas || [];
  t.check('el documento lo avisa arriba, con el nombre de la marca',
    ind7.some((x) => /marcas desconocidas/i.test(String(x.Concepto))
      && /sincronizacion/.test(String(x.Valor))),
    JSON.stringify(ind7.slice(0, 3)));

  const g7 = ((r.body.hojas || []).find((h) => h.nombre === 'Grupos') || {}).filas || [];
  t.check('y ningun grupo se da por digitalizado con ese registro',
    g7.every((g) => g.DIGITALIZADA !== 'si'),
    JSON.stringify(g7.filter((g) => g.DIGITALIZADA === 'si').map((x) => x.Grupo)));

  // ===================================================================
  t.section('REC 8. Una columna movida no se lee como "inicio de sesion"');
  // ===================================================================
  // El agujero que quedaba despues de la lista blanca, y estaba en el sitio
  // menos visible. El lector convierte una marca AUSENTE en 'login', que es un
  // origen real y por tanto pasa la lista blanca. Ese valor por defecto existe
  // por una razon buena (las filas anteriores a que se creara la columna son
  // todas inicios de sesion), pero "ausente" es TAMBIEN lo que se ve cuando
  // alguien mueve o borra la columna en la hoja. Los dos casos producen el
  // mismo valor vacio: uno es legitimo y el otro deja entrar lo sembrado por
  // la puerta de al lado. La cabecera es lo unico que los separa.
  m = await montarProduccion([['g_juntos', 8]]);

  const hojaAcc = fake.ensureSheet(acc.HOJA);
  // Se vacia la marca de TODO (como si la columna ya no cayera ahi) y ademas
  // se estropea la cabecera, que es lo que delata el desplazamiento.
  for (let i = 1; i < hojaAcc.grid.length; i += 1) hojaAcc.grid[i][7] = '';
  hojaAcc.grid[0][7] = 'Comentario';
  hoja.invalidarTodo();

  r = await get('/api/admin/instrumento-digitalizacion', m.e.tokens.admin);
  t.status('el instrumento responde', r, 200);
  t.eq('la ventana NO se da por fiable', r.body.indicador.ventanaDeRegistro.fiable, false);
  t.check('y se nombra el problema como lo que es',
    (r.body.indicador.ventanaDeRegistro.marcasDesconocidas || [])
      .includes('columna-origen-desplazada'),
    JSON.stringify(r.body.indicador.ventanaDeRegistro.marcasDesconocidas));
  t.eq('el indicador no se declara medible', r.body.indicador.medible, false);

  const g8 = ((r.body.hojas || []).find((h) => h.nombre === 'Grupos') || {}).filas || [];
  t.check('ningun grupo se da por digitalizado',
    g8.every((g) => g.DIGITALIZADA !== 'si'),
    JSON.stringify(g8.filter((g) => g.DIGITALIZADA === 'si').map((x) => x.Grupo)));

  // El contraste: con la cabecera en su sitio, una fila vieja SIN marca sigue
  // contando como inicio de sesion. El backfill historico no se rompe.
  hojaAcc.grid[0][7] = acc.CABECERA[7];
  hoja.invalidarTodo();
  r = await get('/api/admin/instrumento-digitalizacion', m.e.tokens.admin);
  t.eq('con la cabecera correcta, la ventana vuelve a ser fiable',
    r.body.indicador.ventanaDeRegistro.fiable, true);
  t.check('y las filas viejas sin marca cuentan como entradas reales',
    r.body.indicador.ventanaDeRegistro.apuntes > 100,
    JSON.stringify(r.body.indicador.ventanaDeRegistro));

  // Pero NO se esconden dentro de la cifra. Contarlas como inicio de sesion es
  // correcto (asi lo documenta quien las escribio) y a la vez es un SUPUESTO,
  // no una lectura. Meter un supuesto dentro de un numero que el INCYT va a
  // leer como medicion es la clase de cosa que nadie detecta despues.
  t.check('pero se declara cuantas llevan el origen supuesto',
    r.body.indicador.ventanaDeRegistro.supuestos > 100,
    JSON.stringify(r.body.indicador.ventanaDeRegistro));
  const ind8 = ((r.body.hojas || []).find((h) => h.nombre === 'Indicador') || {}).filas || [];
  t.check('y el documento lo dice, con el numero y de quien es la decision',
    ind8.some((x) => /origen supuesto/i.test(String(x.Concepto))
      && /SUPUESTO/.test(String(x.Valor))
      && /direccion del proyecto/i.test(String(x.Valor))),
    JSON.stringify(ind8.map((x) => x.Concepto).slice(0, 6)));

  // LA ARITMETICA TIENE QUE CERRAR. En cuanto hay supuestos o marcas sin
  // clasificar, deducir una cifra restando deja de dar lo que uno cree, y un
  // parrafo que invita a esa resta es una contradiccion delante de quien
  // revise el documento con los dedos. Por eso se publican las tres cifras.
  const v8 = r.body.indicador.ventanaDeRegistro;
  t.eq('total = reales + sembradas + sin clasificar',
    v8.apuntes + v8.sembrados + v8.descartados, v8.total);
  t.check('y los supuestos son un subconjunto de las reales, no un cuarto grupo',
    v8.supuestos <= v8.apuntes, JSON.stringify(v8));
  t.check('el documento publica el reparto completo',
    ind8.some((x) => /como se reparten/i.test(String(x.Concepto))
      && String(x.Valor).includes(`${v8.total} filas en total`)
      && String(x.Valor).includes(`${v8.apuntes} entradas reales`)
      && String(x.Valor).includes(`${v8.sembrados} sembradas`)),
    JSON.stringify(ind8.find((x) => /como se reparten/i.test(String(x.Concepto)))));

  // ===================================================================
  t.section('REC 6. Sin ficha de campo no hay indicador, y se dice');
  // ===================================================================
  // ES EL ESTADO DE PRODUCCION HOY: la hoja SeguimientoCampo ni siquiera existe.
  // Con denominador 0, decir "0 %, no cumple la meta" seria afirmar sobre la
  // nada y dejaria escrito en el informe que el proyecto incumple cuando lo que
  // pasa es que nadie ha decidido todavia que grupos se miden.
  seedWorkbook();
  Object.values(G).forEach((d) => fake.seedSheet(d.name, [d.headers]));
  fake.seedSheet(acc.HOJA, [acc.CABECERA]);
  fake.seedSheet(HOJA_CAMPO, [CABECERA_CAMPO]);
  ['Savings', 'Acciones', 'Loans', 'LoanPayments'].forEach((n) => fake.ensureSheet(n));
  hoja.invalidarTodo();
  const e6 = await baseScenario({ groupId: 'REC6' });
  seedUser({ nombre: 'Presi Seis', email: 'presi6@rec.test' });
  seedGroup({ id: 'G6', nombre: 'Caja sin ficha', presidente: 'presi6@rec.test' });
  seedLink('presi6@rec.test', 'G6', 'presidente');
  hoja.invalidarTodo();

  r = await get('/api/admin/instrumento-digitalizacion', e6.tokens.admin);
  t.status('el instrumento responde igual', r, 200);
  t.eq('el denominador es 0', r.body.indicador.denominador, 0);
  t.eq('y NO se afirma que se incumpla la meta', r.body.indicador.cumple, null);
  t.eq('ni se declara medible', r.body.indicador.medible, false);

  const ind6 = ((r.body.hojas || []).find((h) => h.nombre === 'Indicador') || {}).filas || [];
  t.check('el aviso de que falta el denominador encabeza la hoja',
    /todavia no hay indicador/i.test(String(ind6[0] && ind6[0].Concepto)), JSON.stringify(ind6[0]));
  t.check('y explica que no significa incumplimiento',
    /NO significa que la meta no/i.test(String(ind6[0] && ind6[0].Valor)), '');
  t.check('el resultado remite a marcar las CAYC',
    /SeguimientoCampo/i.test(String((ind6.find((x) => x.Concepto === 'RESULTADO') || {}).Valor)),
    JSON.stringify(ind6.find((x) => x.Concepto === 'RESULTADO')));
  t.check('y no se publica ninguna brecha inventada',
    !ind6.some((x) => /Brecha/i.test(String(x.Concepto))),
    JSON.stringify(ind6.map((x) => x.Concepto)));
  t.check('el grupo aparece en la lista de los que no tienen ficha',
    (((r.body.hojas || []).find((h) => h.nombre === 'Grupos sin ficha de campo') || {}).filas || [])
      .some((x) => x.GrupoID === 'G6'), '');
};
