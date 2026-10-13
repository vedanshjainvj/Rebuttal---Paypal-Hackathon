import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { disputes } from "@/lib/db/schema";
import { describeError, isAppError } from "@/lib/errors";
import { publish } from "@/lib/events/bus";
import { JOB_TYPES, enqueue } from "@/lib/jobs/queue";
import { childLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = childLogger("api.draft");

// ---------- REQUEST A DRAFT ----------
// Enqueues rather than drafting inline. Drafting takes ten seconds or more,
// which would hold a request handler open and time out behind most proxies.
// The client watches /api/stream for the result.

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const [dispute] = await db
      .select({ state: disputes.packetState })
      .from(disputes)
      .where(eq(disputes.disputeId, id))
      .limit(1);

    if (!dispute) {
      return NextResponse.json({ error: "dispute not found" }, { status: 404 });
    }

    // Re-drafting a filed packet cannot change what PayPal already received.
    if (dispute.state === "FILED") {
      return NextResponse.json(
        { error: "this dispute has already been filed" },
        { status: 409 },
      );
    }

    const job = await enqueue(
      JOB_TYPES.BUILD_PACKET,
      { disputeId: id, force: true },
      // Timestamped so an explicit re-draft is never collapsed into an
      // earlier queued attempt the user has already seen fail.
      { dedupeKey: `draft:${id}:${Date.now()}` },
    );

    await db
      .update(disputes)
      .set({ packetState: "QUEUED", updatedAt: new Date() })
      .where(eq(disputes.disputeId, id));

    await publish({ type: "packet.queued", disputeId: id, message: "queued for drafting" });

    log.info({ disputeId: id, jobId: job?.id }, "draft requested");
    return NextResponse.json({ status: "queued", jobId: job?.id }, { status: 202 });
  } catch (error) {
    log.error({ disputeId: id, ...describeError(error) }, "failed to queue draft");
    const status = isAppError(error) ? error.status : 500;
    return NextResponse.json({ error: "could not queue drafting" }, { status });
  }
}
