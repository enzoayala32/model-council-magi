/**
 * Fase 5.3 — tests del diagnóstico de acceso remoto (lógica pura).
 *
 * Sin red ni procesos externos: se pasa un snapshot y se verifican los
 * hallazgos. Sirve de red de seguridad para el doctor: si una configuración
 * peligrosa deja de detectarse, estos tests fallan.
 *
 * Uso: npm run security:test-remote-doctor
 */
import {
  diagnoseRemoteAccess,
  looksPubliclyExposed,
  nonLoopbackAllowedHosts,
  remoteDoctorExitCode,
  summarizeFindings,
  type DoctorSnapshot,
} from "./auth/remote-doctor";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  const suffix = detail === undefined ? "" : " - " + JSON.stringify(detail);
  console.log("x " + label + suffix);
}

function ids(snapshot: DoctorSnapshot): string[] {
  return diagnoseRemoteAccess(snapshot).map((finding) => finding.id);
}

function severityOf(snapshot: DoctorSnapshot, id: string): string | undefined {
  return diagnoseRemoteAccess(snapshot).find((finding) => finding.id === id)?.severity;
}

function hasSeverity(snapshot: DoctorSnapshot, severity: string): boolean {
  return diagnoseRemoteAccess(snapshot).some((finding) => finding.severity === severity);
}

const base: DoctorSnapshot = {
  bindHost: "127.0.0.1",
  lanMode: false,
  allowedHostsRaw: "localhost:3000,127.0.0.1:3000",
  hasOperatorToken: false,
  expectsHttps: false,
  remoteAccess: "",
  localImplicitDisabled: false,
  devices: [],
  liveOperatorSessions: 0,
  tailscaleFunnel: false,
};

const OBSERVE = { id: "d-observe", scope: "observe", revoked: false };
const OPERATE = { id: "d-operate", scope: "operate", revoked: false };
const APPROVE = { id: "d-approve", scope: "approve", revoked: false };
const REVOKED = { id: "d-revoked", scope: "observe", revoked: true };

function main(): void {
  console.log("== clasificación de hosts ==\n");
  check(
    "solo loopback -> sin hosts remotos",
    nonLoopbackAllowedHosts("localhost:3000,127.0.0.1:3000,[::1]:3000").length === 0,
  );
  check(
    "IP de LAN es remota",
    JSON.stringify(nonLoopbackAllowedHosts("192.168.0.50:3000")) === JSON.stringify(["192.168.0.50:3000"]),
  );
  check("hostname de túnel es remoto", nonLoopbackAllowedHosts("mi-pc.tail1234.ts.net").length === 1);
  check("ignora entradas vacías", nonLoopbackAllowedHosts(",,localhost:3000,").length === 0);
  check("acepta esquema http/https", nonLoopbackAllowedHosts("https://mi-pc.tail1234.ts.net").length === 1);
  check("127.0.0.5 también es loopback", nonLoopbackAllowedHosts("127.0.0.5:3000").length === 0);

  console.log("\n== parece expuesto a internet ==\n");
  check("IP privada no parece pública", !looksPubliclyExposed("192.168.0.50:3000"));
  check("10.x no parece pública", !looksPubliclyExposed("10.0.0.5"));
  check("172.16.x no parece pública", !looksPubliclyExposed("172.16.1.1"));
  check("172.31.x no parece pública", !looksPubliclyExposed("172.31.255.1"));
  check("172.32.x SÍ parece pública", looksPubliclyExposed("172.32.0.1"));
  check("tailnet .ts.net no parece público", !looksPubliclyExposed("mi-pc.tail1234.ts.net"));
  check("dominio cualquiera parece público", looksPubliclyExposed("mi-app.ejemplo.com"));
  check("una IP pública parece pública", looksPubliclyExposed("203.0.113.9:3000"));

  console.log("\n== FAIL: lo que deja la puerta abierta ==\n");
  const failCases: Array<[string, DoctorSnapshot]> = [
    ["host público sin ninguna credencial", { ...base, allowedHostsRaw: "localhost:3000,mi-app.ejemplo.com" }],
    ["bind en 0.0.0.0 sin credencial", { ...base, bindHost: "0.0.0.0" }],
    ["bind en la IP de la LAN sin credencial", { ...base, bindHost: "192.168.0.104", allowedHostsRaw: "192.168.0.104:3000" }],
    ["modo LAN sin token", { ...base, lanMode: true, bindHost: "0.0.0.0" }],
    ["funnel de Tailscale activo", { ...base, bindHost: "0.0.0.0", hasOperatorToken: true, tailscaleFunnel: true }],
  ];
  for (const [label, snapshot] of failCases) {
    check("FAIL: " + label, hasSeverity(snapshot, "FAIL"), ids(snapshot));
    check("  exit code 1: " + label, remoteDoctorExitCode(diagnoseRemoteAccess(snapshot)) === 1);
  }

  check(
    "con token, el host público deja de ser FAIL",
    !hasSeverity({ ...base, allowedHostsRaw: "localhost:3000,mi-app.ejemplo.com", hasOperatorToken: true }, "FAIL"),
  );
  check(
    "con dispositivo activo, el host público deja de ser FAIL",
    !hasSeverity({ ...base, allowedHostsRaw: "mi-app.ejemplo.com", devices: [OBSERVE] }, "FAIL"),
  );
  check(
    "dispositivo revocado no cuenta como credencial",
    hasSeverity({ ...base, allowedHostsRaw: "mi-app.ejemplo.com", devices: [REVOKED] }, "FAIL"),
  );
  check(
    "REMOTE_ACCESS=off corta el FAIL por falta de credencial",
    !hasSeverity({ ...base, allowedHostsRaw: "mi-app.ejemplo.com", remoteAccess: "off" }, "FAIL"),
  );

  console.log("\n== WARN: riesgos que merecen aviso ==\n");
  check(
    "WARN: remoto por HTTP",
    severityOf({ ...base, allowedHostsRaw: "192.168.0.50:3000", hasOperatorToken: true }, "remote-http") === "WARN",
  );
  check(
    "sin WARN de HTTP si se espera HTTPS",
    !ids({ ...base, allowedHostsRaw: "192.168.0.50:3000", hasOperatorToken: true, expectsHttps: true }).includes(
      "remote-http",
    ),
  );
  check(
    "WARN: host público",
    severityOf({ ...base, allowedHostsRaw: "mi-app.ejemplo.com", hasOperatorToken: true }, "public-host") === "WARN",
  );
  check(
    "sin WARN de host público si es tailnet",
    !ids({ ...base, allowedHostsRaw: "mi-pc.tail1234.ts.net", hasOperatorToken: true }).includes("public-host"),
  );
  check(
    "WARN: acceso implícito apagado",
    severityOf({ ...base, localImplicitDisabled: true }, "local-implicit-off") === "WARN",
  );
  check("sin ese WARN si el implícito está activo", !ids(base).includes("local-implicit-off"));
  check("WARN: sin dispositivos", severityOf({ ...base, hasOperatorToken: true }, "no-devices") === "WARN");
  check(
    "sin WARN si hay dispositivo activo",
    !ids({ ...base, hasOperatorToken: true, devices: [OBSERVE] }).includes("no-devices"),
  );
  check(
    "WARN: dispositivos operate",
    severityOf({ ...base, hasOperatorToken: true, devices: [OPERATE] }, "operate-devices") === "WARN",
  );
  check(
    "WARN: dispositivos approve",
    severityOf({ ...base, hasOperatorToken: true, devices: [APPROVE] }, "approve-devices") === "WARN",
  );
  check(
    "un dispositivo revocado no genera WARN de scope",
    !ids({ ...base, hasOperatorToken: true, devices: [REVOKED] }).includes("approve-devices"),
  );
  check(
    "WARN: sesiones vivas con server expuesto",
    severityOf({ ...base, bindHost: "0.0.0.0", hasOperatorToken: true, liveOperatorSessions: 2 }, "live-operator-sessions") ===
      "WARN",
  );
  check("sin WARN de sesiones en loopback", !ids({ ...base, liveOperatorSessions: 2 }).includes("live-operator-sessions"));

  console.log("\n== PASS: configuraciones sanas ==\n");
  check("PASS: solo loopback", ids(base).includes("loopback-only"));
  check("PASS: loopback sin FAIL ni WARN", diagnoseRemoteAccess(base).every((f) => f.severity === "PASS"));
  check(
    "PASS: tailnet con token y HTTPS",
    ids({
      ...base,
      allowedHostsRaw: "localhost:3000,mi-pc.tail1234.ts.net",
      hasOperatorToken: true,
      expectsHttps: true,
      localImplicitDisabled: true,
    }).includes("remote-authenticated"),
  );
  check(
    "PASS: REMOTE_ACCESS=off corta lo remoto",
    severityOf({ ...base, allowedHostsRaw: "mi-app.ejemplo.com", remoteAccess: "off" }, "remote-access-off") === "PASS",
  );
  check("exit code 0 sin FAIL", remoteDoctorExitCode(diagnoseRemoteAccess(base)) === 0);
  check("el resumen cuenta por severidad", (() => {
    const summary = summarizeFindings(diagnoseRemoteAccess({ ...base, bindHost: "0.0.0.0", lanMode: true }));
    return summary.FAIL === 2 && summary.WARN === 0 && summary.PASS === 0;
  })());

  console.log("\n== higiene de los mensajes ==\n");
  check(
    "los hallazgos se ordenan por severidad",
    (() => {
      const ranked = diagnoseRemoteAccess({
        ...base,
        allowedHostsRaw: "mi-app.ejemplo.com",
        bindHost: "0.0.0.0",
        lanMode: true,
      }).map((finding) => (finding.severity === "FAIL" ? 0 : finding.severity === "WARN" ? 1 : 2));
      return JSON.stringify(ranked) === JSON.stringify([...ranked].sort((a, b) => a - b));
    })(),
  );
  check(
    "ningún mensaje filtra el valor del token",
    diagnoseRemoteAccess({ ...base, allowedHostsRaw: "mi-app.ejemplo.com" }).every(
      (finding) => !finding.message.includes("secreto") && !finding.message.includes("APP_ACCESS_TOKEN="),
    ),
  );
  check(
    "ningún hallazgo duplica id",
    (() => {
      const found = diagnoseRemoteAccess({
        ...base,
        bindHost: "0.0.0.0",
        lanMode: true,
        tailscaleFunnel: true,
        devices: [OBSERVE, OPERATE, APPROVE, REVOKED],
        liveOperatorSessions: 3,
      }).map((finding) => finding.id);
      return new Set(found).size === found.length;
    })(),
  );
  check(
    "todo FAIL trae advice",
    diagnoseRemoteAccess({ ...base, bindHost: "0.0.0.0", lanMode: true }).every(
      (finding) => finding.severity !== "FAIL" || Boolean(finding.advice),
    ),
  );

  console.log("\n== combinación realista: LAN + túnel + dispositivos ==\n");
  {
    const full: DoctorSnapshot = {
      bindHost: "0.0.0.0",
      lanMode: true,
      allowedHostsRaw: "localhost:3001,mi-pc.tail1234.ts.net,router.ejemplo.com",
      hasOperatorToken: true,
      expectsHttps: false,
      remoteAccess: "",
      localImplicitDisabled: true,
      devices: [OBSERVE, OPERATE, APPROVE, REVOKED],
      liveOperatorSessions: 1,
      tailscaleFunnel: false,
    };
    const byId = new Map(diagnoseRemoteAccess(full).map((finding) => [finding.id, finding]));
    check("modo LAN con token no es FAIL", !byId.has("lan-without-token"));
    check("sigue el WARN de HTTP", byId.has("remote-http"));
    check("sigue el WARN de host público", byId.has("public-host"));
    check("sigue el WARN de operate", byId.has("operate-devices"));
    check("sigue el WARN de approve", byId.has("approve-devices"));
    check("sigue el WARN de implícito apagado", byId.has("local-implicit-off"));
    check("sigue el WARN de sesiones vivas", byId.has("live-operator-sessions"));
    check("no hay WARN de sin-dispositivos (hay activos)", !byId.has("no-devices"));
    check("no hay PASS de loopback-only", !byId.has("loopback-only"));
    check("no hay PASS de remote-authenticated (hay host público)", !byId.has("remote-authenticated"));
    check("exit code 0 (no hay FAIL)", remoteDoctorExitCode(diagnoseRemoteAccess(full)) === 0);

    const withFunnel = { ...full, tailscaleFunnel: true };
    const funnelIds = ids(withFunnel);
    check("el funnel agregado es FAIL", severityOf(withFunnel, "tailscale-funnel") === "FAIL");
    check("el funnel cambia el exit code", remoteDoctorExitCode(diagnoseRemoteAccess(withFunnel)) === 1);
    check("el funnel no oculta los WARN previos", funnelIds.includes("remote-http"));
  }

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main();
