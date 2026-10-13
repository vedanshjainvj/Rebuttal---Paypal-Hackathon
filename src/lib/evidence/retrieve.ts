import { sql } from "drizzle-orm";
import { embedOne } from "../ai/embeddings";
import { db } from "../db/client";
import type { DocumentKind } from "../db/schema";
import { childLogger } from "../logger";

const log = childLogger("evidence.retrieve");

// ---------- HYBRID RETRIEVAL ----------
// Two independent searches, fused by Reciprocal Rank Fusion.
//
// Why RRF rather than a weighted sum of scores: cosine similarity and ts_rank
// are on incomparable scales, and ts_rank in particular is unbounded and
// corpus-dependent. Blending the raw numbers requires a normalisation constant
// that has to be retuned whenever the corpus changes. RRF only reads the
// ordering of each list, so it needs no tuning and cannot be skewed by one
// search returning unusually large scores.
//
// Both halves earn their place here. Vector search finds "the buyer admitted
// receiving it" inside a support thread that never uses the word "delivery".
// Full-text search finds an exact tracking number, which embeddings are
// notoriously bad at matching.

/** Standard RRF damping. Keeps rank 1 from dominating the fused score. */
const RRF_K = 60;

export interface RetrievalHit {
  chunkId: string;
  documentId: string;
  chunkContent: string;
  documentTitle: string;
  documentKind: DocumentKind;
  sourceRef: string;
  occurredAt: Date | null;
  /** Fused RRF score. Comparable within one result set only. */
  score: number;
  /** Rank in each contributing list, for explaining why a hit surfaced. */
  vectorRank: number | null;
  textRank: number | null;
}

export interface RetrieveOptions {
  merchantId: string;
  query: string;
  /**
   * Overrides the string handed to full-text search.
   *
   * The two halves want different inputs. The embedding wants prose. tsquery
   * wants terms joined explicitly, because websearch_to_tsquery ANDs bare
   * words — a nine-word expansion then matches nothing and the hybrid quietly
   * collapses to vector-only.
   */
  textQuery?: string;
  /** Hits returned after fusion. */
  limit?: number;
  /** Candidates pulled from each search before fusing. */
  candidatesPerSearch?: number;
}

function toVectorLiteral(values: number[]): string {
  return `[${values.join(",")}]`;
}

export async function retrieveEvidence(options: RetrieveOptions): Promise<RetrievalHit[]> {
  const limit = options.limit ?? 8;
  const candidates = options.candidatesPerSearch ?? Math.max(limit * 3, 20);
  const started = performance.now();

  const embedding = await embedOne(options.query, "RETRIEVAL_QUERY");
  const vectorLiteral = toVectorLiteral(embedding);
  const textQuery = options.textQuery ?? options.query;

  // websearch_to_tsquery tolerates arbitrary user text without throwing, unlike
  // to_tsquery. A query of only stopwords yields an empty tsquery, which simply
  // matches nothing and leaves the vector half to carry the result.
  const rows = await db.execute<{
    chunk_id: string;
    document_id: string;
    chunk_content: string;
    document_title: string;
    document_kind: DocumentKind;
    source_ref: string;
    // db.execute returns driver rows without Drizzle's column mapping, so
    // timestamps arrive as whatever postgres.js produced, not as Date.
    occurred_at: string | Date | null;
    score: number;
    vector_rank: number | null;
    text_rank: number | null;
  }>(sql`
    with
      vector_hits as (
        select
          c.id,
          row_number() over (
            order by c.embedding <=> ${vectorLiteral}::vector
          ) as rank
        from evidence_chunks c
        where c.merchant_id = ${options.merchantId}::uuid
          and c.embedding is not null
        order by c.embedding <=> ${vectorLiteral}::vector
        limit ${candidates}
      ),
      text_hits as (
        select
          c.id,
          row_number() over (
            order by ts_rank(
              to_tsvector('english', c.content),
              websearch_to_tsquery('english', ${textQuery})
            ) desc
          ) as rank
        from evidence_chunks c
        where c.merchant_id = ${options.merchantId}::uuid
          and to_tsvector('english', c.content)
              @@ websearch_to_tsquery('english', ${textQuery})
        limit ${candidates}
      ),
      fused as (
        select
          coalesce(v.id, t.id) as chunk_id,
          v.rank as vector_rank,
          t.rank as text_rank,
          coalesce(1.0 / (${RRF_K} + v.rank), 0)
            + coalesce(1.0 / (${RRF_K} + t.rank), 0) as score
        from vector_hits v
        full outer join text_hits t on t.id = v.id
      )
    select
      f.chunk_id,
      c.document_id,
      c.content        as chunk_content,
      d.title          as document_title,
      d.kind           as document_kind,
      d.source_ref,
      d.occurred_at,
      f.score::float8  as score,
      f.vector_rank::int as vector_rank,
      f.text_rank::int   as text_rank
    from fused f
    join evidence_chunks c on c.id = f.chunk_id
    join evidence_documents d on d.id = c.document_id
    order by f.score desc
    limit ${limit}
  `);

  const hits: RetrievalHit[] = rows.map((row) => ({
    chunkId: row.chunk_id,
    documentId: row.document_id,
    chunkContent: row.chunk_content,
    documentTitle: row.document_title,
    documentKind: row.document_kind,
    sourceRef: row.source_ref,
    occurredAt: row.occurred_at ? new Date(row.occurred_at) : null,
    score: Number(row.score),
    vectorRank: row.vector_rank,
    textRank: row.text_rank,
  }));

  log.info(
    {
      merchantId: options.merchantId,
      hits: hits.length,
      bothLists: hits.filter((h) => h.vectorRank !== null && h.textRank !== null).length,
      durationMs: Math.round(performance.now() - started),
    },
    "retrieved evidence",
  );

  return hits;
}

// ---------- DISPUTE-SHAPED QUERY ----------
// A dispute is not a search string. The reason code carries most of the signal
// about which records matter, so it is expanded into the vocabulary those
// records actually use rather than passed through verbatim.

const REASON_QUERIES: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED:
    "delivery confirmation tracking number carrier scan shipped signature received package",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED:
    "product description specification listing photographs condition return policy variance",
  UNAUTHORISED:
    "account login device session order history billing address previous purchases verification",
  CREDIT_NOT_PROCESSED: "refund issued credit note settlement return received processed",
  DUPLICATE_TRANSACTION: "duplicate charge refund order identifier payment reference",
  INCORRECT_AMOUNT: "order total price tax shipping charge invoice line items",
};

export interface DisputeQueryInput {
  merchantId: string;
  reason: string;
  transactionId?: string | null;
  buyerName?: string | null;
  limit?: number;
}

export async function retrieveForDispute(input: DisputeQueryInput): Promise<RetrievalHit[]> {
  const expansion =
    REASON_QUERIES[input.reason] ?? "order record transaction evidence delivery refund";

  const identifiers = [input.transactionId, input.buyerName].filter(Boolean) as string[];

  // The embedding reads the expansion as prose.
  const query = [expansion, ...identifiers].join(" ");

  // tsquery reads it as alternatives. Joining with OR is what makes the text
  // half contribute at all here: ANDed, a nine-term expansion matches no
  // document in any realistic corpus.
  const textQuery = [...expansion.split(/\s+/), ...identifiers]
    .filter(Boolean)
    .join(" OR ");

  return retrieveEvidence({
    merchantId: input.merchantId,
    query,
    textQuery,
    limit: input.limit ?? 8,
  });
}
