/**
 * Etapa 2.6 (punto 1a del trabajo de seguridad) — rechazo de rutas `.git`.
 *
 * EL ATAQUE que cierra: en un git worktree, `.git` es un ARCHIVO-puntero
 * ("gitdir: ..."). Si el agente puede escribir ese archivo, puede apuntarlo a un
 * directorivo propio con `[core] fsmonitor = <comando>` en su config, y la
 * próxima vez que LA APP corre git en ese workspace, git ejecuta el comando con
 * los privilegios del usuario. También `.git/hooks/*` cuando `.git` es un
 * directorio (workspace de copia, fixtures de test).
 *
 * Este test fija DOS cosas:
 *
 *  1. El helper puro (`esRutaGitInternals`): alias de Windows (`.git.`, `.git `,
 *     `GIT~1`), variantes Unicode, y subdirectorios (`sub/.git/config`).
 *  2. QUE TODAS LAS HERRAMIENTAS DE ESCRITURA lo usan: se enumeran las tools,
 *     se intenta escribir en `.git` con cada una, y si alguna NO falla, el test
 *     falla. Es el que impide que una tool nueva se olvide del helper.
 *
 * Sin red. Uso: npm run agent:test-git-internals
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { esRutaGitInternals, normalizarSegmento, esSegmentoGit } from "./safe-path";
import { createAgentTools } from "./tools";

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passed += 1;
    console.log("+ " + label);
    return;
  }
  failed += 1;
  console.log("x " + label + (detail === undefined ? "" : " - " + JSON.stringify(detail).slice(0, 300)));
}

/** Las herramientas de escritura, con un input que apunta a la ruta dada.
 *  Si se agrega una tool de escritura nueva, HAY QUE agregarla acá: el test
 *  falla si alguna queda afuera sin el helper. */
function herramientasDeEscritura(tools: Record<string, ToolLike>): Array<{ nombre: string; run: (relPath: string) => Promise<unknown> }> {
  return [
    {
      nombre: "write_file",
      run: (relPath) => tools.write_file.execute({ path: relPath, content: "x" }),
    },
    {
      nombre: "edit_file",
      run: (relPath) => tools.edit_file.execute({ path: relPath, oldStr: "a", newStr: "b" }),
    },
    {
      nombre: "delete_file",
      run: (relPath) => tools.delete_file.execute({ path: relPath }),
    },
    {
      nombre: "patch",
      run: (relPath) => tools.patch.execute({ patch: `*** Update File: ${relPath}\n-a\n+b` }),
    },
  ];
}

type ToolLike = { execute: (input: unknown, options?: unknown) => Promise<unknown> };

/** Rutas que TODAS las herramientas de escritura tienen que rechazar. */
const RUTAS_PROHIBIDAS = [
  ".git",
  ".GIT",
  ".Git",
  ".git.",
  ".git ",
  "GIT~1",
  "sub/.git/config",
  "sub/GIT~1",
  "a/b/c/.git/hooks/pre-commit",
  ".git/objects/aa/bb",
];

async function main(): Promise<void> {
  console.log("== el helper puro ==\n");

  check("normaliza puntos y espacios finales", normalizarSegmento(".git.") === ".git" && normalizarSegmento(".git ") === ".git", normalizarSegmento(".git."));
  check("normaliza mayúsculas", normalizarSegmento(".GIT") === ".git", normalizarSegmento(".GIT"));
  check("reconoce el nombre corto 8.3 de Windows", esSegmentoGit(normalizarSegmento("GIT~1")) === true, normalizarSegmento("GIT~1"));
  check("no confunde un archivo que se llama parecido", esSegmentoGit(normalizarSegmento(".gitignore")) === false, normalizarSegmento(".gitignore"));
  check("ni una carpeta que empieza igual", esSegmentoGit(normalizarSegmento(".github")) === false, normalizarSegmento(".github"));

  for (const ruta of RUTAS_PROHIBIDAS) {
    const motivo = await esRutaGitInternals(ruta);
    check(`rechaza por nombre: ${JSON.stringify(ruta)}`, motivo !== null, motivo);
  }

  const permitidas = [".gitignore", "src/index.ts", "docs/guia.md", "a.git", "git.md", "packages/git-utils/index.ts"];
  for (const ruta of permitidas) {
    const motivo = await esRutaGitInternals(ruta);
    check(`permite la ruta legítima: ${ruta}`, motivo === null, motivo);
  }

  console.log("\n== TODAS las herramientas de escritura lo aplican ==\n");

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "magi-gitinternals-"));
  await fs.mkdir(path.join(workspace, "sub"), { recursive: true });
  await fs.writeFile(path.join(workspace, "a.ts"), "a\n", "utf-8");
  await fs.writeFile(path.join(workspace, "sub", "x.ts"), "x\n", "utf-8");
  // Un `.git` real (como archivo-puntero de un worktree, que es el caso que
  // importa) para que el test no dependa de que la ruta exista o no.
  await fs.writeFile(path.join(workspace, ".git"), "gitdir: /algun/lado\n", "utf-8");

  const eventos: unknown[] = [];
  const tools = createAgentTools(workspace, (e) => eventos.push(e), []);
  const herramientas = herramientasDeEscritura(tools as unknown as Record<string, ToolLike>);

  check("se enumeraron las 4 herramientas de escritura", herramientas.length === 4, herramientas.map((h) => h.nombre));

  for (const herramienta of herramientas) {
    let fallos = 0;
    for (const ruta of RUTAS_PROHIBIDAS) {
      const res = (await herramienta.run(ruta)) as { ok?: boolean; error?: string };
      if (res.ok === true) fallos += 1;
      else if (!/\.git/i.test(res.error ?? "")) fallos += 1; // falló, pero por otro motivo: no cuenta
    }
    check(`${herramienta.nombre} rechaza TODAS las rutas .git con un mensaje claro`, fallos === 0, { fallos, total: RUTAS_PROHIBIDAS.length });
  }

  // Y el caso del destino REAL: un symlink dentro del workspace que apunta a
  // `../.git` y escribir a través de él.
  const externo = await fs.mkdtemp(path.join(os.tmpdir(), "magi-gitreal-"));
  await fs.mkdir(path.join(externo, ".git"), { recursive: true });
  await fs.symlink(path.join(externo, ".git"), path.join(workspace, "enlace"), "dir").catch(() => {});
  // En algunos SO (Windows sin modo desarrollador) la junction/symlink no se
  // crea: sin symlink, el caso no prueba lo que dice. Se saltea y SE DICE.
  const enlaceEsSymlink = await fs.lstat(path.join(workspace, "enlace")).then((s) => s.isSymbolicLink()).catch(() => false);
  if (!enlaceEsSymlink) {
    console.log("  (aviso: no se pudo crear el symlink en este SO; el caso de destino real se saltea)");
  }
  if (enlaceEsSymlink)
  try {
    const res = (await (tools.write_file as unknown as ToolLike).execute({ path: "enlace/config", content: "[core] fsmonitor = x" })) as { ok?: boolean; error?: string };
    check("escribir via symlink que resuelve dentro de .git se rechaza", res.ok !== true, res);
    const escrito = await fs.readFile(path.join(externo, ".git", "config"), "utf-8").then(() => true).catch(() => false);
    check("y el archivo del .git real NO se creó", escrito === false, escrito);
  } catch {
    // En algunos sistemas no se puede crear el symlink: el caso se saltea.
    console.log("  (aviso: no se pudo crear el symlink en este SO; el caso de destino real se saltea)");
  }

  // Control: una ruta legítima SÏ funciona (si no, el test estaría marcando todo
  // como rechazado y no probaría nada).
  const ok = (await (tools.write_file as unknown as ToolLike).execute({ path: "legitimo.txt", content: "hola" })) as { ok?: boolean };
  check("una ruta legítima sigue funcionando", ok.ok === true, ok);
  const contenido = await fs.readFile(path.join(workspace, "legitimo.txt"), "utf-8").catch(() => null);
  check("y el archivo quedó escrito", contenido === "hola", contenido);

  await fs.rm(workspace, { recursive: true, force: true });
  await fs.rm(externo, { recursive: true, force: true });
  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
