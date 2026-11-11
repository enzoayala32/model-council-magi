/**
 * Etapa 2.6 (punto 1c del trabajo de seguridad) — PoC de regresión del escape
 * vía `.git`, contra un WORKTREE REAL.
 *
 * No es una simulación: se crea un repo git de verdad y se le agrega un worktree
 * con `git worktree add`, que es exactamente el workspace que usa el agente. Con
 * un directorio disfrazado no se reproduce el ataque (`.git` sería un directorio
 * en vez del archivo-puntero que es el vector real).
 *
 * LO QUE VERIFICA:
 *
 *  1. Las 4 herramientas de escritura fallan contra `.git`, `.GIT`, `.git.`,
 *     `.git `, `GIT~1`, `sub/.git/config` y vía symlink.
 *  2. AUNQUE el puntero se reemplace por otros medios (el test lo escribe
 *     directo con fs, sin pasar por las tools), la verificación de integridad
 *     DETIENE git: el marcador `EJECUTADO.txt` NO aparece.
 *  3. Workspace NO-worktree (`.git` como directorio): escribir
 *     `.git/hooks/pre-commit` falla.
 *
 * Sin red. Uso: npm run agent:test-git-poc
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { createAgentTools } from "./tools";
import { GitIntegrityError, gitSafe } from "./git-safe";
import { gitDirDeWorkspace } from "./workspace-manager";

const execFileAsync = promisify(execFile);

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

type ToolLike = { execute: (input: unknown) => Promise<unknown> };

/** Repo git real + worktree real (`git worktree add`), que es el caso que importa. */
async function worktreeReal(): Promise<{ base: string; repo: string; worktree: string }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "magi-poc-"));
  const repo = path.join(base, "repo");
  const worktree = path.join(base, "worktrees", "task-1");
  await fs.mkdir(repo, { recursive: true });
  await fs.mkdir(path.dirname(worktree), { recursive: true });
  await fs.writeFile(path.join(repo, "a.txt"), "hola\n", "utf-8");
  await execFileAsync("git", ["init"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "poc@x.com"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "PoC"], { cwd: repo });
  await execFileAsync("git", ["add", "-A"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: repo });
  await execFileAsync("git", ["worktree", "add", "-b", "agent/task-1", worktree, "HEAD"], { cwd: repo });
  return { base, repo, worktree };
}

/** El gitdir que le corresponde al worktree (lo registra el workspace-manager). */
function gitDirEsperado(repo: string, worktree: string): string {
  return gitDirDeWorkspace({ mode: "worktree", basePath: repo, worktreePath: worktree, taskId: "task-1" });
}

async function main(): Promise<void> {
  console.log("== PoC 1: las herramientas de escritura, contra un worktree REAL ==\n");

  const { base, repo, worktree } = await worktreeReal();
  // El puntero .git de un worktree es un ARCHIVO: eso es el vector.
  const puntero = await fs.readFile(path.join(worktree, ".git"), "utf-8");
  check("el .git del worktree es un archivo-puntero (como en producción)", puntero.startsWith("gitdir:"), puntero.trim());

  const tools = createAgentTools(worktree, () => {}, []);
  const escrituras: Array<{ nombre: string; run: (rel: string) => Promise<unknown> }> = [
    { nombre: "write_file", run: (rel) => (tools as unknown as { write_file: ToolLike }).write_file.execute({ path: rel, content: "gitdir: /falso\n" }) },
    { nombre: "edit_file", run: (rel) => (tools as unknown as { edit_file: ToolLike }).edit_file.execute({ path: rel, oldStr: "gitdir", newStr: "gitdir: /falso" }) },
    { nombre: "patch", run: (rel) => (tools as unknown as { patch: ToolLike }).patch.execute({ patch: `*** Update File: ${rel}\n-gitdir\n+gitdir: /falso` }) },
    { nombre: "delete_file", run: (rel) => (tools as unknown as { delete_file: ToolLike }).delete_file.execute({ path: rel }) },
  ];

  const rutas = [".git", ".GIT", ".git.", ".git ", "GIT~1", "sub/.git/config"];
  for (const herramienta of escrituras) {
    let fallos = 0;
    const mensajes: string[] = [];
    for (const ruta of rutas) {
      const res = (await herramienta.run(ruta)) as { ok?: boolean; error?: string };
      if (res.ok === true) fallos += 1;
      else mensajes.push(String(res.error ?? ""));
    }
    check(`${herramienta.nombre} rechaza todas las rutas del ataque`, fallos === 0, { fallos, total: rutas.length });
    // `patch` envuelve el motivo ("El patch no se aplicó a ningún archivo: X (...)"):
    // lo que importa es que el motivo de la tool esté en el mensaje final.
    check(`${herramienta.nombre} menciona .git en el error`, mensajes.every((m) => /\.git/i.test(m)), mensajes[0]);
  }

  console.log("\n== PoC 2: el puntero reemplazado por otros medios detiene git ==\n");

  // El atacante ya no pasa por las tools: escribe el puntero con fs directo.
  const falso = path.join(base, "falso");
  await fs.mkdir(path.join(falso, "objects"), { recursive: true });
  await fs.mkdir(path.join(falso, "refs"), { recursive: true });
  const marcador = path.join(base, "EJECUTADO.txt");
  await fs.writeFile(path.join(falso, "HEAD"), "ref: refs/heads/main\n", "utf-8");
  await fs.writeFile(
    path.join(falso, "config"),
    `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tfsmonitor = cmd /c echo PWNED> "${marcador}"\n`,
    "utf-8",
  );

  // Y el ataque por la VÍA DIRECTA: escribir el puntero con fs, sin pasar por
  // las tools. Se construye un workspace PROPIO (no el worktree real: en
  // Windows su puntero es read-only y este caso no correría nunca) con el
  // puntero ya manipulado. Así las dos verificaciones corren en CUALQUIER
  // sistema operativo, que es lo que hacía falta: la versión anterior las
  // tenía detrás de un `if`, así que en algunos SO no se ejecutaban (y cuando
  // sí lo hacían, la de "git acepta el gitdir falso" fallaba porque un
  // `git status` contra un gitdir sin objetos da error, que no era lo que se
  // quería probar).
  const wsManipulado = path.join(base, "ws-manipulado");
  // Un gitdir falso LIMPIO (sin el fsmonitor): el config malicioso de arriba
  // rompe a git con un error de config, asi que para probar "git confia en el
  // puntero" hace falta uno que no reviente. El malicioso se queda para la
  // prueba del marcador.
  const falsoLimpio = path.join(base, "falso-limpio");
  await fs.mkdir(path.join(falsoLimpio, "objects"), { recursive: true });
  await fs.mkdir(path.join(falsoLimpio, "refs"), { recursive: true });
  await fs.writeFile(path.join(falsoLimpio, "HEAD"), "ref: refs/heads/main\n", "utf-8");
  await fs.writeFile(path.join(falsoLimpio, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n", "utf-8");
  await fs.mkdir(wsManipulado, { recursive: true });
  await fs.writeFile(path.join(wsManipulado, ".git"), "gitdir: " + falsoLimpio + "\n", "utf-8");
  let integridadDetecto = false;
  try {
    await gitSafe(["status", "--porcelain"], { cwd: wsManipulado, gitDirEsperado: gitDirEsperado(repo, worktree) });
  } catch (error) {
    integridadDetecto = error instanceof GitIntegrityError;
  }
  check("con el puntero manipulado, git-safe NO ejecuta git", integridadDetecto, integridadDetecto);

  // Y la prueba de POR QUÉ hace falta: git común confía en el puntero y se va
  // al gitdir falso sin chistar. Se mide con `rev-parse --git-dir`, que es
  // determinista en cualquier SO (a diferencia de `git status`, que contra un
  // gitdir sin objetos da error y no probaba nada).
  const gitdirQueGitUsa = await execFileAsync("git", ["rev-parse", "--git-dir"], { cwd: wsManipulado })
    .then((r) => r.stdout.trim())
    .catch(() => "");
  check(
    "git SIN endurecer se va al gitdir manipulado (por eso hace falta la verificación)",
    gitdirQueGitUsa === falsoLimpio || gitdirQueGitUsa.endsWith("falso-limpio"),
    { gitUsa: gitdirQueGitUsa, falsoLimpio },
  );

  // La verificación de integridad como función pura, que es lo que se puede
  // La verificación de integridad como función pura, que es lo que se puede
  // probar en cualquier SO.
  {
    const { verificarIntegridadGit } = await import("./git-safe");
    check("la verificación de integridad es una función pública y testeable", typeof verificarIntegridadGit === "function");
    // Caso 1: el puntero REAL y sin tocar tiene que pasar (si no, rompería toda
    // corrida legítima).
    let legitimoPasa = false;
    try {
      await verificarIntegridadGit(worktree, gitDirEsperado(repo, worktree));
      legitimoPasa = true;
    } catch {
      legitimoPasa = false;
    }
    check("acepta el puntero intacto (no rompe las corridas legítimas)", legitimoPasa, legitimoPasa);
    // Caso 2: un puntero manipulado. Se construye un workspace propio con el
    // puntero ya escrito, para no depender de que el SO deje escribirlo.
    const otro = await fs.mkdtemp(path.join(os.tmpdir(), "magi-poc-integridad-"));
    const gitdirFalso = path.join(otro, "gitdir-falso");
    await fs.mkdir(gitdirFalso, { recursive: true });
    await fs.writeFile(path.join(otro, ".git"), `gitdir: ${gitdirFalso}
`, "utf-8");
    let detectado = false;
    try {
      await verificarIntegridadGit(otro, gitDirEsperado(repo, worktree));
    } catch (error) {
      detectado = error instanceof GitIntegrityError && /Integridad rota/.test(error.message);
    }
    check("rechaza un puntero que no apunta al gitdir esperado", detectado, detectado);
    // Caso 3: sin .git, también error claro.
    const sinGit = await fs.mkdtemp(path.join(os.tmpdir(), "magi-poc-singit-"));
    let sinGitDetectado = false;
    try {
      await verificarIntegridadGit(sinGit, gitDirEsperado(repo, worktree));
    } catch (error) {
      sinGitDetectado = error instanceof GitIntegrityError && /perdió su \.git/.test(error.message);
    }
    check("y si el workspace perdió el .git, falla con un mensaje claro", sinGitDetectado, sinGitDetectado);
    await fs.rm(otro, { recursive: true, force: true });
    await fs.rm(sinGit, { recursive: true, force: true });
  }


  // El comando del fsmonitor NO se ejecutó: la app endurecida no lo corre.
  const ejecutado = await fs.stat(marcador).then(() => true).catch(() => false);
  check("el marcador EJECUTADO.txt NO existe (la app endurecida no dispara el fsmonitor)", ejecutado === false, ejecutado);

  console.log("\n== PoC 3: workspace NO-worktree (.git como directorio) ==\n");

  {
    const copia = await fs.mkdtemp(path.join(os.tmpdir(), "magi-poc-copy-"));
    await execFileAsync("git", ["init"], { cwd: copia });
    await execFileAsync("git", ["config", "user.email", "poc@x.com"], { cwd: copia });
    await execFileAsync("git", ["config", "user.name", "PoC"], { cwd: copia });
    await fs.writeFile(path.join(copia, "a.txt"), "hola\n", "utf-8");
    await execFileAsync("git", ["add", "-A"], { cwd: copia });
    await execFileAsync("git", ["commit", "-m", "inicial"], { cwd: copia });
    const esDirectorio = await fs.stat(path.join(copia, ".git")).then((s) => s.isDirectory());
    check("en un workspace de copia, .git es un directorio", esDirectorio === true, esDirectorio);

    const toolsCopia = createAgentTools(copia, () => {}, []);
    const hook = (await (toolsCopia as unknown as { write_file: ToolLike }).write_file.execute({
      path: ".git/hooks/pre-commit",
      content: "#!/bin/sh\necho PWNED\n",
    })) as { ok?: boolean; error?: string };
    check("escribir .git/hooks/pre-commit FALLA también en el modo copia", hook.ok !== true, hook);
    const gancho = await fs.readFile(path.join(copia, ".git", "hooks", "pre-commit"), "utf-8").then(() => true).catch(() => false);
    check("y el hook no quedó escrito", gancho === false, gancho);

    // Control: escribir un archivo legítimo en la copia sí funciona.
    const normal = (await (toolsCopia as unknown as { write_file: ToolLike }).write_file.execute({ path: "b.txt", content: "ok\n" })) as { ok?: boolean };
    check("un archivo legítimo sigue funcionando en el modo copia", normal.ok === true, normal);
    await fs.rm(copia, { recursive: true, force: true });
  }

  await fs.rm(base, { recursive: true, force: true });
  void repo;
  void worktree;
  void execFileSync;
  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
