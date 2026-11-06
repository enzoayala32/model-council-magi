/**
 * Lanzador del server propio (`server.ts`).
 *
 * Existe para no depender de `cross-env` ni de sintaxis de shell: en Windows
 * `npm run` usa `cmd`, donde `VARIABLE=valor comando` no funciona, y en Linux
 * usa `sh`. Acá las variables se setean desde Node, que es lo mismo en los
 * dos sistemas.
 *
 * Uso:
 *   npm run dev         # tsx scripts/dev-server.ts --dev
 *   npm run dev:lan     # + --lan
 *   npm start           # tsx scripts/dev-server.ts
 *   npm run start:lan   # + --lan
 */
const args = process.argv.slice(2);

if (args.includes("--dev")) process.env.MAGI_DEV = "1";
if (args.includes("--lan")) {
  process.env.MAGI_LAN_MODE = "1";
  // El modo LAN apaga el acceso local implícito: ni localhost entra sin
  // credencial. Exponerse en la red no puede dejar un agujero "local".
  process.env.MAGI_DISABLE_LOCAL_IMPLICIT = "1";
}

// `import()` y no `await import()`: tsx compila a CJS y no soporta top-level
// await en ese formato.
void import("../server.ts");
