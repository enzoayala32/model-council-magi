/**
 * Tests del parser de `patch` multi-archivo (P1 de paridad con OpenCode).
 *
 * Sin red, sin filesystem: el parser es puro, así que se prueba contra strings.
 * Lo que importa no es "parsea el ejemplo feliz" —eso lo hace cualquiera— sino:
 *
 *  - un hunk que NO está en el archivo es error, no un silencio.
 *  - un hunk que está MÁS DE UNA VEZ es error (si no, el patch aplicaría en un
 *    lugar arbitrario y el modelo creería que cambió lo que quiso).
 *  - dos hunks del MISMO archivo se aplican en orden aunque el primero cambie
 *    la cantidad de líneas (los hunks se buscan por contenido, no por línea).
 *  - un patch mal formado dice la línea y el motivo, para que el modelo lo
 *    arregle y reintente.
 *  - CRLF: se normaliza para comparar y se restaura al guardar. Sin eso, en
 *    Windows ningún hunk que cruce un salto de línea matchearía.
 *
 * Uso: npm run agent:test-patch-parser
 */
import {
  MAX_PATCH_CHARS,
  MAX_PATCH_FILES,
  applyHunk,
  applyHunks,
  normalizarSaltos,
  parsePatch,
  restaurarSaltos,
  type PatchHunk,
} from "./patch-parser";

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

const ORIGINAL = ["export const a = 1;", "export const b = 2;", "export const c = 3;", ""].join("\n");

function patchDe(hunks: string, ruta = "src/a.ts", accion = "Update File"): string {
  return [`*** ${accion}: ${ruta}`, ...hunks.split("\n")].join("\n");
}

function main(): void {
  console.log("== update: hunk simple ==\n");

  {
    const p = parsePatch(patchDe(" export const a = 1;\n-export const b = 2;\n+export const b = 99;"));
    check("parsea un update con un hunk", p.ok === true, p);
    if (p.ok) {
      check("queda una operación, tipo update", p.ops.length === 1 && p.ops[0].kind === "update", p.ops);
      check("con un hunk", p.ops[0].hunks?.length === 1, p.ops[0].hunks);
      const aplicado = applyHunks(ORIGINAL, p.ops[0].hunks ?? []);
      check("aplica: b pasa a 99", aplicado.ok && aplicado.lines[1] === "export const b = 99;", aplicado);
      check("y el resto del archivo queda igual", aplicado.ok && aplicado.lines[0] === "export const a = 1;", aplicado);
    }
  }

  console.log("\n== add y delete ==\n");

  {
    const p = parsePatch(["*** Add File: src/nuevo.ts", "+export const x = 1;", "+", "+export const y = 2;"].join("\n"));
    check("parsea un add", p.ok === true && p.ops[0]?.kind === "add", p);
    if (p.ok) check("el contenido es el cuerpo completo", p.ops[0].content === "export const x = 1;\n\nexport const y = 2;", p.ops[0].content);
  }

  {
    const p = parsePatch("*** Delete File: src/viejo.ts");
    check("parsea un delete sin cuerpo", p.ok === true && p.ops[0]?.kind === "delete", p);
  }

  {
    // Un add con líneas SIN el `+` (hay modelos que lo omiten): se acepta.
    const p = parsePatch(["*** Add File: src/otro.txt", "hola", "chau"].join("\n"));
    check("un add sin prefijo + también funciona", p.ok === true && p.ops[0].content === "hola\nchau", p);
  }

  console.log("\n== varios archivos en un solo patch ==\n");

  {
    const p = parsePatch(
      [
        "*** Add File: src/nuevo.ts",
        "+export const n = 1;",
        "*** Update File: src/a.ts",
        "-export const c = 3;",
        "+export const c = 33;",
        "*** Delete File: src/b.ts",
      ].join("\n"),
    );
    check("parsea las tres operaciones", p.ok === true && p.ops.length === 3, p);
    if (p.ok) {
      check("en el orden en que aparecen", p.ops.map((o) => o.kind + ":" + o.relPath).join(" | ") === "add:src/nuevo.ts | update:src/a.ts | delete:src/b.ts", p.ops.map((o) => o.kind));
    }
  }

  console.log("\n== dos hunks del MISMO archivo, aplicados en orden ==\n");

  {
    // El primer hunk AGREGA líneas: si la posición del segundo dependiera de
    // números de línea, se desalinearía. Se buscan por contenido.
    const patch = patchDe(
      ["@@", "-export const a = 1;", "+export const a = 1;", "+// linea nueva 1", "+// linea nueva 2", "+", "@@", "-export const c = 3;", "+export const c = 33;"].join("\n"),
    );
    const p = parsePatch(patch);
    check("parsea los dos hunks como operaciones separadas", p.ok === true && (p.ops[0]?.hunks?.length ?? 0) === 2, p.ok ? p.ops[0]?.hunks?.length : p);
    if (p.ok) {
      const aplicado = applyHunks(ORIGINAL, p.ops[0].hunks ?? []);
      check("el segundo hunk encuentra su bloque aunque el primero agregó líneas", aplicado.ok, aplicado);
      if (aplicado.ok) {
        check("a quedó con las líneas nuevas", aplicado.lines[1] === "// linea nueva 1" && aplicado.lines[2] === "// linea nueva 2", aplicado.lines.slice(0, 4));
        check("c quedó en 33", aplicado.lines[aplicado.lines.length - 2] === "export const c = 33;", aplicado.lines);
      }
    }
  }

  console.log("\n== lo que TIENE que fallar ==\n");

  {
    const p = parsePatch(patchDe("-export const z = 999;\n+export const b = 22;"));
    check("un hunk que no está en el archivo es error", (() => {
      const aplicado = applyHunks(ORIGINAL, p.ok ? p.ops[0].hunks ?? [] : []);
      return !aplicado.ok && /No se encontró/.test(aplicado.error);
    })(), p);

    // Un bloque que aparece DOS veces: si se aplicara en una cualquiera, el
    // modelo creería que cambió la que quiso.
    const tresVeces = ["const x = 1;", "const x = 1;", "const x = 1;", ""].join("\n");
    const ambiguo = parsePatch(patchDe(" const x = 1;\n-const x = 1;\n+const x = 2;"));
    check("un bloque que aparece dos veces es error (no se elige a dedo)", (() => {
      const aplicado = applyHunks(tresVeces, ambiguo.ok ? ambiguo.ops[0].hunks ?? [] : []);
      return !aplicado.ok && /veces/.test(aplicado.error);
    })(), ambiguo);

    const sinContexto: PatchHunk[] = [{ oldLines: [], newLines: ["insertado"] }];
    check("un hunk sin contexto ni borrado no se puede posicionar: error", (() => {
      const aplicado = applyHunk(ORIGINAL.split("\n"), sinContexto[0]);
      return !aplicado.ok && /no se sabe dónde/i.test(aplicado.error);
    })());
  }

  console.log("\n== patches mal formados: mensaje útil, no un silencio ==\n");

  {
    check("patch vacío", parsePatch("").ok === false);
    check("patch sin secciones", (() => {
      const r = parsePatch("+algo\n+otro");
      return !r.ok && /fuera de una sección/i.test(r.error);
    })());
    check("sección sin ruta", (() => {
      const r = parsePatch("*** Add File:");
      return !r.ok && /no dice qué archivo/i.test(r.error);
    })());
    check("encabezado no reconocido", (() => {
      const r = parsePatch("*** Move File: a.ts -> b.ts");
      return !r.ok && /Move File no está soportado/i.test(r.error);
    })());
    check("update sin hunks", (() => {
      const r = parsePatch("*** Update File: src/a.ts");
      return !r.ok && /sin ningún hunk/i.test(r.error);
    })());
    check("add sin contenido", (() => {
      const r = parsePatch("*** Add File: src/a.ts");
      return !r.ok && /sin contenido/i.test(r.error);
    })());
    check("patch gigante", (() => {
      const r = parsePatch("x".repeat(MAX_PATCH_CHARS + 10));
      return !r.ok && /tope/.test(r.error);
    })());
    check(
      "demasiados archivos",
      (() => {
        const cuerpo = Array.from({ length: MAX_PATCH_FILES + 1 }, (_, i) => `*** Delete File: f${i}.ts`).join("\n");
        const r = parsePatch(cuerpo);
        return !r.ok && /demasiados archivos/i.test(r.error);
      })(),
    );
  }

  console.log("\n== CRLF: se normaliza y se restaura ==\n");

  {
    const conCRLF = ORIGINAL.replace(/\n/g, "\r\n");
    const { normalizado, eraCRLF } = normalizarSaltos(conCRLF);
    check("detecta CRLF", eraCRLF === true, eraCRLF);
    check("normaliza a LF", !normalizado.includes("\r\n"), normalizado.slice(0, 40));
    check("restaura al estilo original", restaurarSaltos(normalizado, eraCRLF) === conCRLF, restaurarSaltos(normalizado, eraCRLF).slice(0, 40));
    check("un archivo LF no se toca", restaurarSaltos(normalizado, false) === normalizado);

    // El caso real: el modelo escribe el hunk con LF puro y el archivo es CRLF.
    const p = parsePatch(patchDe("-export const b = 2;\n+export const b = 99;"));
    if (p.ok) {
      const aplicado = applyHunks(normalizado, p.ops[0].hunks ?? []);
      check("el hunk con LF puro aplica sobre un archivo CRLF", aplicado.ok, aplicado);
      if (aplicado.ok) {
        const final = restaurarSaltos(aplicado.lines.join("\n"), eraCRLF);
        check("y el resultado vuelve a CRLF (no cambia el estilo del archivo)", final.includes("\r\n") && final.includes("export const b = 99;\r\n"), final.slice(0, 60));
      }
    }
  }

  console.log("\n== el @@ es decorativo ==\n");

  {
    const p = parsePatch(patchDe("@@ -1,3 +1,3 @@\n export const a = 1;\n-export const b = 2;\n+export const b = 99;\n export const c = 3;"));
    check("el @@ se acepta y sus números NO se usan para posicionar", p.ok === true && (p.ops[0]?.hunks?.length ?? 0) === 1, p.ok ? p.ops[0]?.hunks : p);
    if (p.ok) {
      const aplicado = applyHunks(ORIGINAL, p.ops[0].hunks ?? []);
      check("y el hunk se encuentra igual (por contenido, no por línea)", aplicado.ok && aplicado.lines[1] === "export const b = 99;", aplicado);
    }
  }

  console.log("");
  console.log(passed + "/" + (passed + failed) + " casos OK");
  if (failed > 0) process.exit(1);
}

main();
