import { NextResponse } from "next/server";
import { describeError, isAppError } from "@/lib/errors";
import { childLogger } from "@/lib/logger";
import { submitPacket } from "@/lib/packet/submit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = childLogger("api.submit");

// ---------- FILE WITH PAYPAL ----------
// Runs inline rather than through the queue, deliberately.
//
// Filing is irreversible and a human has just pressed the button. They must
// see the real outcome — including PayPal's own rejection message — rather
// than an optimistic "queued" that silently dead-letters minutes later.

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  try {
    const result = await submitPacket(id);
    log.info({ packetId: id, disputeId: result.disputeId }, "packet filed");

    return NextResponse.json({
      status: "filed",
      disputeId: result.disputeId,
      evidenceType: result.evidenceType,
      submittedAt: result.submittedAt.toISOString(),
    });
  } catch (error) {
    log.error({ packetId: id, ...describeError(error) }, "submission failed");

    if (isAppError(error)) {
      // PayPal's message is more useful to the operator than ours. Conflicts
      // and validation failures are the merchant's problem to act on, so they
      // are surfaced verbatim; anything else stays generic.
      const safe =
        error.code === "CONFLICT" ||
        error.code === "VALIDATION" ||
        error.code === "PAYPAL_REQUEST";
      return NextResponse.json(
        { error: safe ? error.message : "submission failed", code: error.code },
        { status: error.status },
      );
    }

    return NextResponse.json({ error: "submission failed" }, { status: 500 });
  }
}
