import { NextResponse } from "next/server";
import { checkDatabase } from "@/lib/db/client";
import { env, hasFallbackProvider } from "@/lib/env";
import { subscriberCount } from "@/lib/events/bus";
import { deadJobCount, pendingJobCount } from "@/lib/jobs/queue";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------- HEALTH ----------
// Reports component state instead of collapsing to a single boolean. The
// distinction matters on judging day: a missing webhook id is worth surfacing
// but does not mean the service is down.

export async function GET() {
  const database = await checkDatabase();

  // Queue depth is only meaningful if the database answered.
  const [pending, dead] = database.ok
    ? await Promise.all([
        pendingJobCount().catch(() => null),
        deadJobCount().catch(() => null),
      ])
    : [null, null];

  const checks = {
    database,
    jobs: { pending, dead },
    // One shared Postgres listener fans out to every SSE client. If this
    // climbs while the connection count does not, the fan-out is working.
    streamSubscribers: subscriberCount(),
    paypal: {
      configured: Boolean(env.PAYPAL_CLIENT_ID && env.PAYPAL_CLIENT_SECRET),
      apiBase: env.PAYPAL_API_BASE,
      webhookRegistered: Boolean(env.PAYPAL_WEBHOOK_ID),
    },
    ai: {
      provider: env.AI_PROVIDER,
      model: env.GEMINI_MODEL,
      fallbackAvailable: hasFallbackProvider,
    },
    demoMode: env.DEMO_MODE,
  };

  // Only the database can take the service down. Everything else is reported
  // and left for a human to read.
  const healthy = database.ok;

  return NextResponse.json(
    { status: healthy ? "ok" : "degraded", checks, timestamp: new Date().toISOString() },
    { status: healthy ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
