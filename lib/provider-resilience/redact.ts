/**
 * Fase 5C — redacción de secretos.
 *
 * Módulo hoja: no importa nada de `pool.ts`/`config.ts`/HTTP/providers, y
 * nada de ese módulo lo importa a él tampoco salvo `config.ts` (para
 * `registerSecret`). Solo sabe una cosa: "estos strings son secretos
 * ahora mismo, tachalos de cualquier texto que te pase". Memoria del
 * proceso solamente — sin persistencia, coherente con la decisión ya
 * cerrada de Fase 5 (ver diseño, ronda 3, sección 9).
 *
 * Por qué un registro explícito y NO un regex heurístico de "esto parece
 * una API key" (ej. `/sk-[a-zA-Z0-9]{20,}/`): un regex de formato depende
 * de que el formato no cambie entre proveedores y falla en silencio ante
 * uno nuevo que no calce; una lista literal de los secretos REALMENTE
 * cargados en este proceso ahora mismo es exacta sin importar el formato
 * de cada proveedor — soporta "secretos de cualquier formato" (pedido
 * explícito) porque nunca intenta reconocer un formato en absoluto.
 */

const registeredSecrets = new Set<string>();

/** Registra un valor como secreto — a partir de este momento,
 * `redactSecrets`/`redactError` lo tachan de cualquier texto. Ignora
 * valores vacíos o solo-espacios (no hay nada que proteger ahí, y
 * "redactar" un string vacío sería, en la práctica, reemplazar cada
 * posición del texto — un desastre, no una protección). */
export function registerSecret(value: string): void {
  const trimmed = value.trim();
  if (trimmed.length === 0) return;
  registeredSecrets.add(trimmed);
}

/** Reemplaza toda ocurrencia de cualquier secreto registrado por
 * `[REDACTED]` — nunca un fragmento (`sk-****abcd`): el id sintético de
 * cada credential (`openrouter-2`) ya cumple el rol de "saber cuál sin
 * revelar nada de su contenido"; mostrar un fragmento del secreto real no
 * agrega valor de debugging que el id no dé ya, y sí agrega superficie de
 * riesgo. Usa `split`/`join` (no regex) — evita tener que escapar
 * caracteres especiales de un secreto con formato arbitrario, y evita por
 * completo cualquier riesgo de ReDoS.
 *
 * Los secretos se procesan del más largo al más corto: si se registraron
 * dos secretos donde uno es substring del otro (ej. `"sk-abc"` y
 * `"sk-abcdef"`), redactar primero el corto dejaría un resto visible del
 * largo (`"[REDACTED]def"`) — procesando el más largo primero, esa
 * ocurrencia se tacha entera de una sola vez. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  const secretsLongestFirst = Array.from(registeredSecrets).sort((a, b) => b.length - a.length);
  let result = text;
  for (const secret of secretsLongestFirst) {
    result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

function safeStringify(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    return json ?? String(value); // JSON.stringify(undefined) devuelve `undefined`, no un string
  } catch {
    return String(value); // valores circulares u otros que no serializan — nunca tirar por esto
  }
}

/**
 * Contrato de `redactError` (cerrado explícitamente en la ronda de
 * aprobación de 5C — cada punto tiene su test dedicado en `test-redact.ts`):
 *
 * 1. Nunca modifica el `Error` original — siempre construye uno nuevo.
 * 2. Redacta cualquier secreto registrado dentro de `.message`.
 * 3. Si el original tiene `.stack`, redacta también los secretos ahí.
 * 4. Devuelve siempre una instancia real de `Error`.
 * 5. No introduce secretos nuevos — nunca copia nada del `error` original
 *    que no sea `.message`/`.stack`/`.name` ya redactados.
 * 6. No usa ningún regex heurístico — exclusivamente `redactSecrets`.
 * 7. Usa únicamente el registro de `registerSecret`, ninguna otra fuente.
 * 8. Si `error` no es una instancia de `Error` (string, objeto plano,
 *    `null`, `undefined`, lo que sea), el comportamiento es determinista:
 *    se obtiene una representación en texto (el string tal cual si ya lo
 *    es, o un `JSON.stringify` defensivo si no) y esa representación pasa
 *    por la misma `redactSecrets` antes de envolverse en un `Error` nuevo.
 *    Nunca tira una excepción por recibir algo inesperado.
 * 9. Decisión explícita (documentada acá y testeada): NO preserva
 *    propiedades arbitrarias del error original (ej. `.status`,
 *    `.retryAfterSeconds` de `OpenRouterError`, o cualquier campo custom)
 *    — solo `.name`/`.message`/`.stack`, ya redactados. Preservar
 *    propiedades arbitrarias complicaría el contrato sin necesidad real
 *    en esta fase (5C no integra código real todavía); si una fase
 *    posterior necesita conservar algún campo específico, se decide ahí,
 *    con el caso de uso concreto delante.
 */
export function redactError(error: unknown): Error {
  if (error instanceof Error) {
    const redacted = new Error(redactSecrets(error.message));
    redacted.name = error.name;
    if (typeof error.stack === "string") {
      redacted.stack = redactSecrets(error.stack);
    }
    return redacted;
  }

  const text = typeof error === "string" ? error : safeStringify(error);
  return new Error(redactSecrets(text));
}
