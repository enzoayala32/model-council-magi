/**
 * Etapa 2.3 — comandos `/` personalizados del Coding Agent.
 *
 * Sin red, sin modelo real, sin proceso que se quede colgado. Cubre:
 *
 *  1. Descubrimiento: `.magi/commands/**` del proyecto y el directorio global;
 *     id derivado de la ruta (`team/review.md` → `/team/review`); el de proyecto
 *     gana al global con el mismo id.
 *  2. Expansión: `$ARGUMENTS`, posiciones `$1..$n` con comillas, número más alto
 *     que consume el resto, posiciones faltantes como string vacío, y el
 *     "fallback" (sin placeholder, los argumentos se agregan al final).
 *  3. SEGURIDAD: los bloques de shell están APAGADOS por defecto y se marcan
 *     como omitidos; con la variable prendida se corren, la salida se redacta y
 *     se recorta; y un archivo ilegible o un comando inexistente hacen que el
 *     prompt viaje TAL CUAL (un comando roto nunca rompe la task).
 *
 * Uso: npm run agent:test-commands
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { registerSecret } from "../provider-resilience/redact";
import {
  MAX_SHELL_OUTPUT_CHARS,
  expandirPlantilla,
  globalCommandsDir,
  listAgentCommands,
  resolveCommandPrompt,
  shellBlocksEnabled,
  splitArguments,
  type AgentCommand,
} from "./commands";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  console.log("x " + label + (detail === undefined ? "" : " - " + JSON.stringify(detail).slice(0, 400)));
}

/** Falso secreto, para verificar que la redacción funciona de verdad. */
const SECRETO_FALSO = "nvapi-" + "A".repeat(60);

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magi-commands-"));
  const proyecto = path.join(root, "proyecto");
  await fs.mkdir(path.join(proyecto, ".magi", "commands"), { recursive: true });

  // Un proyecto con comandos: uno simple, uno anidado, uno sin descripción.
  await fs.writeFile(
    path.join(proyecto, ".magi", "commands", "review.md"),
    ["---", "description: Revisar cambios", "---", "Revisá $ARGUMENTS. Reportá bugs primero."].join("\n"),
    "utf-8",
  );
  await fs.mkdir(path.join(proyecto, ".magi", "commands", "team"), { recursive: true });
  await fs.writeFile(
    path.join(proyecto, ".magi", "commands", "team", "release.md"),
    ["---", "description: Preparar release", "model: nvidia/nemotron-3.5-lightning-30b-a3b", "---", "Prepará el release de $1."].join("\n"),
    "utf-8",
  );
  // Sin descripción: existe, pero no debería aparecer como opción en la paleta.
  await fs.writeFile(path.join(proyecto, ".magi", "commands", "silencio.md"), "Hacé $ARGUMENTS sin explicar.\n", "utf-8");
  // Un archivo que no es .md: se ignora.
  await fs.writeFile(path.join(proyecto, ".magi", "commands", "notas.txt"), "no es un comando\n", "utf-8");

  console.log("== descubrimiento ==\n");

  const globalDir = path.join(root, "global-commands");
  const { commands, errors } = await listAgentCommands(proyecto, { MAGI_AGENT_COMMANDS_DIR: globalDir, HOME: root });
  check("descubre los 3 comandos .md del proyecto", commands.length === 3, commands.map((c) => c.id));
  check("el id sale de la ruta (anidado → /team/release)", commands.some((c) => c.id === "/team/release"), commands.map((c) => c.id));
  check("la descripción sale del frontmatter", commands.find((c) => c.id === "/review")?.description === "Revisar cambios");
  check("el override de modelo sale del frontmatter", commands.find((c) => c.id === "/team/release")?.model === "nvidia/nemotron-3.5-lightning-30b-a3b");
  check("un comando sin descripción queda sin descripción (la UI decide si mostrarlo)", commands.find((c) => c.id === "/silencio")?.description === undefined);
  check("un archivo que no es .md se ignora", !commands.some((c) => c.id === "/notas"));
  check("sin errores de lectura", errors.length === 0, errors);
  check("el directorio global por defecto cuelga de la config del usuario", globalCommandsDir({}).includes("consenso-ia"));

  // El de proyecto gana al global con el mismo id.
  await fs.mkdir(globalDir, { recursive: true });
  await fs.writeFile(path.join(globalDir, "review.md"), "---\ndescription: version GLOBAL\n---\nPlantilla global.\n", "utf-8");
  const conGlobal = await listAgentCommands(proyecto, { MAGI_AGENT_COMMANDS_DIR: globalDir, HOME: root });
  check("el comando de proyecto gana al global con el mismo id", conGlobal.commands.find((c) => c.id === "/review")?.scope === "project", conGlobal.commands.find((c) => c.id === "/review"));
  check("y el global sigue disponible si no colisiona", conGlobal.commands.length === 3, conGlobal.commands.map((c) => c.id));

  console.log("\n== expansión de plantillas ==\n");

  const review = commands.find((c) => c.id === "/review") as AgentCommand;
  const equipoRelease = commands.find((c) => c.id === "/team/release") as AgentCommand;

  const conArgs = await expandirPlantilla(review, "src/auth.ts");
  check("$ARGUMENTS se reemplaza por el texto completo", conArgs.prompt === "Revisá src/auth.ts. Reportá bugs primero.", conArgs.prompt);

  const sinArgs = await expandirPlantilla(review, "");
  check("$ARGUMENTS vacío deja el hueco vacío (no rompe)", sinArgs.prompt === "Revisá . Reportá bugs primero.", sinArgs.prompt);

  const multi = await expandirPlantilla(equipoRelease, 'v1.2.3 "con notas"');
  check("$1 como único placeholder se come el resto (regla de OpenCode)", multi.prompt === "Prepará el release de v1.2.3 con notas.", multi.prompt);

  checkEq(splitArguments('src/auth.ts "error handling"'), ["src/auth.ts", "error handling"], "las comillas agrupan y se quitan");
  checkEq(splitArguments("  a   b  "), ["a", "b"], "los espacios repetidos no crean huecos");

  // Plantilla con varias posiciones: el número más alto consume el resto.
  const dosPosiciones: AgentCommand = { id: "/dos", template: "Compará $1 con $2.", source: "x", scope: "project" };
  const dos = await expandirPlantilla(dosPosiciones, "api stable branch");
  check("$1 toma una posición y $2 (el más alto) se come el resto", dos.prompt === "Compará api con stable branch.", dos.prompt);

  const falta = await expandirPlantilla(dosPosiciones, "api");
  check("una posición que falta queda como string vacío", falta.prompt === "Compará api con .", falta.prompt);

  // Fallback: sin placeholder, los argumentos se agregan al final.
  const sinPlaceholders: AgentCommand = { id: "/fijo", template: "Corré los tests y reportá.", source: "x", scope: "project" };
  const fallback = await expandirPlantilla(sinPlaceholders, "todo esto");
  check("sin placeholder, los argumentos se agregan al final", fallback.prompt === "Corré los tests y reportá.\n\ntodo esto", fallback.prompt);

  console.log("\n== seguridad: bloques de shell ==\n");

  check("apagados por defecto", shellBlocksEnabled({}) === false, shellBlocksEnabled({}));
  check("se prenden solo con valor explícito", shellBlocksEnabled({ MAGI_AGENT_COMMANDS_SHELL: "1" }) === true);
  check("'0' no los prende", shellBlocksEnabled({ MAGI_AGENT_COMMANDS_SHELL: "0" }) === false);

  const conShell: AgentCommand = {
    id: "/diff",
    template: "Revisá este diff:\n\n!`git status --porcelain`",
    source: "x",
    scope: "project",
  };
  const omitido = await expandirPlantilla(conShell, "", { cwd: proyecto });
  check("con los bloques apagados, el comando NO se ejecuta", !omitido.prompt.includes("MAGI"), omitido.prompt);
  check("y queda un marcador visible en su lugar", omitido.prompt.includes("[bloque de shell omitido"), omitido.prompt);
  check("se cuenta cuántos se omitieron", omitido.shellBloquesOmitidos === 1, omitido.shellBloquesOmitidos);
  check("el comando crudo NO queda en el prompt (el modelo no lo vería como texto a ejecutar)", !omitido.prompt.includes("!`git status`"), omitido.prompt);

  // Prendidos: corre, y la salida se redacta.
  const corrido = await expandirPlantilla(conShell, "", { cwd: proyecto, permitirShell: true });
  check("con la variable prendida, el bloque se corre (aunque falle)", corrido.prompt.includes("<shell-output"), corrido.prompt.slice(0, 160));
  check("la salida va enmarcada como dato", corrido.prompt.includes("</shell-output>"), corrido.prompt);

  // Un bloque cuya SALIDA tiene un secreto registrado: tiene que salir redactado.
  // `redactSecrets` es un registro explícito de los secretos reales del proceso
  // (no una heurística de formato), así que el test registra el suyo.
  registerSecret(SECRETO_FALSO);
  const conSecreto: AgentCommand = {
    // El secreto va en el COMANDO, no en la plantilla: el comando se reemplaza
    // por su salida, así que lo único que puede quedar en el prompt es la salida
    // ya redactada.
    id: "/filtra",
    template: 'Datos: !`node -p process.env.MAGI_SECRETO_FALSO`',
    source: "x",
    scope: "project",
  };
  process.env.MAGI_SECRETO_FALSO = SECRETO_FALSO;
  const filtrado = await expandirPlantilla(conSecreto, "", { cwd: proyecto, permitirShell: true });
  check("la salida del shell se redacta (no filtra secretos)", !filtrado.prompt.includes(SECRETO_FALSO), filtrado.prompt.slice(0, 240));
  check("y la redacción queda a la vista", filtrado.prompt.includes("[REDACTED]"), filtrado.prompt.slice(0, 240));
  delete process.env.MAGI_SECRETO_FALSO;

  // Un bloque que no existe: error marcado, no una excepción.
  const falla: AgentCommand = { id: "/falla", template: "Salida: !`comando-que-no-existe-xyz`", source: "x", scope: "project" };
  const conFalla = await expandirPlantilla(falla, "", { cwd: proyecto, permitirShell: true });
  check("un bloque que falla deja un error marcado, no una excepción", conFalla.prompt.includes('error="true"'), conFalla.prompt.slice(0, 200));

  // Salida enorme: se recorta al tope.
  const enorme: AgentCommand = { id: "/enorme", template: "Salida: !`printf '%0.s-' {1..20000}`", source: "x", scope: "project" };
  const recortado = await expandirPlantilla(enorme, "", { cwd: proyecto, permitirShell: true });
  check("la salida enorme se recorta al tope", recortado.prompt.length <= MAX_SHELL_OUTPUT_CHARS + 400, recortado.prompt.length);

  console.log("\n== resolveCommandPrompt: el prompt tal cual si no es comando ==\n");

  const esComando = await resolveCommandPrompt("/review src/auth.ts", proyecto, { MAGI_AGENT_COMMANDS_DIR: globalDir, HOME: root });
  check("un comando conocido se expande", esComando.expandido === true, esComando);
  check("el prompt queda expandido", esComando.prompt.includes("Revisá src/auth.ts."), esComando.prompt);

  const noEsComando = await resolveCommandPrompt("revisá src/auth.ts a mano", proyecto, { MAGI_AGENT_COMMANDS_DIR: globalDir, HOME: root });
  check("un prompt normal viaja TAL CUAL", noEsComando.expandido === false && noEsComando.prompt === "revisá src/auth.ts a mano", noEsComando);

  const comandoInexistente = await resolveCommandPrompt("/no-existe arg", proyecto, { MAGI_AGENT_COMMANDS_DIR: globalDir, HOME: root });
  check("un comando que no existe viaja TAL CUAL (no rompe la task)", comandoInexistente.expandido === false && comandoInexistente.prompt === "/no-existe arg", comandoInexistente);

  const sinArgumentos = await resolveCommandPrompt("/review", proyecto, { MAGI_AGENT_COMMANDS_DIR: globalDir, HOME: root });
  check("un comando sin argumentos se expande con el hueco vacío", sinArgumentos.expandido === true && sinArgumentos.prompt.startsWith("Revisá ."), sinArgumentos.prompt);

  // Un directorio de comandos ilegible: error informado, prompt tal cual.
  const roto = path.join(root, "roto");
  await fs.mkdir(path.join(roto, ".magi", "commands"), { recursive: true });
  await fs.writeFile(path.join(roto, ".magi", "commands", "x.md"), "plantilla\n", "utf-8");
  const conError = await resolveCommandPrompt("/review algo", roto, { MAGI_AGENT_COMMANDS_DIR: path.join(root, "no-existe"), HOME: root });
  check("aunque algo falle al leer, el prompt se resuelve (o viaja tal cual)", conError.expandido === true || conError.prompt === "/review algo", conError);

  await fs.rm(root, { recursive: true, force: true });
  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

function checkEq(actual: unknown, expected: unknown, label: string): void {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { esperado: expected, actual });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
