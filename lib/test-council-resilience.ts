/**
 * Prueba de aceptación de la Fase 5E (Model Council Integration — ver
 * diseño de Fase 5E + revisiones de cierre). Integra `withCredentialFailover`
 * y `runDraft`/`runDebate` con la infraestructura REAL de
 * `lib/provider-resilience/` (pool, classify, cooldown, redact) — solo se
 * mockea la llamada al modelo (`runCouncilCompletionImpl` para
 * runDraft/runDebate, o el `attempt` callback directo para
 * `withCredentialFailover` en aislamiento).
 *
 * ACTUALIZACIÓN (ronda de corrección del hallazgo bloqueante): `runVote`/
 * `createFusionJudgeReport` ya NO atrapan su propio error — lo propagan,
 * y el fallback funcional (idéntico al de antes: mismo texto "Vote
 * failed: ...", mismo `fallbackFusionJudgeReport`) se movió a los nuevos
 * `runVoteResilient`/`createFusionJudgeReportResilient`, que envuelven la
 * llamada real con `withCredentialFailover` y solo producen el fallback
 * DESPUÉS de que la rotación de credential ya agotó lo que tenía para
 * intentar. Los casos 19-22 de este archivo prueban esto de punta a
 * punta, usando `runVoteImpl`/`createFusionJudgeReportImpl` (seams nuevos,
 * solo en los wrappers — `runVote`/`createFusionJudgeReport` en sí NO
 * tienen ningún seam, siguen con su firma de siempre).
 *
 * Uso: npm run test-council-resilience
 */
import { runDraft, runDebate, runVoteResilient, createFusionJudgeReportResilient, withCredentialFailover, type runCouncilCompletion, type runVote, type createFusionJudgeReport } from "./council-run";
import { __resetProviderPoolsForTests, __getProviderPoolForTests } from "./provider-resilience/registry";
import { redactSecrets, registerSecret } from "./provider-resilience/redact";
import { getCouncilResilienceLog, __clearCouncilResilienceLogForTests } from "./provider-resilience/council-log";
import { OpenRouterError } from "./llm-shared";

let results: boolean[] = [];

function check(label: string, ok: boolean, detail?: unknown): void {
  results.push(ok);
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` — ${JSON.stringify(detail)}`}`);
}

type CompletionImpl = typeof runCouncilCompletion;

function setOpenRouterCredentials(...values: string[]): void {
  const prefix = "OPENROUTER_API_KEY";
  delete process.env[prefix];
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(`${prefix}_`)) delete process.env[key];
  }
  values.forEach((value, index) => {
    if (index === 0) process.env[prefix] = value;
    else process.env[`${prefix}_${index + 1}`] = value;
  });
}

function noop(): void {}

async function main(): Promise<void> {
  console.log("== Fase 5E — prueba de aceptación (Model Council + Provider Resilience) ==\n");

  // ==================== withCredentialFailover, aislado ====================

  console.log("--- Caso 1: una sola credential, éxito ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c1-unica");
    let calls = 0;
    const signal = new AbortController().signal;
    const result = await withCredentialFailover("openrouter", signal, async (apiKey) => {
      calls++;
      return `ok:${apiKey}`;
    });
    check("resultado correcto", result === "ok:secret-c1-unica", result);
    check("una sola llamada", calls === 1, calls);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("la credential queda AVAILABLE, consecutiveFailures=0", snap[0]?.status === "AVAILABLE" && snap[0]?.consecutiveFailures === 0, snap);
  }

  console.log("\n--- Caso 2: 401 → INVALID + failover a la siguiente ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c2-A", "secret-c2-B");
    let calls = 0;
    const signal = new AbortController().signal;
    const result = await withCredentialFailover("openrouter", signal, async () => {
      calls++;
      if (calls === 1) throw new OpenRouterError("Invalid API key provided", 401);
      return "ok";
    });
    check("resultado ok tras el failover", result === "ok", result);
    check("2 llamadas", calls === 2, calls);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("la primera credential quedó INVALID", snap.some((s) => s.status === "INVALID"), snap);
  }

  console.log("\n--- Caso 3: 429 → COOLDOWN + failover ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c3-A", "secret-c3-B");
    let calls = 0;
    const signal = new AbortController().signal;
    await withCredentialFailover("openrouter", signal, async () => {
      calls++;
      if (calls === 1) throw new OpenRouterError("rate limited", 429);
      return "ok";
    });
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("la primera credential quedó exactamente COOLDOWN (no INVALID)", snap.some((s) => s.status === "COOLDOWN"), snap);
  }

  console.log("\n--- Caso 4: 403 quota/plan → COOLDOWN + failover ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c4-A", "secret-c4-B");
    let calls = 0;
    const signal = new AbortController().signal;
    const result = await withCredentialFailover("openrouter", signal, async () => {
      calls++;
      if (calls === 1) throw new OpenRouterError("You have exceeded your current quota, please check your plan", 403);
      return "ok";
    });
    check("resultado ok", result === "ok", result);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("403 de cuota → COOLDOWN", snap.some((s) => s.status === "COOLDOWN"), snap);
  }

  console.log("\n--- Caso 5: 403 auth inválida → INVALID + failover ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c5-A", "secret-c5-B");
    let calls = 0;
    const signal = new AbortController().signal;
    await withCredentialFailover("openrouter", signal, async () => {
      calls++;
      if (calls === 1) throw new OpenRouterError("Invalid API key provided", 403);
      return "ok";
    });
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("403 auth → INVALID", snap.some((s) => s.status === "INVALID"), snap);
  }

  console.log("\n--- Caso 6: 403 policy/safety → SIN failover, propaga inmediato ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c6-A", "secret-c6-B");
    let calls = 0;
    const signal = new AbortController().signal;
    let threw = false;
    try {
      await withCredentialFailover("openrouter", signal, async () => {
        calls++;
        throw new OpenRouterError("Your request was flagged by our content_policy system", 403);
      });
    } catch {
      threw = true;
    }
    check("propaga el error, no lo absorbe", threw);
    check("UNA sola llamada — nunca intenta la 2da credential", calls === 1, calls);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("ninguna credential se degradó", snap.every((s) => s.status === "AVAILABLE" && s.consecutiveFailures === 0), snap);
  }

  console.log("\n--- Caso 7: 500/502/503 → poolAction NONE, PERO SÍ rota (poolAction=NONE nunca significa 'no failover') ---");
  for (const status of [500, 502, 503]) {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials(`secret-c7-${status}-A`, `secret-c7-${status}-B`);
    let calls = 0;
    const signal = new AbortController().signal;
    const result = await withCredentialFailover("openrouter", signal, async () => {
      calls++;
      if (calls === 1) throw new OpenRouterError(`server error ${status}`, status);
      return "ok";
    });
    check(`${status}: rota a la siguiente credential (2 llamadas) y resuelve ok`, result === "ok" && calls === 2, { result, calls });
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check(`${status}: NINGUNA credential se degrada (todas AVAILABLE, consecutiveFailures=0)`, snap.every((s) => s.status === "AVAILABLE" && s.consecutiveFailures === 0), snap);
  }

  console.log("\n--- Caso 8: timeout/network (heurística, sin status) → rota sin degradar salud ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c8a-A", "secret-c8a-B");
    let calls = 0;
    const signal = new AbortController().signal;
    const result = await withCredentialFailover("openrouter", signal, async () => {
      calls++;
      if (calls === 1) throw new Error("Request timed out");
      return "ok";
    });
    check("timeout: rota y resuelve ok", result === "ok" && calls === 2, { result, calls });
  }
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c8b-A", "secret-c8b-B");
    let calls = 0;
    const signal = new AbortController().signal;
    const result = await withCredentialFailover("openrouter", signal, async () => {
      calls++;
      if (calls === 1) throw new Error("fetch failed: ECONNRESET");
      return "ok";
    });
    check("network: rota y resuelve ok", result === "ok" && calls === 2, { result, calls });
  }

  console.log("\n--- Caso 9: UNKNOWN → propaga inmediatamente, sin ningún failover ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c9-A", "secret-c9-B");
    let calls = 0;
    const signal = new AbortController().signal;
    let threw = false;
    try {
      await withCredentialFailover("openrouter", signal, async () => {
        calls++;
        throw "un valor que ni siquiera es un Error"; // eslint-disable-line no-throw-literal
      });
    } catch {
      threw = true;
    }
    check("propaga inmediato", threw);
    check("UNA sola llamada — UNKNOWN nunca rota, ni siquiera una vez", calls === 1, calls);
  }

  console.log("\n--- Caso 10: agotamiento — todas las credentials fallan, nunca repite una ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c10-A", "secret-c10-B", "secret-c10-C");
    let calls = 0;
    const signal = new AbortController().signal;
    let threw = false;
    try {
      await withCredentialFailover("openrouter", signal, async () => {
        calls++;
        throw new OpenRouterError("rate limited siempre", 429);
      });
    } catch {
      threw = true;
    }
    check("termina en error", threw);
    check("EXACTAMENTE 3 llamadas — nunca una 4ta (repetiría alguna)", calls === 3, calls);
  }

  console.log("\n--- Caso 11: cancelación — no degrada, no rota, no consume otra credential ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c11-A", "secret-c11-B");
    const controller = new AbortController();
    let calls = 0;
    let threw = false;
    try {
      await withCredentialFailover("openrouter", controller.signal, async () => {
        calls++;
        controller.abort(); // el usuario cancela justo cuando esta llamada está fallando
        throw new OpenRouterError("rate limited", 429);
      });
    } catch {
      threw = true;
    }
    check("propaga el error de cancelación, no sigue intentando", threw);
    check("UNA sola llamada — nunca prueba la 2da credential tras abortar", calls === 1, calls);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("la credential no se degrada por una cancelación", snap.every((s) => s.status === "AVAILABLE" && s.consecutiveFailures === 0), snap);
  }

  console.log("\n--- Caso 12: no repetición dentro de la misma invocación; reuso permitido entre invocaciones independientes ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c12-A", "secret-c12-B");
    const signal = new AbortController().signal;
    const seenInFirst: string[] = [];
    await withCredentialFailover("openrouter", signal, async (apiKey) => {
      seenInFirst.push(apiKey);
      if (seenInFirst.length === 1) throw new OpenRouterError("rate limited", 429);
      return "ok";
    });
    check("dentro de una invocación, nunca repite la misma credential", new Set(seenInFirst).size === seenInFirst.length, seenInFirst);

    // Segunda invocación independiente — puede perfectamente volver a usar
    // la credential A (la que ya usó la primera), porque Draft A y Draft B
    // (aquí simulados) son operaciones hermanas, no una sola operación.
    const seenInSecond: string[] = [];
    const result2 = await withCredentialFailover("openrouter", signal, async (apiKey) => {
      seenInSecond.push(apiKey);
      return "ok";
    });
    check("una invocación nueva puede reusar cualquier credential sana, incluida la que ya usó la anterior", result2 === "ok", seenInSecond);
  }

  console.log("\n--- Caso 13: explicitApiKey — bypass total del pool, sin tocar ningún estado ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c13-pool-A", "secret-c13-pool-B");
    const signal = new AbortController().signal;
    let calls = 0;
    const result = await withCredentialFailover(
      "openrouter",
      signal,
      async (apiKey) => {
        calls++;
        return `used:${apiKey}`;
      },
      { explicitApiKey: "explicit-key-c13" },
    );
    check("usa exclusivamente la key explícita", result === "used:explicit-key-c13", result);
    check("una sola llamada", calls === 1, calls);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("NINGÚN estado del pool cambió — sigue como si nunca se hubiera llamado", snap.every((s) => s.status === "AVAILABLE" && s.consecutiveFailures === 0 && s.lastUsedAt === null), snap);
  }
  {
    console.log("--- Caso 13b: explicitApiKey también funciona cuando la llamada falla — nunca toca el pool ---");
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c13b-pool-A");
    const signal = new AbortController().signal;
    let threw = false;
    try {
      await withCredentialFailover(
        "openrouter",
        signal,
        async () => {
          throw new OpenRouterError("rate limited", 429);
        },
        { explicitApiKey: "explicit-key-c13b" },
      );
    } catch {
      threw = true;
    }
    check("propaga el error tal cual — sin ningún intento de rotar (no hay cursor)", threw);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("el pool (la key real de .env) sigue completamente intacto", snap[0]?.status === "AVAILABLE" && snap[0]?.consecutiveFailures === 0, snap);
  }

  console.log("\n--- Caso 14: redacción — un secreto embebido en el error nunca sobrevive ---");
  {
    __resetProviderPoolsForTests();
    const secreto = "SECRETO-COUNCIL-QUE-NUNCA-DEBE-APARECER";
    setOpenRouterCredentials(secreto);
    const signal = new AbortController().signal;
    let mensajeFinal = "";
    try {
      await withCredentialFailover("openrouter", signal, async () => {
        throw new OpenRouterError(`Bad request usando la key ${secreto}`, 400); // 400 = permanente, no failover-eligible
      });
    } catch (error) {
      mensajeFinal = redactSecrets(error instanceof Error ? error.message : String(error));
    }
    check("el secreto no aparece en el mensaje ya redactado", !mensajeFinal.includes(secreto), mensajeFinal);
    check("el mensaje redactado contiene [REDACTED]", mensajeFinal.includes("[REDACTED]"), mensajeFinal);
  }
  {
    console.log("--- Caso 14b: una explicitApiKey (body.apiKey) registrada también queda cubierta ---");
    const explicitSecret = "EXPLICIT-BODY-APIKEY-CASO14B";
    registerSecret(explicitSecret); // esto es lo que route.ts hace apenas resuelve body.apiKey
    const mensaje = redactSecrets(`fallo usando ${explicitSecret} en el header`);
    check("una key explícita registrada también se redacta igual que las del pool", !mensaje.includes(explicitSecret) && mensaje.includes("[REDACTED]"), mensaje);
  }

  // ==================== runDraft / runDebate — integración real ====================

  console.log("\n--- Caso 15: runDraft con runCouncilCompletionImpl fake — failover real entre credentials ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c15-A", "secret-c15-B");
    let calls = 0;
    const fakeImpl: CompletionImpl = async (_modelId, options) => {
      calls++;
      if (calls === 1) throw new OpenRouterError("rate limited", 429);
      return { content: "respuesta ok", usage: undefined } as never;
    };
    const result = await runDraft({
      modelId: "test/modelo-no-registrado",
      prompt: "pregunta de prueba",
      attachments: [],
      history: [],
      explicitOpenRouterKey: null,
      send: noop,
      offset: 0,
      signal: new AbortController().signal,
      webGrounding: false,
      skillPrompt: "",
      personaPrompt: "",
      tools: [],
      executeTool: async () => ({ name: "noop", content: "" }),
      reasoningEffort: "medium",
      runCouncilCompletionImpl: fakeImpl,
    });
    check("runDraft resuelve ok tras el failover interno", result.ok === true && result.content === "respuesta ok", result);
    check("2 llamadas (A falló, B funcionó)", calls === 2, calls);
  }

  console.log("\n--- Caso 16: runDebate con runCouncilCompletionImpl fake — mismo patrón ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c16-A", "secret-c16-B");
    let calls = 0;
    const fakeImpl: CompletionImpl = async () => {
      calls++;
      if (calls === 1) throw new OpenRouterError("provider overloaded", 503);
      return { content: "## Critique\nok\n\n## Revised Answer\nok", usage: undefined } as never;
    };
    const result = await runDebate({
      self: { modelId: "test/modelo-no-registrado", label: "Test", content: "borrador previo" },
      others: [],
      prompt: "pregunta de prueba",
      history: [],
      explicitOpenRouterKey: null,
      send: noop,
      offset: 0,
      signal: new AbortController().signal,
      skillPrompt: "",
      personaPrompt: "",
      tools: [],
      executeTool: async () => ({ name: "noop", content: "" }),
      reasoningEffort: "medium",
      round: 1,
      maxRounds: 2,
      runCouncilCompletionImpl: fakeImpl,
    });
    check("runDebate resuelve ok tras el failover interno", result.ok === true, result);
    check("2 llamadas (A falló con 503, B funcionó)", calls === 2, calls);
  }

  console.log("\n--- Caso 17: runDraft — explicitOpenRouterKey bypassea el pool también acá ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c17-pool");
    let usedKey: string | null = null;
    const fakeImpl: CompletionImpl = async (_modelId, options) => {
      usedKey = (options as { apiKey: string }).apiKey;
      return { content: "ok", usage: undefined } as never;
    };
    await runDraft({
      modelId: "test/modelo-no-registrado",
      prompt: "pregunta de prueba",
      attachments: [],
      history: [],
      explicitOpenRouterKey: "explicit-key-c17",
      send: noop,
      offset: 0,
      signal: new AbortController().signal,
      webGrounding: false,
      skillPrompt: "",
      personaPrompt: "",
      tools: [],
      executeTool: async () => ({ name: "noop", content: "" }),
      reasoningEffort: "medium",
      runCouncilCompletionImpl: fakeImpl,
    });
    check("usó la key explícita, no la del pool", usedKey === "explicit-key-c17", usedKey);
    const snap = __getProviderPoolForTests("openrouter").snapshot();
    check("el pool quedó intacto", snap[0]?.consecutiveFailures === 0 && snap[0]?.lastUsedAt === null, snap);
  }

  console.log("\n--- Caso 18: Draft A y Draft B (dos runDraft independientes) pueden compartir credential ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c18-unica");
    const usedKeys: string[] = [];
    const fakeImpl: CompletionImpl = async (_modelId, options) => {
      usedKeys.push((options as { apiKey: string }).apiKey);
      return { content: "ok", usage: undefined } as never;
    };
    const draftOptions = {
      modelId: "test/modelo-no-registrado",
      prompt: "pregunta",
      attachments: [],
      history: [],
      explicitOpenRouterKey: null,
      send: noop,
      offset: 0,
      signal: new AbortController().signal,
      webGrounding: false,
      skillPrompt: "",
      personaPrompt: "",
      tools: [],
      executeTool: async () => ({ name: "noop", content: "" }),
      reasoningEffort: "medium" as const,
      runCouncilCompletionImpl: fakeImpl,
    };
    await runDraft(draftOptions); // "Draft A"
    await runDraft(draftOptions); // "Draft B" — misma única credential configurada
    check("con una sola credential configurada, ambos drafts la usan sin problema (cursores independientes)", usedKeys.length === 2 && usedKeys[0] === "secret-c18-unica" && usedKeys[1] === "secret-c18-unica", usedKeys);
  }

  // ==================== runVoteResilient / createFusionJudgeReportResilient ====================

  console.log("\n--- Caso 19: runVoteResilient — A falla (429), B funciona → resultado real, no el fallback ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c19-A", "secret-c19-B");
    let calls = 0;
    const fakeRunVote: typeof runVote = async ({ self }) => {
      calls++;
      if (calls === 1) throw new OpenRouterError("rate limited", 429);
      return { modelId: self.modelId, label: self.label, votedFor: "peer-model", rationale: "Peer had the stronger answer.", usage: undefined };
    };
    const result = await runVoteResilient({
      self: { modelId: "model-a", label: "Model A" },
      candidates: [{ modelId: "peer-model", label: "Peer", content: "..." }],
      prompt: "pregunta",
      send: noop,
      signal: new AbortController().signal,
      runVoteImpl: fakeRunVote,
    });
    check("el wrapper SÍ observó el error de A y rotó a B — resultado real, no fallback", result.votedFor === "peer-model" && result.rationale === "Peer had the stronger answer.", result);
    check("2 llamadas (A falló, B funcionó)", calls === 2, calls);
  }

  console.log("\n--- Caso 20: runVoteResilient — todas las credentials fallan → fallback funcional original ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c20-A", "secret-c20-B");
    let calls = 0;
    let sawFallbackEvent = false;
    const fakeRunVote: typeof runVote = async () => {
      calls++;
      throw new OpenRouterError("rate limited siempre", 429);
    };
    const result = await runVoteResilient({
      self: { modelId: "model-a", label: "Model A" },
      candidates: [{ modelId: "peer-model", label: "Peer", content: "..." }],
      prompt: "pregunta",
      send: (event) => {
        if (event.type === "vote_cast" && (event as { votedForModelId?: unknown }).votedForModelId === null) sawFallbackEvent = true;
      },
      signal: new AbortController().signal,
      runVoteImpl: fakeRunVote,
    });
    check("agotadas las 2 credentials, produce el fallback funcional (votedFor: null)", result.votedFor === null && result.rationale.startsWith("Vote failed:"), result);
    check("2 llamadas (A y B, nunca una 3ra)", calls === 2, calls);
    check("se emitió el evento vote_cast de fallback (mismo shape que siempre)", sawFallbackEvent);
  }

  console.log("\n--- Caso 21: createFusionJudgeReportResilient — A falla (503), B funciona → reporte real, no el fallback ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c21-A", "secret-c21-B");
    let calls = 0;
    const fakeJudge: typeof createFusionJudgeReport = async () => {
      calls++;
      if (calls === 1) throw new OpenRouterError("provider overloaded", 503);
      return {
        report: { panelVerdict: "REAL_VERDICT_NOT_FALLBACK", consensus: [], contradictions: [], uniqueInsights: [], coverageGaps: [] },
        usage: undefined,
      };
    };
    const result = await createFusionJudgeReportResilient({
      prompt: "pregunta",
      drafts: [],
      debates: [],
      signal: new AbortController().signal,
      createFusionJudgeReportImpl: fakeJudge,
    });
    check("el wrapper observó el 503 de A y rotó a B — reporte real, no el fallback", result.report.panelVerdict === "REAL_VERDICT_NOT_FALLBACK", result);
    check("2 llamadas (A falló con 503, B funcionó)", calls === 2, calls);
  }

  console.log("\n--- Caso 22: createFusionJudgeReportResilient — todas fallan → fallbackFusionJudgeReport original ---");
  {
    __resetProviderPoolsForTests();
    setOpenRouterCredentials("secret-c22-A", "secret-c22-B");
    let calls = 0;
    const fakeJudge: typeof createFusionJudgeReport = async () => {
      calls++;
      throw new OpenRouterError("rate limited siempre", 429);
    };
    const drafts = [{ modelId: "m1", label: "M1", content: "respuesta de m1" }];
    const result = await createFusionJudgeReportResilient({
      prompt: "pregunta",
      drafts,
      debates: [],
      signal: new AbortController().signal,
      createFusionJudgeReportImpl: fakeJudge,
    });
    check("2 llamadas (A y B, nunca una 3ra)", calls === 2, calls);
    check("produce el fallback funcional original (mismo mecanismo que ya existía)", Array.isArray(result.report.coverageGaps), result);
  }

  // ============================================================
  // Fase 5F — Observability: council-log.ts (ring buffer en memoria)
  // ============================================================

  console.log("\n--- Caso 23 (5F): rotación exitosa queda registrada en el council-log con outcome=rotated ---");
  {
    __resetProviderPoolsForTests();
    __clearCouncilResilienceLogForTests();
    setOpenRouterCredentials("secret-c23-A", "secret-c23-B");
    let calls = 0;
    const signal = new AbortController().signal;
    await withCredentialFailover("openrouter", signal, async () => {
      calls++;
      if (calls === 1) throw new OpenRouterError("Invalid API key provided", 401);
      return "ok";
    });
    const events = getCouncilResilienceLog();
    check("se registró exactamente 1 evento", events.length === 1, events);
    check("outcome=rotated, provider=openrouter, credentialId presente, source=council", events[0]?.outcome === "rotated" && events[0]?.provider === "openrouter" && !!events[0]?.credentialId && events[0]?.source === "council", events[0]);
    check("el evento nunca contiene el secreto real de ninguna credential", !JSON.stringify(events[0]).includes("secret-c23"), events[0]);
  }

  console.log("\n--- Caso 24 (5F): agotamiento (Caso 10, 3 credentials en 429) queda como evento outcome=exhausted, reason=all_cooldown ---");
  {
    __resetProviderPoolsForTests();
    __clearCouncilResilienceLogForTests();
    setOpenRouterCredentials("secret-c24-A", "secret-c24-B", "secret-c24-C");
    const signal = new AbortController().signal;
    try {
      await withCredentialFailover("openrouter", signal, async () => {
        throw new OpenRouterError("rate limited siempre", 429);
      });
    } catch {
      /* esperado */
    }
    const events = getCouncilResilienceLog();
    // 3 credentials rotando (rotated x3) + 1 agotamiento final = 4
    check("se registraron 4 eventos: 3 rotaciones + 1 agotamiento, sin corromperse", events.length === 4, events);
    const last = events[events.length - 1];
    check("el último es el agotamiento: outcome=exhausted, credentialId/poolAction en null, reason=all_cooldown", last?.outcome === "exhausted" && last.credentialId === null && last.poolAction === null && last.reason === "all_cooldown", last);
  }

  console.log("\n--- Caso 25 (5F): error no failover-eligible (policy/safety, Caso 6) igual queda registrado, con outcome=stopped ---");
  {
    __resetProviderPoolsForTests();
    __clearCouncilResilienceLogForTests();
    setOpenRouterCredentials("secret-c25-A", "secret-c25-B");
    const signal = new AbortController().signal;
    try {
      await withCredentialFailover("openrouter", signal, async () => {
        throw new OpenRouterError("Your request was flagged by our content_policy system", 403);
      });
    } catch {
      /* esperado */
    }
    const events = getCouncilResilienceLog();
    check("se registró exactamente 1 evento (nunca llegó a rotar)", events.length === 1, events);
    check("outcome=stopped", events[0]?.outcome === "stopped", events[0]);
  }

  console.log("\n--- Caso 26 (5F): concurrencia — muchas llamadas simultáneas (Promise.all) no corrompen el buffer ---");
  {
    __resetProviderPoolsForTests();
    __clearCouncilResilienceLogForTests();
    setOpenRouterCredentials(...Array.from({ length: 30 }, (_, i) => `secret-c26-${i}`));
    // 10 operaciones concurrentes (como los 10 modelos reales de un run de
    // Council), cada una falla una vez (COOLDOWN) y rota. Credentials de
    // sobra (30, muy por encima de las ≤20 que se van a usar en total) a
    // propósito — el objetivo de este caso es aislar la seguridad ante
    // concurrencia del buffer en sí, no la dinámica de agotamiento (esa ya
    // la cubren los Casos 10/24, con pocas credentials).
    const ops = Array.from({ length: 10 }, (_, i) => {
      let calls = 0;
      return withCredentialFailover("openrouter", new AbortController().signal, async () => {
        calls++;
        if (calls === 1) throw new OpenRouterError(`rate limited op${i}`, 429);
        return "ok";
      });
    });
    const outcomes = await Promise.all(ops);
    check("las 10 operaciones concurrentes resuelven ok", outcomes.every((o) => o === "ok"), outcomes);
    const events = getCouncilResilienceLog();
    check("se registraron exactamente 10 eventos (1 por operación) — ninguno se perdió ni se duplicó pese a la concurrencia", events.length === 10, events.length);
    check("todos son outcome=rotated (cada una rotó exactamente una vez)", events.every((e) => e.outcome === "rotated"), events);
    check("ningún evento quedó a medio escribir (todos tienen id/ts/provider/credentialId/reason)", events.every((e) => e.id && e.ts && e.provider === "openrouter" && e.credentialId && e.reason), events);
  }

  console.log("\n--- Caso 27 (5F): el ring buffer queda acotado (no crece sin límite) ---");
  {
    __clearCouncilResilienceLogForTests();
    // Más de 50 eventos en total: cada iteración resetea el pool a 2
    // credentials sanas y las agota (2 rotated + 1 exhausted = 3 eventos),
    // 20 iteraciones × 3 = 60 eventos generados, bien por encima del cap.
    for (let i = 0; i < 20; i++) {
      __resetProviderPoolsForTests();
      setOpenRouterCredentials(`secret-c27-${i}-A`, `secret-c27-${i}-B`);
      const signal = new AbortController().signal;
      try {
        await withCredentialFailover("openrouter", signal, async () => {
          throw new OpenRouterError("rate limited siempre", 429);
        });
      } catch {
        /* esperado, se ignora — el objetivo es generar volumen de eventos */
      }
    }
    const events = getCouncilResilienceLog();
    check("se generaron más de 50 eventos en total (60), pero el log quedó acotado en 50", events.length === 50, events.length);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n${passed}/${results.length} casos OK.`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error("Error inesperado en la prueba:", error);
  process.exit(1);
});
