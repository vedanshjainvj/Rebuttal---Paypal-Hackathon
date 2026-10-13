import { eq } from "drizzle-orm";
import { generateJson } from "../ai/provider";
import { DRAFT_JSON_SCHEMA, draftResultSchema } from "../ai/schemas";
import { db } from "../db/client";
import { disputes, packetClaims, packets, type Packet } from "../db/schema";
import { AppError, notFound, ungroundedClaimError } from "../errors";
import { retrieveForDispute } from "../evidence/retrieve";
import { childLogger } from "../logger";
import { checkGrounding, type GroundingReport } from "./grounding";
import { linkRecords } from "./relevance";
import { PROMPT_VERSION, SYSTEM_PROMPT, buildUserPrompt } from "./prompt";

const log = childLogger("packet.draft");

// ---------- DRAFTING ----------
// Retrieve, draft, verify, persist. The verify step sits between the model and
// the database by design: an ungrounded claim is never written, so it can
// never reach PayPal, regardless of what happens downstream.

export interface DraftOptions {
  disputeId: string;
  /** Records pulled for the model to work from. */
  evidenceLimit?: number;
  /** Fresh draft even if one already exists. */
  force?: boolean;
}

export interface DraftOutcome {
  packet: Packet;
  grounding: GroundingReport;
  retrievedCount: number;
  provider: string;
  model: string;
  durationMs: number;
}

export async function draftPacket(options: DraftOptions): Promise<DraftOutcome> {
  const started = performance.now();

  const [dispute] = await db
    .select()
    .from(disputes)
    .where(eq(disputes.disputeId, options.disputeId))
    .limit(1);

  if (!dispute) throw notFound("Dispute", { disputeId: options.disputeId });

  // ---------- RETRIEVE ----------
  await db
    .update(disputes)
    .set({ packetState: "RETRIEVING", updatedAt: new Date() })
    .where(eq(disputes.disputeId, dispute.disputeId));

  const hits = await retrieveForDispute({
    merchantId: dispute.merchantId,
    reason: dispute.reason,
    transactionId: dispute.transactionId,
    buyerName: dispute.buyerName,
    limit: options.evidenceLimit ?? 8,
  });

  if (hits.length === 0) {
    // Nothing to ground against. Fail loudly rather than inviting the model to
    // write something unsupported.
    await db
      .update(disputes)
      // Clear the score too. A stale win read beside a failed draft reads as
      // if the system still believes the case is winnable.
      .set({ packetState: "FAILED", winScore: null, updatedAt: new Date() })
      .where(eq(disputes.disputeId, dispute.disputeId));

    throw new AppError({
      code: "NOT_FOUND",
      message: "No evidence records matched this dispute — nothing can be grounded",
      retryable: false,
      status: 422,
      context: { disputeId: dispute.disputeId, reason: dispute.reason },
    });
  }

  // ---------- LINKAGE PRECHECK ----------
  // Whether any retrieved record concerns this transaction is knowable before
  // the model is called, and it decides the outcome entirely: with nothing
  // linked, every claim the model could produce would be rejected as
  // WRONG_CASE.
  //
  // Checking here rather than after drafting saves a model call and, more
  // importantly, makes the refusal deterministic and non-retryable. Left to
  // the post-draft check, this case failed with "no claims survived" — which
  // is retryable — and burned five attempts rediscovering the same answer.
  const linkage = linkRecords({
    transactionId: dispute.transactionId,
    records: hits.map((h) => ({ id: h.chunkId, content: h.chunkContent })),
  });

  if (linkage.linked.size === 0) {
    await db
      .update(disputes)
      .set({ packetState: "FAILED", winScore: null, updatedAt: new Date() })
      .where(eq(disputes.disputeId, dispute.disputeId));

    throw new AppError({
      code: "UNGROUNDED_CLAIM",
      message:
        "No record could be linked to this transaction — only general policy " +
        "documents matched, which prove nothing about this specific case",
      // No amount of redrafting invents a record that does not exist. The
      // merchant needs to connect the data source that holds it.
      retryable: false,
      status: 422,
      context: {
        disputeId: dispute.disputeId,
        transactionId: dispute.transactionId,
        retrieved: hits.length,
        generalRecords: linkage.general.size,
        foreignRecords: linkage.foreign.size,
      },
    });
  }

  // ---------- DRAFT ----------
  await db
    .update(disputes)
    .set({ packetState: "DRAFTING", updatedAt: new Date() })
    .where(eq(disputes.disputeId, dispute.disputeId));

  const userPrompt = buildUserPrompt({
    disputeId: dispute.disputeId,
    reason: dispute.reason,
    status: dispute.status,
    lifecycleStage: dispute.lifecycleStage,
    amount: dispute.amountValue,
    currency: dispute.currency,
    buyerName: dispute.buyerName,
    transactionId: dispute.transactionId,
    evidenceRequested: dispute.evidenceRequested,
    sellerResponseDueAt: dispute.sellerResponseDueAt,
    hits,
  });

  const generation = await generateJson({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    schema: DRAFT_JSON_SCHEMA,
    temperature: 0.2,
  });

  const parsed = draftResultSchema.safeParse(generation.value);
  if (!parsed.success) {
    throw new AppError({
      code: "AI_MALFORMED_OUTPUT",
      message: "Draft did not match the expected shape",
      retryable: true,
      context: {
        issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    });
  }

  // ---------- VERIFY ----------
  const grounding = checkGrounding(parsed.data.claims, hits, {
    transactionId: dispute.transactionId,
  });

  if (grounding.grounded.length === 0) {
    await db
      .update(disputes)
      // Clear the score too. A stale win read beside a failed draft reads as
      // if the system still believes the case is winnable.
      .set({ packetState: "FAILED", winScore: null, updatedAt: new Date() })
      .where(eq(disputes.disputeId, dispute.disputeId));

    // Retryable: a second pass at this temperature often grounds correctly.
    throw ungroundedClaimError("Every drafted claim failed grounding", {
      disputeId: dispute.disputeId,
      rejected: grounding.rejected.map((r) => r.reason),
    });
  }

  // Linked records were available, yet the model cited only general ones.
  // The draft therefore rests entirely on policy and standing procedure,
  // which establish nothing about this order. Retryable, unlike the precheck
  // above: the evidence exists, the model simply failed to use it.
  if (grounding.caseLinkedCount === 0) {
    await db
      .update(disputes)
      .set({ packetState: "FAILED", winScore: null, updatedAt: new Date() })
      .where(eq(disputes.disputeId, dispute.disputeId));

    throw new AppError({
      code: "UNGROUNDED_CLAIM",
      message:
        "The draft cited only general policy documents and ignored the records " +
        "linked to this transaction",
      // Worth another pass: the precheck proved linked evidence exists, so
      // this is the model under-using it rather than an absence of records.
      retryable: true,
      status: 422,
      context: {
        disputeId: dispute.disputeId,
        transactionId: dispute.transactionId,
        linkedRecordsAvailable: linkage.linked.size,
        generalOnlyClaims: grounding.grounded.length,
      },
    });
  }

  // A partially grounded draft is usable but must not be filed unreviewed.
  const state = grounding.rejected.length === 0 ? "DRAFTED" : "NEEDS_REVIEW";

  // ---------- PERSIST ----------
  // One transaction: a packet without its claims would render as an
  // uncited argument, which is the exact thing this system exists to prevent.
  const packet = await db.transaction(async (tx) => {
    const [created] = await tx
      .insert(packets)
      .values({
        disputeId: dispute.disputeId,
        state,
        model: generation.model,
        promptVersion: PROMPT_VERSION,
        winScore: parsed.data.winScore,
        scoreReasons: parsed.data.scoreReasons,
        narrative: parsed.data.narrative,
      })
      .returning();

    await tx.insert(packetClaims).values(
      grounding.grounded.map((claim, index) => ({
        packetId: created.id,
        ordinal: index + 1,
        text: claim.text,
        documentId: claim.documentId,
        chunkId: claim.chunkId,
        quote: claim.quote,
      })),
    );

    await tx
      .update(disputes)
      .set({ packetState: state, winScore: parsed.data.winScore, updatedAt: new Date() })
      .where(eq(disputes.disputeId, dispute.disputeId));

    return created;
  });

  const durationMs = Math.round(performance.now() - started);

  log.info(
    {
      disputeId: dispute.disputeId,
      packetId: packet.id,
      state,
      retrieved: hits.length,
      grounded: grounding.grounded.length,
      rejected: grounding.rejected.length,
      winScore: parsed.data.winScore,
      provider: generation.provider,
      durationMs,
    },
    "packet drafted",
  );

  return {
    packet,
    grounding,
    retrievedCount: hits.length,
    provider: generation.provider,
    model: generation.model,
    durationMs,
  };
}
