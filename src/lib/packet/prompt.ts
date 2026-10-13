import type { RetrievalHit } from "../evidence/retrieve";

// ---------- PROMPT ----------
// Versioned, because a packet filed with PayPal is a record. When output
// quality changes, the stored promptVersion is what says why.

export const PROMPT_VERSION = "2026-10-10.v1";

export const SYSTEM_PROMPT = `You prepare evidence responses for a merchant answering PayPal disputes.

Your output is submitted to PayPal as the merchant's formal response. A reviewer at PayPal reads it and decides who keeps the money. Write accordingly: plain, specific, verifiable.

RULES, in order of importance.

1. Every claim must come from the supplied records. You have no other knowledge of this merchant, this buyer, or this order. If the records do not establish something, you may not assert it.

2. Each claim carries a quote copied word for word from the record it cites. Do not paraphrase inside the quote. Do not fix spelling, expand abbreviations, or tidy formatting. The quote is compared character by character against the source and a claim whose quote does not match is discarded.

3. Cite using the exact chunk_id shown above each record. Never invent one.

4. Prefer few strong claims to many weak ones. Three claims resting on delivery confirmation, an address match and a written admission beat seven vague ones.

5. Be honest about a weak position. If the records undercut the merchant, say so in scoreReasons and score it low. A merchant who is told "38, accepting the claim may cost less than losing it" is better served than one told "72" and then loses. Never inflate.

6. Address the specific dispute reason. Not-received disputes turn on delivery evidence. Not-as-described disputes turn on what was advertised versus shipped. Unauthorised disputes turn on account and device history.

7. The narrative restates only what the claims already establish. It introduces no new facts.

Write in British English, in the merchant's voice, without salutations or sign-offs.`;

export interface PromptContext {
  disputeId: string;
  reason: string;
  status: string;
  lifecycleStage: string;
  amount: string;
  currency: string;
  buyerName?: string | null;
  transactionId?: string | null;
  evidenceRequested?: string | null;
  sellerResponseDueAt?: Date | null;
  hits: RetrievalHit[];
}

/**
 * Records are rendered with their chunk_id on a line of its own immediately
 * above the text. Burying the identifier inside a JSON blob measurably
 * increases how often a model mis-copies it.
 */
function renderRecords(hits: RetrievalHit[]): string {
  if (hits.length === 0) return "(no records were retrieved for this dispute)";

  return hits
    .map((hit, index) => {
      const when = hit.occurredAt ? hit.occurredAt.toISOString().slice(0, 10) : "date unknown";
      return [
        `RECORD ${index + 1}`,
        `chunk_id: ${hit.chunkId}`,
        `title: ${hit.documentTitle}`,
        `type: ${hit.documentKind}`,
        `provenance: ${hit.sourceRef}`,
        `date: ${when}`,
        "text:",
        hit.chunkContent,
      ].join("\n");
    })
    .join("\n\n---\n\n");
}

export function buildUserPrompt(context: PromptContext): string {
  const due = context.sellerResponseDueAt
    ? `${context.sellerResponseDueAt.toISOString()} (${Math.max(
        0,
        Math.round((context.sellerResponseDueAt.getTime() - Date.now()) / 3_600_000),
      )} hours remaining)`
    : "not set";

  return `DISPUTE

dispute_id: ${context.disputeId}
reason: ${context.reason}
status: ${context.status}
lifecycle_stage: ${context.lifecycleStage}
amount: ${context.amount} ${context.currency}
buyer: ${context.buyerName ?? "unknown"}
transaction: ${context.transactionId ?? "unknown"}
evidence_requested_by_paypal: ${context.evidenceRequested ?? "unspecified"}
seller_response_due: ${due}

RECORDS AVAILABLE

${renderRecords(context.hits)}

TASK

Draft the merchant's response. Return JSON only.

- claims: each with text, chunkId copied exactly from above, and a quote copied word for word from that record.
- narrative: 60 to 300 words, restating only what the claims establish.
- winScore: 0 to 100, your honest read of this evidence against this reason.
- scoreReasons: short reasons, including the weaknesses.

If the records do not support a defence, return the single strongest claim you can actually ground and score it low. Do not pad.`;
}
