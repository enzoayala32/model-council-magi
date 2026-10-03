/**
 * Fase 6A — Tool Execution Hardening.
 *
 * Capa ADICIONAL sobre el `execute()` de cada tool de `lib/agent/tools.ts`
 * — nunca reemplaza ni afloja los límites que cada tool ya tiene (los
 * `MAX_*` de `tools.ts`, el `timeout:120_000` de `run_typecheck`/
 * `run_script`). Existe como red de seguridad, pensada sobre todo para
 * tools futuras (ej. una que haga red, Fase 6B) que hoy no existen.
 *
 * Verificado contra el código REAL del AI SDK instalado (`ai@7.0.78`, el
 * JS compilado en `node_modules/ai/dist/index.js`, no solo los `.d.ts`):
 *
 * - `generateText({ abortSignal })` SÍ reenvía ese signal al segundo
 *   parámetro de cada `execute(input, options)` como `options.abortSignal`
 *   (función `mergeAbortSignals`, `node_modules/ai/dist/index.js`).
 * - Pero el SDK NUNCA lo hace cumplir por su cuenta: `executeTool()`
 *   (`node_modules/@ai-sdk/provider-utils/dist/index.js`) hace
 *   únicamente `await tool.execute(input, options)` — sin ningún `race`
 *   ni timeout propio. Si una tool ignora `options.abortSignal`, el SDK
 *   simplemente espera a que su promise resuelva sola.
 * - El SDK sí atrapa cualquier excepción que la tool tire y la convierte
 *   en un step-part `"tool-error"` en vez de tirar abajo todo
 *   `generateText()` — pero eso nunca se ejerce hoy en este proyecto
 *   porque las 7 tools existentes (y ahora esta capa) devuelven
 *   `{ok:false, error}` como un valor RESUELTO normal, nunca como
 *   excepción sin atrapar.
 *
 * Por eso esta capa hace su PROPIA carrera (`Promise.race`) entre la tool
 * real y un timeout/abort combinados — mismo patrón manual que ya usa
 * `lib/agent/loop.ts` (combinar el abortSignal de afuera con un timer
 * propio vía un `AbortController` intermedio), sin usar `AbortSignal.any`.
 * (El SDK sí usa `AbortSignal.any` internamente en `mergeAbortSignals`
 * cuando hay más de un signal para combinar — confirmado en el mismo
 * archivo — así que estaría disponible en este runtime sin problema; se
 * prefiere igual el patrón manual acá por consistencia con el resto del
 * archivo y para no sumar una dependencia de API más de la necesaria.)
 *
 * `createAgentTools`/`loop.ts` NO necesitan ningún cambio de firma para
 * que esto funcione — el abortSignal ya llega solo vía `options` en cada
 * llamada real desde `generateText`; los call sites que llaman
 * `tool.execute(input)` directo en los tests (sin `options`) also siguen
 * andando: `options` queda `undefined` y esta capa lo trata como "sin
 * abort de afuera", exactamente el mismo comportamiento que tienen hoy.
 */

export type ToolPolicy = {
  /** Timeout propio de ESTA capa. Para tools que YA tienen un timeout
   * interno (ver `tools.ts`: `run_typecheck`/`run_script` con
   * `execFileAsync(..., {timeout:120_000})`), este valor debe ser mayor
   * al interno — nunca dispara antes, solo actúa de backstop si el
   * timeout interno de la tool fallara en aplicarse (ej. un caso límite
   * de `shell:true` en Windows que no mate todo el árbol de procesos). */
  timeoutMs: number;
  /** Tope duro sobre el tamaño TOTAL serializado (`JSON.stringify`) del
   * resultado — nunca sobre un campo puntual de adentro. Ese tipo de
   * límite específico sigue siendo responsabilidad de cada tool (ver
   * `MAX_READ_BYTES`/`MAX_SEARCH_RESULTS`/etc. en `tools.ts`). Pensado
   * como red de seguridad muy por encima de lo que cualquier tool actual
   * produce hoy — no debería dispararse nunca en el camino feliz. */
  maxOutputChars: number;
};

class ToolTimeoutError extends Error {}
class ToolAbortedByAgentError extends Error {}

type MinimalToolOptions = { abortSignal?: AbortSignal } | undefined;

/**
 * Envuelve el `execute` real de una tool con la política de arriba, sin
 * tocar su firma pública: mismo `input`, mismo `options`, y en el camino
 * feliz exactamente el mismo resultado que la tool original habría
 * devuelto (sin ninguna copia/mutación de su estructura).
 *
 * `OUTPUT` debe incluir `{ok:false; error:string}` como uno de sus
 * miembros posibles — las 7 tools de `tools.ts` ya lo hacen en su propio
 * `catch`, así que el fallback de acá (timeout/abort/tamaño/excepción no
 * atrapada) encaja en el mismo shape que la tool ya podía devolver por su
 * cuenta; el `as OUTPUT` es solo para que TypeScript acepte esa unión, no
 * cambia nada en runtime.
 */
export function wrapToolExecute<INPUT, OUTPUT extends { ok: boolean }>(
  toolName: string,
  execute: (input: INPUT, options: MinimalToolOptions) => PromiseLike<OUTPUT> | OUTPUT,
  policy: ToolPolicy,
): (input: INPUT, options: MinimalToolOptions) => Promise<OUTPUT> {
  return async (input, options) => {
    const upstream = options?.abortSignal;
    const controller = new AbortController();
    let timedOut = false;

    // El executor de esta promise corre SÍNCRONO al construirla — antes
    // de armar el timer o de engancharse al signal de arriba — así que
    // `controller.signal.aborted` todavía no pudo volverse true acá
    // adentro; no hace falta chequearlo antes de agregar el listener.
    const abortWatcher = new Promise<never>((_, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(timedOut ? new ToolTimeoutError(`${toolName} superó el timeout de ${policy.timeoutMs}ms.`) : new ToolAbortedByAgentError(`${toolName} fue cancelada (la task se abortó).`)),
        { once: true },
      );
    });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, policy.timeoutMs);
    const onUpstreamAbort = () => controller.abort();
    if (upstream) {
      if (upstream.aborted) controller.abort();
      else upstream.addEventListener("abort", onUpstreamAbort, { once: true });
    }

    try {
      const result = await Promise.race([Promise.resolve(execute(input, options)), abortWatcher]);
      return capOutputSize(toolName, result, policy.maxOutputChars);
    } catch (error) {
      if (error instanceof ToolTimeoutError || error instanceof ToolAbortedByAgentError) {
        return { ok: false, error: error.message } as unknown as OUTPUT;
      }
      // Excepción real no atrapada por la tool misma (nunca debería pasar
      // con las 7 de hoy, que ya tienen su propio try/catch — esta es la
      // red de seguridad para una tool futura que se olvide del suyo).
      return { ok: false, error: error instanceof Error ? error.message : `Error inesperado en ${toolName}.` } as unknown as OUTPUT;
    } finally {
      clearTimeout(timer);
      if (upstream) upstream.removeEventListener("abort", onUpstreamAbort);
    }
  };
}

/** Mide el tamaño SERIALIZADO total del resultado y, si se pasa del tope,
 * lo reemplaza ENTERO por un `{ok:false, error}` — nunca recorre ni
 * trunca campos internos de la estructura original (eso rompería
 * contratos de la tool). En el camino normal (por debajo del tope)
 * devuelve el resultado exactamente como llegó, sin tocarlo. */
function capOutputSize<OUTPUT extends { ok: boolean }>(toolName: string, result: OUTPUT, maxOutputChars: number): OUTPUT {
  let size: number;
  try {
    size = JSON.stringify(result)?.length ?? 0;
  } catch {
    return result; // no serializable (no debería pasar) — no es el trabajo de esta capa arreglar eso
  }
  if (size <= maxOutputChars) return result;
  return {
    ok: false,
    error: `El resultado de ${toolName} superó el límite de tamaño permitido (${size} > ${maxOutputChars} caracteres) y fue descartado — usá un filtro o alcance más chico.`,
  } as unknown as OUTPUT;
}
