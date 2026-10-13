import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  disputes,
  evidenceChunks,
  evidenceDocuments,
  jobs,
  packetClaims,
  packets,
  type DocumentKind,
  type PacketState,
} from "../db/schema";

// ---------- READ MODELS ----------
// Shapes the UI renders, kept separate from the table rows. The console should
// not have to know that amounts are numeric strings or that a dispute's
// current packet is the newest of several.

export interface DocketRow {
  disputeId: string;
  buyerName: string | null;
  amount: number;
  currency: string;
  reason: string;
  status: string;
  lifecycleStage: string;
  packetState: PacketState;
  winScore: number | null;
  sellerResponseDueAt: Date | null;
  /** Hours remaining, negative once the window has closed. */
  hoursRemaining: number | null;
  /** True for locally seeded practice cases, never for PayPal records. */
  isFixture: boolean;
}

function hoursUntil(date: Date | null): number | null {
  if (!date) return null;
  return (date.getTime() - Date.now()) / 3_600_000;
}

/** Local practice disputes are marked at creation; nothing infers this. */
function isFixtureRow(raw: unknown): boolean {
  return (raw as { _source?: string } | null)?._source === "local fixture";
}

export async function listDocket(): Promise<DocketRow[]> {
  const rows = await db
    .select()
    .from(disputes)
    // Soonest deadline first, with cases that have no deadline last rather
    // than sorting as if they were urgent.
    .orderBy(sql`${disputes.sellerResponseDueAt} asc nulls last`);

  return rows.map((row) => ({
    disputeId: row.disputeId,
    buyerName: row.buyerName,
    amount: Number(row.amountValue),
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    lifecycleStage: row.lifecycleStage,
    packetState: row.packetState,
    winScore: row.winScore,
    sellerResponseDueAt: row.sellerResponseDueAt,
    hoursRemaining: hoursUntil(row.sellerResponseDueAt),
    isFixture: isFixtureRow(row.raw),
  }));
}

export interface DocketSummary {
  openCount: number;
  closingSoonCount: number;
  /** Money at risk across cases still awaiting a response. */
  exposure: number;
  currency: string;
}

export async function docketSummary(): Promise<DocketSummary> {
  const rows = await listDocket();
  const awaiting = rows.filter((r) => r.status === "WAITING_FOR_SELLER_RESPONSE");

  return {
    openCount: awaiting.length,
    closingSoonCount: awaiting.filter(
      (r) => r.hoursRemaining !== null && r.hoursRemaining > 0 && r.hoursRemaining <= 48,
    ).length,
    exposure: awaiting.reduce((sum, r) => sum + r.amount, 0),
    currency: rows[0]?.currency ?? "USD",
  };
}

// ---------- CASE DETAIL ----------

export interface CaseClaim {
  ordinal: number;
  text: string;
  quote: string;
  documentTitle: string;
  documentKind: DocumentKind;
  sourceRef: string;
}

export interface CasePacket {
  id: string;
  state: PacketState;
  model: string | null;
  promptVersion: string | null;
  winScore: number | null;
  scoreReasons: string[];
  narrative: string | null;
  submittedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  claims: CaseClaim[];
}

export interface CaseDetail extends DocketRow {
  evidenceRequested: string | null;
  transactionId: string | null;
  paypalCreatedAt: Date | null;
  /** Actions PayPal says are legal right now, read from its HATEOAS links. */
  allowedActions: string[];
  packet: CasePacket | null;
  /**
   * Why the last attempt failed, taken from the job that gave up.
   *
   * A refused draft produces no packet, so without this the interface can
   * only say that something went wrong. The operator needs the actual reason
   * — "no record links to this transaction" tells them to connect a data
   * source, which is an action they can take.
   */
  lastFailure: string | null;
}

export async function getCase(disputeId: string): Promise<CaseDetail | null> {
  const [row] = await db
    .select()
    .from(disputes)
    .where(eq(disputes.disputeId, disputeId))
    .limit(1);

  if (!row) return null;

  // Newest packet wins. Superseded drafts are retained for the audit trail but
  // never rendered as the current position.
  const [packet] = await db
    .select()
    .from(packets)
    .where(eq(packets.disputeId, disputeId))
    .orderBy(desc(packets.createdAt))
    .limit(1);

  let claims: CaseClaim[] = [];
  if (packet) {
    claims = await db
      .select({
        ordinal: packetClaims.ordinal,
        text: packetClaims.text,
        quote: packetClaims.quote,
        documentTitle: evidenceDocuments.title,
        documentKind: evidenceDocuments.kind,
        sourceRef: evidenceDocuments.sourceRef,
      })
      .from(packetClaims)
      .innerJoin(evidenceDocuments, eq(packetClaims.documentId, evidenceDocuments.id))
      .where(eq(packetClaims.packetId, packet.id))
      .orderBy(asc(packetClaims.ordinal));
  }

  // Only surfaced while the dispute is actually in a failed state; a stale
  // error beside a successful draft would be misleading.
  let lastFailure: string | null = null;
  if (row.packetState === "FAILED") {
    const [failedJob] = await db
      .select({ lastError: jobs.lastError })
      .from(jobs)
      .where(
        and(
          eq(jobs.type, "build_packet"),
          sql`${jobs.payload}->>'disputeId' = ${disputeId}`,
          isNotNull(jobs.lastError),
        ),
      )
      .orderBy(desc(jobs.updatedAt))
      .limit(1);
    lastFailure = failedJob?.lastError ?? null;
  }

  const links = (row.raw as { links?: Array<{ rel: string }> } | null)?.links ?? [];

  return {
    disputeId: row.disputeId,
    buyerName: row.buyerName,
    amount: Number(row.amountValue),
    currency: row.currency,
    reason: row.reason,
    status: row.status,
    lifecycleStage: row.lifecycleStage,
    packetState: row.packetState,
    winScore: row.winScore,
    sellerResponseDueAt: row.sellerResponseDueAt,
    hoursRemaining: hoursUntil(row.sellerResponseDueAt),
    isFixture: isFixtureRow(row.raw),
    evidenceRequested: row.evidenceRequested,
    transactionId: row.transactionId,
    paypalCreatedAt: row.paypalCreatedAt,
    allowedActions: links.map((l) => l.rel).filter((rel) => rel !== "self"),
    lastFailure,
    packet: packet
      ? {
          id: packet.id,
          state: packet.state,
          model: packet.model,
          promptVersion: packet.promptVersion,
          winScore: packet.winScore,
          scoreReasons: packet.scoreReasons ?? [],
          narrative: packet.narrative,
          submittedAt: packet.submittedAt,
          lastError: packet.lastError,
          createdAt: packet.createdAt,
          claims,
        }
      : null,
  };
}

export async function listCaseIds(): Promise<string[]> {
  const rows = await db.select({ id: disputes.disputeId }).from(disputes);
  return rows.map((r) => r.id);
}

// ---------- CORPUS ----------

export interface CorpusRow {
  id: string;
  kind: DocumentKind;
  title: string;
  sourceRef: string;
  occurredAt: Date | null;
  indexedAt: Date | null;
  chunkCount: number;
  citedCount: number;
}

/**
 * Counts per document, gathered as two grouped queries and merged in memory.
 *
 * An earlier version used correlated subqueries inside the select list. They
 * rendered without correlating to the outer row and every document reported
 * zero chunks beside a header claiming fourteen — wrong in a way that looks
 * like a data problem rather than a query bug. Grouped aggregates are harder
 * to get silently wrong.
 */
async function documentCounts(): Promise<{
  chunks: Map<string, number>;
  cited: Map<string, number>;
}> {
  const [chunkRows, citedRows] = await Promise.all([
    db
      .select({
        documentId: evidenceChunks.documentId,
        count: sql<number>`count(*)::int`,
      })
      .from(evidenceChunks)
      .groupBy(evidenceChunks.documentId),
    db
      .select({
        documentId: packetClaims.documentId,
        count: sql<number>`count(*)::int`,
      })
      .from(packetClaims)
      .groupBy(packetClaims.documentId),
  ]);

  return {
    chunks: new Map(chunkRows.map((r) => [r.documentId, r.count])),
    cited: new Map(citedRows.map((r) => [r.documentId, r.count])),
  };
}

export async function listCorpus(): Promise<CorpusRow[]> {
  const [rows, counts] = await Promise.all([
    db
      .select({
        id: evidenceDocuments.id,
        kind: evidenceDocuments.kind,
        title: evidenceDocuments.title,
        sourceRef: evidenceDocuments.sourceRef,
        occurredAt: evidenceDocuments.occurredAt,
        indexedAt: evidenceDocuments.indexedAt,
      })
      .from(evidenceDocuments)
      .orderBy(desc(evidenceDocuments.occurredAt)),
    documentCounts(),
  ]);

  return rows.map((row) => ({
    ...row,
    chunkCount: counts.chunks.get(row.id) ?? 0,
    citedCount: counts.cited.get(row.id) ?? 0,
  }));
}

export interface CorpusStats {
  documents: number;
  indexed: number;
  chunks: number;
  /** Chunks carrying an embedding. A gap here means retrieval is incomplete. */
  embedded: number;
  citedDocuments: number;
}

export async function corpusStats(): Promise<CorpusStats> {
  const [documents] = await db
    .select({
      total: sql<number>`count(*)::int`,
      indexed: sql<number>`count(*) filter (where ${evidenceDocuments.indexedAt} is not null)::int`,
    })
    .from(evidenceDocuments);

  // Counted from the chunk table itself. An earlier version joined through
  // packet_claims, which counts citations rather than chunks and silently
  // reported zero for a corpus that had never been cited.
  const [chunks] = await db
    .select({
      total: sql<number>`count(*)::int`,
      embedded: sql<number>`count(*) filter (where ${evidenceChunks.embedding} is not null)::int`,
    })
    .from(evidenceChunks);

  const [cited] = await db
    .select({ total: sql<number>`count(distinct ${packetClaims.documentId})::int` })
    .from(packetClaims);

  return {
    documents: documents?.total ?? 0,
    indexed: documents?.indexed ?? 0,
    chunks: chunks?.total ?? 0,
    embedded: chunks?.embedded ?? 0,
    citedDocuments: cited?.total ?? 0,
  };
}
