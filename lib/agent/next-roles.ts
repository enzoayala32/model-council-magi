/**
 * Fase 7B — Roles de Next.js (App Router), FUNCIÓN PURA y separada del
 * parser: `repo-symbols.ts` no sabe nada de frameworks.
 *
 * El rol sale del PATH; los métodos HTTP salen de los `exports` ya
 * extraídos, así que cubre todas las formas estáticas por igual
 * (`export async function GET`, `export const GET = …`,
 * `export { handler as GET }`, `export const { GET, POST } = handlers`,
 * `export { GET } from "./h"`).
 *
 * Solo corre si 7A identificó el proyecto como Next.js. App Router
 * únicamente: `pages/` NO recibe rol. Fuera de alcance: `proxy.ts`,
 * `middleware.ts`, `instrumentation.ts`.
 */
import type { ExportEntry } from "./repo-symbols";

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export type NextFileRole = {
  router: "app";
  role: "route" | "page" | "layout";
  /** Solo para `route`: métodos estáticamente exportados (puede ser `[]`). */
  httpMethods?: HttpMethod[];
  /** `export * from` impide conocer los métodos sin resolver el grafo (7C). */
  httpMethodsPartial?: true;
};

const FILE_PATTERN = /^(route|page|layout)\.(ts|tsx|js|jsx)$/;

/** Devuelve la ruta relativa al directorio `app` como segmentos, o `undefined` si no está bajo `app/` ni `src/app/`. */
function segmentsUnderAppRoot(segments: string[]): string[] | undefined {
  if (segments[0] === "app") return segments.slice(1);
  if (segments[0] === "src" && segments[1] === "app") return segments.slice(2);
  return undefined;
}

export function detectNextRole(relPath: string, exports: readonly ExportEntry[], frameworks: readonly { name: string }[]): NextFileRole | undefined {
  if (!frameworks.some((framework) => framework.name === "next")) return undefined;

  const underApp = segmentsUnderAppRoot(relPath.split("/"));
  if (!underApp || underApp.length === 0) return undefined;
  const fileName = underApp[underApp.length - 1];
  const match = FILE_PATTERN.exec(fileName);
  if (!match) return undefined;
  // Carpetas privadas de Next (`_algo`): no forman parte del routing.
  if (underApp.slice(0, -1).some((segment) => segment.startsWith("_"))) return undefined;

  const role = match[1] as NextFileRole["role"];
  const result: NextFileRole = { router: "app", role };
  if (role !== "route") return result;

  // Cuenta solo exports de VALOR: ni tipos/interfaces ni `export type …`.
  const valueExports = exports.filter((entry) => !entry.isTypeOnly && entry.kind !== "interface" && entry.kind !== "type");
  const exported = new Set(valueExports.filter((entry) => entry.kind !== "star" && entry.kind !== "namespace-reexport").map((entry) => entry.name));
  result.httpMethods = HTTP_METHODS.filter((method) => exported.has(method));
  if (valueExports.some((entry) => entry.kind === "star")) result.httpMethodsPartial = true;
  return result;
}
