/**
 * Cliente minimo del Chrome DevTools Protocol.
 *
 * Sirve para capturar pantallas reales de la app sin instalar Playwright ni
 * Puppeteer: lanza Chrome en modo headless con el puerto de depuracion abierto y
 * lo maneja por WebSocket (Node 22 ya trae WebSocket nativo).
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CANDIDATOS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

function buscarNavegador() {
  const encontrado = CANDIDATOS.find((ruta) => fs.existsSync(ruta));
  if (!encontrado) throw new Error('No se encontro Chrome ni Edge en las rutas habituales.');
  return encontrado;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarEndpoint(puerto, intentos = 60) {
  for (let i = 0; i < intentos; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${puerto}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch (e) { /* todavia arrancando */ }
    await dormir(250);
  }
  throw new Error('El navegador no abrio el puerto de depuracion.');
}

class Navegador {
  constructor({ ancho = 1440, alto = 900, escala = 2 } = {}) {
    this.ancho = ancho;
    this.alto = alto;
    this.escala = escala;
    this.siguienteId = 1;
    this.pendientes = new Map();
    this.sesion = null;
  }

  async abrir() {
    const ejecutable = buscarNavegador();
    const puerto = 9333 + Math.floor(Math.random() * 400);
    this.perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'juntago-capturas-'));

    this.proceso = spawn(ejecutable, [
      '--headless=new',
      `--remote-debugging-port=${puerto}`,
      `--user-data-dir=${this.perfil}`,
      `--window-size=${this.ancho},${this.alto}`,
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-gpu',
    ], { stdio: 'ignore' });

    const wsNavegador = await esperarEndpoint(puerto);
    this.ws = new WebSocket(wsNavegador);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (evento) => this._recibir(evento.data));

    // Crea la pestana y se engancha a ella
    const { targetId } = await this.enviar('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.enviar('Target.attachToTarget', { targetId, flatten: true });
    this.sesion = sessionId;

    await this.enviar('Page.enable');
    await this.enviar('Runtime.enable');
    await this.enviar('Emulation.setDeviceMetricsOverride', {
      width: this.ancho, height: this.alto, deviceScaleFactor: this.escala, mobile: false,
    });
  }

  _recibir(datos) {
    let mensaje;
    try { mensaje = JSON.parse(datos); } catch (e) { return; }
    if (mensaje.id && this.pendientes.has(mensaje.id)) {
      const { resolve, reject } = this.pendientes.get(mensaje.id);
      this.pendientes.delete(mensaje.id);
      if (mensaje.error) reject(new Error(`${mensaje.error.message} (${JSON.stringify(mensaje.error.data || '')})`));
      else resolve(mensaje.result);
    }
  }

  enviar(method, params = {}) {
    const id = this.siguienteId++;
    const paquete = { id, method, params };
    if (this.sesion) paquete.sessionId = this.sesion;
    return new Promise((resolve, reject) => {
      this.pendientes.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(paquete));
      setTimeout(() => {
        if (this.pendientes.has(id)) {
          this.pendientes.delete(id);
          reject(new Error(`Tiempo agotado en ${method}`));
        }
      }, 30000);
    });
  }

  /** Navega y espera a que la pagina cargue. */
  async ir(url, esperaMs = 1200) {
    await this.enviar('Page.navigate', { url });
    await dormir(esperaMs);
  }

  /** Evalua JavaScript en la pagina y devuelve el valor (serializado). */
  async evaluar(expresion, esperaMs = 0) {
    const r = await this.enviar('Runtime.evaluate', {
      expression: `(async () => { ${expresion} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`Error en la pagina: ${r.exceptionDetails.text} ${JSON.stringify(r.exceptionDetails.exception?.description || '')}`);
    }
    if (esperaMs) await dormir(esperaMs);
    return r.result?.value;
  }

  /** Cambia el tamano de la ventana emulada (util para el modo movil). */
  async tamano(ancho, alto, escala = this.escala) {
    await this.enviar('Emulation.setDeviceMetricsOverride', {
      width: ancho, height: alto, deviceScaleFactor: escala, mobile: ancho < 768,
    });
    await dormir(400);
  }

  /** Captura la pantalla y la guarda como PNG. */
  async capturar(rutaArchivo, { pantallaCompleta = false } = {}) {
    const opciones = { format: 'png', captureBeyondViewport: pantallaCompleta };
    if (pantallaCompleta) {
      // Los elementos fijos (la barra inferior de navegacion) quedarian flotando
      // en mitad de la imagen larga. Se ocultan solo mientras dura la captura.
      await this.enviar('Runtime.evaluate', {
        expression: `
          window.__ocultos = [...document.querySelectorAll('*')].filter((el) => {
            const p = getComputedStyle(el).position;
            return (p === 'fixed' || p === 'sticky') && el.offsetHeight > 0;
          });
          window.__ocultos.forEach((el) => { el.dataset.visPrevia = el.style.visibility; el.style.visibility = 'hidden'; });
          window.__ocultos.length;
        `,
        returnByValue: true,
      });
      await dormir(200);
      const metricas = await this.enviar('Page.getLayoutMetrics');
      const alto = Math.min(Math.ceil(metricas.cssContentSize.height), 4200);
      opciones.clip = { x: 0, y: 0, width: this.ancho, height: alto, scale: 1 };
    }
    const { data } = await this.enviar('Page.captureScreenshot', opciones);
    if (pantallaCompleta) {
      await this.enviar('Runtime.evaluate', {
        expression: `(window.__ocultos || []).forEach((el) => { el.style.visibility = el.dataset.visPrevia || ''; }); 1;`,
        returnByValue: true,
      });
    }
    fs.mkdirSync(path.dirname(rutaArchivo), { recursive: true });
    fs.writeFileSync(rutaArchivo, Buffer.from(data, 'base64'));
    return rutaArchivo;
  }

  async cerrar() {
    try { this.ws.close(); } catch (e) { /* ya cerrado */ }
    try { this.proceso.kill(); } catch (e) { /* ya termino */ }
    await dormir(300);
    try { fs.rmSync(this.perfil, { recursive: true, force: true }); } catch (e) { /* da igual */ }
  }
}

module.exports = { Navegador, dormir, buscarNavegador };
