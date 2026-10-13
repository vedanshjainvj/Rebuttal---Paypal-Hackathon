import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env, isProduction } from "../env";
import { childLogger } from "../logger";
import * as schema from "./schema";

const log = childLogger("db");

// ---------- CONNECTION ----------
// Neon's pooled endpoint runs PgBouncer in transaction mode, which does not
// support prepared statements. `prepare: false` is required whenever the host
// contains "-pooler"; leaving it on produces intermittent protocol errors that
// only show up under concurrency.

const isPooled = env.DATABASE_URL.includes("-pooler");

function createClient(): postgres.Sql {
  return postgres(env.DATABASE_URL, {
    ssl: "require",
    // Neon's free tier caps connections. The web app and the worker each hold
    // their own small pool rather than one large shared one.
    max: isProduction ? 10 : 5,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: !isPooled,
    connection: {
      // Server-side ceiling on a single query. Without it a request that is
      // waiting on a starved pool or a stalled socket can hang for tens of
      // minutes — observed as `GET / 500 in 27.8min` before the shared event
      // listener landed. Failing in 20 seconds is far more useful.
      statement_timeout: 20_000,
    },
    onnotice: (notice) => log.debug({ notice: notice.message }, "postgres notice"),
  });
}

// ---------- SINGLETON ----------
// Next's dev server re-evaluates modules on every edit. Without this cache each
// reload would open a new pool and exhaust Neon's connection limit within a few
// minutes of editing.

const globalForDb = globalThis as unknown as {
  __rebuttalSql?: postgres.Sql;
  __rebuttalDb?: PostgresJsDatabase<typeof schema>;
};

export const sql: postgres.Sql = globalForDb.__rebuttalSql ?? createClient();

export const db: PostgresJsDatabase<typeof schema> =
  globalForDb.__rebuttalDb ?? drizzle(sql, { schema, logger: false });

if (!isProduction) {
  globalForDb.__rebuttalSql = sql;
  globalForDb.__rebuttalDb = db;
}

export { schema };

// ---------- HEALTH ----------

export interface DbHealth {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/** Cheap liveness probe. Never throws — the health route reports, not fails. */
export async function checkDatabase(): Promise<DbHealth> {
  const start = performance.now();
  try {
    await sql`select 1`;
    return { ok: true, latencyMs: Math.round(performance.now() - start) };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : "unknown error",
    };
  }
}

/** Closes the pool. Called by scripts and on worker shutdown, not by the web app. */
export async function closeDatabase(): Promise<void> {
  await sql.end({ timeout: 5 });
  log.info("database pool closed");
}
