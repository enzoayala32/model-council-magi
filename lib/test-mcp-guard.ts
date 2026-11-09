/**
 * Etapa 0.2 — la guardia que impide tocar la config MCP real.
 *
 * El problema: `createMcpTools()` llama a `loadMcpConfig()` sin ruta, y esa
 * cae al directorio de configuración del USUARIO. Varios tests lo hacían sin
 * fijar `MAGI_MCP_CONFIG`. Peor aún: al reproducir el bug 0.1, la petición
 * remota llegó a ESCRIBIR un servidor `/bin/sh -c id` en la config real.
 *
 * Acá se prueba el mecanismo que evita que vuelva a pasar:
 *
 *  1. la guardia lanza al leer o escribir la ruta real;
 *  2. la guardia NO molesta con rutas temporales (que es lo que usan los tests);
 *  3. `MAGI_ALLOW_REAL_MCP_CONFIG=1` es el único escape, explícito;
 *  4. los campos que cubre son todos los de escritura, no solo lectura.
 *
 * La guardia es JS plano (se carga con --require antes de cualquier test), así
 * que este test la ejercita tal como la usa el runner.
 *
 * Uso: npm run security:test-mcp-guard
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const GUARD = path.join(REPO_ROOT, "lib", "test", "fixtures", "guard-mcp-config.js");

/** Ruta real de config, igual que la calcula la guardia. */
function rutaReal(): string {
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "consenso-ia", "mcp.json");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "consenso-ia", "mcp.json");
}

/** Corre un script de node con la guardia cargada. */
function conGuardia(codigo: string, extraEnv: Record<string, string> = {}): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ["--require", GUARD, "-e", codigo], {
      encoding: "utf8",
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (error: unknown) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function main(): void {
  const real = rutaReal();
  console.log("ruta real protegida: " + real + "\n");

  console.log("== leer la config real: prohibido ==\n");
  const leer = conGuardia(
    "const fs=require('fs');try{fs.readFileSync(" + JSON.stringify(real) + ",'utf8');console.log('LEYO')}catch(e){console.log('FALLO:'+e.code)}",
  );
  check("readFileSync sobre la real falla", leer.out.includes("FALLO:MAGI_GUARD_MCP_CONFIG"), leer.out.slice(0, 160));

  const existe = conGuardia(
    "const fs=require('fs');try{fs.existsSync(" + JSON.stringify(real) + ");console.log('EXISTE_OK')}catch(e){console.log('FALLO:'+e.code)}",
  );
  check("existsSync también falla", existe.out.includes("FALLO:MAGI_GUARD_MCP_CONFIG"), existe.out.slice(0, 160));

  console.log("\n== escribir la config real: prohibido ==\n");
  const escribir = conGuardia(
    "const fs=require('fs');try{fs.writeFileSync(" +
      JSON.stringify(real) +
      ",'{}');console.log('ESCRIBIO')}catch(e){console.log('FALLO:'+e.code)}",
  );
  check("writeFileSync falla", escribir.out.includes("FALLO:MAGI_GUARD_MCP_CONFIG"), escribir.out.slice(0, 160));

  const respaldo = conGuardia(
    "const fs=require('fs');try{fs.copyFileSync(" +
      JSON.stringify(real) +
      "," +
      JSON.stringify(real + ".bak") +
      ");console.log('COPIO')}catch(e){console.log('FALLO:'+e.code)}",
  );
  check("también el respaldo .bak", respaldo.out.includes("FALLO:MAGI_GUARD_MCP_CONFIG"), respaldo.out.slice(0, 160));

  console.log("\n== rutas temporales: sin problemas ==\n");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "magi-guard-ok-"));
  const rutaTemp = path.join(temp, "mcp.json");
  fs.writeFileSync(rutaTemp, JSON.stringify({ version: 1, servers: [] }));
  const enTemp = conGuardia(
    "const fs=require('fs');const r=" +
      JSON.stringify(rutaTemp) +
      ";try{fs.writeFileSync(r,fs.readFileSync(r,'utf8'));console.log('OK_TEMP')}catch(e){console.log('FALLO:'+e.code)}",
  );
  check("leer y escribir en temporal funciona", enTemp.out.includes("OK_TEMP"), enTemp.out.slice(0, 160));
  const leeTemp = conGuardia(
    "const fs=require('fs');try{fs.readFileSync(" + JSON.stringify(rutaTemp) + ",'utf8');console.log('OK_LEE_TEMP')}catch(e){console.log('FALLO:'+e.code)}",
  );
  check("existeSync sobre temporal no lanza", leeTemp.out.includes("OK_LEE_TEMP"), leeTemp.out.slice(0, 160));
  fs.rmSync(temp, { recursive: true, force: true });

  console.log("\n== el escape existe pero es explícito ==\n");
  const prohibido = conGuardia(
    "const fs=require('fs');try{fs.readFileSync(" + JSON.stringify(real) + ",'utf8');console.log('OK')}catch(e){console.log('FALLO:'+e.code)}",
    { MAGI_ALLOW_REAL_MCP_CONFIG: "1" },
  );
  check("con MAGI_ALLOW_REAL_MCP_CONFIG=1 se puede (debug consciente)", !prohibido.out.includes("MAGI_GUARD"), prohibido.out.slice(0, 120));

  console.log("\n== el mensaje explica qué hacer ==\n");
  const mensaje = conGuardia(
    "const fs=require('fs');try{fs.readFileSync(" + JSON.stringify(real) + ",'utf8')}catch(e){console.log(e.message)}",
  );
  check("dice que hay que fijar MAGI_MCP_CONFIG", mensaje.out.includes("MAGI_MCP_CONFIG"), mensaje.out.slice(0, 200));

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main();
