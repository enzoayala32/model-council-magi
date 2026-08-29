import { NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/agent/project-store";

/** Fase 2H. `GET` lista proyectos activos (no archivados) — la UI todavía
 * no expone "ver archivados", así que no hace falta el query param acá. */
export async function GET() {
  const projects = listProjects();
  return NextResponse.json({ ok: true, projects });
}

/**
 * Crea un `Project` nuevo apuntando a una carpeta local. Todo el trabajo
 * real (validar que la ruta exista, detectar si es un repo git) ya vive en
 * `createProject` (Fase 2A) — este endpoint solo valida el shape del body
 * y traduce errores a códigos HTTP razonables.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Body inválido: se esperaba JSON." }, { status: 400 });
  }

  const { name, localPath } = (body ?? {}) as { name?: unknown; localPath?: unknown };
  if (typeof name !== "string" || !name.trim() || typeof localPath !== "string" || !localPath.trim()) {
    return NextResponse.json({ ok: false, error: "Se requieren \"name\" y \"localPath\" (ambos string, no vacíos)." }, { status: 400 });
  }

  try {
    const project = await createProject({ name, localPath });
    return NextResponse.json({ ok: true, project }, { status: 201 });
  } catch (error) {
    // Errores esperables de createProject: ruta inexistente / no es carpeta.
    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "No se pudo crear el proyecto." }, { status: 400 });
  }
}
