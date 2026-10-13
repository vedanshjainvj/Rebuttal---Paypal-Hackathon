import { asc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { disputes, evidenceDocuments, packetClaims, packets } from "../db/schema";
import { AppError, conflictError, notFound } from "../errors";
import { childLogger } from "../logger";
import { canProvideEvidence, provideEvidence } from "../paypal/disputes";
import type { EvidenceType, PayPalDispute, TrackingInfo } from "../paypal/types";

const log = childLogger("packet.submit");

// ---------- SUBMISSION ----------
// Turns a stored packet into the evidence note PayPal receives.
//
// The note is assembled here rather than taken from the model's narrative
// alone, so every claim arrives beside the record it came from. A PayPal
// reviewer reading it can check each assertion against a named source without
// asking the merchant for anything.

export interface SubmitResult {
  packetId: string;
  disputeId: string;
  evidenceType: EvidenceType;
  submittedAt: Date;
}

/** PayPal asks for a specific evidence type; fall back by dispute reason. */
function resolveEvidenceType(
  requested: string | null,
  reason: string,
): EvidenceType {
  if (requested && requested !== "OTHER") return requested as EvidenceType;

  switch (reason) {
    case "MERCHANDISE_OR_SERVICE_NOT_RECEIVED":
      return "PROOF_OF_FULFILLMENT";
    case "CREDIT_NOT_PROCESSED":
    case "DUPLICATE_TRANSACTION":
      return "PROOF_OF_REFUND";
    case "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED":
      return "ITEM_DESCRIPTION";
    default:
      return "OTHER";
  }
}

/**
 * Pulls carrier details out of the cited records.
 *
 * PayPal weighs structured tracking information far more heavily than the same
 * facts stated in prose, so when a carrier record is cited the identifiers are
 * lifted into evidence_info as well as appearing in the note.
 */
function extractTracking(sources: Array<{ kind: string; content: string }>): TrackingInfo[] {
  const tracking: TrackingInfo[] = [];

  for (const source of sources) {
    if (source.kind !== "CARRIER") continue;

    const carrier = source.content.match(/\bCarrier\s+([A-Za-z]+)/i)?.[1];
    const number = source.content.match(/tracking number\s+([A-Z0-9]+)/i)?.[1];

    if (carrier && number) {
      tracking.push({ carrier_name: carrier.toUpperCase(), tracking_number: number });
    }
  }

  return tracking;
}

function buildNote(
  narrative: string,
  claims: Array<{ ordinal: number; text: string; quote: string; title: string; sourceRef: string }>,
): string {
  const citations = claims
    .map(
      (c) =>
        `[${c.ordinal}] ${c.text}\n` +
        `    Source: ${c.title} (${c.sourceRef})\n` +
        `    Record states: "${c.quote.replace(/\s+/g, " ")}"`,
    )
    .join("\n\n");

  return [
    narrative.trim(),
    "",
    "SUPPORTING RECORDS",
    "",
    citations,
    "",
    "Every statement above is drawn from the merchant's own records and quoted verbatim.",
  ].join("\n");
}

export async function submitPacket(packetId: string): Promise<SubmitResult> {
  const [packet] = await db.select().from(packets).where(eq(packets.id, packetId)).limit(1);
  if (!packet) throw notFound("Packet", { packetId });

  // Filing twice would duplicate evidence on the case and cannot be undone.
  if (packet.state === "FILED" || packet.submittedAt) {
    throw conflictError("This packet has already been filed with PayPal", {
      packetId,
      submittedAt: packet.submittedAt,
    });
  }

  const [dispute] = await db
    .select()
    .from(disputes)
    .where(eq(disputes.disputeId, packet.disputeId))
    .limit(1);
  if (!dispute) throw notFound("Dispute", { disputeId: packet.disputeId });

  // PayPal states which actions are legal through HATEOAS links. Trusting the
  // stored copy rather than inferring from status avoids filing into a case
  // that has moved on since we last looked.
  if (!canProvideEvidence(dispute.raw as PayPalDispute)) {
    throw conflictError("PayPal is not currently accepting evidence on this dispute", {
      disputeId: dispute.disputeId,
      status: dispute.status,
      stage: dispute.lifecycleStage,
    });
  }

  const claims = await db
    .select({
      ordinal: packetClaims.ordinal,
      text: packetClaims.text,
      quote: packetClaims.quote,
      title: evidenceDocuments.title,
      sourceRef: evidenceDocuments.sourceRef,
      kind: evidenceDocuments.kind,
      content: evidenceDocuments.content,
    })
    .from(packetClaims)
    .innerJoin(evidenceDocuments, eq(packetClaims.documentId, evidenceDocuments.id))
    .where(eq(packetClaims.packetId, packetId))
    .orderBy(asc(packetClaims.ordinal));

  if (claims.length === 0) {
    throw new AppError({
      code: "VALIDATION",
      message: "Packet has no claims — nothing to file",
      retryable: false,
      status: 422,
      context: { packetId },
    });
  }

  await db
    .update(packets)
    .set({ state: "SUBMITTING", updatedAt: new Date() })
    .where(eq(packets.id, packetId));
  await db
    .update(disputes)
    .set({ packetState: "SUBMITTING", updatedAt: new Date() })
    .where(eq(disputes.disputeId, dispute.disputeId));

  const evidenceType = resolveEvidenceType(dispute.evidenceRequested, dispute.reason);
  const trackingInfo = extractTracking(claims);

  try {
    const response = await provideEvidence(
      dispute.disputeId,
      {
        evidenceType,
        notes: buildNote(packet.narrative ?? "", claims),
        trackingInfo: trackingInfo.length > 0 ? trackingInfo : undefined,
      },
      // Deterministic key: a retry of this job replays the same submission
      // rather than filing a second copy.
      `packet-${packetId}`,
    );

    const submittedAt = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(packets)
        .set({
          state: "FILED",
          submittedAt,
          paypalResponse: response,
          lastError: null,
          updatedAt: submittedAt,
        })
        .where(eq(packets.id, packetId));

      await tx
        .update(disputes)
        .set({ packetState: "FILED", updatedAt: submittedAt })
        .where(eq(disputes.disputeId, dispute.disputeId));
    });

    log.info(
      { packetId, disputeId: dispute.disputeId, evidenceType, claims: claims.length },
      "packet filed with PayPal",
    );

    return { packetId, disputeId: dispute.disputeId, evidenceType, submittedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Return the packet to a reviewable state. Leaving it SUBMITTING would
    // make a transient PayPal outage look like a permanent hole in the docket.
    await db
      .update(packets)
      .set({ state: "DRAFTED", lastError: message.slice(0, 2000), updatedAt: new Date() })
      .where(eq(packets.id, packetId));
    await db
      .update(disputes)
      .set({ packetState: "DRAFTED", updatedAt: new Date() })
      .where(eq(disputes.disputeId, dispute.disputeId));

    throw error;
  }
}
