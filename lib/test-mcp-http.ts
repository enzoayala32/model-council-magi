/**
 * Fase 7 (pendiente) — transporte HTTP para clientes MCP, hermético.
 *
 * Levanta el servidor MCP falso en modo HTTP sobre 127.0.0.1 (puerto libre) y
 * prueba la cadena completa SIN red externa:
 *
 *  - lectura ejecuta y viene marcada como no confiable;
 *  - escritura exige aprobación (fail-closed: solo `readOnlyTools` exime);
 *  - redirect rechazado (el fixture responde 307 a /redirige);
 *  - host privado/link-local/metadata rechazado, por IP literal y por DNS
 *    (resolución inyectada);
 *  - respuesta gigante recortada;
 *  - las cabeceras con secretos no aparecen en el texto devuelto;
 *  - http en claro solo con `allowInsecureLocal: true` y host loopback.
 *
 * Uso: npm run security:test-mcp-http
 */
import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpHttpConnection } from "./mcp/http-client";
import { validateHttpTransport, isBlockedAddress, resolveHeaderTemplates } from "./mcp/http-transport";
import type { McpServerConfig } from "./mcp/config";

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

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const FIXTURE = path.join(REPO_ROOT, "lib", "test", "fixtures", "fake-mcp-server.js");

if (!process.env.MAGI_DATA_DIR) {
  process.env.MAGI_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "magi-mcp-http-"));
}

/** Puerto libre real (no solo "no escuchado": se abre y se cierra). */
async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function serverConfig(url: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name: "http-falso",
    transport: "http",
    url,
    httpHeaders: { "x-mcp-token": "${MI_TOKEN_MCP}" },
    tools: ["leer", "list_files", "get_updates", "search_created_issues", "borrar"],
    // FAIL-CLOSED: las cuatro primeras eximidas; "borrar" no.
    readOnlyTools: ["leer", "list_files", "get_updates", "search_created_issues"],
    readOnly: false,
    timeoutMs: 5000,
    ...overrides,
  };
}

async function main(): Promise<void> {
  const port = await freePort();
  const base = "http://127.0.0.1:" + port;
  const child = spawn(process.execPath, [FIXTURE, "--http", "--port=" + String(port)], {
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  child.stdout.on("data", () => undefined);
  // Esperar a que el server esté listo.
  for (let i = 0; i < 40; i += 1) {
    try {
      const probe = await fetch(base + "/", { method: "POST", body: "{}" });
      await probe.arrayBuffer();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  try {
    console.log("== clasificacion de direcciones ==\n");
    check("127.0.0.1 bloqueada", isBlockedAddress("127.0.0.1"));
    check("10.x bloqueada", isBlockedAddress("10.1.2.3"));
    check("192.168.x bloqueada", isBlockedAddress("192.168.0.5"));
    check("169.254.x bloqueada", isBlockedAddress("169.254.1.2"));
    check("metadata 169.254.169.254 bloqueada", isBlockedAddress("169.254.169.254"));
    check("::1 bloqueada", isBlockedAddress("::1"));
    check("fe80:: bloqueada", isBlockedAddress("fe80::1"));
    check("ipv4 mapeada en ipv6 bloqueada", isBlockedAddress("::ffff:127.0.0.1"));
    check("una IP pública NO bloqueada", !isBlockedAddress("142.250.185.70"));

    console.log("\n== validacion de la URL del transporte ==\n");
    const httpsOk = await validateHttpTransport("https://mcp.ejemplo.com/mcp", {
      resolve: () => Promise.resolve(["93.184.216.34"]),
    });
    check("https publico valida", httpsOk.ok === true, httpsOk);

    for (const [label, url, expected] of [
      ["http remoto sin allowInsecureLocal", "http://mcp.ejemplo.com/mcp", "protocol"],
      ["credenciales en la URL", "https://user:pass@mcp.ejemplo.com/mcp", "credentials"],
      ["IP privada literal", "https://10.0.0.5/mcp", "private-address"],
      ["IP de metadata literal", "https://169.254.169.254/mcp", "private-address"],
      ["loopback literal por https", "https://127.0.0.1:8443/mcp", "protocol"],
      ["basura", "no-es-url", "malformed"],
    ] as Array<[string, string, string]>) {
      const result = await validateHttpTransport(url, { resolve: () => Promise.resolve(["93.184.216.34"]) });
      check("rechaza: " + label, result.ok === false && result.reason === expected, result);
    }

    const localOk = await validateHttpTransport("http://127.0.0.1:8799/mcp", { allowInsecureLocal: true });
    check("http loopback con allowInsecureLocal explicit o valida", localOk.ok === true, localOk);
    const localRemoto = await validateHttpTransport("http://mcp.ejemplo.com/mcp", { allowInsecureLocal: true });
    check("allowInsecureLocal NO habilita http remoto", localRemoto.ok === false && localRemoto.reason === "protocol");

    const dnsPrivado = await validateHttpTransport("https://mcp.ejemplo.com/mcp", {
      resolve: () => Promise.resolve(["10.1.2.3"]),
    });
    check("host que resuelve a privada se rechaza", dnsPrivado.ok === false && dnsPrivado.reason === "private-address");
    const dnsMuerto = await validateHttpTransport("https://mcp.ejemplo.com/mcp", {
      resolve: () => Promise.reject(new Error("ENOTFOUND")),
    });
    check("si no resuelve, se rechaza", dnsMuerto.ok === false && dnsMuerto.reason === "dns");

    console.log("\n== headers por referencia, nunca valores en claro ==\n");
    process.env.MI_TOKEN_MCP = "secreto-de-prueba";
    const resueltos = resolveHeaderTemplates({ authorization: "${MI_TOKEN_MCP}", "x-fijo": "valor-fijo" });
    check("la referencia se resuelve", resueltos.headers.authorization === "secreto-de-prueba", resueltos.headers);
    check("un header sin referencia pasa igual", resueltos.headers["x-fijo"] === "valor-fijo");
    const faltante = resolveHeaderTemplates({ authorization: "${NO_EXISTE_MCP}" }, { NODE_ENV: "test" });
    check("una variable inexistente omite el header (no manda el texto literal)", faltante.headers.authorization === undefined, faltante.headers);
    check("e informa cuál faltó", faltante.missing.length === 1 && faltante.missing[0] === "NO_EXISTE_MCP");

    console.log("\n== cliente http contra el servidor local ==\n");
    const conn = new McpHttpConnection(
      serverConfig(base + "/mcp"),
      // El fixture corre en HTTP sobre loopback: hace falta el opt-in.
      { untrustedLabel: "http-falso", transportOptions: { allowInsecureLocal: true } },
    );
    const handshake = await conn.connect();
    check("el handshake http funciona", handshake.ok === true, handshake);

    if (handshake.ok) {
      check("lista las herramientas del servidor", handshake.tools.length === 8, handshake.tools.map((t) => t.name));
      check("ping responde", await conn.ping());

      for (const name of ["leer", "list_files", "get_updates", "search_created_issues"]) {
        const salida = await conn.callTool(name, {});
        check("ejecuta sin aprobación (esta en readOnlyTools): " + name, salida.ok === true, salida.error);
        check("viene marcada como no confiable: " + name, salida.text.includes("no confiable"));
        check("trae el contenido del servidor: " + name, salida.text.includes("EJECUTO:" + name));
      }

      // El token de la cabecera no aparece en el texto devuelto.
      const eco = await conn.callTool("leer", {});
      check("el secreto de la cabecera no aparece en la salida", !eco.text.includes("secreto-de-prueba"), eco.text.slice(0, 120));

      // Respuesta gigante: se recorta (el tope de lectura).
      const connGrande = new McpHttpConnection(
        serverConfig(base + "/mcp", { tools: [...serverConfig(base).tools, "gigante"], readOnlyTools: [...serverConfig(base).readOnlyTools, "gigante"] }),
        { untrustedLabel: "grande", transportOptions: { allowInsecureLocal: true } },
      );
      await connGrande.connect();
      const grande = await connGrande.callTool("gigante", {});
      check("una respuesta gigante se corta con error explicito (no JSON roto)", grande.ok === false && (grande.error ?? "").includes("demasiado grande"), grande);
      await connGrande.close();

      // Escritura: en el flujo del loop, exige aprobación porque no está en
      // readOnlyTools. El cliente en sí ejecuta (la decisión es del llamador).
      const escritura = await conn.callTool("borrar", {});
      check("el cliente http ejecuta (la aprobacion la decide el loop)", escritura.ok === true, escritura.error);
    }

    console.log("\n== redirect y url invalida al vuelo ==\n");
    const redir = new McpHttpConnection(
      serverConfig(base + "/redirige"),
      { untrustedLabel: "redir", transportOptions: { allowInsecureLocal: true } },
    );
    const redirResult = await redir.connect();
    check("un redirect (307) no se sigue: connect falla", redirResult.ok === false, redirResult);

    const ssrf = new McpHttpConnection(serverConfig("https://127.0.0.1:9/mcp"), { untrustedLabel: "ssrf" });
    const ssrfResult = await ssrf.connect();
    check("una url de loopback se rechaza antes de conectar", ssrfResult.ok === false, ssrfResult);

    const sinUrl = new McpHttpConnection(serverConfig(""), { untrustedLabel: "sinurl" });
    check("sin url falla limpio", (await sinUrl.connect()).ok === false);

    const faltaVar = new McpHttpConnection(
      serverConfig(base + "/mcp", { httpHeaders: { authorization: "${TOKEN_QUE_NO_EXISTE}" } }),
      { untrustedLabel: "falta", transportOptions: { allowInsecureLocal: true } },
    );
    const faltaResult = await faltaVar.connect();
    check("una variable de header inexistente se informa", faltaResult.ok === false && faltaResult.error.includes("TOKEN_QUE_NO_EXISTE"), faltaResult);

    await conn.close();
    await redir.close();
    await ssrf.close();
    await sinUrl.close();
    await faltaVar.close();
  } finally {
    child.kill("SIGKILL");
    delete process.env.MI_TOKEN_MCP;
  }

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
