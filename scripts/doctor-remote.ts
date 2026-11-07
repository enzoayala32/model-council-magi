/**
 * Fase 5.3 — doctor de acceso remoto.
 *
 * No prueba la red: arma un snapshot del entorno y de la DB, se lo pasa a
 * `lib/auth/remote-doctor.ts` (lógica pura, con tests) e imprime lo que
 * decide. Así el operador ve ANTES de exponerse si dejó la puerta abierta.
 *
 * Uso:
 *   npm run doctor:remote
 *   npx tsx scripts/doctor-remote.ts --check-tailscale   # además consulta
 *                                                       # tailscale funnel status
 *
 * Reglas de este script:
 * - NUNCA imprime valores de secretos. Muestra si una variable está puesta,
 *   no su contenido. `ALLOWED_HOSTS` sí se muestra: no es un secreto y es
 *   justo lo que hay que revisar.
 * - Lee `.env` y `.env.local` porque el comando corre fuera de Next: el
 *   server los cargaría solo, este script no. Solo lee, nunca escribe.
 * - No toca la DB si no existe: si todavía no se creó `data/council.db`,
 *   informa 0 dispositivos y 0 sesiones en vez de crear el archivo.
 * - Sin procesos externos salvo con `--check-tailscale` (explícito).
 */
import fs from "node:fs";
import path from "node:path";
import {
  diagnoseRemoteAccess,
  nonLoopbackAllowedHosts,
  remoteDoctorExitCode,
  summarizeFindings,
  type DoctorSnapshot,
} from "../lib/auth/remote-doctor";

/** Carga .env / .env.local sin pisar lo que ya está en el entorno real. */
function loadDotEnv(): void {
  for (const name of [".env", ".env.local"]) {
    const file = path.join(process.cwd(), name);
    if (!fs.existsSync(file)) continue;
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
      let value = line.slice(eq + 1).trim();
      if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  }
}

function env(name: string): string {
  return (process.env[name] ?? "").trim();
}

/** ¿Está puesta? (nunca el valor). */
function presence(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return "no definida";
  return "definida";
}

function mark(label: string, ok: boolean, detail = ""): string {
  const symbol = ok ? "[ok]  " : "[ ! ] ";
  const suffix = detail ? "  (" + detail + ")" : "";
  return "  " + symbol + label.padEnd(46, ".") + suffix;
}

/** Lee la DB solo si existe; si no, informa que todavía no hay nada. */
async function readDbState(): Promise<{ devices: DoctorSnapshot["devices"]; liveSessions: number; note: string | null }> {
  const dataDir = process.env.MAGI_DATA_DIR?.trim()
    ? path.resolve(process.env.MAGI_DATA_DIR.trim())
    : path.join(process.cwd(), "data");
  const dbPath = path.join(dataDir, "council.db");
  if (!fs.existsSync(dbPath)) {
    return { devices: [], liveSessions: 0, note: "todavía no existe " + dbPath };
  }
  // Import tardío: recién acá se decide si la DB se abre.
  const { listDevices } = await import("../lib/auth/devices");
  const { getDb } = await import("../lib/db");

  const devices = listDevices().map((device) => ({
    id: device.id,
    scope: device.scope,
    revoked: device.revokedAt !== null,
  }));
  const now = Date.now();
  let liveSessions = 0;
  try {
    const row = getDb()
      .prepare("SELECT COUNT(*) AS c FROM operator_sessions WHERE revoked_at IS NULL AND expires_at > ?")
      .get(now) as { c: number };
    liveSessions = row.c;
  } catch {
    // Tabla ausente (DB vieja): se trata como cero sesiones.
    liveSessions = 0;
  }
  return { devices, liveSessions, note: null };
}

/** `tailscale funnel status` solo si se pide con --check-tailscale. */
async function detectFunnel(): Promise<boolean> {
  if (!process.argv.includes("--check-tailscale")) return env("TAILSCALE_FUNNEL") === "1";
  try {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync("tailscale", ["funnel", "status"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 8000,
    });
    // Si el comando lista un funnel activo, lo dice; si no hay, responde
    // "no funnel" / "not enabled" / similar.
    return /funnel/i.test(output) && !/(no funnel|not enabled|disabled|none)/i.test(output);
  } catch {
    return env("TAILSCALE_FUNNEL") === "1";
  }
}

async function main(): Promise<void> {
  loadDotEnv();

  const allowedHostsRaw = env("ALLOWED_HOSTS");
  const bindHost = env("MAGI_BIND_HOST") || "127.0.0.1";
  const lanMode = env("MAGI_LAN_MODE") === "1";
  const nonLoopback = nonLoopbackAllowedHosts(allowedHostsRaw);
  // Lo mismo que decide el server al arrancar (server.ts): modo LAN o
  // cualquier host no loopback apagan el acceso local implícito.
  const implicitOff = env("MAGI_DISABLE_LOCAL_IMPLICIT") === "1" || lanMode || nonLoopback.length > 0;
  // Se espera HTTPS si algún host remoto se configuró con esquema https://.
  const expectsHttps = nonLoopback.some((host) => /^https:\/\//i.test(host)) || env("MAGI_TLS") === "1";

  const db = await readDbState();
  const snapshot: DoctorSnapshot = {
    bindHost,
    lanMode,
    allowedHostsRaw,
    hasOperatorToken: env("APP_ACCESS_TOKEN") !== "",
    expectsHttps,
    remoteAccess: env("REMOTE_ACCESS"),
    localImplicitDisabled: implicitOff,
    devices: db.devices,
    liveOperatorSessions: db.liveSessions,
    tailscaleFunnel: await detectFunnel(),
  };

  const activeDevices = db.devices.filter((device) => !device.revoked).length;
  const revokedDevices = db.devices.length - activeDevices;

  console.log("\n=== Doctor de acceso remoto — Consenso IA ===\n");
  console.log("Entorno leído de: variables del proceso + .env + .env.local (solo lectura)");
  console.log("");
  console.log(mark("Puerto", true, env("PORT") || "3000 por defecto"));
  console.log(mark("Bind (MAGI_BIND_HOST)", bindHost === "127.0.0.1", bindHost));
  console.log(mark("Modo LAN (MAGI_LAN_MODE)", lanMode, lanMode ? "activo" : "inactivo"));
  console.log(
    mark(
      "ALLOWED_HOSTS",
      allowedHostsRaw === "" || nonLoopback.length === 0,
      allowedHostsRaw === "" ? "vacío (por defecto: localhost)" : nonLoopback.length + " host(s) remoto(s)",
    ),
  );
  console.log(mark("APP_ACCESS_TOKEN", snapshot.hasOperatorToken, presence("APP_ACCESS_TOKEN")));
  console.log(mark("REMOTE_ACCESS", snapshot.remoteAccess !== "off", snapshot.remoteAccess || "por defecto"));
  console.log(mark("Acceso local implícito", !implicitOff, implicitOff ? "apagado (fail-closed)" : "activo"));
  console.log(mark("Tras túnel HTTPS", nonLoopback.length === 0 || expectsHttps, nonLoopback.length === 0 ? "no aplica (solo loopback)" : expectsHttps ? "sí" : "no (HTTP plano)"));
  console.log(
    mark(
      "Dispositivos",
      revokedDevices === 0 || activeDevices > 0,
      activeDevices + " activo(s), " + revokedDevices + " revocado(s)",
    ),
  );
  console.log(mark("Sesiones de operador vivas", db.liveSessions === 0, String(db.liveSessions)));
  if (snapshot.tailscaleFunnel) {
    console.log(mark("Funnel de Tailscale", false, "activo: expone a internet"));
  }
  if (db.note) {
    console.log("");
    console.log("  (DB: " + db.note + ")");
  }
  if (nonLoopback.length > 0) {
    console.log("");
    console.log("  Hosts remotos configurados:");
    for (const host of nonLoopback) console.log("    - " + host);
  }

  const findings = diagnoseRemoteAccess(snapshot);
  const summary = summarizeFindings(findings);

  for (const severity of ["FAIL", "WARN", "PASS"] as const) {
    const group = findings.filter((finding) => finding.severity === severity);
    if (group.length === 0) continue;
    const title = severity === "FAIL" ? "PROBLEMAS (hay que arreglarlos)" : severity === "WARN" ? "AVISOS" : "BIEN";
    console.log("\n" + severity + " — " + title + "\n");
    for (const finding of group) {
      console.log("  [" + severity + "] " + finding.message);
      if (finding.advice) console.log("         -> " + finding.advice);
    }
  }

  console.log("\n=== Resumen: " + summary.FAIL + " FAIL, " + summary.WARN + " WARN, " + summary.PASS + " PASS ===\n");

  const code = remoteDoctorExitCode(findings);
  if (code !== 0) {
    console.log("El doctor encontró configuraciones que dejan la puerta abierta (exit 1).");
    console.log("No expongas el server hasta arreglarlas. Detalle en docs/ACCESO-REMOTO.md.\n");
  } else {
    console.log("Ninguna configuración detectada deja la puerta abierta (exit 0).");
    console.log("Los WARN son recordatorios, no bloqueos.\n");
  }
  process.exit(code);
}

main().catch((error: unknown) => {
  console.error("El doctor falló al leer el entorno:", error);
  process.exit(1);
});
