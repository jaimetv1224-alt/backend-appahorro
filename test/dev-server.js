/**
 * Backend de DEMOSTRACION local.
 *
 * Levanta el backend real contra el emulador de Google Sheets en memoria, con
 * un grupo de ejemplo ya sembrado y con movimiento en TODAS las pantallas
 * (ahorros, acciones, prestamos, pagos, metas, solicitudes, asamblea y actas).
 * Sirve para probar la app entera en el navegador sin credenciales de Google y
 * sin tocar la hoja de produccion.
 *
 *   node test/dev-server.js            (puerto 3001)
 *   PORT=4000 node test/dev-server.js
 *
 * Luego, en la carpeta del frontend:
 *   echo VITE_API_TARGET=http://127.0.0.1:3001 > .env.development.local
 *   npx vite
 *
 * Los datos viven solo en memoria: al parar el proceso se pierden.
 */

process.env.TEST_PORT = process.env.PORT || '3001';

const { seedWorkbook, startServer, fake } = require('./harness');
const { seedUser, seedGroup, seedLink } = require('./scenario');
const { SHEETS } = require('../governance');

// Hojas que el backend crea sola la primera vez que se usan. Para la demo hay que
// sembrarlas CON su cabecera: si se escriben datos en una hoja vacia, la primera
// fila ocupa el lugar del encabezado y las lecturas (que empiezan en A2) la pierden.
const CABECERAS_EXTRA = {
  ActasAsamblea: ['ActaID', 'GrupoID', 'Fecha', 'CreadaPor', 'Titulo', 'Contenido', 'Asistentes'],
  AprobacionesAsamblea: ['SolicitudID', 'Tipo', 'GrupoID', 'AprobadoPor', 'RolAprobador', 'Decision', 'Fecha', 'Comentario'],
};

const CLAVE = 'Clave123';
const GRUPO = 'DEMO-001';
const HOY = new Date().toISOString();

const GENTE = [
  ['Rosa Villon (presidenta)', 'rosa@demo.test', 'presidente'],
  ['Luis Tomala (tesorero)', 'luis@demo.test', 'tesorero'],
  ['Nelly Borbor (secretaria)', 'nelly@demo.test', 'secretario'],
  ['Jose Panchana (socio)', 'jose@demo.test', 'member'],
  ['Maria Reyes (socia)', 'maria@demo.test', 'member'],
];

function fila(hoja, valores) {
  fake.ensureSheet(hoja).grid.push(valores);
}

function sembrarDemo() {
  seedWorkbook();

  // Cabeceras de las hojas del control interno y de las que crea server.js
  Object.values(SHEETS).forEach((def) => fake.seedSheet(def.name, [def.headers]));
  Object.entries(CABECERAS_EXTRA).forEach(([nombre, cabecera]) => fake.seedSheet(nombre, [cabecera]));

  seedUser({ nombre: 'Administrador', email: 'admin@demo.test', password: CLAVE, role: 'admin' });
  GENTE.forEach(([nombre, email]) => seedUser({ nombre, email, password: CLAVE }));

  seedGroup({ id: GRUPO, nombre: 'Caja de Ahorro El Progreso', presidente: 'rosa@demo.test', valorAccion: 10, interesMensual: 2 });
  GENTE.forEach(([, email, rol]) => seedLink(email, GRUPO, rol));

  // --- Historial ya confirmado, para que nada arranque en cero ---
  const ahorros = { 'rosa@demo.test': 320, 'luis@demo.test': 280, 'nelly@demo.test': 240, 'jose@demo.test': 150, 'maria@demo.test': 190 };
  Object.entries(ahorros).forEach(([email, monto], i) => {
    fila('Savings', [email, GRUPO, monto, '2026-07-05', 'mensual', 'Aporte de julio',
      'confirmado', 'luis@demo.test', 'rosa@demo.test', HOY, `demo_sav_${i}`, '']);
    fila('Acciones', [email, GRUPO, '2026-07-05', 10 + i * 5, 10, 2, HOY,
      'confirmado', 'luis@demo.test', 'rosa@demo.test', HOY, `demo_acc_${i}`, '']);
    fila('Transactions', [`T${1000 + i}`, email, 'saving', monto, 'Aporte de julio', HOY, 'saving', '']);
  });

  // --- Dos aportes de agosto esperando confirmacion de tesoreria ---
  fila('Savings', ['jose@demo.test', GRUPO, 60, '2026-08-04', 'mensual', 'Aporte de agosto',
    'pendiente', 'jose@demo.test', '', '', 'demo_sav_pend_1', '']);
  fila('Savings', ['maria@demo.test', GRUPO, 75, '2026-08-04', 'mensual', 'Aporte de agosto',
    'pendiente', 'maria@demo.test', '', '', 'demo_sav_pend_2', '']);

  // --- Un prestamo vigente de Maria, con un pago aprobado y otro por revisar ---
  const PRESTAMO = 'demo_loan_1';
  fila('SolicitudesPrestamos', [PRESTAMO, 'maria@demo.test', GRUPO, 'member', 300, 'aprobado',
    '2026-07-10', 'Plazo: 6', 'rosa@demo.test', 2]);
  fila('Loans', [PRESTAMO, 'maria@demo.test', GRUPO, 300, '2026-07-10T00:00:00.000Z',
    '2027-01-10T00:00:00.000Z', 2, 'aprobado', 6, 336]);
  fila('Transactions', ['T2001', 'maria@demo.test', 'loan', 300, 'Prestamo aprobado (plazo 6m, 2%/mes, total $336)', HOY, 'loan', '']);
  fila('LoanPayments', ['demo_pay_1', 'maria@demo.test', PRESTAMO, 100, '2026-08-05',
    'comprobante1.png', 'approved', 'luis@demo.test', HOY, 'pago de agosto', GRUPO, '', '', '', '']);
  fila('LoanPayments', ['demo_pay_2', 'maria@demo.test', PRESTAMO, 50, '2026-08-20',
    'comprobante2.png', 'pending_approval', '', '', 'pago de septiembre', GRUPO, '', '', '', '']);

  // --- Solicitudes abiertas esperando el voto de la junta ---
  fila('SolicitudesPrestamos', ['demo_sol_1', 'jose@demo.test', GRUPO, 'member', 200, 'pendiente',
    '2026-08-18', 'Plazo: 4', '', 2]);
  fila('SolicitudesAcciones', ['demo_sol_acc', 'nelly@demo.test', GRUPO, 'secretario', 5, 'pendiente',
    '2026-08-19', 'Compra de 5 acciones', '']);

  // --- Metas de ahorro ---
  fila('MetasAhorro', ['GOAL_demo_1', 'jose@demo.test', GRUPO, 'Techo de la casa', 800, 150,
    '2027-03-31', 'Cambiar el zinc', 'alta', 'hogar', 'Activa', HOY]);
  fila('MetasAhorro', ['GOAL_demo_2', 'maria@demo.test', GRUPO, 'Capital para el negocio', 500, 190,
    '2027-06-30', 'Comprar mercaderia', 'media', 'negocio', 'Activa', HOY]);

  // --- Asamblea cerrada con su acta, y una programada ---
  fila('Asambleas', ['demo_asm_1', GRUPO, 'Asamblea ordinaria de julio', '2026-07-05', 'presencial',
    'cerrada', '1. Informe de tesoreria\n2. Varios', 'rosa@demo.test', HOY, HOY, HOY, 'rosa@demo.test', '', '']);
  fila('Asambleas', ['demo_asm_2', GRUPO, 'Asamblea ordinaria de septiembre', '2026-09-05', 'presencial',
    'programada', '1. Lectura del acta\n2. Solicitudes de credito', 'rosa@demo.test', HOY, '', '', '', '', '']);
  GENTE.forEach(([, email]) => {
    fila('AsambleaAsistencia', ['demo_asm_1', GRUPO, email, 'presente', 'nelly@demo.test', HOY]);
  });
  fila('Acuerdos', ['demo_acu_1', 'demo_asm_1', GRUPO, 'gasto', 'Compra de cuaderno de actas',
    'Gasto de 15 dolares', '{}', 'aprobado', 'nelly@demo.test', HOY, HOY, '', 4, 1, 0]);
  fila('ActasAsamblea', ['acta_demo_1', GRUPO, '2026-07-05T18:00:00.000Z', 'nelly@demo.test',
    'Acta de la asamblea de julio', 'Se aprobo el gasto del cuaderno de actas y se reviso la cartera.',
    'Rosa, Luis, Nelly, Jose, Maria']);

  // --- Reglamento explicito del grupo ---
  fila('GrupoReglas', [GRUPO, 'si', 'si', 0, 3, 1, 0, 0, 50, 'rosa@demo.test', HOY]);
}

(async () => {
  sembrarDemo();
  await startServer();
  const puerto = process.env.TEST_PORT;
  process.stdout.write(
    `\n  Backend de DEMOSTRACION escuchando en http://127.0.0.1:${puerto}\n`
    + `  Datos en memoria (no toca Google Sheets).\n\n`
    + `  Clave de todos los usuarios: ${CLAVE}\n`
    + `    rosa@demo.test    presidenta\n`
    + `    luis@demo.test    tesorero\n`
    + `    nelly@demo.test   secretaria\n`
    + `    jose@demo.test    socio (aporte pendiente, meta y solicitud abierta)\n`
    + `    maria@demo.test   socia (prestamo vigente con pagos)\n`
    + `    admin@demo.test   administrador global\n\n`
    + `  Para apuntar el frontend aqui, en la carpeta del proyecto:\n`
    + `    echo VITE_API_TARGET=http://127.0.0.1:${puerto} > .env.development.local\n`
    + `    npx vite\n\n`
  );
})();
