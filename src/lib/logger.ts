import pino, { type Logger } from "pino";
import { env, isProduction } from "./env";

// ---------- LOGGER ----------
// JSON in production so Render's log drain can parse it; pretty-printed in
// development. Credentials are redacted at the serializer level rather than
// relying on call sites to remember.

const REDACTED = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "password",
  "token",
  "access_token",
  "client_secret",
  "PAYPAL_CLIENT_SECRET",
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "DATABASE_URL",
  "*.access_token",
  "*.client_secret",
];

/**
 * pino-pretty runs as a worker-thread transport resolved at runtime, which
 * Next's bundler cannot trace — inside Next it throws "unable to determine
 * transport target". NEXT_RUNTIME is set only within Next, so the pretty
 * printer is reserved for the worker and the CLI scripts, where it is
 * genuinely useful and resolves normally.
 */
const usePrettyTransport = !isProduction && !process.env.NEXT_RUNTIME;

export const logger: Logger = pino({
  level: env.LOG_LEVEL,
  redact: { paths: REDACTED, censor: "[redacted]" },
  base: { service: "rebuttal" },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(usePrettyTransport
    ? {
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "HH:MM:ss", ignore: "pid,hostname,service" },
        },
      }
    : {}),
});

/**
 * Child logger bound to a subsystem. Use one per module so every line carries
 * the component that emitted it.
 */
export function childLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  return logger.child({ component, ...bindings });
}

// ---------- TIMING ----------

/**
 * Runs `fn`, logging duration and outcome. Errors are logged with the elapsed
 * time and rethrown untouched, so callers keep full control of handling.
 */
export async function timed<T>(
  log: Logger,
  operation: string,
  fn: () => Promise<T>,
  context: Record<string, unknown> = {},
): Promise<T> {
  const start = performance.now();
  try {
    const result = await fn();
    log.debug({ operation, durationMs: Math.round(performance.now() - start), ...context }, "ok");
    return result;
  } catch (error) {
    log.error(
      { operation, durationMs: Math.round(performance.now() - start), err: error, ...context },
      "failed",
    );
    throw error;
  }
}
