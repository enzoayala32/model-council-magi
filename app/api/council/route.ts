import { NextResponse } from "next/server";
import { COUNCIL_MODELS, getCouncilModel } from "@/lib/models";
import { OpenRouterError, createChatCompletion } from "@/lib/openrouter";

export const maxDuration = 120;

type CouncilRequest = {
  prompt?: string;
  selectedModels?: string[];
  apiKey?: string;
  mode?: "balanced" | "critical" | "creative";
};

type ModelResult = {
  id: string;
  label: string;
  maker: string;
  ok: boolean;
  content?: string;
  error?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

const MODE_INSTRUCTIONS = {
  balanced: "Answer with calibrated confidence. Capture both practical value and caveats.",
  critical: "Stress-test claims, flag uncertainty, and prefer falsifiable reasoning over fluency.",
  creative: "Surface unusual options and useful reframes, while still separating fact from speculation.",
};

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as CouncilRequest;
    const prompt = body.prompt?.trim();
    const apiKey = body.apiKey?.trim() || process.env.OPENROUTER_API_KEY;
    const selectedModels = normalizeSelection(body.selectedModels);
    const mode = body.mode ?? "balanced";

    if (!prompt) {
      return NextResponse.json({ error: "Enter a prompt for the council." }, { status: 400 });
    }

    if (!apiKey) {
      return NextResponse.json(
        { error: "Set OPENROUTER_API_KEY in .env or enter a temporary key in the UI." },
        { status: 400 },
      );
    }

    const modelResults = await Promise.all(
      selectedModels.map(async (modelId) => queryCouncilModel(modelId, prompt, apiKey, mode)),
    );

    const successful = modelResults.filter((result) => result.ok && result.content);
    if (successful.length === 0) {
      return NextResponse.json(
        {
          error: "All council models failed.",
          modelResults,
        },
        { status: 502 },
      );
    }

    const synthesis = await synthesizeCouncil(prompt, successful, apiKey, mode);

    return NextResponse.json({
      synthesis,
      modelResults,
      selectedModels,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

function normalizeSelection(selectedModels: string[] | undefined) {
  const knownIds = new Set(COUNCIL_MODELS.map((model) => model.id));
  const requested = (selectedModels ?? [])
    .filter((id): id is string => typeof id === "string")
    .filter((id) => knownIds.has(id));

  const fallback = COUNCIL_MODELS.filter((model) => model.defaultSelected).map((model) => model.id);
  const normalized = requested.length > 0 ? requested : fallback;

  return Array.from(new Set(normalized)).slice(0, 4);
}

async function queryCouncilModel(
  modelId: string,
  prompt: string,
  apiKey: string,
  mode: keyof typeof MODE_INSTRUCTIONS,
): Promise<ModelResult> {
  const model = getCouncilModel(modelId);

  try {
    const completion = await createChatCompletion({
      model: modelId,
      apiKey,
      maxTokens: 5200,
      temperature: mode === "creative" ? 0.5 : 0.22,
      reasoningEffort: model?.reasoning ? "high" : "medium",
      messages: [
        {
          role: "system",
          content: [
            "You are one independent expert member of an AI Model Council.",
            "Give your own best answer before seeing other models.",
            MODE_INSTRUCTIONS[mode],
            "Do deeper analysis than a quick chat answer. Stress-test assumptions, identify the best counterargument to your own conclusion, and name what evidence would change your view.",
            "Structure the response with: Direct Answer, Key Reasoning, Evidence or Signals, Assumptions, Risks and Disagreements, What Would Change My View, Final Recommendation.",
            "Do not reveal hidden chain-of-thought. Keep reasoning concise and auditable.",
          ].join("\n"),
        },
        {
          role: "user",
          content: prompt,
        },
      ],
    });

    return {
      id: modelId,
      label: model?.label ?? modelId,
      maker: model?.maker ?? "Unknown",
      ok: true,
      content: completion.content,
      usage: completion.usage,
    };
  } catch (error) {
    return {
      id: modelId,
      label: model?.label ?? modelId,
      maker: model?.maker ?? "Unknown",
      ok: false,
      error:
        error instanceof OpenRouterError || error instanceof Error
          ? error.message
          : "Model request failed.",
    };
  }
}

async function synthesizeCouncil(
  prompt: string,
  modelResults: ModelResult[],
  apiKey: string,
  mode: keyof typeof MODE_INSTRUCTIONS,
) {
  const councilTranscript = modelResults
    .map((result) => `## ${result.label} (${result.id})\n${result.content}`)
    .join("\n\n---\n\n");

  const synthesisModel = process.env.SYNTHESIS_MODEL ?? "openai/gpt-5.4";
  const completion = await createChatCompletion({
    model: synthesisModel,
    apiKey,
    maxTokens: 6000,
    temperature: 0.18,
    reasoningEffort: "high",
    messages: [
      {
        role: "system",
        content: [
          "You are the neutral synthesizer for an open-source Model Council.",
          "Review independent model answers and produce a single useful response.",
          "Explicitly show where models agree, where they differ, and what the user should trust most.",
          "Do not expose hidden chain-of-thought. Use concise, evidence-like rationale.",
          MODE_INSTRUCTIONS[mode],
          "Use this exact markdown structure: Where Models Agree, Where Models Disagree, Unique Discoveries, High-confidence Summary, Actionable Next Steps, Follow-up Checks.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `Original prompt:\n${prompt}\n\nCouncil member outputs:\n${councilTranscript}`,
      },
    ],
  });

  return {
    model: completion.model,
    content: completion.content,
    usage: completion.usage,
  };
}
