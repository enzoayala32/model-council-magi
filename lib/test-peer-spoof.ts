/**
 * Correccion de seguridad: el loopback NO se decide por el header Host.
 *
 * Levanta el server propio (`scripts/dev-server.ts`) en un puerto libre y se
 * conecta por una IP REAL no-loopback del equipo, con el `Host` falsificado.
 * Antes esto alcanzaba para tener "acceso local implicito" sin ninguna
 * credencial: 200 en projects y codigos de emparejamiento generables y
 * canjeables.
 *
 * La prueba Habilitando que el ataque falle:
 *   peer remoto + Host: localhost  -> 403 en todo.
 *
 * Ademas cubre la matriz peer x credencial x ruta.
 *
 * Si el equipo no tiene ninguna interfaz no-loopback, el test se SALTA y lo
 * dice (no falla): no se puede simular el ataque sin una IP real.
 *
 * Uso: npm run security:test-peer-spoof
 */
import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

let passed = 0;
let failed = 0;
let skipped = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) { passed += 1; console.log(`+ ${label}`); return; }
  failed += 1;
  console.log(`x ${label}${detail === undefined ? "" : ` - ${JSON.stringify(detail)}`}`);
}
function skip(label: string, why: string): void {
  skipped += 1;
  console.log(`- SALTADO: ${label} (${why})`);
}

/** IPs IPv4 reales (no loopback, no link-local de Windows). */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (!entry || entry.family !== "IPv4") continue;
      if (entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      out.push(entry.address);
    }
  }
  return out;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForHttp(url: string, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);
      await response.arrayBuffer();
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  return false;
}

type ServerHandle = { child: ChildProcess; base: string; cleanup: () => Promise<void> };

/** Levanta el server propio con las variables dadas. */
async function startServer(env: Record<string, string>, wantedPort?: number): Promise<ServerHandle> {
  const port = wantedPort ?? (await freePort());
  const dataDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "magi-peertest-"));
  // `process.execPath` + `--import tsx`: se evita spawnear `npx`, que en
  // Windows es `npx.cmd` y necesita `shell: true`. Con el binario de node
  // directo es igual en los dos sistemas.
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-server.ts"], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      MAGI_DATA_DIR: dataDir,
      MAGI_DEBUG_HEADERS: "0",
      // Modo desarrollo a propósito: el test tiene que probar el código
      // FUENTE, no un build previo. Con `dev: false` servía el `.next` viejo
      // y un test de seguridad podía pasar sin que el fix estuviera compilado
      // (trampa en la que caímos con el rate limiting).
      MAGI_DEV: "1",
      ...env,
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const ready = await waitForHttp(`${base}/offline`);
  if (!ready) throw new Error("el server no arranco a tiempo");
  return {
    child,
    base,
    cleanup: async () => {
      child.kill("SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 400));
      await fs.promises.rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

async function main(): Promise<void> {
  const lan = lanAddresses();
  if (lan.length === 0) {
    skip("ataque con peer remoto", "el equipo no tiene interfaz IPv4 no-loopback");
    console.log(`\n${passed}/${passed + failed} casos OK, ${skipped} saltado(s).`);
    return;
  }
  const lanIp = lan[0];
  console.log(`(IP LAN usada para el ataque: ${lanIp})\n`);

  // ---------- Server A: modo LAN CON credencial (el caso del ataque) ----------
  const port = await freePort();
  const lanServer = await startServer(
    {
      MAGI_BIND_HOST: "0.0.0.0",
      MAGI_LAN_MODE: "1",
      MAGI_DISABLE_LOCAL_IMPLICIT: "1",
      APP_ACCESS_TOKEN: "operador-de-prueba",
      ALLOWED_HOSTS: `localhost:${port},127.0.0.1:${port},[::1]:${port},${lanIp}:${port}`,
    },
    port,
  );
  const viaLan = `http://${lanIp}:${port}`;
  const viaLoop = `http://127.0.0.1:${port}`;

  console.log("== ataque: peer remoto + Host falsificado ==\n");
  {
    const attacked = await fetch(`${viaLan}/api/agent/projects`, { headers: { Host: `localhost:${port}` } });
    check("GET projects: 403 (antes 200)", attacked.status === 403, attacked.status);

    const pairing = await fetch(`${viaLan}/api/pairing`, {
      method: "POST",
      headers: { Host: `localhost:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ scope: "approve" }),
    });
    check("POST pairing: 403 (antes generaba codigo)", pairing.status === 403, pairing.status);
    const pairingBody = (await pairing.json()) as { code?: string };
    check("y no devuelve ningun codigo", pairingBody.code === undefined, pairingBody);

    const spoofPeer = await fetch(`${viaLan}/api/agent/projects`, {
      headers: { Host: `localhost:${port}`, "x-magi-peer": "loopback", "x-magi-peer-addr": "127.0.0.1" },
    });
    check("falsificar x-magi-peer tampoco alcanza: 403", spoofPeer.status === 403, spoofPeer.status);

    check("GET threads: 403", (await fetch(`${viaLan}/api/threads`, { headers: { Host: `localhost:${port}` } })).status === 403);
    const redeem = await fetch(`${viaLan}/api/pairing/redeem`, {
      method: "POST",
      headers: { Host: `localhost:${port}`, "Content-Type": "application/json" },
      body: JSON.stringify({ code: "AAAA-BBBB-CCCC-DDDD", deviceName: "atacante" }),
    });
    check("POST redeem: 403", redeem.status === 403, redeem.status);
  }

  console.log("\n== matriz: peer x credencial x ruta ==\n");
  {
    const token = { authorization: "Bearer operador-de-prueba" };
    check("remoto + token: projects 200", (await fetch(`${viaLan}/api/agent/projects`, { headers: { Host: `${lanIp}:${port}`, ...token } })).status === 200);
    check("loopback + token: projects 200", (await fetch(`${viaLoop}/api/agent/projects`, { headers: { Host: `localhost:${port}`, ...token } })).status === 200);
    const noToken = await fetch(`${viaLoop}/api/agent/projects`, { headers: { Host: `localhost:${port}` } });
    check("loopback sin token en modo LAN: bloqueado", noToken.status === 401 || noToken.status === 403, noToken.status);
    check("remoto sin token: 403", (await fetch(`${viaLan}/api/agent/projects`, { headers: { Host: `${lanIp}:${port}` } })).status === 403);
    check(
      "remoto + token: pairing 200",
      (await fetch(`${viaLan}/api/pairing`, { method: "POST", headers: { Host: `${lanIp}:${port}`, "Content-Type": "application/json", ...token }, body: JSON.stringify({ scope: "observe" }) })).status === 200,
    );
    // En modo LAN el acceso implícito está apagado A PROPOSITO: ni loopback
    // sin credencial puede generar códigos. El proxy corta antes de la ruta.
    const loopPairing = await fetch(`${viaLoop}/api/pairing`, { method: "POST", headers: { Host: `localhost:${port}`, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "observe" }) });
    check("loopback real sin token en modo LAN: bloqueado", loopPairing.status === 403, loopPairing.status);
    // Y con el token del operador, el mismo loopback si puede.
    check(
      "loopback real + token: pairing 200",
      (await fetch(`${viaLoop}/api/pairing`, { method: "POST", headers: { Host: `localhost:${port}`, "Content-Type": "application/json", authorization: "Bearer operador-de-prueba" }, body: JSON.stringify({ scope: "observe" }) })).status === 200,
    );
    // Una ruta inexistente SIN credencial la corta el proxy (403); con
    // credencial recién se llega al 404 de Next.
    check("ruta inexistente sin credencial: 403 del proxy", (await fetch(`${viaLan}/api/no/existe`, { headers: { Host: `${lanIp}:${port}` } })).status === 403);
    check(
      "ruta inexistente con token: 404 de Next",
      (await fetch(`${viaLan}/api/no/existe`, { headers: { Host: `${lanIp}:${port}`, authorization: "Bearer operador-de-prueba" } })).status === 404,
    );
  }

  console.log("\n== cookie de dispositivo FALSA + Host mentido ==\n");
  {
    // El proxy no puede validar la cookie contra la DB, así que la deja
    // pasar. La ruta es la que tiene que denegar. Antes 28 de 35 rutas no lo
    // hacían: con una cookie falsa se creaban proyectos (201).
    const fake = { Host: `localhost:${port}`, cookie: "magi_device_token=cookie-inventada" };
    for (const route of ["/api/agent/projects", "/api/agent/browse?path=/", "/api/agent/models", "/api/threads", "/api/council/runs", "/api/models/catalog", "/api/provider-resilience/status"]) {
      const response = await fetch(`${viaLan}${route}`, { headers: fake });
      const code = response.status;
      check("GET " + route + " con cookie falsa: 401/403", code === 401 || code === 403, code);
    }
    const post = await fetch(`${viaLan}/api/agent/projects`, {
      method: "POST",
      headers: { ...fake, "content-type": "application/json", origin: `http://${lanIp}:${port}` },
      body: JSON.stringify({ name: "ataque", localPath: "C:/tmp" }),
    });
    check("POST /api/agent/projects con cookie falsa: 401/403", post.status === 401 || post.status === 403, post.status);

    const del = await fetch(`${viaLan}/api/council/runs/id-inventado`, { method: "DELETE", headers: fake });
    check("DELETE /api/council/runs/:id con cookie falsa: 401/403", del.status === 401 || del.status === 403, del.status);

    // Y con el operador real, esas mismas rutas sí pasan.
    check("GET projects con operador: 200", (await fetch(`${viaLan}/api/agent/projects`, { headers: { Host: `${lanIp}:${port}`, authorization: "Bearer operador-de-prueba" } })).status === 200);
  }
  await lanServer.cleanup();

  // ---------- Server B: loopback, sin credencial (uso local de siempre) ----------
  const localServer = await startServer({});
  const localPort = Number(new URL(localServer.base).port);
  console.log("\n== uso local sin credencial (no debe cambiar) ==\n");
  {
    check("GET projects: 200", (await fetch(`${localServer.base}/api/agent/projects`, { headers: { Host: `localhost:${localPort}` } })).status === 200);
    check("GET threads: 200", (await fetch(`${localServer.base}/api/threads`, { headers: { Host: `localhost:${localPort}` } })).status === 200);
    check(
      "POST pairing: 200 (peer verificado)",
      (await fetch(`${localServer.base}/api/pairing`, { method: "POST", headers: { Host: `localhost:${localPort}`, "Content-Type": "application/json" }, body: JSON.stringify({ scope: "observe" }) })).status === 200,
    );
    check("GET /m carga: 200", (await fetch(`${localServer.base}/m`, { headers: { Host: `localhost:${localPort}` } })).status === 200);
  }
  await localServer.cleanup();

  // ---------- Server C: modo LAN sin credencial debe negarse a arrancar ----------
  console.log("\n== modo LAN sin credencial no arranca ==\n");
  {
    const port3 = await freePort();
    const child = spawn(process.execPath, ["--import", "tsx", "scripts/dev-server.ts"], {
      cwd: path.resolve(import.meta.dirname, ".."),
      env: {
        ...process.env,
        PORT: String(port3),
        MAGI_BIND_HOST: "0.0.0.0",
        MAGI_LAN_MODE: "1",
        MAGI_DATA_DIR: await fs.promises.mkdtemp(path.join(os.tmpdir(), "magi-nolan-")),
      },
      stdio: "pipe",
    });
    const code: number | null = await new Promise((resolve) => {
      child.on("exit", (c) => resolve(c));
      setTimeout(() => resolve(null), 30_000);
    });
    check("el server sale con error (no arranco)", code !== null && code !== 0, code);
    child.kill("SIGKILL");
  }

  console.log(`\n${passed}/${passed + failed} casos OK, ${skipped} saltado(s).`);
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
