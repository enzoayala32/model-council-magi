/**
 * P1 de paridad con OpenCode — skills del agente desde archivo (`SKILL.md`).
 *
 * Sin red. Verifica, en orden:
 *
 *  1. Descubrimiento: la forma de carpeta (`id/SKILL.md`) y la plana (`id.md`),
 *     el id derivado de la ruta, la precedencia proyecto > global, y que un
 *     archivo ilegible se informe en vez de ocultarse.
 *  2. Frontmatter: name, description, y los campos de compatibilidad que
 *     OCULTAN la skill de la lista que ve el modelo sin impedir cargarla.
 *  3. La lista que se anuncia: id/nombre/descripcion y NUNCA el cuerpo —esa es
 *     la diferencia entera con las skills del Consejo, que se inyectan completas.
 *  4. El body del payload: el cuerpo, la carpeta base y los archivos de apoyo.
 *  5. La tool `skill`: carga por id, error util cuando no existe, y que el
 *     cuerpo NO este en el prompt (la prueba de que la carga es bajo demanda).
 *
 * Uso: npm run agent:test-skills-file
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  MAX_ADVERTISED_SKILLS,
  MAX_SKILL_BODY_CHARS,
  PROJECT_SKILLS_DIR,
  globalSkillsDir,
  loadFileSkills,
  renderSkillList,
  renderSkillPayload,
} from "./skills-file";
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
  console.log("x " + label + (detail === undefined ? "" : " - " + JSON.stringify(detail).slice(0, 400)));
}

async function escribirSkill(base: string, rel: string, contenido: string): Promise<void> {
  const abs = path.join(base, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, contenido, "utf-8");
}

type ToolLike = { execute: (input: unknown) => Promise<unknown> };

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "magi-skills-"));
  const proyecto = path.join(root, "proyecto");
  const dirSkills = path.join(proyecto, PROJECT_SKILLS_DIR);
  await fs.mkdir(dirSkills, { recursive: true });

  // Forma de carpeta (la recomendada) con archivos de apoyo al lado.
  await escribirSkill(
    dirSkills,
    "git-release/SKILL.md",
    ["---", "name: Git Release", "description: Preparar releases", "---", "## Workflow", "1. Leer references/release-policy.md", "2. Resumir cambios"].join("\n"),
  );
  await escribirSkill(dirSkills, "git-release/references/release-policy.md", "politica\n", );
  await escribirSkill(dirSkills, "git-release/scripts/changelog.ts", "// script\n");
  // Forma plana.
  await escribirSkill(dirSkills, "revisar.md", ["---", "name: Revisar", "---", "Revisá los cambios."].join("\n"));
  // Anidada: el id tiene que salir con `/`.
  await escribirSkill(dirSkills, "team/review/SKILL.md", ["---", "name: Team Review", "---", "Revisión del equipo."].join("\n"));
  // Sin descripción: no se puede anunciar bien, pero existe.
  await escribirSkill(dirSkills, "silencio.md", "Hacé esto sin decir por qué.\n");
  // Oculta al modelo por el campo de compatibilidad.
  await escribirSkill(
    dirSkills,
    "interno.md",
    ["---", "name: Interno", "description: No anunciar", "metadata.opencode/autoinvoke: false", "---", "Instrucciones internas."].join("\n"),
  );
  // Un archivo que no es .md: se ignora.
  await escribirSkill(dirSkills, "notas.txt", "no es una skill\n");
  // Un ilegible: se informa, no se oculta.
  const roto = path.join(dirSkills, "roto.md");
  await fs.writeFile(roto, "contenido\n", "utf-8");
  await fs.chmod(roto, 0o000);
  // En Windows el chmod no impide la lectura (el proceso suele correr con
  // privilegios suficientes), asi que el caso se verifica solo si de verdad
  // quedo ilegible: afirmar lo que no se pudo reproducir seria un test que
  // miente.
  let rotoRealmenteIlegible = false;
  try {
    await fs.readFile(roto, "utf-8");
  } catch {
    rotoRealmenteIlegible = true;
  }
  if (!rotoRealmenteIlegible) console.log("  (aviso: en este SO el chmod 000 no impide la lectura; el caso de archivo ilegible se saltea)");

  console.log("== descubrimiento ==\n");

  const globalDir = path.join(root, "global-skills");
  const { skills, errors } = await loadFileSkills(proyecto, { MAGI_AGENT_SKILLS_DIR: globalDir, HOME: root });

  const ids = skills.map((s) => s.id);
  // 6 si el chmod 000 no impidió la lectura en este SO (Windows), 5 si sí.
  check("descubre todas las skills validas del fixture", skills.length === (rotoRealmenteIlegible ? 5 : 6), ids);
  check("el id de la carpeta es la carpeta", ids.includes("/git-release"), ids);
  check("el id de la plana es el nombre del archivo", ids.includes("/revisar"), ids);
  check("una anidada sale con / (team/review)", ids.includes("/team/review"), ids);
  check("un .txt se ignora", !ids.includes("/notas"), ids);
  if (rotoRealmenteIlegible) {
    check("el ilegible se informa como error", errors.some((e) => e.path.endsWith("roto.md")), errors);
    check("y NO aparece en las skills", !ids.includes("/roto"), ids);
  }
  check("si el ilegible se pudo leer, aparece como skill (no se inventa un error)", rotoRealmenteIlegible || ids.includes("/roto"), ids);
  check("el nombre sale del frontmatter", skills.find((s) => s.id === "/git-release")?.name === "Git Release", skills.find((s) => s.id === "/git-release")?.name);
  check("la descripcion sale del frontmatter", skills.find((s) => s.id === "/git-release")?.description === "Preparar releases");
  check("la plana sin descripcion no la inventa", skills.find((s) => s.id === "/silencio")?.description === "", skills.find((s) => s.id === "/silencio"));
  check("la base dir es la carpeta de la skill", skills.find((s) => s.id === "/git-release")?.baseDir === path.join(dirSkills, "git-release"), skills.find((s) => s.id === "/git-release")?.baseDir);
  check(
    "lista los archivos de apoyo (sin el SKILL.md)",
    (skills.find((s) => s.id === "/git-release")?.supportingFiles ?? []).join(",") === "references/release-policy.md,scripts/changelog.ts",
    skills.find((s) => s.id === "/git-release")?.supportingFiles,
  );

  console.log("\n== precedencia proyecto > global ==\n");

  await fs.mkdir(globalDir, { recursive: true });
  await escribirSkill(globalDir, "git-release/SKILL.md", ["---", "name: GLOBAL", "description: version global", "---", "Version global."].join("\n"));
  await escribirSkill(globalDir, "solo-global.md", ["---", "name: Solo global", "---", "Solo en global."].join("\n"));
  const conGlobal = await loadFileSkills(proyecto, { MAGI_AGENT_SKILLS_DIR: globalDir, HOME: root });
  check("la de proyecto gana a la global con el mismo id", conGlobal.skills.find((s) => s.id === "/git-release")?.scope === "project", conGlobal.skills.find((s) => s.id === "/git-release"));
  check("la global sigue disponible si no colisiona", conGlobal.skills.some((s) => s.id === "/solo-global"), conGlobal.skills.map((s) => s.id));
  check("el directorio global por defecto cuelga de la config", globalSkillsDir({}).includes("consenso-ia"));

  console.log("\n== la lista anuncia, no inyecta ==\n");

  {
    const lista = renderSkillList(skills);
    check("la lista tiene encabezado y cierre", lista.includes("<available-skills>") && lista.includes("</available-skills>"), lista.slice(0, 80));
    check("anuncia id, nombre y descripcion", lista.includes("/git-release — Git Release: Preparar releases"), lista.split("\n")[3]);
    check("dice que el cuerpo NO está en el prompt", /NO está en este prompt/.test(lista), lista);
    check("NO contiene el cuerpo", !lista.includes("Leer references/release-policy.md"), lista);
    check("la oculta por autoinvoke no aparece anunciada", !lista.includes("/interno"), lista);
    check("una skill sin descripcion igual se anuncia", lista.includes("/silencio —"), lista);

    check("sin skills, la lista esta vacia", renderSkillList([]) === "", renderSkillList([]));
    check("con todas ocultas, tambien", renderSkillList(skills.filter((s) => s.autoinvokeDisabled)) === "");
  }

  console.log("\n== el payload de la carga ==\n");

  {
    const payload = renderSkillPayload(skills.find((s) => s.id === "/git-release")!);
    check("trae el nombre como titulo", payload.startsWith("# Git Release"), payload.slice(0, 40));
    check("trae el cuerpo completo", payload.includes("Resumir cambios"), payload.slice(0, 200));
    check("trae la carpeta base", payload.includes(dirSkills.replace(/\\/g, "/")) || payload.includes(path.join(dirSkills, "git-release")), payload.slice(-200));
    check("lista los archivos de apoyo", payload.includes("references/release-policy.md") && payload.includes("scripts/changelog.ts"), payload.slice(-200));
  }

  console.log("\n== topes ==\n");

  {
    await escribirSkill(dirSkills, "enorme.md", "---\nname: Enorme\n---\n" + "x".repeat(MAX_SKILL_BODY_CHARS + 1_000));
    const conEnorme = await loadFileSkills(proyecto, { MAGI_AGENT_SKILLS_DIR: globalDir, HOME: root });
    const enorme = conEnorme.skills.find((s) => s.id === "/enorme");
    check("un cuerpo enorme se recorta al tope", (enorme?.body.length ?? 0) === MAX_SKILL_BODY_CHARS, enorme?.body.length);
    check("y lo indica", enorme?.bodyTruncated === true, enorme?.bodyTruncated);
    await fs.rm(path.join(dirSkills, "enorme.md"));

    // Tope de cantidad: se dejan de anunciar las que pasan.
    for (let i = 0; i < MAX_ADVERTISED_SKILLS + 3; i += 1) {
      await escribirSkill(dirSkills, `relleno-${i}.md`, `---\nname: R${i}\n---\nhola`);
    }
    const conRelleno = await loadFileSkills(proyecto, { MAGI_AGENT_SKILLS_DIR: globalDir, HOME: root });
    check("se anuncian como maximo las del tope", conRelleno.skills.length === MAX_ADVERTISED_SKILLS, conRelleno.skills.length);
    check("y se informa que quedo afuera", conRelleno.truncated === true, conRelleno.truncated);
  }

  console.log("\n== la tool `skill` carga bajo demanda ==\n");

  {
    const tools = createAgentTools(proyecto, () => {}, [], undefined, undefined, undefined, skills);
    const skillTool = (tools as unknown as { skill: ToolLike }).skill;

    const cargada = (await skillTool.execute({ id: "/git-release" })) as { ok: boolean; text?: string };
    check("carga por id", cargada.ok === true && (cargada.text ?? "").includes("Resumir cambios"), cargada);

    const sinBarra = (await skillTool.execute({ id: "revisar" })) as { ok: boolean; text?: string };
    check("acepta el id sin la barra inicial", sinBarra.ok === true && (sinBarra.text ?? "").includes("Revisá los cambios."), sinBarra);

    const inexistente = (await skillTool.execute({ id: "/no-existe" })) as { ok: boolean; error?: string };
    check("un id que no existe es error", inexistente.ok === false, inexistente);
    check("y el error lista las disponibles (para no reintentar a ciegas)", /Las disponibles son/.test(inexistente.error ?? ""), inexistente.error);

    const oculta = (await skillTool.execute({ id: "/interno" })) as { ok: boolean; text?: string };
    check("una skill oculta al modelo IGUAL se puede cargar por id", oculta.ok === true && (oculta.text ?? "").includes("Instrucciones internas"), oculta);

    const sinSkills = createAgentTools(proyecto, () => {}, [], undefined, undefined, undefined, []);
    const vacia = (await (sinSkills as unknown as { skill: ToolLike }).skill.execute({ id: "/x" })) as { ok: boolean; error?: string };
    check("sin skills descubiertas, la tool lo dice", vacia.ok === false && /No hay skills/.test(vacia.error ?? ""), vacia);
  }

  console.log("\n== la tool existe siempre, incluso sin skills ==\n");

  {
    const tools = createAgentTools(proyecto, () => {}, []);
    check("`skill` está en el set de tools siempre", typeof (tools as unknown as { skill?: ToolLike }).skill?.execute === "function", Object.keys(tools));
  }

  await fs.rm(root, { recursive: true, force: true });
  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
