/**
 * Fase 4 — tests de los constructores de prompts del consejo.
 *
 * Cubre `lib/council-prompts.ts` sin red: compactado, condensación para
 * pares, historial, mensajes de draft/debate/síntesis/juez/voto, follow-ups
 * e imagen. Verifica contenido y orden de las secciones, no igualdad byte a
 * byte de prompts largos.
 *
 * Uso: npm run council:test-prompts
 */
import {
  COUNCIL_MEMBER_SYSTEM_PROMPT,
  FUSION_JUDGE_SYSTEM_PROMPT,
  SYNTHESIZER_SYSTEM_PROMPT,
  VOTE_SYSTEM_PROMPT,
  buildDraftMessages,
  buildFollowUpMessages,
  buildFusionJudgePrompt,
  buildImagePrompt,
  buildSynthesisPrompt,
  buildVotePrompt,
  compactForHistory,
  condenseDraftForPeers,
  debateSystemPrompt,
  personaPrompt,
  renderHistoryBlock,
} from "./council-prompts";
import type { ConversationTurn, UploadedAttachment } from "./council-types";
import type { Persona } from "./persona-presets";

const results: boolean[] = [];
function check(ok: boolean, label: string, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}
function checkEq(actual: unknown, expected: unknown, label: string): void {
  check(JSON.stringify(actual) === JSON.stringify(expected), label, { esperado: expected, actual });
}
function includesAll(text: string, parts: string[]): boolean {
  return parts.every((part) => text.includes(part));
}

const persona: Persona = {
  key: "melchior",
  name: "Melchior",
  title: "The Scientist",
  lens: "Priorizá evidencia verificable.",
};

function main(): void {
  console.log("== Fase 4 — prompts del consejo ==\n");

  const turns: ConversationTurn[] = [
    { question: "¿Pregunta uno?", synthesis: "Respuesta uno." },
    { question: "¿Pregunta dos?", synthesis: "Respuesta dos." },
  ];

  console.log("--- compactForHistory ---");
  {
    checkEq(compactForHistory("  hola  ", 10), "hola", "recorta espacios y devuelve el texto si entra");
    checkEq(compactForHistory("1234567890", 10), "1234567890", "texto de exactamente max no se corta");
    checkEq(compactForHistory("12345678901", 10), "1234567890…", "texto más largo se corta a max y agrega ellipsis");
    checkEq(compactForHistory("  abcdefghij  ", 5), "abcde…", "recorta primero y luego corta sobre el texto limpio");
    checkEq(compactForHistory("", 5), "", "texto vacío queda vacío");
  }

  console.log("\n--- condenseDraftForPeers ---");
  {
    const structured = [
      "## Direct Answer",
      "La respuesta directa.",
      "",
      "## Key Reasoning",
      "1. Punto uno.",
      "### Subdetalle",
      "2. Punto dos.",
      "",
      "## Evidence and Signals",
      "Evidencia que no debería pasar.",
      "",
      "## Assumptions",
      "Supuestos que no deberían pasar.",
      "",
      "## Risks and Counterarguments",
      "Riesgos que no deberían pasar.",
      "",
      "## Final Recommendation",
      "La recomendación final.",
    ].join("\n");
    const condensed = condenseDraftForPeers(structured);
    check(includesAll(condensed, ["## Direct Answer", "La respuesta directa.", "## Key Reasoning", "Punto uno.", "### Subdetalle", "## Final Recommendation", "La recomendación final."]), "conserva respuesta directa, razonamiento y recomendación", condensed);
    check(!condensed.includes("Evidencia que no debería pasar") && !condensed.includes("Supuestos que no deberían pasar") && !condensed.includes("Riesgos que no deberían pasar"), "descarta evidencia, supuestos y riesgos");
    check(condensed.indexOf("## Direct Answer") < condensed.indexOf("## Key Reasoning") && condensed.indexOf("## Key Reasoning") < condensed.indexOf("## Final Recommendation"), "respeta el orden de las secciones");

    const onlyAnswer = condenseDraftForPeers("## Direct Answer\nSolo esto.\n\n## Other\nNo.");
    checkEq(onlyAnswer, "## Direct Answer\nSolo esto.", "si solo hay una sección útil, devuelve solo esa");

    const caseInsensitive = condenseDraftForPeers("## direct answer\nMinúsculas.\n\n## FINAL RECOMMENDATION\nFin.");
    check(caseInsensitive.includes("Minúsculas.") && caseInsensitive.includes("Fin."), "los headings son case-insensitive", caseInsensitive);

    const shortOffFormat = "Un draft sin headings.";
    checkEq(condenseDraftForPeers(shortOffFormat), shortOffFormat, "draft corto sin headings pasa sin cambios");

    const longOffFormat = "x".repeat(1000);
    const truncated = condenseDraftForPeers(longOffFormat);
    checkEq(truncated.length, 901, "draft largo sin headings se corta a 900 + ellipsis");
    check(truncated.endsWith("…"), "el corte de fallback termina en ellipsis");

    const otherHeading = "## Other\nContenido.\n";
    checkEq(condenseDraftForPeers(otherHeading), otherHeading, "un heading que no es de los tres usa el fallback");
  }

  console.log("\n--- renderHistoryBlock ---");
  {
    checkEq(renderHistoryBlock([]), "", "sin historial devuelve string vacío");

    const block = renderHistoryBlock(turns);
    check(includesAll(block, ["# Conversation so far", "### Turn 1", "**Question:** ¿Pregunta uno?", "**Council's prior answer (excerpt):**", "Respuesta uno.", "### Turn 2", "¿Pregunta dos?", "Respuesta dos."]), "incluye encabezado y ambos turnos", block);
    check(block.indexOf("### Turn 1") < block.indexOf("### Turn 2"), "numera los turnos en orden");

    const longTurn = renderHistoryBlock([{ question: "q", synthesis: "y".repeat(2000) }]);
    check(longTurn.includes(`${"y".repeat(1800)}…`) && !longTurn.includes("y".repeat(1801)), "la síntesis del historial se corta a 1800");
  }

  console.log("\n--- buildDraftMessages ---");
  {
    const base = buildDraftMessages("¿Pregunta?", [], []);
    checkEq(base.length, 2, "sin adjuntos ni historial devuelve system + user");
    checkEq(base[0].role, "system", "el primer mensaje es system");
    checkEq(base[0].content, COUNCIL_MEMBER_SYSTEM_PROMPT, "sin historial usa el system prompt base");
    checkEq(base[1].content, "¿Pregunta?", "sin historial el user es el prompt pelado");

    const withHistory = buildDraftMessages("¿Seguimiento?", [], turns);
    check(String(withHistory[0].content).includes("follow-up question inside an existing thread"), "con historial agrega la instrucción de seguimiento");
    const historyUser = String(withHistory[1].content);
    check(historyUser.includes("# Conversation so far") && historyUser.includes("# Current user question\n¿Seguimiento?"), "el user combina historial y pregunta actual");
    check(historyUser.indexOf("# Conversation so far") < historyUser.indexOf("# Current user question"), "el historial va antes de la pregunta actual");

    const grounded = buildDraftMessages("q", [], [], true);
    check(String(grounded[0].content).includes("Web grounding is enabled"), "webGrounding agrega la instrucción de búsqueda");

    const withSkill = buildDraftMessages("q", [], [], false, true, "SKILL-PROMPT");
    check(String(withSkill[0].content).endsWith("SKILL-PROMPT"), "skillPrompt se agrega al final del system");

    const withPersona = buildDraftMessages("q", [], [], false, true, "SKILL", "PERSONA-PROMPT");
    const systemWithPersona = String(withPersona[0].content);
    check(systemWithPersona.includes("SKILL") && systemWithPersona.endsWith("PERSONA-PROMPT"), "persona se agrega después del skill");
    check(systemWithPersona.indexOf("SKILL") < systemWithPersona.indexOf("PERSONA-PROMPT"), "skill y persona conservan el orden");

    const imageAttachment: UploadedAttachment = { name: "foto.png", type: "image/png", size: 123, kind: "image", dataUrl: "data:image/png;base64,AAAA" };
    const withImage = buildDraftMessages("Describí", [imageAttachment], []);
    const imageParts = withImage[1].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    check(Array.isArray(imageParts) && imageParts.length === 2, "con adjunto, el user es un array de partes");
    checkEq(imageParts[0].type, "text", "la primera parte es texto");
    check(imageParts[0].text?.includes("Uploaded attachments are included below") === true, "el texto avisa que hay adjuntos");
    checkEq(imageParts[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, "la imagen viaja como image_url");

    const textAttachment: UploadedAttachment = { name: "notas.txt", type: "text/plain", size: 5, kind: "text", text: "Hola texto" };
    const withText = buildDraftMessages("Leé", [textAttachment], []);
    const textParts = withText[1].content as Array<{ type: string; text?: string }>;
    check(textParts.some((part) => part.text?.includes("--- File: notas.txt (text/plain) ---") && part.text.includes("Hola texto")), "el archivo de texto se agrega con nombre y tipo");

    const longTextAttachment: UploadedAttachment = { name: "largo.txt", type: "text/plain", size: 20000, kind: "text", text: "z".repeat(20000) };
    const withLongText = buildDraftMessages("Leé", [longTextAttachment], []);
    const longParts = withLongText[1].content as Array<{ type: string; text?: string }>;
    check(longParts.some((part) => part.text?.includes("z".repeat(18000)) && !part.text.includes("z".repeat(18001))), "el texto adjunto se corta a 18000");

    const unsupportedImage: UploadedAttachment = { name: "foto.png", type: "image/png", size: 123, kind: "image", dataUrl: "data:image/png;base64,AAAA" };
    const noVision = buildDraftMessages("Describí", [unsupportedImage], [], false, false);
    const noVisionParts = noVision[1].content as Array<{ type: string; text?: string }>;
    check(!noVisionParts.some((part) => part.type === "image_url"), "sin soporte de imágenes no se manda image_url");
    check(noVisionParts[0].text?.includes("does not accept image input") === true, "sin soporte de imágenes el texto explica que se omiten");

    const genericAttachment: UploadedAttachment = { name: "datos.bin", type: "application/octet-stream", size: 99, kind: "file" };
    const generic = buildDraftMessages("Mirá", [genericAttachment], []);
    const genericParts = generic[1].content as Array<{ type: string; text?: string }>;
    check(genericParts.some((part) => part.text?.includes("--- Uploaded file: datos.bin (application/octet-stream, 99 bytes) ---")), "un archivo no inspeccionable se menciona con tamaño");

    const imageWithoutData = buildDraftMessages("Mirá", [{ name: "rota.png", type: "image/png", size: 1, kind: "image" }], []);
    const imageWithoutDataParts = imageWithoutData[1].content as Array<{ type: string; text?: string }>;
    check(imageWithoutDataParts.some((part) => part.text?.includes("--- Uploaded file: rota.png")), "una imagen sin dataUrl cae en la nota genérica");
  }

  console.log("\n--- debateSystemPrompt ---");
  {
    const first = debateSystemPrompt(1, 3);
    check(first.includes("This is the first debate round."), "ronda 1 se anuncia como primera");
    check(first.includes("## Revised Answer") && first.includes("## Critique"), "incluye la estructura requerida");

    const middle = debateSystemPrompt(2, 3);
    check(middle.includes("This is debate round 2 of 3."), "ronda intermedia se numera");
    check(!middle.includes("This is the first debate round.") && !middle.includes("FINAL debate round"), "la ronda intermedia no usa los textos de primera/final");

    const final = debateSystemPrompt(3, 3);
    check(final.includes("This is the FINAL debate round (3 of 3)."), "la última ronda se anuncia como final");
    check(final.includes("If the council has substantially converged"), "la última ronda pide declarar convergencia");

    const withPersona = debateSystemPrompt(1, 1, "PERSONA-DEBATE");
    check(withPersona.endsWith("PERSONA-DEBATE"), "persona se agrega al final del prompt de debate");
  }

  console.log("\n--- buildSynthesisPrompt ---");
  {
    const drafts = [{ label: "Alpha", content: "Draft A" }, { label: "Beta", content: "Draft B" }];
    const base = buildSynthesisPrompt("¿Pregunta?", drafts, [], []);
    check(includesAll(base, ["# Current user question\n¿Pregunta?", "# Round 1 — independent drafts", "## Alpha — initial draft\nDraft A", "## Beta — initial draft\nDraft B", "Now produce the final synthesized answer"]), "incluye pregunta, drafts y cierre de síntesis", base);
    check(!base.includes("# Round 2 — debate"), "sin debates válidos no agrega la ronda 2");
    check(!base.includes("# Fusion judge report"), "sin juez no agrega el reporte");
    check(!base.includes("# Council vote"), "sin votos no agrega la sección de voto");

    const debates = [
      { ok: true, label: "Alpha", critique: "Crítica A", revisedAnswer: "Revisión A" },
      { ok: false, label: "Beta", critique: "Crítica B" },
      { ok: true, label: "Beta" },
    ];
    const withDebates = buildSynthesisPrompt("q", drafts, debates, []);
    check(includesAll(withDebates, ["# Round 2 — debate", "## Alpha — debate", "### Critique of others\nCrítica A", "### Revised answer\nRevisión A"]), "incluye solo debates ok con contenido");
    check(!withDebates.includes("Crítica B"), "descarta debates no-ok");
    check(!withDebates.includes("## Beta — debate"), "descarta debates ok pero vacíos");

    const judgeReport = {
      panelVerdict: "Veredicto",
      consensus: [{ finding: "F", models: ["Alpha"], evidence: "E" }],
      contradictions: [],
      uniqueInsights: [],
      coverageGaps: ["G"],
    };
    const withJudge = buildSynthesisPrompt("q", drafts, [], [], judgeReport);
    check(includesAll(withJudge, ["# Fusion judge report", '"panelVerdict": "Veredicto"', '"coverageGaps"']), "incluye el reporte del juez serializado");
    check(withJudge.indexOf("# Fusion judge report") > withJudge.indexOf("## Beta — initial draft"), "el juez va después de los drafts");

    const withVote = buildSynthesisPrompt("q", drafts, [], [], undefined, "Alpha: 2 votos");
    check(includesAll(withVote, ["# Council vote", "Alpha: 2 votos", "not a binding rule"]), "incluye el resumen de votos");

    const followUp = buildSynthesisPrompt("q", drafts, [], turns);
    check(followUp.includes("This is a follow-up question in an ongoing thread."), "con historial usa la instrucción de seguimiento");
    check(!followUp.includes("Now produce the final synthesized answer"), "con historial no repite la instrucción de primera respuesta");
    check(followUp.indexOf("# Conversation so far") < followUp.indexOf("# Current user question"), "el historial va antes de la pregunta");
  }

  console.log("\n--- buildFusionJudgePrompt ---");
  {
    const drafts = [{ label: "Alpha", content: "a".repeat(6000) }, { label: "Beta", content: "B" }];
    const prompt = buildFusionJudgePrompt("¿Pregunta?", drafts, [
      { ok: true, label: "Alpha", critique: "c".repeat(3000), revisedAnswer: "r".repeat(3000) },
      { ok: false, label: "Beta", critique: "NO-DEBATE" },
    ]);
    check(includesAll(prompt, ["# User question\n¿Pregunta?", "# Independent drafts", "## Alpha", "## Beta"]), "incluye pregunta y drafts");
    check(prompt.includes(`${"a".repeat(5000)}…`) && !prompt.includes("a".repeat(5001)), "el draft se compacta a 5000");
    check(prompt.includes("# Debate outputs"), "incluye la sección de debates válidos");
    check(prompt.includes(`${"c".repeat(2200)}…`) && prompt.includes(`${"r".repeat(2200)}…`), "crítica y revisión se compactan a 2200");
    check(!prompt.includes("NO-DEBATE"), "descarta debates no-ok");
  }

  console.log("\n--- buildVotePrompt ---");
  {
    const prompt = buildVotePrompt("¿Pregunta?", [
      { label: "Alpha", content: "x".repeat(4000) },
      { label: "Beta", content: "Corta" },
    ]);
    check(includesAll(prompt, ["# User question\n¿Pregunta?", "# Final answers", "## Alpha", "## Beta", "Corta"]), "incluye pregunta y candidatos");
    check(prompt.includes(`${"x".repeat(3000)}…`) && !prompt.includes("x".repeat(3001)), "cada respuesta se compacta a 3000");
  }

  console.log("\n--- buildFollowUpMessages / buildImagePrompt ---");
  {
    const followUp = buildFollowUpMessages("¿Pregunta?", "s".repeat(8000));
    checkEq(followUp.length, 2, "follow-ups devuelve system + user");
    checkEq(followUp[0].role, "system", "el primer mensaje es system");
    check(String(followUp[0].content).includes("Return exactly four questions as a JSON array of strings."), "el system pide exactamente cuatro preguntas");
    const followUpUser = String(followUp[1].content);
    check(followUpUser.includes("Original user question:\n¿Pregunta?"), "incluye la pregunta original");
    check(followUpUser.includes(`${"s".repeat(7000)}…`) && !followUpUser.includes("s".repeat(7001)), "la síntesis se compacta a 7000");

    const imagePrompt = buildImagePrompt("Un gato", "t".repeat(2000));
    check(includesAll(imagePrompt, ["# User prompt", "Un gato", "# Context from the final answer"]), "incluye prompt e imagen");
    check(imagePrompt.includes(`${"t".repeat(1800)}…`) && !imagePrompt.includes("t".repeat(1801)), "la síntesis se compacta a 1800");
  }

  console.log("\n--- prompts de sistema y persona ---");
  {
    check(includesAll(COUNCIL_MEMBER_SYSTEM_PROMPT, ["## Direct Answer", "## Key Reasoning", "## Evidence and Signals", "## Assumptions", "## Risks and Counterarguments", "## What Would Change My View", "## Final Recommendation"]), "el prompt de miembro exige las siete secciones");
    check(includesAll(SYNTHESIZER_SYSTEM_PROMPT, ["## Bottom Line", "## In-Depth Answer", "## Where the Council Agreed", "## Where the Council Disagreed", "## Unique Insights", "## Confidence and Open Questions", "## Recommended Next Steps"]), "el prompt de síntesis exige las siete secciones");
    check(includesAll(VOTE_SYSTEM_PROMPT, ["VOTE: <exact model label as shown>", "REASON: <one specific sentence>", "do not vote strategically"]), "el prompt de voto fija el formato exacto");
    check(FUSION_JUDGE_SYSTEM_PROMPT.includes("Return JSON only. No markdown, no commentary."), "el juez de fusión pide JSON puro");

    checkEq(personaPrompt(undefined), "", "sin persona no agrega texto");
    const text = personaPrompt(persona);
    check(includesAll(text, ["# Assigned analytical persona: Melchior, \"The Scientist\"", "Priorizá evidencia verificable.", "not a character to roleplay"]), "persona incluye nombre, título, lente y disclaimer", text);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main();
