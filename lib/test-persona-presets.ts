/**
 * Fase 4 — tests de los presets de personas del consejo.
 *
 * Cubre `lib/persona-presets.ts` como dato puro: integridad de los presets,
 * búsqueda por id y asignación por asiento. Sin red ni DB.
 *
 * Uso: npm run council:test-persona-presets
 */
import {
  PERSONA_PRESETS,
  assignPersonas,
  getPersonaPreset,
  type PersonaPreset,
} from "./persona-presets";

const results: boolean[] = [];
function check(ok: boolean, label: string, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function checkEq(actual: unknown, expected: unknown, label: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, { esperado: expected, actual });
}

function main(): void {
  console.log("== Fase 4 — presets de personas ==\n");

  console.log("--- integridad del catálogo ---");
  {
    checkEq(PERSONA_PRESETS.length, 5, "hay exactamente 5 presets");
    checkEq(PERSONA_PRESETS.map((preset) => preset.id), ["eva", "code-review", "research", "writing", "strategy"], "los ids están en el orden esperado");

    const ids = PERSONA_PRESETS.map((preset) => preset.id);
    checkEq(new Set(ids).size, ids.length, "los ids de preset son únicos");

    const labels = PERSONA_PRESETS.map((preset) => preset.label);
    checkEq(new Set(labels).size, labels.length, "los labels de preset son únicos");

    check(PERSONA_PRESETS.every((preset) => preset.label.trim().length > 0), "todos los presets tienen label");
    check(PERSONA_PRESETS.every((preset) => preset.description.trim().length > 0), "todos los presets tienen descripción");
    check(PERSONA_PRESETS.every((preset) => preset.description.trim().endsWith(".")), "las descripciones terminan en punto");

    check(PERSONA_PRESETS.every((preset) => preset.personas.length === 3), "cada preset tiene exactamente 3 personas");

    const keysPerPreset = PERSONA_PRESETS.map((preset) => preset.personas.map((persona) => persona.key));
    check(keysPerPreset.every((keys) => new Set(keys).size === keys.length), "las keys son únicas dentro de cada preset");

    const allKeys = keysPerPreset.flat();
    checkEq(new Set(allKeys).size, allKeys.length, "las keys son únicas en todo el catálogo");

    const allPersonas = PERSONA_PRESETS.flatMap((preset) => preset.personas);
    check(allPersonas.every((persona) => persona.name.trim().length > 0), "todas las personas tienen nombre");
    check(allPersonas.every((persona) => persona.title.trim().startsWith("The ")), "todos los títulos empiezan con 'The '");
    check(allPersonas.every((persona) => persona.lens.trim().length > 100), "todas las lentes tienen contenido sustantivo (>100 chars)");
    check(allPersonas.every((persona) => persona.lens.trim().endsWith(".")), "todas las lentes terminan en punto");

    const lenses = allPersonas.map((persona) => persona.lens);
    checkEq(new Set(lenses).size, lenses.length, "no hay lentes duplicadas entre personas");

    check(allKeys.every((key) => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)), "las keys son slugs en minúsculas");
  }

  console.log("\n--- composición por preset ---");
  {
    const expected: Record<string, string[]> = {
      eva: ["melchior", "balthasar", "casper"],
      "code-review": ["security", "performance", "quality"],
      research: ["methodologist", "domain-expert", "devils-advocate"],
      writing: ["editor", "reader", "fact-checker"],
      strategy: ["optimist", "pessimist", "pragmatist"],
    };
    for (const preset of PERSONA_PRESETS) {
      checkEq(preset.personas.map((persona) => persona.key), expected[preset.id], `${preset.id} tiene las personas esperadas`);
    }

    const eva = getPersonaPreset("eva") as PersonaPreset;
    checkEq(eva.personas.map((persona) => persona.name), ["Melchior", "Balthasar", "Casper"], "MAGI conserva los nombres clásicos");
    checkEq(eva.personas.map((persona) => persona.title), ["The Scientist", "The Guardian", "The Advocate"], "MAGI conserva los títulos clásicos");
  }

  console.log("\n--- getPersonaPreset ---");
  {
    checkEq(getPersonaPreset(undefined), undefined, "id undefined no encuentra preset");
    checkEq(getPersonaPreset(""), undefined, "id vacío no encuentra preset");
    checkEq(getPersonaPreset("no-existe"), undefined, "id desconocido no encuentra preset");
    checkEq(getPersonaPreset("EVA"), undefined, "la búsqueda es case-sensitive (EVA no matchea eva)");
    checkEq(getPersonaPreset("eva")?.id, "eva", "encuentra eva por id");
    checkEq(getPersonaPreset("code-review")?.id, "code-review", "encuentra code-review por id");
    check(getPersonaPreset("eva") === PERSONA_PRESETS[0], "devuelve la misma referencia del catálogo, no una copia");
  }

  console.log("\n--- assignPersonas ---");
  {
    const preset = getPersonaPreset("eva") as PersonaPreset;

    const three = assignPersonas(["openai/gpt-5", "google/gemini", "nvidia/nemotron"], preset);
    checkEq(Object.keys(three), ["openai/gpt-5", "google/gemini", "nvidia/nemotron"], "asigna una persona por modelo en orden");
    checkEq(three["openai/gpt-5"].key, "melchior", "el primer asiento recibe melchior");
    checkEq(three["google/gemini"].key, "balthasar", "el segundo asiento recibe balthasar");
    checkEq(three["nvidia/nemotron"].key, "casper", "el tercer asiento recibe casper");

    const two = assignPersonas(["a", "b"], preset);
    checkEq(Object.keys(two), ["a", "b"], "con dos modelos asigna solo dos asientos");
    checkEq(two.b.key, "balthasar", "el segundo modelo recibe la segunda persona");

    const one = assignPersonas(["solo"], preset);
    checkEq(one.solo.key, "melchior", "con un modelo asigna la primera persona");

    const four = assignPersonas(["a", "b", "c", "d"], preset);
    checkEq(Object.keys(four), ["a", "b", "c"], "con cuatro modelos ignora el cuarto (solo hay tres personas)");
    check(!("d" in four), "el cuarto modelo no queda en el mapa");

    checkEq(assignPersonas([], preset), {}, "sin modelos devuelve un mapa vacío");

    const duplicate = assignPersonas(["a", "a", "b"], preset);
    checkEq(Object.keys(duplicate), ["a", "b"], "un modelo repetido no crea una clave extra");
    checkEq(duplicate.a.key, "balthasar", "la última asignación del modelo repetido gana (segundo asiento)");

    const before = JSON.stringify(preset);
    assignPersonas(["x", "y", "z"], preset);
    checkEq(JSON.stringify(preset), before, "asignar no muta el preset");

    const otherPreset = getPersonaPreset("strategy") as PersonaPreset;
    const strategy = assignPersonas(["m1", "m2", "m3"], otherPreset);
    checkEq(Object.values(strategy).map((persona) => persona.key), ["optimist", "pessimist", "pragmatist"], "funciona con un preset distinto");
    check(strategy.m1 !== preset.personas[0], "las personas asignadas son las del preset elegido");
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
