import type { RetrievalHit } from "../evidence/retrieve";
import { childLogger } from "../logger";
import type { DraftedClaim } from "../ai/schemas";
import { linkRecords } from "./relevance";

const log = childLogger("packet.grounding");

// ---------- GROUNDING ----------
// The product's central promise is that every claim filed with PayPal traces
// to a record the merchant actually holds. A prompt asking for citations is
// not a guarantee — models cite confidently and incorrectly. This is the
// mechanical check that turns the promise into something enforced.
//
// Two independent failures are caught:
//
//   1. A citation pointing at a chunk that was never retrieved. The model
//      invented an identifier.
//   2. A quote that does not appear in the chunk it cites. The model
//      paraphrased, embellished, or fabricated the supporting text — the
//      dangerous case, because the citation looks valid until you read it.
//
// Check 2 is the one that matters. A fabricated quote submitted to PayPal as
// evidence is worse than filing nothing.

export type RejectionReason =
  | "UNKNOWN_CHUNK"
  | "QUOTE_NOT_FOUND"
  | "EMPTY_CLAIM"
  /** Real record, real quote — but it belongs to a different transaction. */
  | "WRONG_CASE";

export interface GroundedClaim {
  text: string;
  quote: string;
  chunkId: string;
  documentId: string;
  documentTitle: string;
  sourceRef: string;
  /**
   * True when the cited record traces back to the disputed transaction.
   * False for general documents — policies, terms, standing procedure — which
   * are admissible as context but prove nothing about this particular case.
   */
  caseLinked: boolean;
}

export interface RejectedClaim {
  claim: DraftedClaim;
  reason: RejectionReason;
  detail: string;
}

export interface GroundingReport {
  grounded: GroundedClaim[];
  rejected: RejectedClaim[];
  /** Share of claims that survived. 1 means every claim checked out. */
  groundingRate: number;
  /**
   * How many surviving claims cite a record tied to the disputed transaction.
   *
   * Zero is a refusal condition, not a warning. A packet assembled purely
   * from policy documents reads as a confident defence while containing no
   * evidence about this case at all — the exact shape of a draft that scored
   * 95% citing a shipping policy for a transaction it could not find.
   */
  caseLinkedCount: number;
}

/**
 * Canonical form for comparison.
 *
 * Normalises only presentation: case, whitespace runs, and the typographic
 * characters that get substituted when text passes through a model — curly
 * quotes, en and em dashes, ellipsis. Words are never altered, so a
 * paraphrase still fails.
 */
function canonicalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim();
}

/** Trailing punctuation is an artefact of where the model cut the span. */
function trimEdgePunctuation(text: string): string {
  return text.replace(/^[\s"'.,;:—–-]+|[\s"'.,;:—–-]+$/g, "");
}

function quoteAppearsIn(quote: string, source: string): boolean {
  const haystack = canonicalise(source);
  const needle = canonicalise(quote);
  if (!needle) return false;
  if (haystack.includes(needle)) return true;

  // Retry once without edge punctuation before declaring a mismatch.
  const trimmed = trimEdgePunctuation(needle);
  return trimmed.length > 0 && haystack.includes(trimmed);
}

export interface GroundingContext {
  /**
   * The disputed transaction. Linkage starts here; without it no record can
   * be proved to concern this case and only general documents are admissible.
   */
  transactionId: string | null;
}

export function checkGrounding(
  claims: DraftedClaim[],
  hits: RetrievalHit[],
  context: GroundingContext = { transactionId: null },
): GroundingReport {
  const byChunkId = new Map(hits.map((h) => [h.chunkId, h]));

  // Which retrieved records actually concern this dispute. Computed once over
  // the whole set because linkage is transitive between records.
  const linkage = linkRecords({
    transactionId: context.transactionId,
    records: hits.map((h) => ({ id: h.chunkId, content: h.chunkContent })),
  });

  const grounded: GroundedClaim[] = [];
  const rejected: RejectedClaim[] = [];

  for (const claim of claims) {
    if (!claim.text.trim() || !claim.quote.trim()) {
      rejected.push({ claim, reason: "EMPTY_CLAIM", detail: "claim or quote was blank" });
      continue;
    }

    const hit = byChunkId.get(claim.chunkId);
    if (!hit) {
      rejected.push({
        claim,
        reason: "UNKNOWN_CHUNK",
        detail: `chunk ${claim.chunkId} was not in the retrieved set`,
      });
      continue;
    }

    if (!quoteAppearsIn(claim.quote, hit.chunkContent)) {
      rejected.push({
        claim,
        reason: "QUOTE_NOT_FOUND",
        detail: `quote does not appear in "${hit.documentTitle}"`,
      });
      continue;
    }

    // Provenance is established; relevance is not. A verbatim quote from
    // another customer's delivery scan passes every check above.
    if (linkage.foreign.has(hit.chunkId)) {
      rejected.push({
        claim,
        reason: "WRONG_CASE",
        detail:
          `"${hit.documentTitle}" carries identifiers that do not link to ` +
          `transaction ${context.transactionId ?? "(unknown)"}`,
      });
      continue;
    }

    grounded.push({
      text: claim.text.trim(),
      quote: claim.quote.trim(),
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      documentTitle: hit.documentTitle,
      sourceRef: hit.sourceRef,
      caseLinked: linkage.linked.has(hit.chunkId),
    });
  }

  const total = claims.length || 1;
  const report: GroundingReport = {
    grounded,
    rejected,
    groundingRate: grounded.length / total,
    caseLinkedCount: grounded.filter((c) => c.caseLinked).length,
  };

  if (rejected.length > 0) {
    log.warn(
      {
        rejected: rejected.length,
        grounded: grounded.length,
        reasons: rejected.map((r) => r.reason),
      },
      "dropped ungrounded claims",
    );
    for (const r of rejected) {
      log.debug({ reason: r.reason, detail: r.detail, text: r.claim.text }, "rejected claim");
    }
  }

  return report;
}
