import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { disputes, packets, webhookEvents } from "../db/schema";
import { publish } from "../events/bus";
import { notFound } from "../errors";
import { indexDocument } from "../evidence/ingest";
import { syncAllDisputes, syncDispute } from "../disputes/sync";
import { childLogger } from "../logger";
import { draftPacket } from "../packet/draft";
import { submitPacket } from "../packet/submit";
import { JOB_TYPES, enqueue, type JobType } from "./queue";

const log = childLogger("jobs.handlers");

// ---------- HANDLERS ----------
// One function per job type. Each is responsible for being safely re-runnable:
// the queue guarantees at-least-once delivery, never exactly-once.

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

// ---------- INGEST DISPUTE ----------

async function ingestDispute(payload: Record<string, unknown>): Promise<void> {
  const disputeId = String(payload.disputeId ?? "");
  if (!disputeId) throw notFound("disputeId in job payload");

  const { dispute, created } = await syncDispute(disputeId, process.env.PAYPAL_MERCHANT_ID);

  await publish({
    type: created ? "dispute.ingested" : "dispute.updated",
    disputeId,
    message: `${dispute.reason} · ${dispute.amountValue} ${dispute.currency}`,
  });

  // Mark the originating webhook processed so the reconciliation sweep can
  // tell a delivery that was handled from one that was merely recorded.
  if (payload.webhookEventId) {
    await db
      .update(webhookEvents)
      .set({ processedAt: new Date() })
      .where(eq(webhookEvents.paypalEventId, String(payload.webhookEventId)));
  }

  // Only chase evidence when PayPal is actually waiting on the merchant.
  // Drafting for a resolved case burns model quota for nothing.
  if (dispute.status === "WAITING_FOR_SELLER_RESPONSE" && dispute.packetState === "NONE") {
    await enqueue(
      JOB_TYPES.BUILD_PACKET,
      { disputeId },
      { dedupeKey: `draft:${disputeId}` },
    );
  }
}

// ---------- BUILD PACKET ----------

async function buildPacket(payload: Record<string, unknown>): Promise<void> {
  const disputeId = String(payload.disputeId ?? "");
  if (!disputeId) throw notFound("disputeId in job payload");

  await publish({ type: "packet.retrieving", disputeId, message: "searching your records" });

  const outcome = await draftPacket({
    disputeId,
    force: Boolean(payload.force),
  });

  await publish({
    type: "packet.drafted",
    disputeId,
    packetId: outcome.packet.id,
    message:
      `${outcome.grounding.grounded.length} cited claims · ` +
      `${outcome.packet.winScore}% win read`,
  });
}

// ---------- INDEX DOCUMENT ----------

async function indexDocumentJob(payload: Record<string, unknown>): Promise<void> {
  const documentId = String(payload.documentId ?? "");
  if (!documentId) throw notFound("documentId in job payload");
  await indexDocument(documentId);
}

// ---------- SUBMIT PACKET ----------

async function submitPacketJob(payload: Record<string, unknown>): Promise<void> {
  const packetId = String(payload.packetId ?? "");
  if (!packetId) throw notFound("packetId in job payload");

  const [packet] = await db.select().from(packets).where(eq(packets.id, packetId)).limit(1);
  if (!packet) throw notFound("Packet", { packetId });

  const result = await submitPacket(packetId);

  await publish({
    type: "packet.submitted",
    disputeId: packet.disputeId,
    packetId,
    message: `filed with PayPal · ${result.evidenceType}`,
  });
}

// ---------- RECONCILE ----------
// Rebuilds the docket from PayPal. Webhooks are the fast path, but a missed
// delivery — a restart, a dead tunnel, a retry PayPal eventually abandoned —
// must not mean a case is invisible until someone notices. Upserts preserve
// locally-owned state, so re-running this is harmless.

async function reconcileDisputes(): Promise<void> {
  const result = await syncAllDisputes(process.env.PAYPAL_MERCHANT_ID);
  if (result.created > 0) {
    log.info({ created: result.created }, "reconciliation found disputes webhooks had missed");
  }
}

// ---------- REGISTRY ----------

export const HANDLERS: Record<JobType, JobHandler> = {
  [JOB_TYPES.INGEST_DISPUTE]: ingestDispute,
  [JOB_TYPES.BUILD_PACKET]: buildPacket,
  [JOB_TYPES.INDEX_DOCUMENT]: indexDocumentJob,
  [JOB_TYPES.SUBMIT_PACKET]: submitPacketJob,
  [JOB_TYPES.RECONCILE]: reconcileDisputes,
};

export function handlerFor(type: string): JobHandler | null {
  const handler = HANDLERS[type as JobType];
  if (!handler) {
    log.error({ type }, "no handler registered for job type");
    return null;
  }
  return handler;
}

// ---------- FAILURE SIDE EFFECTS ----------

/**
 * Reflects a terminal drafting failure onto the dispute, so the docket shows
 * FAILED rather than leaving the row stuck mid-pipeline in DRAFTING forever.
 */
export async function onJobDead(type: string, payload: Record<string, unknown>): Promise<void> {
  if (type !== JOB_TYPES.BUILD_PACKET) return;

  const disputeId = String(payload.disputeId ?? "");
  if (!disputeId) return;

  await db
    .update(disputes)
    .set({ packetState: "FAILED", updatedAt: new Date() })
    .where(eq(disputes.disputeId, disputeId));

  await publish({
    type: "packet.failed",
    disputeId,
    message: "drafting failed — review manually",
  });
}
