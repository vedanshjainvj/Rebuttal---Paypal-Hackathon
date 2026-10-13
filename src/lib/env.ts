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
  // Parsed as raw strings here; the booleans are resolved below, where
  // NODE_ENV is known. Both default ON in production — see the note on
  // resolveDeploymentFlags.
  RUN_WORKER_IN_WEB: z.enum(["true", "false"]).optional(),
  KEEPALIVE: z.enum(["true", "false"]).optional(),
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

// ---------- DEPLOYMENT FLAGS ----------
// Resolved rather than defaulted in the schema, because the right default
// depends on NODE_ENV.
//
// Both default ON in production, and that choice is deliberate. Render's free
// tier has no Background Workers, so the embedded worker is the only thing
// that processes jobs there. A service created by hand in the dashboard —
// rather than from render.yaml — never receives the blueprint's env vars, and
// the previous opt-in default meant it booted perfectly, served pages, and
// silently did no work. Nothing failed; drafts simply never happened. An
// unset variable should not be able to cause that.
//
// Running a worker twice is harmless: jobs are claimed with FOR UPDATE SKIP
// LOCKED, so an embedded worker alongside a dedicated one is safe. Set
// RUN_WORKER_IN_WEB=false explicitly once a separate worker service exists.

function flag(value: "true" | "false" | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === "true";
}

/** Whether the web process also runs the job worker. */
export const runWorkerInWeb = flag(env.RUN_WORKER_IN_WEB, isProduction);

/**
 * Whether to self-ping to stay warm. Only meaningful behind a public URL;
 * the ping has to leave and re-enter for Render to count it as traffic.
 */
export const keepAliveEnabled =
  flag(env.KEEPALIVE, isProduction) &&
  !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(env.APP_BASE_URL);

/** True when a second provider is configured and can absorb a primary outage. */
export const hasFallbackProvider =
  env.AI_PROVIDER === "gemini" ? Boolean(env.OPENAI_API_KEY) : Boolean(env.GEMINI_API_KEY);
