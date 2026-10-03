/**
 * Fase 6A — prueba de aceptación de `wrapToolExecute` (`tool-policy.ts`).
 *
 * Todo lo que necesita "tiempo" en estos casos usa promesas diferidas
 * controladas a mano (nunca `sleep(N)` esperando que alcance) — mismo
 * criterio que ya se usó para el fix de `test-dispatcher.ts` en Fase 5B y
 * las barreras deterministas de `test-concurrency.ts` en 5G. El único
 * `setTimeout` real que aparece es el propio timeout de la política bajo
 * prueba (con un valor chico a propósito) corriendo contra una promesa
 * que NUNCA se resuelve por sí sola — el resultado es determinista porque
 * el timeout es la única forma en que esa carrera puede terminar, no
 * porque se calculó "cuánto debería alcanzar".
 *
 * Uso: npm run agent:test-tool-policy
 */
import { wrapToolExecute, type ToolPolicy } from "./tool-policy";
import { createAgentTools } from "./tools";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

/** Una promesa que nunca se resuelve por sí sola — el único jeito de que
 * termine es el timeout de la política o un abort externo. Nada de
 * `setTimeout` acá adentro. */
function deferredForever<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

async function main(): Promise<void> {
  console.log("== Fase 6A — prueba de aceptación (wrapToolExecute) ==\n");

  const GENEROUS: ToolPolicy = { timeoutMs: 5_000, maxOutputChars: 500_000 };

  // --- Caso 1: ejecuta normalmente una tool exitosa, mismo shape exacto ---
  console.log("--- Caso 1: camino feliz — el resultado pasa sin cambios ---");
  {
    const original = { ok: true, files: ["a.ts", "b.ts"], truncated: false };
    const wrapped = wrapToolExecute("fake_tool", async () => original, GENEROUS);
    const result = await wrapped({}, undefined);
    check("el resultado es EXACTAMENTE el mismo objeto (misma referencia, no una copia)", result === original, result);
  }

  // --- Caso 2: excepción no capturada por la tool queda normalizada ---
  console.log("\n--- Caso 2: una excepción no atrapada por la tool se normaliza a {ok:false, error} ---");
  {
    const wrapped = wrapToolExecute<Record<string, never>, { ok: boolean; error?: string }>(
      "fake_tool",
      async () => {
        throw new Error("boom, la tool nunca atrapó esto");
      },
      GENEROUS,
    );
    const result = await wrapped({}, undefined);
    check("ok:false y el mensaje de la excepción original sobrevive", result.ok === false && result.error === "boom, la tool nunca atrapó esto", result);
  }

  // --- Caso 3: el timeout PROPIO de la política dispara ---
  console.log("\n--- Caso 3: timeout propio de la política — la tool nunca resuelve por sí sola ---");
  {
    const SHORT: ToolPolicy = { timeoutMs: 20, maxOutputChars: 500_000 };
    const wrapped = wrapToolExecute<Record<string, never>, { ok: boolean; error?: string }>("fake_tool_lenta", () => deferredForever(), SHORT);
    const result = await wrapped({}, undefined);
    check("ok:false, y el mensaje distingue que fue TIMEOUT (no abort del Agent)", result.ok === false && !!result.error?.includes("timeout"), result);
  }

  // --- Caso 4: el abort del Agent llega REALMENTE a la tool (determinista, sin timers) ---
  console.log("\n--- Caso 4: abort externo (options.abortSignal) — sin ningún timer, la tool se entera de verdad ---");
  {
    const controller = new AbortController();
    let sawAbortInsideTheTool = false;
    const wrapped = wrapToolExecute<Record<string, never>, { ok: boolean; error?: string }>(
      "fake_tool_abortable",
      (_input, options) =>
        new Promise((resolve) => {
          // Una tool "bien portada" que sí mira options.abortSignal — así
          // se prueba que el signal que llega es el REAL, no uno decorativo.
          options?.abortSignal?.addEventListener("abort", () => {
            sawAbortInsideTheTool = true;
          });
          // nunca llama resolve() por su cuenta — solo el abort la termina.
        }),
      GENEROUS,
    );
    const promise = wrapped({}, { abortSignal: controller.signal });
    controller.abort();
    const result = await promise;
    check("la tool en sí observó el abort (el signal reenviado es el mismo objeto real)", sawAbortInsideTheTool, { sawAbortInsideTheTool });
    check("el resultado distingue 'abort del Agent' de un timeout propio", result.ok === false && !!result.error?.includes("cancelada") && !result.error.includes("timeout"), result);
  }

  // --- Caso 5: una operación abortada no queda colgada — el wrapper resuelve igual ---
  console.log("\n--- Caso 5: la tool interna JAMÁS resuelve (deferredForever) — el abort igual termina el wrapper ---");
  {
    const controller = new AbortController();
    const wrapped = wrapToolExecute<Record<string, never>, { ok: boolean; error?: string }>("fake_tool_colgada", () => deferredForever(), GENEROUS);
    const promise = wrapped({}, { abortSignal: controller.signal });
    controller.abort();
    // Si esto no resolviera, el test entero se colgaría — el hecho de que
    // `await` acá abajo termine YA ES la prueba de que no queda corriendo
    // indefinidamente (sin necesidad de ningún timeout de test externo).
    const result = await promise;
    check("el wrapper resolvió pese a que la tool interna nunca iba a hacerlo por sí sola", result.ok === false, result);
  }

  // --- Caso 6: el límite de output se aplica SIN romper la estructura ---
  console.log("\n--- Caso 6: límite de tamaño de salida ---");
  {
    const TIGHT: ToolPolicy = { timeoutMs: 5_000, maxOutputChars: 50 };
    const bigResult = { ok: true, files: Array.from({ length: 50 }, (_, i) => `archivo-${i}.ts`) };
    const wrappedBig = wrapToolExecute("fake_tool_grande", async () => bigResult, TIGHT);
    const bigOutcome = await wrappedBig({}, undefined);
    check("por sobre el límite: se reemplaza ENTERO por {ok:false, error} — nunca un array truncado a mitad", bigOutcome.ok === false && Array.isArray((bigOutcome as { files?: unknown }).files) === false, bigOutcome);

    const smallResult = { ok: true, files: ["a.ts"] };
    const wrappedSmall = wrapToolExecute("fake_tool_chica", async () => smallResult, TIGHT);
    const smallOutcome = await wrappedSmall({}, undefined);
    check("por debajo del límite: el resultado NO se toca (misma referencia)", smallOutcome === smallResult, smallOutcome);
  }

  // --- Caso 7/8: las tools reales (incluidas run_typecheck/run_script) conservan su comportamiento exacto ---
  console.log("\n--- Caso 7/8: integración real — createAgentTools sigue devolviendo el mismo shape de siempre ---");
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-tool-policy-"));
    await fs.writeFile(path.join(dir, "a.ts"), "export const x = 1;\n", "utf-8");
    const tools = createAgentTools(dir, () => {});

    const listResult = await (tools as any).list_files.execute({}, undefined);
    check("list_files: shape exacto de siempre (ok, files, truncated)", listResult.ok === true && Array.isArray(listResult.files) && listResult.files.includes("a.ts") && listResult.truncated === false, listResult);

    const readResult = await (tools as any).read_file.execute({ path: "a.ts" }, undefined);
    check("read_file: shape exacto de siempre (ok, content, truncated, sizeBytes)", readResult.ok === true && readResult.content === "export const x = 1;\n" && readResult.truncated === false, readResult);

    const readMissing = await (tools as any).read_file.execute({ path: "no-existe.ts" }, undefined);
    check("read_file sobre un archivo inexistente: sigue devolviendo el mismo error legible de siempre (no el genérico de la política)", readMissing.ok === false && readMissing.error === "no-existe.ts no existe.", readMissing);

    // Llamada SIN segundo argumento (`options`), igual que ya hacían
    // test-delete-file.ts/test-run-script.ts antes de 6A — debe seguir
    // andando idéntico, sin romperse por el `options?.` defensivo.
    const readNoOptions = await (tools as any).read_file.execute({ path: "a.ts" });
    check("llamar .execute(input) SIN el 2do argumento (como ya hacían los tests existentes) sigue andando", readNoOptions.ok === true, readNoOptions);
  }

  // ------------------------------------------------------------
  // Fase 6D: la cancelación llega hasta el PROCESO DEL SISTEMA OPERATIVO,
  // no solo hasta el wrapper de 6A. Cada caso hace que el proceso hijo
  // real escriba un "marker" recién a los 2s de vida — si el proceso
  // sigue vivo tras el abort, el marker aparece; si `execFileAsync`
  // realmente lo mató, nunca aparece. Se espera un poco más de 2s después
  // del abort (bien pasado el momento en que el marker HABRÍA aparecido)
  // para poder afirmar con certeza que no apareció — a diferencia de los
  // casos de arriba, acá SÍ hace falta que pase tiempo real: se está
  // observando un proceso del SO de verdad, no una promesa en memoria que
  // se pueda controlar con un deferred.
  // ------------------------------------------------------------
  console.log("\n--- Caso 9 (6D): abort de run_typecheck — el proceso hijo real muere, no sigue corriendo en el SO ---");
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-tool-policy-6d-"));
    const fakeBin = path.join(dir, "fakebin");
    await fs.mkdir(fakeBin, { recursive: true });
    const markerPath = path.join(dir, "marker-typecheck.txt");
    const fakeNpxPath = path.join(fakeBin, "npx");
    await fs.writeFile(fakeNpxPath, `#!/bin/sh\nsleep 2\ntouch "${markerPath}"\n`, "utf-8");
    await fs.chmod(fakeNpxPath, 0o755);

    const tools = createAgentTools(dir, () => {});
    const controller = new AbortController();
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath}`;
    try {
      const executePromise = (tools as any).run_typecheck.execute({}, { abortSignal: controller.signal });
      await new Promise((r) => setTimeout(r, 200)); // deja que el fake "npx" arranque y esté en medio del sleep
      controller.abort();
      await executePromise; // el wrapper de 6A ya garantiza que esto resuelve rápido (probado arriba)
      await new Promise((r) => setTimeout(r, 2300)); // bien pasado el momento en que el marker habría aparecido
      const markerExists = await fs
        .access(markerPath)
        .then(() => true)
        .catch(() => false);
      check("el proceso hijo murió de verdad — el marker (solo aparece tras 2s vivo) nunca se creó", !markerExists, { markerExists });
    } finally {
      process.env.PATH = originalPath;
    }
  }

  console.log("\n--- Caso 10 (6D): abort de run_script — mismo comportamiento ---");
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-tool-policy-6d-"));
    const markerPath = path.join(dir, "marker-script.txt");
    await fs.writeFile(path.join(dir, "slow.js"), `setTimeout(() => { require("fs").writeFileSync(${JSON.stringify(markerPath)}, "done"); }, 2000);`, "utf-8");
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "tmp", scripts: { test: "node slow.js" } }), "utf-8");

    const tools = createAgentTools(dir, () => {}, ["test"]);
    const controller = new AbortController();
    const executePromise = (tools as any).run_script.execute({ name: "test" }, { abortSignal: controller.signal });
    await new Promise((r) => setTimeout(r, 200));
    controller.abort();
    await executePromise;
    await new Promise((r) => setTimeout(r, 2300));
    const markerExists = await fs
      .access(markerPath)
      .then(() => true)
      .catch(() => false);
    check("el proceso hijo murió de verdad — el marker (solo aparece tras 2s vivo) nunca se creó", !markerExists, { markerExists });
  }

  console.log("\n--- Caso 11 (6D): sin AbortSignal, el comportamiento normal de run_typecheck/run_script sigue exactamente igual (regresión) ---");
  {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "test-tool-policy-6d-"));
    await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "tmp", scripts: { test: "node -e \"console.log('hola')\"" } }), "utf-8");
    const tools = createAgentTools(dir, () => {}, ["test"]);
    // Llamada SIN options (como ya hacían los tests de 4B/4D antes de 6D)
    // — `options?.abortSignal` debe quedar `undefined`, mismo comportamiento
    // de siempre, sin ningún cambio.
    const result = await (tools as any).run_script.execute({ name: "test" });
    check("run_script sin AbortSignal sigue funcionando exactamente igual que antes de 6D", result.ok === true && result.success === true && result.output.includes("hola"), result);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
