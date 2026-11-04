/**
 * Fase 3.1 — mostrar por qué URL se puede entrar a la app.
 *
 * Con `next dev`/`next start` normales el server escucha solo en
 * loopback, así que el teléfono no puede entrar. Con `-H 0.0.0.0`
 * (`npm run dev:lan`) escucha en todas las interfaces, pero el usuario
 * necesita saber la IP real de la PC para escribirla en el teléfono —
 * y `localhost` en el teléfono apunta al teléfono mismo.
 *
 * Este script lista las interfaces IPv4 reales y arma las URLs. No
 * depende de nada: usa `node:os`, que ya existe.
 *
 * Uso: npm run print-access-urls [-- --port 3000]
 */
import os from "node:os";

const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = portArg ? portArg.slice("--port=".length) : (process.env.PORT ?? "3000");

/** IPv4 reales, sin loopback ni link-local de Windows (169.254.x). */
function lanAddresses(): Array<{ iface: string; address: string }> {
  const out: Array<{ iface: string; address: string }> = [];
  const interfaces = os.networkInterfaces();
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (!entry || entry.family !== "IPv4") continue;
      if (entry.internal) continue;
      if (entry.address.startsWith("169.254.")) continue;
      out.push({ iface: name, address: entry.address });
    }
  }
  return out;
}

function main(): void {
  console.log("\n=== URLs de acceso — Consenso IA ===\n");
  console.log(`Loopback (esta PC):      http://localhost:${port}`);
  console.log(`                         http://127.0.0.1:${port}`);

  const addresses = lanAddresses();
  if (addresses.length === 0) {
    console.log("\nNo encontré interfaces de red activas (¿Wi-Fi/Ethernet apagados?).");
    console.log("Conectate a una red y volvé a correr este script.\n");
    return;
  }

  console.log("\nLAN (teléfono en la misma red, con `npm run dev:lan` o `start:lan`):");
  for (const { iface, address } of addresses) {
    console.log(`  http://${address}:${port}   [${iface}]`);
  }

  console.log("\nDesde internet: NO abras el puerto en el router. Usá un túnel privado");
  console.log("y autenticado (Tailscale o Cloudflare Tunnel) — ver docs/ACCESO-REMOTO.md.");
  console.log("Todo acceso que no venga de loopback exige autenticación (Fase 4).\n");
}

main();
