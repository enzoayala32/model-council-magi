/**
 * Fase 5.3 — diagnóstico de acceso remoto (lógica pura).
 *
 * `scripts/doctor-remote.ts` solo imprime lo que esta función decide. Acá no
 * hay red ni procesos: se pasa un snapshot del entorno y de la DB, y sale una
 * lista de hallazgos con nivel PASS / WARN / FAIL.
 *
 * Principio: el doctor tiene que detectar las configuraciones que DEJAN LA
 * PUERTA ABIERTA, no las que molestan. Lo peor —un host público sin
 * autenticación— es FAIL, no WARN. Los PASS no son felicitaciones: son para
 * que el operador sepa que esa parte quedó razonada.
 */

export type Severity = "PASS" | "WARN" | "FAIL";

export type DoctorFinding = {
  id: string;
  severity: Severity;
  /** Mensaje corto en español, sin secretos. */
  message: string;
  /** Qué hacer para arreglarlo (o por qué está bien). */
  advice?: string;
};

export type DoctorSnapshot = {
  /** Host donde escucha el server ("127.0.0.1", "0.0.0.0", "localhost"). */
  bindHost: string;
  /** `MAGI_LAN_MODE=1`. */
  lanMode: boolean;
  /** `ALLOWED_HOSTS` crudo (lista separada por comas). */
  allowedHostsRaw: string;
  /** `APP_ACCESS_TOKEN` definido. */
  hasOperatorToken: boolean;
  /** Si el acceso remoto se espera por HTTPS (túnel/TLS). */
  expectsHttps: boolean;
  /** `REMOTE_ACCESS` (vacío, "on", "off"). */
  remoteAccess: string;
  /** `MAGI_DISABLE_LOCAL_IMPLICIT` (el server lo fuerza en modo túnel/LAN). */
  localImplicitDisabled: boolean;
  /** Dispositivos emparejados, con su scope. */
  devices: Array<{ id: string; scope: string; revoked: boolean }>;
  /** Sesiones de operador vivas (no revocadas ni vencidas). */
  liveOperatorSessions: number;
  /** `tailscale funnel` activo: expone a internet, no solo al tailnet. */
  tailscaleFunnel: boolean;
};

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  // IPv6 con corchetes: [::1]:3000. Se resuelve ANTES de partir por ":" o
  // el "::" se come la dirección y queda un string vacío.
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    const inner = end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
    return inner === "::1" || inner === "localhost";
  }
  const clean = trimmed.split(":")[0];
  if (LOOPBACK.has(clean)) return true;
  // 127.0.0.0/8 completo, por si el sistema usa otra dirección de loopback.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(clean)) return true;
  return false;
}

/** Quita el esquema, si alguien lo escribió en ALLOWED_HOSTS. */
function stripScheme(host: string): string {
  return host.replace(/^https?:\/\//, "");
}

/** Hosts de ALLOWED_HOSTS que no son loopback. */
export function nonLoopbackAllowedHosts(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(stripScheme)
    .filter((entry) => !isLoopbackHost(entry));
}

/** ¿La config parece "expuesta a internet" (no solo LAN o tailnet privado)? */
export function looksPubliclyExposed(raw: string): boolean {
  return nonLoopbackAllowedHosts(raw).some((host) => {
    // Redes privadas y tailnet: exposición limitada, no internet abierto.
    if (/\.ts\.net$/i.test(host) || /\.tailscale$/i.test(host)) return false;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
    return true;
  });
}

function activeDevices(snapshot: DoctorSnapshot): number {
  return snapshot.devices.filter((device) => !device.revoked).length;
}

/** Detecta configuraciones peligrosas y devuelve hallazgos ordenados por severidad. */
export function diagnoseRemoteAccess(snapshot: DoctorSnapshot): DoctorFinding[] {
  const findings: DoctorFinding[] = [];
  const nonLoopback = nonLoopbackAllowedHosts(snapshot.allowedHostsRaw);
  const exposed = looksPubliclyExposed(snapshot.allowedHostsRaw);
  const devices = activeDevices(snapshot);
  // `REMOTE_ACCESS=off` corta todo Host que no sea loopback: si está puesto,
  // lo remoto no se alcanza aunque haya hosts configurados.
  const remoteOff = snapshot.remoteAccess.trim().toLowerCase() === "off";
  const exposedBind = !isLoopbackHost(snapshot.bindHost);

  // --- FAIL: host remoto y ninguna credencial posible ---
  if (nonLoopback.length > 0 && !snapshot.hasOperatorToken && devices === 0 && !remoteOff) {
    findings.push({
      id: "remote-without-auth",
      severity: "FAIL",
      message:
        "Hay hosts que no son loopback en ALLOWED_HOSTS y no hay ninguna credencial " +
        "(ni APP_ACCESS_TOKEN ni dispositivos emparejados).",
      advice: "Definí APP_ACCESS_TOKEN o emparejá un dispositivo antes de exponer el server.",
    });
  }

  // --- FAIL: escuchando en todas las interfaces sin credencial ---
  if (exposedBind && !snapshot.hasOperatorToken && devices === 0 && !remoteOff) {
    findings.push({
      id: "bind-without-auth",
      severity: "FAIL",
      message: `El server escucha en ${snapshot.bindHost} (todas las interfaces) sin ninguna credencial configurada.`,
      advice: "Usá `npm start` (solo loopback) o definí APP_ACCESS_TOKEN antes de `start:lan`.",
    });
  }

  // --- FAIL: modo LAN sin token (el server debería negarse a arrancar) ---
  if (snapshot.lanMode && !snapshot.hasOperatorToken) {
    findings.push({
      id: "lan-without-token",
      severity: "FAIL",
      message: "Modo LAN activo sin APP_ACCESS_TOKEN: el acceso remoto quedaría sin autenticar.",
      advice: "Definí APP_ACCESS_TOKEN en .env y reiniciá el server.",
    });
  }

  // --- FAIL: funnel de Tailscale (expone a internet público) ---
  if (snapshot.tailscaleFunnel) {
    findings.push({
      id: "tailscale-funnel",
      severity: "FAIL",
      message: "Hay un funnel de Tailscale activo: expone el server a internet público.",
      advice: "Usá `tailscale serve` (solo tu tailnet). No uses `tailscale funnel` sin Access delante.",
    });
  }

  // --- WARN: host que parece público ---
  if (exposed) {
    findings.push({
      id: "public-host",
      severity: "WARN",
      message: "ALLOWED_HOSTS incluye un host que parece público (no es tailnet ni IP privada).",
      advice: "Verificá que sea intencional y que Cloudflare Access esté delante.",
    });
  }

  // --- WARN: remoto por HTTP plano ---
  if (nonLoopback.length > 0 && !snapshot.expectsHttps && !remoteOff) {
    findings.push({
      id: "remote-http",
      severity: "WARN",
      message: "Acceso desde fuera de la PC por HTTP plano: las cookies y los tokens viajan sin cifrar.",
      advice: "Usá `tailscale serve` (HTTPS) o Cloudflare Tunnel con Access.",
    });
  }

  // --- WARN: acceso implícito apagado (sorprende al operador) ---
  if (snapshot.localImplicitDisabled) {
    findings.push({
      id: "local-implicit-off",
      severity: "WARN",
      message:
        "El acceso local implícito está desactivado: incluso desde esta PC hace falta " +
        "token de operador o dispositivo emparejado.",
      advice: "Es lo esperado con ALLOWED_HOSTS no loopback o modo LAN.",
    });
  }

  // --- WARN: solo token de operador, sin dispositivos revocables ---
  if (snapshot.hasOperatorToken && devices === 0) {
    findings.push({
      id: "no-devices",
      severity: "WARN",
      message: "No hay dispositivos emparejados: el acceso remoto depende solo del token de operador.",
      advice: "Emparejá el teléfono para tener tokens revocables por dispositivo.",
    });
  }

  // --- WARN: dispositivos que pueden modificar (operate) y aprobar (approve) ---
  const operating = snapshot.devices.filter((device) => !device.revoked && device.scope === "operate").length;
  const approving = snapshot.devices.filter((device) => !device.revoked && device.scope === "approve").length;
  if (operating > 0) {
    findings.push({
      id: "operate-devices",
      severity: "WARN",
      message: `Hay ${operating} dispositivo(s) con scope 'operate' (pueden lanzar y modificar tareas).`,
      advice: "Revisá que sigan siendo de confianza.",
    });
  }
  if (approving > 0) {
    findings.push({
      id: "approve-devices",
      severity: "WARN",
      message: `Hay ${approving} dispositivo(s) con scope 'approve' (pueden aplicar cambios con step-up).`,
      advice: "Revisá que sigan siendo de confianza.",
    });
  }

  // --- WARN: sesiones de operador vivas con el server expuesto ---
  if (snapshot.liveOperatorSessions > 0 && (exposedBind || nonLoopback.length > 0)) {
    findings.push({
      id: "live-operator-sessions",
      severity: "WARN",
      message: `Hay ${snapshot.liveOperatorSessions} sesión(es) de operador activas con el server expuesto.`,
      advice: "Si no las reconocés, cerrá sesión o usá \"Revocar todos\".",
    });
  }

  // --- PASS: REMOTE_ACCESS=off corta lo remoto aunque haya hosts ---
  if (remoteOff && nonLoopback.length > 0) {
    findings.push({
      id: "remote-access-off",
      severity: "PASS",
      message: "REMOTE_ACCESS=off: el acceso remoto está cortado aunque haya hosts configurados.",
      advice: "Para habilitarlo, quitá REMOTE_ACCESS=off y reiniciá.",
    });
  }

  // --- PASS: configuración solo local ---
  if (nonLoopback.length === 0 && !exposedBind && !snapshot.lanMode && !snapshot.tailscaleFunnel) {
    findings.push({
      id: "loopback-only",
      severity: "PASS",
      message: "El server solo escucha en loopback y no hay hosts remotos configurados.",
    });
  }

  // --- PASS: remoto con autenticación y exposición acotada ---
  if (nonLoopback.length > 0 && !remoteOff && (snapshot.hasOperatorToken || devices > 0) && !exposed) {
    findings.push({
      id: "remote-authenticated",
      severity: "PASS",
      message: "Acceso remoto configurado con autenticación y exposición acotada (LAN o tailnet).",
    });
  }

  const order: Record<Severity, number> = { FAIL: 0, WARN: 1, PASS: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

/** Conteo por severidad, para el resumen del script. */
export function summarizeFindings(findings: DoctorFinding[]): Record<Severity, number> {
  const summary: Record<Severity, number> = { FAIL: 0, WARN: 0, PASS: 0 };
  for (const finding of findings) summary[finding.severity] += 1;
  return summary;
}

/** Exit code del doctor: 1 si hay algo que deja la puerta abierta. */
export function remoteDoctorExitCode(findings: DoctorFinding[]): number {
  return findings.some((finding) => finding.severity === "FAIL") ? 1 : 0;
}
