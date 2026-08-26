/**
 * Prueba de aceptación de la Fase 2A: registra (o reusa) un `Project` real
 * apuntando a una carpeta local — no al propio repo de MAGI — y confirma
 * que `createAgentWorkspace` arma el worktree correctamente a partir de
 * `project.localPath`, sin que `workspace.ts` toque nada de MAGI.
 *
 * Uso: npm run agent:test-project -- "C:\Users\vos\ruta\al\proyecto" "Nombre del proyecto"
 * (el nombre es opcional — si no se pasa, se usa el nombre de la carpeta.)
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProject, listProjects, refreshIsGitRepo } from "./project-store";
import { createAgentWorkspace, destroyAgentWorkspace } from "./workspace";

const execFileAsync = promisify(execFile);

for (const file of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // no existe ese archivo puntual — probamos el siguiente
  }
}

async function main() {
  const localPath = process.argv[2];
  if (!localPath) {
    console.error('Uso: npm run agent:test-project -- "C:\\ruta\\al\\proyecto" ["Nombre"]');
    process.exit(1);
  }
  const name = process.argv[3] ?? path.basename(path.resolve(localPath));

  console.log("== Fase 2A — prueba de aceptación (Project → Workspace) ==\n");

  // Reusa el proyecto si ya fue registrado antes (por ruta), para poder
  // correr este script varias veces sin acumular filas duplicadas.
  const existing = listProjects({ includeArchived: true }).find(
    (p) => path.resolve(p.localPath) === path.resolve(localPath),
  );
  const project = existing ? await (refreshIsGitRepo(existing.id).then((p) => p!)) : await createProject({ name, localPath });

  console.log(`Proyecto: ${project.name} (${project.id})`);
  console.log(`localPath: ${project.localPath}`);
  console.log(`isGitRepo: ${project.isGitRepo}\n`);

  if (!project.isGitRepo) {
    console.log(
      "Este proyecto no tiene todavía un HEAD git válido para armar un worktree. Dos causas posibles:\n" +
        "  1) Es un repo git recién inicializado (`git init`) pero sin ningún commit todavía —\n" +
        "     `git worktree add` necesita al menos un commit para poder apuntar a HEAD.\n" +
        "     Solución: adentro de esa carpeta, corré `git add -A && git commit -m \"inicial\"`\n" +
        "     y volvé a correr este script.\n" +
        "  2) No es un repo git en absoluto (no corriste `git init`).\n" +
        "     El modo \"copy\" para proyectos no-git todavía no está implementado — llega en la Fase 2C.",
    );
    process.exit(1);
  }

  // Estado del proyecto real ANTES — para confirmar después que no cambió un bit.
  const { stdout: statusBefore } = await execFileAsync("git", ["status", "--porcelain"], { cwd: project.localPath });
  console.log(`git status del proyecto real (antes): ${JSON.stringify(statusBefore.trim())}`);

  const taskId = `test2a-${Date.now()}`;
  console.log(`\nCreando workspace aislado (${taskId}) a partir de project.localPath…`);
  const workspace = await createAgentWorkspace(taskId, project.localPath);
  console.log(`Worktree: ${workspace.worktreePath}`);
  console.log(`Rama descartable: ${workspace.branchName}`);
  console.log(`repoRoot registrado en el workspace: ${workspace.repoRoot}`);

  // Confirmación cruzada: el propio git del proyecto real debe ver el worktree registrado.
  // `git worktree list` en Windows imprime las rutas con `/` aunque el resto del
  // sistema (incluido `workspace.worktreePath`) las maneje con `\` — normalizamos
  // separadores antes de comparar, si no, un match real da falso negativo.
  const normalizeSlashes = (p: string) => p.replace(/\\/g, "/");
  const { stdout: worktreeList } = await execFileAsync("git", ["worktree", "list"], { cwd: project.localPath });
  const worktreeRegistered = normalizeSlashes(worktreeList).includes(normalizeSlashes(workspace.worktreePath));
  console.log(`\n\`git worktree list\` en el proyecto real:\n${worktreeList}`);
  console.log(worktreeRegistered ? "✅ El worktree quedó registrado contra el repo correcto." : "❌ El worktree NO aparece en `git worktree list` del proyecto — algo está mal.");

  console.log("\nLimpiando workspace…");
  await destroyAgentWorkspace(workspace);

  const { stdout: statusAfter } = await execFileAsync("git", ["status", "--porcelain"], { cwd: project.localPath });
  const untouched = statusAfter.trim() === statusBefore.trim();
  console.log(`git status del proyecto real (después): ${JSON.stringify(statusAfter.trim())}`);
  console.log(untouched ? "✅ El proyecto real quedó exactamente igual que antes." : "❌ El proyecto real cambió — esto NO debería pasar.");

  const { stdout: worktreeListAfter } = await execFileAsync("git", ["worktree", "list"], { cwd: project.localPath });
  const cleanedUp = !normalizeSlashes(worktreeListAfter).includes(normalizeSlashes(workspace.worktreePath));
  console.log(cleanedUp ? "✅ El worktree fue removido correctamente." : "❌ El worktree sigue registrado — destroyAgentWorkspace no limpió bien.");

  console.log(`\n${worktreeRegistered && untouched && cleanedUp ? "=== PRUEBA DE ACEPTACIÓN 2A: PASS ===" : "=== PRUEBA DE ACEPTACIÓN 2A: FAIL ==="}`);
}

main().catch((error) => {
  console.error("Falló la prueba de Fase 2A:", error);
  process.exit(1);
});
