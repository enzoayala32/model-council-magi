/**
 * Fase 5C — descubrimiento de credenciales + armado de pools por provider.
 *
 * Dueño de "cómo se descubren y arman los pools" — `pool.ts` (5A) sigue
 * sin saber nada de `.env` ni de redacción, sigue recibiendo
 * `CredentialEntry[]` ya armados desde afuera, ciego a de dónde salieron.
 * `pool.ts` NO se modifica en esta fase (decisión explícita de la ronda de
 * aprobación de 5C) — todo lo que sigue trabaja sobre su API tal cual
 * quedó cerrada en 5A/5B.
 */

import { CredentialPool, type CredentialEntry, type CredentialState } from "./pool";
import { registerSecret } from "./redact";

/** Unión cerrada a propósito — evita que un typo en un nombre de provider
 * quede sin detectar hasta runtime. No se integra ningún cliente real
 * todavía (eso es 5D/5E) — este tipo solo etiqueta pools. */
export type ProviderName = "openrouter" | "nvidia" | "google";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Descubre las credenciales de un provider a partir de `.env`:
 * - la variable base (`envPrefix`), si existe;
 * - TODAS las variables `${envPrefix}_<n>` — escaneando `Object.keys(process.env)`
 *   con una regexp, nunca probando `_1`, `_2`, `_3`... secuencialmente y
 *   parando en el primer hueco (eso perdería silenciosamente algo como
 *   `_5` si no existe `_3`/`_4` — bug detectado y corregido en la ronda 2
 *   del diseño de Fase 5);
 * - ordenadas ascendentemente por el número del sufijo, después de la base.
 *
 * Cada valor se recorta (`trim`); vacío tras el recorte se descarta sin
 * romper la numeración de las demás. Deduplicación por VALOR (post-trim):
 * si dos variables tienen el mismo string, cuenta como una sola
 * credential, conservando la posición de la primera aparición. Ninguna
 * validación de formato — una key "rara" se acepta igual, si el proveedor
 * la rechaza eso ya lo maneja `classify.ts` (5B) como 401/403.
 *
 * Nunca loguea ni devuelve nada que identifique qué variable faltaba más
 * allá del array de valores en sí — el caller decide qué hacer con eso.
 */
export function resolveCredentials(envPrefix: string): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  const addIfNew = (raw: string | undefined): void => {
    if (raw === undefined) return;
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    if (seen.has(trimmed)) return;
    seen.add(trimmed);
    ordered.push(trimmed);
  };

  addIfNew(process.env[envPrefix]);

  const numberedPattern = new RegExp(`^${escapeRegExp(envPrefix)}_(\\d+)$`);
  const numberedKeys = Object.keys(process.env)
    .map((key) => {
      const match = key.match(numberedPattern);
      return match ? { key, n: Number(match[1]) } : null;
    })
    .filter((entry): entry is { key: string; n: number } => entry !== null)
    .sort((a, b) => a.n - b.n);

  for (const { key } of numberedKeys) {
    addIfNew(process.env[key]);
  }

  return ordered;
}

/** El shape que devuelve `getProviderSnapshot` — el `CredentialState` de
 * 5A (ya seguro por construcción, sin `value`) enriquecido con `provider`
 * y `priority`, ambos agregados acá afuera sin tocar `pool.ts`: `provider`
 * es una propiedad del POOL entero (un pool es de un solo provider), y
 * `priority` es directamente la posición en `order` que `snapshot()` ya
 * preserva — ninguno de los dos necesita vivir dentro del estado interno
 * de cada credential. */
export type ProviderCredentialState = CredentialState & {
  provider: ProviderName;
  priority: number;
};

export type ProviderSnapshot = {
  provider: ProviderName;
  credentials: ProviderCredentialState[];
};

/**
 * Descubre las credenciales de `envPrefix` y arma un `CredentialPool` (5A)
 * con ellas. El id de cada una es `${provider}-${n}` según su posición
 * FINAL (después de discovery + orden + trim + deduplicación) — nunca un
 * hash ni un fragmento del valor: usar el valor del secreto para derivar
 * el id, aunque no lo exponga directamente, sigue siendo depender de él
 * innecesariamente, y un contador simple da exactamente lo mismo sin esa
 * dependencia.
 *
 * Cada valor se registra en `redact.ts` ANTES de construir el pool — para
 * que no exista ni un instante en que una credential esté activa sin que
 * `redactSecrets`/`redactError` ya la cubran.
 */
export function createProviderPool(provider: ProviderName, envPrefix: string): CredentialPool {
  const values = resolveCredentials(envPrefix);
  const entries: CredentialEntry[] = values.map((value, index) => {
    registerSecret(value);
    return { id: `${provider}-${index + 1}`, value };
  });
  return new CredentialPool(entries);
}

/** Snapshot seguro de un pool ya construido: nunca incluye `value` (5A ya
 * garantiza esto por construcción), y agrega `provider`/`priority` que
 * `pool.ts` no conoce. `priority` = posición en el snapshot (1-based) —
 * el mismo orden con el que se armaron los ids en `createProviderPool`,
 * porque `pool.snapshot()` preserva el orden de `order`, fijado en la
 * construcción y nunca alterado después (5A, "sin hot reload"). */
export function getProviderSnapshot(provider: ProviderName, pool: CredentialPool): ProviderSnapshot {
  const credentials = pool.snapshot().map((state, index) => ({
    ...state,
    provider,
    priority: index + 1,
  }));
  return { provider, credentials };
}
