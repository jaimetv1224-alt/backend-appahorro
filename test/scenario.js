/** Utilidades para montar escenarios realistas (usuarios, grupos, roles). */

const bcrypt = require('bcrypt');
const { fake, post, get } = require('./harness');

const HASH_CACHE = new Map();
function hash(pw) {
  if (!HASH_CACHE.has(pw)) HASH_CACHE.set(pw, bcrypt.hashSync(pw, 4));
  return HASH_CACHE.get(pw);
}

/** Inserta un usuario directamente en la hoja (mas rapido que el endpoint). */
function seedUser({ nombre, email, password = 'Clave123', role = 'member', balance = 0, estado = 'activo' }) {
  const sheet = fake.ensureSheet('Users');
  sheet.grid.push([nombre, email.toLowerCase(), hash(password), role, balance, new Date().toISOString(), '', '', estado]);
  return { nombre, email: email.toLowerCase(), password, role };
}

async function login(email, password = 'Clave123') {
  const res = await post('/api/login', { email, password });
  if (res.status !== 200) {
    throw new Error(`Login fallido para ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.token || res.body.data?.token;
}

/** Inserta un vinculo usuario-grupo directamente. */
function seedLink(email, groupId, role = 'member', estado = 'activo') {
  const sheet = fake.ensureSheet('UserGroupLinks');
  sheet.grid.push([email.toLowerCase(), groupId, new Date().toISOString(), role, estado, 'seed']);
}

/** Inserta un grupo directamente con su configuracion financiera. */
function seedGroup({ id, nombre, presidente, valorAccion = 10, interesMensual = 2, aporteMensual = 20 }) {
  const sheet = fake.ensureSheet('Groups');
  sheet.grid.push([
    id, nombre, `Grupo de prueba ${nombre}`, presidente, presidente, new Date().toISOString(),
    1000, 0, aporteMensual, new Date().toISOString(), '', 'activo', 30, 0, 'ahorro',
    valorAccion, interesMensual,
  ]);
  return id;
}

/**
 * Escenario base: 1 admin global, 1 grupo con presidente, tesorero, secretario y 2 socios.
 * Devuelve tokens listos para usar.
 */
async function baseScenario({ groupId = 'G1', leaders = 3 } = {}) {
  const users = {
    admin: seedUser({ nombre: 'Admin', email: 'admin@juntago.test', role: 'admin' }),
    presi: seedUser({ nombre: 'Presidenta Ana', email: 'presi@juntago.test' }),
    teso: seedUser({ nombre: 'Tesorero Beto', email: 'teso@juntago.test' }),
    secre: seedUser({ nombre: 'Secretaria Cira', email: 'secre@juntago.test' }),
    socio1: seedUser({ nombre: 'Socio Dani', email: 'socio1@juntago.test' }),
    socio2: seedUser({ nombre: 'Socia Elsa', email: 'socio2@juntago.test' }),
    ajeno: seedUser({ nombre: 'Ajeno Fito', email: 'ajeno@juntago.test' }),
  };

  seedGroup({ id: groupId, nombre: 'Banco Comunal Salinas', presidente: users.presi.email });
  seedLink(users.presi.email, groupId, 'presidente');
  if (leaders >= 2) seedLink(users.teso.email, groupId, 'tesorero');
  if (leaders >= 3) seedLink(users.secre.email, groupId, 'secretario');
  seedLink(users.socio1.email, groupId, 'member');
  seedLink(users.socio2.email, groupId, 'member');

  // Segundo grupo con UN solo lider (para probar manipulacion de quorum entre grupos)
  seedGroup({ id: 'G2', nombre: 'Grupo Chico', presidente: users.ajeno.email });
  seedLink(users.ajeno.email, 'G2', 'presidente');

  const tokens = {};
  for (const [k, u] of Object.entries(users)) {
    tokens[k] = await login(u.email, u.password);
  }
  return { users, tokens, groupId };
}

module.exports = { seedUser, seedLink, seedGroup, login, baseScenario, hash };
