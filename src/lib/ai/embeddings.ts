import { env } from "../env";
import { AppError } from "../errors";
import { childLogger } from "../logger";

const log = childLogger("ai.embeddings");

// ---------- EMBEDDINGS ----------
// gemini-embedding-001 at 768 dimensions, matching EMBEDDING_DIMENSIONS in the
// schema. Changing the model means changing that constant and re-indexing
// every chunk — the two cannot drift apart.
//
// 768 is not the model's default. gemini-embedding-001 returns 3072
// dimensions unless told otherwise, and pgvector's hnsw index rejects anything
// above 2000, so the smaller size is a hard requirement rather than a
// preference. The model is trained with Matryoshka representation learning, so
// truncated vectors stay meaningful.

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 600;

const OUTPUT_DIMENSIONS = 768;

/**
 * The current embedding models expose embedContent and asyncBatchEmbedContent,
 * but not the synchronous batchEmbedContents. Many inputs are therefore sent as
 * concurrent single calls, capped so the free tier's rate limit is not tripped.
 */
const CONCURRENCY = 4;

/**
 * Asymmetric retrieval: documents and queries are embedded with different
 * task types. Using the same type for both measurably degrades recall, and
 * it is a silent failure — results look plausible but rank badly.
 */
export type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

interface EmbedResponse {
  embedding?: { values: number[] };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function apiKey(): string {
  const key = env.GEMINI_API_KEY;
  if (!key) {
    throw new AppError({
      code: "CONFIG",
      message: "GEMINI_API_KEY is required to generate embeddings",
      retryable: false,
    });
  }
  return key;
}

async function callGemini<T>(path: string, body: unknown): Promise<T> {
  const url = `${API_ROOT}/${path}`;
  let lastError: AppError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (cause) {
      lastError = new AppError({
        code: "AI_PROVIDER",
        message: "Could not reach the Gemini embedding API",
        retryable: true,
        status: 503,
        cause,
      });
      if (attempt < MAX_ATTEMPTS) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
        continue;
      }
      throw lastError;
    }

    if (response.ok) {
      return (await response.json()) as T;
    }

    const text = await response.text().catch(() => "");
    const rateLimited = response.status === 429;
    const retryable = rateLimited || response.status >= 500;

    lastError = new AppError({
      code: rateLimited ? "AI_RATE_LIMIT" : "AI_PROVIDER",
      message: `Gemini embedding request failed (HTTP ${response.status})`,
      retryable,
      status: response.status,
      context: { body: text.slice(0, 400) },
    });

    if (!retryable || attempt === MAX_ATTEMPTS) throw lastError;

    // The free tier rate-limits aggressively; back off hard rather than
    // hammering and burning the daily quota on rejected requests.
    const delay = BASE_BACKOFF_MS * 2 ** (attempt - 1) * (rateLimited ? 3 : 1);
    log.warn({ attempt, status: response.status, delay }, "embedding request failed, retrying");
    await sleep(delay);
  }

  throw lastError ?? new AppError({ code: "AI_PROVIDER", message: "Embedding request failed" });
}

function assertDimensions(values: number[], index: number): number[] {
  // A dimension mismatch would be rejected by Postgres anyway, but the error
  // there names a column, not the model. Fail here where the cause is obvious.
  if (values.length !== OUTPUT_DIMENSIONS) {
    throw new AppError({
      code: "AI_PROVIDER",
      message: `Embedding ${index} has ${values.length} dimensions, expected ${OUTPUT_DIMENSIONS}`,
      retryable: false,
    });
  }
  return values;
}

/**
 * Scales to unit length. Google normalises only the full-size output, so a
 * truncated Matryoshka vector arrives un-normalised. Cosine distance would
 * rescale anyway, but storing unit vectors keeps the column well-formed and
 * makes the values comparable if a dot-product operator is ever used instead.
 */
function normalise(values: number[]): number[] {
  let sumSquares = 0;
  for (const v of values) sumSquares += v * v;
  const magnitude = Math.sqrt(sumSquares);
  if (magnitude === 0) return values;
  return values.map((v) => v / magnitude);
}

// ---------- PUBLIC API ----------

export async function embedOne(text: string, task: EmbeddingTask): Promise<number[]> {
  const model = env.GEMINI_EMBEDDING_MODEL;
  const data = await callGemini<EmbedResponse>(`models/${model}:embedContent`, {
    model: `models/${model}`,
    content: { parts: [{ text }] },
    taskType: task,
    outputDimensionality: OUTPUT_DIMENSIONS,
  });

  const values = data.embedding?.values;
  if (!values) {
    throw new AppError({
      code: "AI_MALFORMED_OUTPUT",
      message: "Gemini returned no embedding values",
      retryable: true,
    });
  }
  return normalise(assertDimensions(values, 0));
}

/**
 * Embeds many texts with bounded concurrency. Order is preserved: results are
 * written back by index, never by completion order.
 */
export async function embedMany(
  texts: string[],
  task: EmbeddingTask,
): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out = new Array<number[]>(texts.length);
  const started = performance.now();
  let cursor = 0;

  async function drain(): Promise<void> {
    while (cursor < texts.length) {
      const index = cursor++;
      out[index] = await embedOne(texts[index], task);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, texts.length) }, () => drain()),
  );

  log.debug(
    { count: texts.length, durationMs: Math.round(performance.now() - started) },
    "embedded texts",
  );

  return out;
}
