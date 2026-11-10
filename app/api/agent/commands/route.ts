import { NextResponse } from "next/server";
import { guardRequest } from "@/lib/auth/guard";
import { getProject } from "@/lib/agent/project-store";
import { listAgentCommands } from "@/lib/agent/commands";

/**
 * Etapa 2.3 — comandos `/` personalizados del Coding Agent.
 *
 * La UI los necesita para la paleta del composer. El contrato es deliberadamente
 * mínimo: id, descripción y de qué scope viene. La plantilla NO viaja —el
 * cliente no la necesita, y la expansión ocurre en el servidor al crear la
 * task (ver `app/api/agent/tasks/route.ts`), igual que hace OpenCode.
 *
 * `projectId` es obligatorio: los comandos de proyecto viven en el workspace
 * del proyecto, así que no tiene sentido listarlos sin saber de qué proyecto.
 */
export async function GET(request: Request) {
  const denied = guardRequest(request);
  if (denied) return denied;

  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return NextResponse.json({ ok: false, error: 'Falta "projectId" en la query.' }, { status: 400 });
  }

  const project = getProject(projectId);
  if (!project) {
    return NextResponse.json({ ok: false, error: `No existe un Project con id "${projectId}".` }, { status: 404 });
  }

  const { commands, errors } = await listAgentCommands(project.localPath);
  return NextResponse.json({
    ok: true,
    commands: commands.map((c) => ({ id: c.id, description: c.description ?? null, scope: c.scope, model: c.model ?? null })),
    // Los archivos que no se pudieron leer se informan: un comando roto se ve,
    // no se oculta.
    errors,
  });
}
