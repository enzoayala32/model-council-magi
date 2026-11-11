/**
 * P1 de paridad con OpenCode — skills del agente desde archivo (`SKILL.md`).
 *
 * QUÉ HABÍA: skills curadas a mano en la UI (`lib/skills.ts`), que se inyectan
 * COMPLETAS en el prompt del Consejo (hasta 12). No había forma de que un repo
 * traiga las suyas, y el prompt se llenaba con cuerpos enteros aunque la tarea
 * no los necesitara.
 *
 * QUÉ HACE OpenCode (verificado contra su doc): `SKILL.md` dentro de
 * `.opencode/skills/<id>/`, descubiertas por ruta, y el modelo las carga BAJO
 * DEMANDA con la tool `skill` —al prompt solo llega la lista (id, nombre,
 * descripción), nunca el cuerpo—.
 *
 * ESTE MÓDULO implementa la parte de descubrimiento y parseo:
 *
 *  - Ubicaciones: `<proyecto>/.magi/skills/<id>/SKILL.md` (forma recomendada,
 *    que permite archivos de apoyo al lado) y `<proyecto>/.magi/skills/<id>.md`
 *    (forma plana). Más el directorio global, `MAGI_AGENT_SKILLS_DIR` o
 *    `<config>/consenso-ia/skills` (la misma base que la config de MCP y que los
 *    comandos del agente).
 *  - El id sale de la ruta (`team/review/SKILL.md` → `team/review`), igual que
 *    los comandos: una sola convención de ids en todo el proyecto.
 *  - El de proyecto gana al global con el mismo id.
 *  - Frontmatter: `name`, `description`, y los campos de compatibilidad
 *    `metadata.opencode/autoinvoke: false` / `disable-model-invocation: true`
 *    (ocultan la skill de la lista que ve el modelo; se siguen pudiendo cargar
 *    por id).
 *
 * TOPES, y por qué existen: la lista que se le muestra al modelo es contexto
 * caro. Se limitan la cantidad de skills anunciadas (30), el cuerpo por skill
 * (20 KB) y la profundidad de descubrimiento (6). No son límites de seguridad:
 *  son de cordialidad, con el mismo espíritu que los topes de la cola de
 *  prompts y de los comandos.
 *
 * NADA de esto rompe las skills del Consejo: son otro mecanismo (curadas en la
 * UI, persistidas donde el usuario las guarda) y siguen intactas.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Directorio de skills dentro de un proyecto. */
export const PROJECT_SKILLS_DIR = ".magi/skills";

/** Tope de skills anunciadas al modelo. */
export const MAX_ADVERTISED_SKILLS = 30;

/** Tope del cuerpo por skill. */
export const MAX_SKILL_BODY_CHARS = 20 * 1024;

/** Profundidad máxima debajo del directorio de skills. */
export const MAX_PROFUNDIDAD = 6;

export type FileSkill = {
  /** `/` + ruta sin extensión, o `/` + nombre de la carpeta. */
  id: string;
  name: string;
  description: string;
  /** Cuerpo ya sin frontmatter, recortado si pasaba el tope. */
  body: string;
  /** Directorio base: de acá salen las rutas de los archivos de apoyo. */
  baseDir: string;
  /** Ruta del SKILL.md (o del .md) que la define. */
  source: string;
  scope: "project" | "global";
  /** true si el cuerpo se recortó por el tope. */
  bodyTruncated: boolean;
  /** true si el archivo pidió no anunciarla al modelo. */
  autoinvokeDisabled: boolean;
  /** Muestra de archivos de apoyo (máximo 10), para que el modelo sepa qué hay. */
  supportingFiles: string[];
};

export type SkillDiscovery = {
  skills: FileSkill[];
  /** Archivos que se intentaron leer y fallaron: se informan, no se ocultan. */
  errors: Array<{ path: string; error: string }>;
  /** true si se dejaron de anunciar skills por el tope. */
  truncated: boolean;
};

/** Directorio global de skills. Misma base que la config de MCP y los comandos. */
export function globalSkillsDir(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.MAGI_AGENT_SKILLS_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  const base =
    process.platform === "win32"
      ? (env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"))
      : (env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"));
  return path.join(base, "consenso-ia", "skills");
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string; autoinvokeDisabled: boolean } {
  const normalizado = raw.replace(/\r\n/g, "\n");
  if (!normalizado.startsWith("---\n")) return { meta: {}, body: normalizado, autoinvokeDisabled: false };
  const fin = normalizado.indexOf("\n---", 4);
  if (fin < 0) return { meta: {}, body: normalizado, autoinvokeDisabled: false };
  const bloque = normalizado.slice(4, fin);
  const cuerpo = normalizado.slice(fin + 4).replace(/^\n/, "");
  const meta: Record<string, string> = {};
  let autoinvokeDisabled = false;
  for (const linea of bloque.split("\n")) {
    if (!linea.trim() || linea.trim().startsWith("#")) continue;
    const dosPuntos = linea.indexOf(":");
    if (dosPuntos <= 0) continue;
    const clave = linea.slice(0, dosPuntos).trim();
    const valor = linea.slice(dosPuntos + 1).trim().replace(/^["']|["']$/g, "");
    if (clave) meta[clave] = valor;
    // Campos de compatibilidad con OpenCode: esconden la skill de la lista.
    if (clave === "metadata.opencode/autoinvoke" && valor.trim() === "false") autoinvokeDisabled = true;
    if (clave === "disable-model-invocation" && valor.trim() === "true") autoinvokeDisabled = true;
  }
  return { meta, body: cuerpo, autoinvokeDisabled };
}

/** El id sale de la ruta relativa, con `/` como separador (Windows incluido). */
function idDesdeRuta(relPath: string): string {
  const sinExt = relPath.split("\\").join("/").replace(/\.md$/i, "").replace(/\/SKILL$/i, "");
  return "/" + sinExt.split("/").filter((s) => s.length > 0).join("/");
}

/**
 * Lista los `.md` de un directorio y sus subdirectorios (hasta MAX_PROFUNDIDAD).
 *
 * El `rel` se calcula contra la raíz ORIGINAL, no contra el subdirectorio de la
 * llamada recursiva: si no, una skill anidada (`team/review/SKILL.md`) salía con
 * id `/review` en vez de `/team/review`, y los archivos de apoyo perdían su
 * prefijo. Lo destapó el test.
 */
async function listarSkillsDir(base: string, raiz: string = base, profundidad = 0): Promise<Array<{ abs: string; rel: string }>> {
  if (profundidad > MAX_PROFUNDIDAD) return [];
  let entradas;
  try {
    entradas = await fs.readdir(base, { withFileTypes: true });
  } catch {
    // No existe el directorio: no hay skills de este scope. No es un error.
    return [];
  }
  const salida: Array<{ abs: string; rel: string }> = [];
  for (const entrada of entradas) {
    if (entrada.name.startsWith(".") || entrada.name === "node_modules") continue;
    const abs = path.join(base, entrada.name);
    if (entrada.isDirectory()) {
      // Forma recomendada: una carpeta con SKILL.md adentro.
      const posible = path.join(abs, "SKILL.md");
      try {
        const stat = await fs.stat(posible);
        if (stat.isFile()) {
          salida.push({ abs: posible, rel: path.relative(raiz, posible) });
          continue;
        }
      } catch {
        /* no tiene SKILL.md: se busca recursivamente */
      }
      salida.push(...(await listarSkillsDir(abs, raiz, profundidad + 1)));
      continue;
    }
    if (entrada.isFile() && entrada.name.toLowerCase().endsWith(".md")) {
      salida.push({ abs, rel: path.relative(raiz, abs) });
    }
  }
  return salida;
}

/** Profundidad de la muestra de archivos de apoyo. */
const MAX_PROFUNDIDAD_APOYO = 3;

/** Tope de archivos de apoyo listados por skill. */
export const MAX_SUPPORTING_FILES = 10;

/**
 * Muestra de archivos de apoyo de una skill. RECURSIVA a propósito: listar solo
 * el primer nivel daba "references" y "scripts", que no le sirven a nadie —el
 * modelo necesita la ruta completa del archivo para poder leerlo—.
 */
async function archivosDeApoyo(baseDir: string, raiz: string = baseDir, profundidad = 0): Promise<string[]> {
  if (profundidad > MAX_PROFUNDIDAD_APOYO) return [];
  let entradas;
  try {
    entradas = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const salida: string[] = [];
  for (const entrada of entradas) {
    if (entrada.name.startsWith(".") || entrada.name === "node_modules") continue;
    const abs = path.join(baseDir, entrada.name);
    if (entrada.isDirectory()) {
      salida.push(...(await archivosDeApoyo(abs, raiz, profundidad + 1)));
      continue;
    }
    if (entrada.name === "SKILL.md") continue;
    // Rutas con `/` siempre: son las que el modelo va a usar en sus tools.
    salida.push(path.relative(raiz, abs).split("\\").join("/"));
  }
  return salida.slice(0, MAX_SUPPORTING_FILES);
}

/**
 * Descubre las skills de un proyecto. Nunca tira: un directorio ausente, un
 * archivo ilegible o una skill rota devuelven lo que se pudo leer, con los
 * errores a parte.
 */
export async function loadFileSkills(projectPath: string, env: Record<string, string | undefined> = process.env): Promise<SkillDiscovery> {
  const local = await leerScope(path.join(projectPath, PROJECT_SKILLS_DIR), "project");
  const global = await leerScope(globalSkillsDir(env), "global");

  const porId = new Map<string, FileSkill>();
  for (const skill of [...global.skills, ...local.skills]) porId.set(skill.id, skill);
  const todas = [...porId.values()].sort((a, b) => a.id.localeCompare(b.id));

  const anunciadas = todas.slice(0, MAX_ADVERTISED_SKILLS);
  return {
    skills: anunciadas,
    errors: [...local.errors, ...global.errors],
    truncated: todas.length > MAX_ADVERTISED_SKILLS,
  };
}

async function leerScope(base: string, scope: "project" | "global"): Promise<{ skills: FileSkill[]; errors: Array<{ path: string; error: string }> }> {
  const skills: FileSkill[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  for (const archivo of await listarSkillsDir(base)) {
    let raw: string;
    try {
      raw = await fs.readFile(archivo.abs, "utf-8");
    } catch (error) {
      errors.push({ path: archivo.abs, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    const { meta, body, autoinvokeDisabled } = parseFrontmatter(raw);
    const id = idDesdeRuta(archivo.rel);
    const bodyTruncated = body.length > MAX_SKILL_BODY_CHARS;
    skills.push({
      id,
      // El nombre visible: del frontmatter, o el último segmento del id.
      name: (meta.name ?? id.split("/").filter(Boolean).pop() ?? id).trim(),
      description: (meta.description ?? "").trim(),
      body: bodyTruncated ? body.slice(0, MAX_SKILL_BODY_CHARS) : body,
      baseDir: path.dirname(archivo.abs),
      source: archivo.abs,
      scope,
      bodyTruncated,
      autoinvokeDisabled,
      supportingFiles: await archivosDeApoyo(path.dirname(archivo.abs)),
    });
  }
  return { skills, errors };
}

/**
 * La lista que se le muestra al modelo: id, nombre y descripción. NUNCA el
 * cuerpo —esa es la diferencia entera con las skills del Consejo, que se
 * inyectan completas y por eso no pueden ser muchas.
 */
export function renderSkillList(skills: readonly FileSkill[]): string {
  if (skills.length === 0) return "";
  const anunciadas = skills.filter((s) => !s.autoinvokeDisabled);
  if (anunciadas.length === 0) return "";
  const lineas = anunciadas.map((skill) => {
    const marca = skill.bodyTruncated ? " (cuerpo recortado por el tope)" : "";
    return `- ${skill.id} — ${skill.name}${skill.description ? `: ${skill.description}` : ""}${marca}`;
  });
  return [
    "",
    "<available-skills>",
    "Skills del proyecto, cargadas a demanda con la tool `skill` (pasale el id).",
    "El cuerpo NO está en este prompt: cargalo solo cuando la tarea lo pida.",
    ...lineas,
    "</available-skills>",
    "",
  ].join("\n");
}

/** El texto que devuelve la tool `skill` al cargar una. */
export function renderSkillPayload(skill: FileSkill): string {
  const apoyo = skill.supportingFiles.length > 0 ? "\n\nArchivos de apoyo en " + skill.baseDir + ":\n" + skill.supportingFiles.map((f) => "- " + f).join("\n") : "";
  const recortada = skill.bodyTruncated ? "\n\n(El cuerpo se recortó por el tope de " + MAX_SKILL_BODY_CHARS + " caracteres.)" : "";
  return [
    "# " + skill.name,
    "",
    skill.description ? skill.description + "\n" : "",
    skill.body,
    apoyo,
    recortada,
  ]
    .filter((parte) => parte !== undefined)
    .join("\n");
}
