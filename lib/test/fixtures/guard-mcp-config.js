/**
 * Guardia de hermetismo para los tests: nadie toca la config MCP real.
 *
 * El bug que motivó esto (Etapa 0.2): `lib/test-mcp-loop.ts` hacía
 * `createMcpTools()` sin fijar `MAGI_MCP_CONFIG`, y esa función llama a
 * `loadMcpConfig()` sin ruta, que cae al directorio de configuración del
 * USUARIO. Peor: al reproducir el bug 0.1 (alta remota de un servidor stdio),
 * la petición llegó a escribir en la config real —quedó un servidor
 * `/bin/sh -c id` en `%APPDATA%\consenso-ia\mcp.json` del usuario.
 *
 * Este módulo se carga con `--require` desde el runner (igual que el de DNS) y
 * hace que cualquier acceso a la ruta real de config lance, con un mensaje que
 * dice qué test fue. Salida: `MAGI_ALLOW_REAL_MCP_CONFIG=1` (solo para
 * debugging consciente).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function rutaRealConfig() {
  // ATENCIÓN: la ruta a proteger es SIEMPRE la del usuario, calculada SIN mirar
  // MAGI_MCP_CONFIG. Si se usara la variable, la guardia bloquearía justo la
  // ruta temporal que el runner asigna para aislar — que es lo que pasó en la
  // primera versión.
  const base =
    process.platform === "win32"
      ? process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(base, "consenso-ia", "mcp.json");
}

const objetivo = rutaRealConfig();

/** ¿La ruta toca la config real (o su respaldo)? */
function tocaReal(rutaEntrante) {
  if (typeof rutaEntrante !== "string") return false;
  let ruta = rutaEntrante;
  try {
    ruta = path.resolve(ruta);
  } catch {
    return false;
  }
  return ruta === objetivo || ruta === objetivo + ".bak" || ruta.startsWith(objetivo + ".tmp-");
}

function fallar(operacion, ruta) {
  const error = new Error(
    "[guardia-mcp] " +
      operacion +
      " sobre la config MCP REAL (" +
      ruta +
      "). Los tests deben fijar MAGI_MCP_CONFIG a una ruta temporal. " +
      "Si realmente querés tocar la real, definí MAGI_ALLOW_REAL_MCP_CONFIG=1.",
  );
  error.code = "MAGI_GUARD_MCP_CONFIG";
  throw error;
}

const permitido = process.env.MAGI_ALLOW_REAL_MCP_CONFIG === "1";

/** Envuelve una función de fs para que falle si apunta a la config real. */
function guardar(nombre, fn) {
  const original = fn;
  const envuelta = function guarded() {
    const argumentos = Array.prototype.slice.call(arguments);
    if (!permitido && tocaReal(argumentos[0])) fallar(nombre, String(argumentos[0]));
    return original.apply(this, argumentos);
  };
  try {
    Object.defineProperty(envuelta, "name", { value: String(nombre) });
  } catch {
    /* no todos los motores permiten redefinir name */
  }
  return envuelta;
}

// Las operaciones que leen o escriben la config.
const PARCHEADAS = [
  ["existsSync", fs.existsSync],
  ["readFileSync", fs.readFileSync],
  ["writeFileSync", fs.writeFileSync],
  ["appendFileSync", fs.appendFileSync],
  ["copyFileSync", fs.copyFileSync],
  ["renameSync", fs.renameSync],
  ["statSync", fs.statSync],
  ["rmSync", fs.rmSync],
  ["unlinkSync", fs.unlinkSync],
  ["mkdirSync", fs.mkdirSync],
];

for (const [nombre, original] of PARCHEADAS) {
  if (typeof original !== "function") continue;
  fs[nombre] = guardar(nombre, original);
}

// promises también, por si algo usa await fs.readFile
if (fs.promises) {
  for (const [nombre, original] of Object.entries(fs.promises)) {
    if (typeof original !== "function") continue;
    fs.promises[nombre] = guardar("promises." + nombre, original);
  }
}

// Aviso único de que la guardia está activa (no ensucia la salida normal).
if (process.env.MAGI_GUARD_VERBOSE === "1") {
  console.log("[guardia-mcp] activa, protegiendo " + objetivo);
}

module.exports = { objetivo: objetivo, tocaReal: tocaReal };
