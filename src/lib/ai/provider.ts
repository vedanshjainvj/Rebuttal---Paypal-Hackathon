import { env, hasFallbackProvider } from "../env";
import { AppError } from "../errors";
import { childLogger } from "../logger";

const log = childLogger("ai.provider");

// ---------- LLM PROVIDER ----------
// One interface, two implementations, so a rate limit on the free Gemini tier
// during judging degrades to OpenAI instead of taking the demo down.

const TIMEOUT_MS = 90_000;
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 800;

export interface GenerateJsonOptions {
  system: string;
  user: string;
  /** OpenAPI-subset schema constraining the response. */
  schema: unknown;
  /** Low by default: this is extraction, not creative writing. */
  temperature?: number;
  maxOutputTokens?: number;
}

export interface GenerationResult {
  /** Parsed JSON, still unvalidated. The caller runs the Zod parse. */
  value: unknown;
  model: string;
  provider: "gemini" | "openai";
  durationMs: number;
}

export interface LlmProvider {
  readonly name: "gemini" | "openai";
  readonly model: string;
  generateJson(options: GenerateJsonOptions): Promise<GenerationResult>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function parseJsonOrThrow(text: string, provider: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // Some models wrap JSON in a fenced block despite being told not to.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        /* fall through to the error below */
      }
    }
    throw new AppError({
      code: "AI_MALFORMED_OUTPUT",
      message: `${provider} returned text that is not valid JSON`,
      retryable: true,
      context: { preview: text.slice(0, 300) },
    });
  }
}

// ---------- GEMINI ----------

interface GeminiResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  promptFeedback?: { blockReason?: string };
}

class GeminiProvider implements LlmProvider {
  readonly name = "gemini" as const;
  readonly model = env.GEMINI_MODEL;

  async generateJson(options: GenerateJsonOptions): Promise<GenerationResult> {
    if (!env.GEMINI_API_KEY) {
      throw new AppError({ code: "CONFIG", message: "GEMINI_API_KEY is not set" });
    }

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;

    const body = {
      systemInstruction: { parts: [{ text: options.system }] },
      contents: [{ role: "user", parts: [{ text: options.user }] }],
      generationConfig: {
        temperature: options.temperature ?? 0.2,
        maxOutputTokens: options.maxOutputTokens ?? 4096,
        responseMimeType: "application/json",
        responseSchema: options.schema,
      },
    };

    const started = performance.now();
    let lastError: AppError | null = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (cause) {
        lastError = new AppError({
          code: "AI_PROVIDER",
          message: "Could not reach Gemini",
          retryable: true,
          cause,
        });
        if (attempt < MAX_ATTEMPTS) {
          await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
          continue;
        }
        throw lastError;
      }

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        const rateLimited = response.status === 429;
        const retryable = rateLimited || response.status >= 500;

        lastError = new AppError({
          code: rateLimited ? "AI_RATE_LIMIT" : "AI_PROVIDER",
          message: `Gemini request failed (HTTP ${response.status})`,
          retryable,
          status: response.status,
          context: { body: text.slice(0, 400) },
        });

        if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1) * (rateLimited ? 3 : 1));
        continue;
      }

      const data = (await response.json()) as GeminiResponse;

      if (data.promptFeedback?.blockReason) {
        throw new AppError({
          code: "AI_PROVIDER",
          message: `Gemini blocked the prompt: ${data.promptFeedback.blockReason}`,
          retryable: false,
        });
      }

      const candidate = data.candidates?.[0];
      // A truncated response is almost always invalid JSON. Say why, rather
      // than letting it surface as a confusing parse error.
      if (candidate?.finishReason === "MAX_TOKENS") {
        throw new AppError({
          code: "AI_MALFORMED_OUTPUT",
          message: "Gemini hit the output token limit before completing the JSON",
          retryable: true,
        });
      }

      const text = candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      if (!text.trim()) {
        throw new AppError({
          code: "AI_MALFORMED_OUTPUT",
          message: "Gemini returned an empty response",
          retryable: true,
        });
      }

      return {
        value: parseJsonOrThrow(text, "Gemini"),
        model: this.model,
        provider: this.name,
        durationMs: Math.round(performance.now() - started),
      };
    }

    throw lastError ?? new AppError({ code: "AI_PROVIDER", message: "Gemini request failed" });
  }
}

// ---------- OPENAI ----------

interface OpenAiResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
}

class OpenAiProvider implements LlmProvider {
  readonly name = "openai" as const;
  readonly model = "gpt-4o-mini";

  async generateJson(options: GenerateJsonOptions): Promise<GenerationResult> {
    if (!env.OPENAI_API_KEY) {
      throw new AppError({ code: "CONFIG", message: "OPENAI_API_KEY is not set" });
    }

    const started = performance.now();

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxOutputTokens ?? 4096,
        // json_object rather than json_schema: the schema written for Gemini
        // omits additionalProperties, which OpenAI's strict mode requires.
        // The Zod parse downstream enforces the same contract either way.
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.user },
        ],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new AppError({
        code: response.status === 429 ? "AI_RATE_LIMIT" : "AI_PROVIDER",
        message: `OpenAI request failed (HTTP ${response.status})`,
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
        context: { body: text.slice(0, 400) },
      });
    }

    const data = (await response.json()) as OpenAiResponse;
    const text = data.choices?.[0]?.message?.content ?? "";

    if (!text.trim()) {
      throw new AppError({
        code: "AI_MALFORMED_OUTPUT",
        message: "OpenAI returned an empty response",
        retryable: true,
      });
    }

    return {
      value: parseJsonOrThrow(text, "OpenAI"),
      model: this.model,
      provider: this.name,
      durationMs: Math.round(performance.now() - started),
    };
  }
}

// ---------- SELECTION ----------

const gemini = new GeminiProvider();
const openai = new OpenAiProvider();

export function primaryProvider(): LlmProvider {
  return env.AI_PROVIDER === "openai" ? openai : gemini;
}

function secondaryProvider(): LlmProvider | null {
  if (!hasFallbackProvider) return null;
  return env.AI_PROVIDER === "openai" ? gemini : openai;
}

/**
 * Generates with the configured provider, falling back to the other one when
 * the failure is transient.
 *
 * A configuration or content-policy failure is not retried elsewhere: the
 * second provider would fail the same way, and masking it would hide a real
 * problem behind a slower path.
 */
export async function generateJson(options: GenerateJsonOptions): Promise<GenerationResult> {
  const primary = primaryProvider();

  try {
    return await primary.generateJson(options);
  } catch (error) {
    const fallback = secondaryProvider();
    const transient =
      error instanceof AppError &&
      (error.code === "AI_RATE_LIMIT" || error.code === "AI_PROVIDER") &&
      error.retryable;

    if (!fallback || !transient) throw error;

    log.warn(
      { from: primary.name, to: fallback.name, reason: (error as AppError).code },
      "primary AI provider failed, falling back",
    );
    return fallback.generateJson(options);
  }
}
