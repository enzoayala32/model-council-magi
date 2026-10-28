/**
 * Fase 4 — tests del núcleo de consenso del consejo.
 *
 * Cubre `lib/council-consensus.ts` sin red ni DB: split del debate,
 * convergencia léxica, cambio de opinión, votos, parsing del juez de fusión
 * y preguntas de seguimiento.
 *
 * Uso: npm run council:test-consensus
 */
import {
  ADAPTIVE_SKIP_THRESHOLD,
  CONVERGENCE_THRESHOLD,
  MIND_CHANGE_THRESHOLD,
  computeConvergence,
  computeMindChange,
  fallbackFusionJudgeReport,
  normalizeFusionJudgeReport,
  parseFollowUpQuestions,
  parseFusionJudgeJson,
  parseVote,
  splitDebateOutput,
  tallyVotes,
} from "./council-consensus";

const results: boolean[] = [];
function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function checkEq(actual: unknown, expected: unknown, label: string): void {
  check(label, JSON.stringify(actual) === JSON.stringify(expected), { esperado: expected, actual });
}

function words(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}${index}`);
}

function main(): void {
  console.log("== Fase 4 — consenso del consejo ==\n");

  console.log("--- splitDebateOutput ---");
  {
    const plain = splitDebateOutput("  Una crítica sin sección revisada.  ");
    checkEq(plain, { critique: "Una crítica sin sección revisada.", revisedAnswer: undefined }, "sin 'Revised Answer' devuelve todo como crítica, sin revisión");

    const withRevised = splitDebateOutput("Crítica inicial.\n\n## Revised Answer\nRespuesta revisada.\n");
    checkEq(withRevised, { critique: "Crítica inicial.", revisedAnswer: "Respuesta revisada." }, "separa crítica y respuesta revisada");

    const caseInsensitive = splitDebateOutput("Crítica.\n## revised answer\nOtra respuesta.");
    checkEq(caseInsensitive, { critique: "Crítica.", revisedAnswer: "Otra respuesta." }, "el heading es case-insensitive");

    const nested = splitDebateOutput("Crítica.\n\n## Revised Answer\n## Subsección\nTexto.");
    checkEq(nested, { critique: "Crítica.", revisedAnswer: "## Subsección\nTexto." }, "conserva subheadings dentro de la respuesta revisada");

    const extraSpaces = splitDebateOutput("Crítica.\n##   Revised Answer   \nRespuesta.");
    checkEq(extraSpaces, { critique: "Crítica.", revisedAnswer: "Respuesta." }, "tolera espacios extra en el heading");

    const onlyHeading = splitDebateOutput("## Revised Answer\nSolo la respuesta.");
    checkEq(onlyHeading, { critique: "## Revised Answer\nSolo la respuesta.", revisedAnswer: undefined }, "si el heading abre el texto no hay crítica previa que separar");
  }

  console.log("\n--- computeConvergence ---");
  {
    checkEq(computeConvergence([]), { score: 1, converged: true }, "sin respuestas se considera convergido (no hay desacuerdo)");
    checkEq(computeConvergence(["una sola respuesta"]), { score: 1, converged: true }, "una sola respuesta se considera convergida");
    checkEq(computeConvergence(["", ""]), { score: 1, converged: true }, "respuestas vacías se filtran y no rompen el cálculo");

    const base = words("alfa", 10).join(" ");
    const same = computeConvergence([base, base]);
    checkEq(same, { score: 1, converged: true }, "textos idénticos dan similitud 1");

    const disjoint = computeConvergence([words("alfa", 10).join(" "), words("beta", 10).join(" ")]);
    checkEq(disjoint, { score: 0, converged: false }, "vocabulario disjunto da similitud 0");

    const reordered = computeConvergence([words("alfa", 10).join(" "), words("alfa", 10).reverse().join(" ")]);
    checkEq(reordered, { score: 1, converged: true }, "el orden de las palabras no importa");

    const accented = computeConvergence(["Acción Estratégica Decisión", "accion estrategica decision"]);
    checkEq(accented, { score: 1, converged: true }, "normaliza mayúsculas y acentos (NFKD)");

    const stopwords = computeConvergence(["the and for with that this", "para como esto pero porque"]);
    checkEq(stopwords, { score: 1, converged: true }, "si ambos textos solo tienen stopwords, ambos conjuntos quedan vacíos y la similitud es 1");

    // 5 compartidas de 20 en la unión: exactamente el umbral 0.25.
    const sharedAtThreshold = words("comun", 5);
    const aThreshold = [...sharedAtThreshold, ...words("soloA", 10)].join(" ");
    const bThreshold = [...sharedAtThreshold, ...words("soloB", 5)].join(" ");
    const threshold = computeConvergence([aThreshold, bThreshold]);
    checkEq(threshold, { score: CONVERGENCE_THRESHOLD, converged: true }, "score exactamente 0.25 se considera convergido (>=)");

    // 4 compartidas de 20 en la unión: 0.2, por debajo del umbral.
    const sharedBelow = words("comun", 4);
    const aBelow = [...sharedBelow, ...words("soloA", 11)].join(" ");
    const bBelow = [...sharedBelow, ...words("soloB", 5)].join(" ");
    const below = computeConvergence([aBelow, bBelow]);
    check("score 0.2 no converge", below.score < CONVERGENCE_THRESHOLD && below.converged === false, below);

    const average = computeConvergence([words("alfa", 10).join(" "), words("alfa", 10).join(" "), words("beta", 10).join(" ")]);
    check("con tres respuestas promedia los tres pares (1, 0, 0) = 1/3", Math.abs(average.score - 1 / 3) < 1e-12 && average.converged === true, average);

    check("el umbral adaptativo es más estricto que el de convergencia", ADAPTIVE_SKIP_THRESHOLD > CONVERGENCE_THRESHOLD);
  }

  console.log("\n--- computeMindChange ---");
  {
    checkEq(computeMindChange("", "algo"), { similarity: 1, changed: false }, "draft vacío no se marca como cambio");
    checkEq(computeMindChange("algo", ""), { similarity: 1, changed: false }, "respuesta final vacía no se marca como cambio");
    checkEq(computeMindChange("igual", "igual"), { similarity: 1, changed: false }, "texto idéntico no es cambio de opinión");

    const reordered = computeMindChange(words("alfa", 8).join(" "), words("alfa", 8).reverse().join(" "));
    checkEq(reordered, { similarity: 1, changed: false }, "mismas palabras en otro orden no es cambio");

    const disjoint = computeMindChange(words("alfa", 8).join(" "), words("beta", 8).join(" "));
    checkEq(disjoint, { similarity: 0, changed: true }, "vocabulario disjunto sí es cambio");

    // 4 compartidas de 10 en la unión: exactamente el umbral 0.4.
    const shared = words("comun", 4);
    const initial = [...shared, ...words("inicial", 2)].join(" ");
    const final = [...shared, ...words("final", 4)].join(" ");
    const boundary = computeMindChange(initial, final);
    checkEq(boundary, { similarity: MIND_CHANGE_THRESHOLD, changed: false }, "similitud exactamente 0.4 no cuenta como cambio (< estricto)");

    const changed = computeMindChange(words("alfa", 6).join(" "), [...words("comun", 2), ...words("beta", 6)].join(" "));
    check("similitud baja marca cambio", changed.similarity < MIND_CHANGE_THRESHOLD && changed.changed === true, changed);
  }

  console.log("\n--- parseVote ---");
  {
    const candidates = [
      { modelId: "openai/gpt", label: "Alpha" },
      { modelId: "google/gemini", label: "Beta" },
      { modelId: "nvidia/nemotron", label: "Model C" },
    ];

    checkEq(parseVote("VOTE: Alpha\nREASON: Mejor evidencia.", candidates), { votedFor: { modelId: "openai/gpt", label: "Alpha" }, rationale: "Mejor evidencia." }, "voto exacto por label");
    checkEq(parseVote("vote: alpha\nreason: Clara.", candidates).votedFor, { modelId: "openai/gpt", label: "Alpha" }, "voto y razón son case-insensitive");
    checkEq(parseVote("VOTE: I choose Beta because it is stronger\nREASON: Más completa.", candidates).votedFor, { modelId: "google/gemini", label: "Beta" }, "encuentra el label dentro de una frase");
    checkEq(parseVote("VOTE: Model C\nREASON: Mejor estructura.", candidates).votedFor, { modelId: "nvidia/nemotron", label: "Model C" }, "matchea labels con espacios");
    checkEq(parseVote("VOTE: Nadie\nREASON: Empate.", candidates), { votedFor: null, rationale: "Empate." }, "label desconocido devuelve null");
    checkEq(parseVote("REASON: Sin voto.", candidates), { votedFor: null, rationale: "Sin voto." }, "sin línea VOTE devuelve null");
    checkEq(parseVote("VOTE: Alpha\nREASON: Primera línea.\nSegunda línea.", candidates).rationale, "Primera línea.", "la razón toma solo la primera línea");
    checkEq(parseVote("VOTE: Alpha", candidates), { votedFor: { modelId: "openai/gpt", label: "Alpha" }, rationale: "" }, "sin REASON la razón queda vacía");
    checkEq(parseVote("VOTE: Alpha\nREASON:   ", candidates).rationale, "", "razón con solo espacios queda vacía");
  }

  console.log("\n--- tallyVotes ---");
  {
    const candidates = [
      { modelId: "a", label: "Alpha" },
      { modelId: "b", label: "Beta" },
      { modelId: "c", label: "Gamma" },
    ];
    const votes = [
      { modelId: "a", label: "Alpha", votedFor: "a" },
      { modelId: "b", label: "Beta", votedFor: "a" },
      { modelId: "c", label: "Gamma", votedFor: "b" },
    ];
    const tally = tallyVotes(votes, candidates);
    checkEq(tally, {
      tally: [
        { modelId: "a", label: "Alpha", votes: 2 },
        { modelId: "b", label: "Beta", votes: 1 },
        { modelId: "c", label: "Gamma", votes: 0 },
      ],
      winner: { modelId: "a", label: "Alpha" },
      totalVotes: 3,
    }, "cuenta votos y elige al ganador");

    const tie = tallyVotes([
      { modelId: "a", label: "Alpha", votedFor: "a" },
      { modelId: "b", label: "Beta", votedFor: "b" },
    ], candidates);
    checkEq(tie.winner, { modelId: "a", label: "Alpha" }, "en empate gana el primero del orden de candidatos");

    const noVotes = tallyVotes([
      { modelId: "a", label: "Alpha", votedFor: null },
      { modelId: "b", label: "Beta", votedFor: null },
    ], candidates);
    checkEq(noVotes, {
      tally: [
        { modelId: "a", label: "Alpha", votes: 0 },
        { modelId: "b", label: "Beta", votes: 0 },
        { modelId: "c", label: "Gamma", votes: 0 },
      ],
      winner: null,
      totalVotes: 0,
    }, "sin votos no hay ganador");

    const unknown = tallyVotes([{ modelId: "a", label: "Alpha", votedFor: "z" }], candidates);
    checkEq(unknown.winner, null, "un voto por un id fuera de la lista no elige ganador");
    checkEq(unknown.totalVotes, 1, "pero sí cuenta como voto emitido");
    checkEq(unknown.tally.map((entry) => entry.votes), [0, 0, 0], "y no se suma a ningún candidato");
  }

  console.log("\n--- parseFusionJudgeJson ---");
  {
    checkEq(parseFusionJudgeJson('{"panelVerdict":"ok"}'), { panelVerdict: "ok" }, "parsea JSON plano");
    checkEq(parseFusionJudgeJson('```json\n{"panelVerdict":"ok"}\n```'), { panelVerdict: "ok" }, "parsea JSON en fence markdown");
    checkEq(parseFusionJudgeJson('Texto previo {"panelVerdict":"ok"} texto posterior'), { panelVerdict: "ok" }, "recorta el primer objeto dentro de texto");
    checkEq(parseFusionJudgeJson("no es json"), {}, "texto inválido devuelve objeto vacío");
    checkEq(parseFusionJudgeJson(""), {}, "texto vacío devuelve objeto vacío");
    checkEq(parseFusionJudgeJson("[1,2,3]"), [1, 2, 3], "un array JSON válido se devuelve tal cual (el normalizador decide después)");
    checkEq(parseFusionJudgeJson('```json\n{"a":1}\n```\ntexto'), { a: 1 }, "tolera texto después del fence");
  }

  console.log("\n--- normalizeFusionJudgeReport ---");
  {
    const drafts = [{ label: "Alpha", content: "draft A" }, { label: "Beta", content: "draft B" }];
    const full = normalizeFusionJudgeReport({
      panelVerdict: "  Veredicto del panel.  ",
      consensus: [{ finding: "  Hallazgo  ", models: ["Alpha", "Beta", "Gamma"], evidence: "  Evidencia  " }],
      contradictions: [{ topic: "  Tema  ", positions: { Alpha: "  Posición A  ", Gamma: "  Posición G  " }, judgment: "  Juicio  " }],
      uniqueInsights: [{ model: "Alpha", insight: "  Insight  ", whyItMatters: "  Importa  " }],
      coverageGaps: ["  Gap  "],
    }, drafts);
    checkEq(full, {
      panelVerdict: "Veredicto del panel.",
      consensus: [{ finding: "  Hallazgo  ", models: ["Alpha", "Beta"], evidence: "  Evidencia  " }],
      contradictions: [{ topic: "  Tema  ", positions: { Alpha: "  Posición A  " }, judgment: "  Juicio  " }],
      uniqueInsights: [{ model: "Alpha", insight: "  Insight  ", whyItMatters: "  Importa  " }],
      coverageGaps: ["  Gap  "],
    }, "recorta longitudes y filtra modelos que no están en los drafts (no recorta espacios internos)");

    const empty = normalizeFusionJudgeReport({}, drafts);
    checkEq(empty.panelVerdict, "The panel produced enough overlapping signal for a synthesized answer, with model-specific caveats.", "veredicto default cuando falta");
    checkEq(empty.consensus, [], "consenso default vacío");
    checkEq(empty.contradictions, [], "contradicciones default vacías");
    checkEq(empty.uniqueInsights, [], "insights default vacíos");
    checkEq(empty.coverageGaps, [], "gaps default vacíos");

    const fallback = normalizeFusionJudgeReport(null, drafts);
    check("input no-objeto usa el fallback con los labels", fallback.panelVerdict.includes("Alpha") && fallback.panelVerdict.includes("Beta"), fallback);

    const caps = normalizeFusionJudgeReport({
      consensus: Array.from({ length: 8 }, (_, i) => ({ finding: `f${i}`, models: ["Alpha"], evidence: "e" })),
      contradictions: Array.from({ length: 7 }, (_, i) => ({ topic: `t${i}`, positions: { Alpha: "p" }, judgment: "j" })),
      uniqueInsights: Array.from({ length: 10 }, (_, i) => ({ model: "Alpha", insight: `i${i}`, whyItMatters: "w" })),
      coverageGaps: Array.from({ length: 8 }, (_, i) => `g${i}`),
    }, drafts);
    checkEq(caps.consensus.length, 6, "consenso se limita a 6 entradas");
    checkEq(caps.contradictions.length, 5, "contradicciones se limitan a 5");
    checkEq(caps.uniqueInsights.length, 8, "insights se limitan a 8");
    checkEq(caps.coverageGaps.length, 6, "gaps se limitan a 6");

    const sliced = normalizeFusionJudgeReport({
      panelVerdict: "v".repeat(700),
      consensus: [{ finding: "f".repeat(800), models: [], evidence: "e".repeat(800) }],
      contradictions: [{ topic: "t".repeat(300), positions: { Alpha: "p".repeat(600) }, judgment: "j".repeat(800) }],
      uniqueInsights: [{ model: "m".repeat(200), insight: "i".repeat(800), whyItMatters: "w".repeat(800) }],
      coverageGaps: ["g".repeat(500)],
    }, drafts);
    checkEq(sliced.panelVerdict.length, 600, "panelVerdict se corta a 600");
    checkEq(sliced.consensus[0].finding.length, 700, "finding se corta a 700");
    checkEq(sliced.consensus[0].evidence.length, 700, "evidence se corta a 700");
    checkEq(sliced.contradictions[0].topic.length, 240, "topic se corta a 240");
    checkEq(sliced.contradictions[0].positions.Alpha.length, 500, "posición se corta a 500");
    checkEq(sliced.contradictions[0].judgment.length, 700, "judgment se corta a 700");
    checkEq(sliced.uniqueInsights[0].model.length, 180, "model de insight se corta a 180");
    checkEq(sliced.uniqueInsights[0].insight.length, 700, "insight se corta a 700");
    checkEq(sliced.uniqueInsights[0].whyItMatters.length, 700, "whyItMatters se corta a 700");
    checkEq(sliced.coverageGaps[0].length, 400, "coverage gap se corta a 400");

    const emptyFindings = normalizeFusionJudgeReport({
      consensus: [{ finding: "   ", models: ["Alpha"], evidence: "e" }],
      contradictions: [{ topic: "   ", positions: {}, judgment: "j" }],
      uniqueInsights: [{ model: "Alpha", insight: "   ", whyItMatters: "w" }],
    }, drafts);
    checkEq(emptyFindings.consensus, [], "hallazgos vacíos se descartan");
    checkEq(emptyFindings.contradictions, [], "contradicciones con topic vacío se descartan");
    checkEq(emptyFindings.uniqueInsights, [], "insights vacíos se descartan");

    const noDrafts = normalizeFusionJudgeReport({
      consensus: [{ finding: "f", models: ["Cualquiera"], evidence: "e" }],
      contradictions: [{ topic: "t", positions: { Otro: "p" }, judgment: "j" }],
    }, []);
    checkEq(noDrafts.consensus[0].models, ["Cualquiera"], "sin drafts no se filtra por label");
    checkEq(noDrafts.contradictions[0].positions, { Otro: "p" }, "sin drafts se conservan todas las posiciones");
  }

  console.log("\n--- fallbackFusionJudgeReport ---");
  {
    const drafts = [
      { label: "Alpha", content: "Contenido A" },
      { label: "Beta", content: "Contenido B" },
    ];
    const report = fallbackFusionJudgeReport(drafts, [
      { ok: true, label: "Alpha", critique: "Crítica A", revisedAnswer: "Revisión A" },
      { ok: false, label: "Beta", critique: "Crítica B" },
      { ok: true, label: "Beta" },
    ]);
    check("el veredicto nombra a los modelos", report.panelVerdict.includes("Alpha") && report.panelVerdict.includes("Beta"), report.panelVerdict);
    checkEq(report.consensus[0].models, ["Alpha", "Beta"], "el consenso incluye todos los labels");
    checkEq(Object.keys(report.contradictions[0].positions), ["Alpha"], "solo los debates ok y con contenido entran en contradicciones");
    checkEq(report.uniqueInsights.length, 2, "genera un insight por draft");
    checkEq(report.coverageGaps.length, 1, "incluye un gap de verificación");

    const solo = fallbackFusionJudgeReport([{ label: "Alpha", content: "Contenido A" }], []);
    check("con un solo draft avisa que no hay consenso cross-model", solo.panelVerdict.includes("solo answer"), solo.panelVerdict);
    checkEq(solo.contradictions, [], "sin debates no inventa contradicciones");

    const many = fallbackFusionJudgeReport(
      Array.from({ length: 6 }, (_, i) => ({ label: `M${i}`, content: `Contenido ${i}` })),
      [],
    );
    checkEq(many.uniqueInsights.length, 4, "los insights de fallback se limitan a 4");
  }

  console.log("\n--- parseFollowUpQuestions ---");
  {
    checkEq(parseFollowUpQuestions('["¿Uno?","¿Dos?","¿Tres?","¿Cuatro?","¿Cinco?"]'), ["¿Uno?", "¿Dos?", "¿Tres?", "¿Cuatro?"], "toma como máximo 4 preguntas");
    checkEq(parseFollowUpQuestions('```json\n["¿Uno?","¿Dos?"]\n```'), ["¿Uno?", "¿Dos?"], "parsea un fence JSON");
    checkEq(parseFollowUpQuestions('Texto ["¿Uno?","¿Dos?"] texto'), ["¿Uno?", "¿Dos?"], "recorta el array dentro de texto");
    checkEq(parseFollowUpQuestions('["¿Uno?","¿Uno?","¿DOS?","no es pregunta",42]'), ["¿Uno?", "¿DOS?"], "deduplica sin distinguir mayúsculas y filtra no-strings/no-preguntas");
    checkEq(parseFollowUpQuestions("- ¿Primera?\n- ¿Segunda?\n* ¿Tercera?"), ["¿Primera?", "¿Segunda?", "¿Tercera?"], "fallback de lista markdown");
    checkEq(parseFollowUpQuestions("1. ¿Primera?\n2) ¿Segunda?"), ["¿Primera?", "¿Segunda?"], "fallback de lista numerada");
    checkEq(parseFollowUpQuestions("¿Una?\n\n¿Dos?\n\n¿Una?"), ["¿Una?", "¿Dos?"], "fallback de líneas con deduplicación");
    checkEq(parseFollowUpQuestions('"¿Con comillas?"'), ["¿Con comillas?"], "quita comillas alrededor de la pregunta");
    checkEq(parseFollowUpQuestions(""), [], "texto vacío no produce preguntas");
    checkEq(parseFollowUpQuestions("una afirmación sin signo"), [], "descarta líneas que no terminan en ?");

    const long = `¿${"a".repeat(200)}?`;
    const shortened = parseFollowUpQuestions(JSON.stringify([long]));
    checkEq(shortened.length, 1, "una pregunta larga sigue produciendo un elemento");
    check("la pregunta larga se recorta a 157 + '?'", shortened[0].length <= 158 && shortened[0].endsWith("?"), shortened[0]);

    checkEq(parseFollowUpQuestions('{"pregunta":"¿Uno?"}'), [], "un objeto JSON no se confunde con un array de preguntas");
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
