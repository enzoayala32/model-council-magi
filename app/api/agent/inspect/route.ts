import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { detectIsGitRepo } from "@/lib/agent/project-store";

/** Scripts de `package.json` que vale la pena mostrarle al usuario antes de
 * agregar un proyecto — los que el Coding Agent (o el propio usuario)
 * probablemente va a querer correr. No es una lista exhaustiva a propósito
 * (mostrar los 40 scripts de un monorepo real sería ruido, no ayuda). */
const INTERESTING_SCRIPTS = ["build", "dev", "start", "test", "lint", "typecheck", "type-check"];

type PackageJsonInfo = { name: string | null; hasTypeScript: boolean; scripts: string[] };

async function readPackageJsonInfo(dir: string): Promise<PackageJsonInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(dir, "package.json"), "utf-8");
  } catch {
    return null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Existe pero no es JSON válido — igual contamos que "hay package.json".
    return { name: null, hasTypeScript: false, scripts: [] };
  }

  const deps = {
    ...(typeof parsed.dependencies === "object" && parsed.dependencies ? parsed.dependencies : {}),
    ...(typeof parsed.devDependencies === "object" && parsed.devDependencies ? parsed.devDependencies : {}),
  } as Record<string, unknown>;

  let hasTsconfig = false;
  try {
    await fs.stat(path.join(dir, "tsconfig.json"));
    hasTsconfig = true;
  } catch {
    // no hay tsconfig.json — no es un error, solo un dato menos.
  }

  const hasTypeScript = hasTsconfig || Object.prototype.hasOwnProperty.call(deps, "typescript");
  const scriptNames = typeof parsed.scripts === "object" && parsed.scripts ? Object.keys(parsed.scripts) : [];
  const scripts = scriptNames.filter((s) => INTERESTING_SCRIPTS.includes(s));

  return { name: typeof parsed.name === "string" ? parsed.name : null, hasTypeScript, scripts };
}

/**
 * Analiza una carpeta ANTES de agregarla como `Project` — pensado para el
 * paso "Analizar automáticamente" del Project Picker: si es un repo git
 * (y por lo tanto qué modo de workspace va a usar el Coding Agent,
 * `"worktree"` vs `"copy"` — ver diseño de Fase 2, sección 14), si tiene
 * `package.json`, si el proyecto usa TypeScript, y qué scripts conocidos
 * expone. Es de solo lectura — no crea nada, no valida nada más allá de
 * "existe y es una carpeta" (esa validación final, más estricta, la sigue
 * haciendo `createProject` en `project-store.ts` al momento de agregar).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const requested = url.searchParams.get("path");
  if (!requested || !requested.trim()) {
    return NextResponse.json({ ok: false, error: 'Falta el parámetro "path".' }, { status: 400 });
  }

  const resolved = path.resolve(requested);

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(resolved);
  } catch {
    return NextResponse.json({ ok: false, error: `La ruta no existe: ${resolved}` }, { status: 400 });
  }
  if (!stat.isDirectory()) {
    return NextResponse.json({ ok: false, error: `La ruta no es una carpeta: ${resolved}` }, { status: 400 });
  }

  const [isGitRepo, packageJsonInfo] = await Promise.all([detectIsGitRepo(resolved), readPackageJsonInfo(resolved)]);

  return NextResponse.json({
    ok: true,
    path: resolved,
    isGitRepo,
    workspaceMode: isGitRepo ? "worktree" : "copy",
    hasPackageJson: packageJsonInfo !== null,
    packageName: packageJsonInfo?.name ?? null,
    hasTypeScript: packageJsonInfo?.hasTypeScript ?? false,
    scripts: packageJsonInfo?.scripts ?? [],
  });
}
