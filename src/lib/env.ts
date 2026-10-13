import { z } from "zod";

// ---------- ENVIRONMENT ----------
// Deliberately not using the `server-only` package: the standalone worker runs
// outside the Next bundler, where that module resolves to its throwing variant.
// A runtime guard gives the same protection in both runtimes.

if (typeof window !== "undefined") {
  throw new Error("src/lib/env.ts was imported into a client bundle");
}

// Parsed once at module load. A missing or malformed value fails the process
// immediately with a readable report rather than surfacing as an undefined
// deep inside a request handler.

const schema = z.object({
  // ---------- RUNTIME ----------
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_BASE_URL: z.url().default("http://localhost:3000"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),

  // ---------- DATABASE ----------
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // ---------- PAYPAL ----------
  PAYPAL_CLIENT_ID: z.string().min(1, "PAYPAL_CLIENT_ID is required"),
  PAYPAL_CLIENT_SECRET: z.string().min(1, "PAYPAL_CLIENT_SECRET is required"),
  PAYPAL_API_BASE: z.url().default("https://api-m.sandbox.paypal.com"),
  PAYPAL_MERCHANT_ID: z.string().optional(),
  // Issued by PayPal only after the webhook URL is registered, so it stays
  // optional until then. Verification refuses to run without it.
  PAYPAL_WEBHOOK_ID: z.string().optional(),

  // ---------- AI ----------
  AI_PROVIDER: z.enum(["gemini", "openai"]).default("gemini"),
  GEMINI_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  // gemini-2.5-flash is closed to new API keys and returns 404 with a pointer
  // to a newer model. ListModels still advertises it, so the model list is not
  // a reliable signal of what a given key may actually call.
  //
  // flash-lite over flash: drafting ran 28-50s on the larger model, which is
  // too slow to watch. Extraction against supplied records is not a reasoning
  // task, and the grounding guard catches any quality regression rather than
  // letting it reach PayPal.
  GEMINI_MODEL: z.string().default("gemini-3.1-flash-lite"),
  // text-embedding-004 is retired. gemini-embedding-001 defaults to 3072
  // dimensions, which exceeds pgvector's 2000-dimension ceiling for hnsw
  // indexes, so it is requested at 768 via outputDimensionality.
  GEMINI_EMBEDDING_MODEL: z.string().default("gemini-embedding-001"),

  // ---------- WORKER ----------
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(50).default(5),
  WORKER_ID: z.string().default(() => `worker-${process.pid}`),

  // ---------- DEPLOYMENT ----------
  // Render's free tier has no Background Workers, so on a free deploy the
  // worker runs inside the web process. Locally it stays off, because
  // `npm run worker` is the separate process you watch.
  RUN_WORKER_IN_WEB: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),

  // Render idles a free web service after 15 minutes without traffic, and a
  // cold start then costs about a minute — long enough to lose a judge. The
  // app pings its own public URL to stay warm.
  KEEPALIVE: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  KEEPALIVE_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),

  // ---------- FEATURE FLAGS ----------
  DEMO_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

export type Env = z.infer<typeof schema>;

/**
 * A key written as `FOO=` in a .env file arrives as an empty string, which is
 * "present" to a validator and then fails every format check. Treating blanks
 * as absent is what lets defaults and `.optional()` behave as written.
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

function load(): Env {
  const parsed = schema.safeParse(withoutBlanks(process.env));

  if (!parsed.success) {
    const report = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${report}`);
  }

  // The selected provider must actually have a key. Caught here rather than on
  // the first drafting job, which would be hours into a demo.
  const e = parsed.data;
  if (e.AI_PROVIDER === "gemini" && !e.GEMINI_API_KEY) {
    throw new Error("AI_PROVIDER is 'gemini' but GEMINI_API_KEY is not set");
  }
  if (e.AI_PROVIDER === "openai" && !e.OPENAI_API_KEY) {
    throw new Error("AI_PROVIDER is 'openai' but OPENAI_API_KEY is not set");
  }

  return e;
}

export const env = load();

export const isProduction = env.NODE_ENV === "production";

/** True when a second provider is configured and can absorb a primary outage. */
export const hasFallbackProvider =
  env.AI_PROVIDER === "gemini" ? Boolean(env.OPENAI_API_KEY) : Boolean(env.GEMINI_API_KEY);
