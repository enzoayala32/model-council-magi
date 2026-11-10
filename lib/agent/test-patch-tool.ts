/**
 * P1 de paridad con OpenCode — prueba de la tool `patch` contra un workspace
 * real (temporario).
 *
 * El parser ya está probado con strings (`test-patch-parser.ts`, 34/34). Lo que
 * se prueba ACÁ es lo que el parser no puede ver: que la tool escriba de verdad,
 * que respete el límite del workspace, que los eventos salgan igual que con
 * `edit_file`/`write_file` (para que la propuesta final y el mapa del repo se
 * enteren), y que un patch que falla NO deje el workspace a medio aplicar sin
 * decirlo.
 *
 * Sin red. Uso: npm run agent:test-patch-tool
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

type ToolLike = { execute: (input: unknown, options?: { abortSignal?: AbortSignal }) => Promise<unknown> };
type Evento = { type: string; relPath?: string };

async function main(): Promise<void> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "magi-patch-tool-"));
  await fs.mkdir(path.join(workspace, "src"), { recursive: true });
  await fs.writeFile(path.join(workspace, "src", "a.ts"), "export const a = 1;\nexport const b = 2;\nexport const c = 3;\n", "utf-8");
  await fs.writeFile(path.join(workspace, "src", "fuera.ts"), "borrado\n", "utf-8");
  await fs.writeFile(path.join(workspace, "todo.txt"), "hola\n", "utf-8");

  const eventos: Evento[] = [];
  const tools = createAgentTools(workspace, (evento) => eventos.push(evento as Evento), []);
  const patch = (tools as unknown as { patch: ToolLike }).patch;

  console.log("== un patch que crea, actualiza y borra en una sola llamada ==\n");

  {
    const res = (await patch.execute({
      patch: [
        "*** Add File: src/nuevo.ts",
        "+export const n = 1;",
        "+",
        "+export const m = 2;",
        "*** Update File: src/a.ts",
        "@@",
        "-export const b = 2;",
        "+export const b = 99;",
        "*** Delete File: src/fuera.ts",
      ].join("\n"),
    })) as { ok: boolean; applied?: string[]; failed?: Array<{ relPath: string; error: string }> };

    check("ok", res.ok === true, res);
    check("reporta los tres archivos aplicados", (res.applied ?? []).join(" | ") === "add src/nuevo.ts | update src/a.ts | delete src/fuera.ts", res.applied);
    check("no reporta fallos", (res.failed ?? []).length === 0, res.failed);
    check("el archivo nuevo existe con su contenido (sin nueva línea mágica: es lo que dijo el patch)", (await fs.readFile(path.join(workspace, "src", "nuevo.ts"), "utf-8")) === "export const n = 1;\n\nexport const m = 2;", await fs.readFile(path.join(workspace, "src", "nuevo.ts"), "utf-8"));
    check("la update se aplicó (b = 99)", (await fs.readFile(path.join(workspace, "src", "a.ts"), "utf-8")).includes("export const b = 99;"), await fs.readFile(path.join(workspace, "src", "a.ts"), "utf-8"));
    check("el resto del archivo quedó igual", (await fs.readFile(path.join(workspace, "src", "a.ts"), "utf-8")).includes("export const c = 3;"), await fs.readFile(path.join(workspace, "src", "a.ts"), "utf-8"));
    check("el borrado existe", !(await fs.stat(path.join(workspace, "src", "fuera.ts")).then(() => true).catch(() => false)));

    // Los eventos tienen que salir igual que con las tools de a un archivo: sin
    // ellos, la propuesta final y el invalidado del mapa del repo no se enteran.
    const tipos = eventos.map((e) => e.type + ":" + (e.relPath ?? ""));
    check("salió un evento file_written", tipos.includes("file_written:src/nuevo.ts"), tipos);
    check("salió un evento file_edited", tipos.includes("file_edited:src/a.ts"), tipos);
    check("salió un evento file_deleted", tipos.includes("file_deleted:src/fuera.ts"), tipos);
  }

  console.log("\n== CRLF: el patch se aplica y el estilo del archivo no cambia ==\n");

  {
    await fs.writeFile(path.join(workspace, "src", "crlf.ts"), "linea1\r\nlinea2\r\nlinea3\r\n", "utf-8");
    const res = (await patch.execute({
      patch: ["*** Update File: src/crlf.ts", "@@", " linea1", "-linea2", "+linea2-cambiada", " linea3"].join("\n"),
    })) as { ok: boolean };
    const contenido = await fs.readFile(path.join(workspace, "src", "crlf.ts"), "utf-8");
    check("aplicó sobre un archivo CRLF con un patch escrito en LF", res.ok === true, res);
    check("el archivo sigue en CRLF", contenido.includes("\r\n") && !contenido.includes("linea1\n"), JSON.stringify(contenido));
    check("y el cambio entró", contenido.includes("linea2-cambiada"), JSON.stringify(contenido));
  }

  console.log("\n== los fallos se reportan, no se ocultan ==\n");

  {
    await fs.writeFile(path.join(workspace, "src", "ya-existe.ts"), "previo\n", "utf-8");
    const res = (await patch.execute({
      patch: [
        "*** Update File: src/inexistente.ts",
        "-algo",
        "+otro",
        "*** Add File: src/ya-existe.ts",
        "+contenido",
      ].join("\n"),
    })) as { ok: boolean; error?: string; applied?: string[]; failed?: Array<{ relPath: string; error: string }> };

    check("un patch que no aplica nada devuelve ok:false", res.ok === false, res);
    check("con el detalle de los dos fallos", (res.failed ?? []).length === 2 || /no se aplicó/.test(res.error ?? ""), res);

    // Parcial: una sección funciona y otra no. Las que funcionaron quedan, y el
    // resultado lo dice.
    await fs.writeFile(path.join(workspace, "src", "parcial.ts"), "antes\n", "utf-8");
    const parcial = (await patch.execute({
      patch: [
        "*** Update File: src/parcial.ts",
        "-antes",
        "+despues",
        "*** Update File: src/fantasma.ts",
        "-nada",
        "+algo",
      ].join("\n"),
    })) as { ok: boolean; applied?: string[]; failed?: Array<{ relPath: string; error: string }> };
    check("un patch parcial aplica lo que puede", parcial.ok === true && (parcial.applied ?? []).length === 1, parcial);
    check("y reporta el archivo que falló", (parcial.failed ?? []).some((f) => f.relPath === "src/fantasma.ts"), parcial.failed);
    check("el archivo que sí pudo quedó escrito", (await fs.readFile(path.join(workspace, "src", "parcial.ts"), "utf-8")) === "despues\n");
  }

  console.log("\n== el límite del workspace se respeta ==\n");

  {
    const res = (await patch.execute({
      patch: ["*** Add File: ../escapado.txt", "+contenido"].join("\n"),
    })) as { ok: boolean; error?: string; failed?: Array<{ relPath: string; error: string }> };
    check("no se puede escribir fuera del workspace", res.ok === false, res);
    check("y el archivo no existe", !(await fs.stat(path.join(workspace, "..", "escapado.txt")).then(() => true).catch(() => false)));
  }

  console.log("\n== patch mal formado: error claro, nada escrito ==\n");

  {
    const antes = await fs.readFile(path.join(workspace, "src", "a.ts"), "utf-8");
    const res = (await patch.execute({ patch: "*** Add File: src/x.ts" })) as { ok: boolean; error?: string };
    check("un patch sin contenido en Add File falla", res.ok === false, res);
    check("con un mensaje accionable", /sin contenido/i.test(res.error ?? ""), res.error);
    check("y no tocó ningún archivo", (await fs.readFile(path.join(workspace, "src", "a.ts"), "utf-8")) === antes);
  }

  await fs.rm(workspace, { recursive: true, force: true });
  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
