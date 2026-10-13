import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// ---------- CONVENTIONS ----------
// PayPal-supplied vocabularies (reason, status, lifecycle stage, evidence type)
// are stored as text, not as Postgres enums. PayPal adds values to these over
// time and an unrecognised value must land in the database for a human to look
// at, not abort the webhook with a type error. Enums are used only for states
// this system owns outright.

export const EMBEDDING_DIMENSIONS = 768; // text-embedding-004

// ---------- OWNED ENUMS ----------

export const packetStateEnum = pgEnum("packet_state", [
  "NONE",
  "QUEUED",
  "RETRIEVING",
  "DRAFTING",
  "NEEDS_REVIEW",
  "DRAFTED",
  "SUBMITTING",
  "FILED",
  "FAILED",
]);

export const jobStatusEnum = pgEnum("job_status", [
  "PENDING",
  "RUNNING",
  "DONE",
  "FAILED",
  "DEAD",
]);

export const documentKindEnum = pgEnum("document_kind", [
  "ORDER",
  "CARRIER",
  "SUPPORT",
  "POLICY",
  "LEDGER",
  "OTHER",
]);

// ---------- MERCHANTS ----------
// One row today. Every other table is keyed to it so that turning this into a
// real multi-tenant system is a routing change, not a migration.

export const merchants = pgTable(
  "merchants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paypalMerchantId: text("paypal_merchant_id").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("merchants_paypal_id_key").on(t.paypalMerchantId)],
);

// ---------- DISPUTES ----------
// Keyed by PayPal's own dispute_id. The full payload is kept in `raw` so a
// field we did not model is never lost, and projected columns stay queryable.

export const disputes = pgTable(
  "disputes",
  {
    disputeId: text("dispute_id").primaryKey(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),

    buyerName: text("buyer_name"),
    amountValue: numeric("amount_value", { precision: 14, scale: 2 }).notNull(),
    currency: text("currency").notNull(),

    reason: text("reason").notNull(),
    status: text("status").notNull(),
    lifecycleStage: text("lifecycle_stage").notNull(),
    evidenceRequested: text("evidence_requested"),
    transactionId: text("transaction_id"),

    // The deadline that decides the case if nothing is filed.
    sellerResponseDueAt: timestamp("seller_response_due_at", { withTimezone: true }),
    paypalCreatedAt: timestamp("paypal_created_at", { withTimezone: true }),

    packetState: packetStateEnum("packet_state").notNull().default("NONE"),
    winScore: integer("win_score"),

    raw: jsonb("raw").notNull(),

    ingestedAt: timestamp("ingested_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("disputes_merchant_idx").on(t.merchantId),
    index("disputes_status_idx").on(t.status),
    // Drives the docket's default ordering: soonest deadline first.
    index("disputes_due_idx").on(t.sellerResponseDueAt),
    index("disputes_packet_state_idx").on(t.packetState),
  ],
);

// ---------- EVIDENCE DOCUMENTS ----------
// The merchant's own records. Nothing may be asserted in a packet that does not
// trace back to a row here.

export const evidenceDocuments = pgTable(
  "evidence_documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),

    kind: documentKindEnum("kind").notNull(),
    title: text("title").notNull(),
    /** Human-readable provenance, e.g. "orders table, row 4471". */
    sourceRef: text("source_ref").notNull(),
    content: text("content").notNull(),
    /** SHA-256 of content. Makes re-ingesting the same export idempotent. */
    contentHash: text("content_hash").notNull(),

    /** When the underlying event happened, not when we ingested it. */
    occurredAt: timestamp("occurred_at", { withTimezone: true }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),

    indexedAt: timestamp("indexed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("evidence_documents_dedupe_key").on(t.merchantId, t.contentHash),
    index("evidence_documents_merchant_idx").on(t.merchantId),
    index("evidence_documents_unindexed_idx").on(t.indexedAt),
  ],
);

// ---------- EVIDENCE CHUNKS ----------
// Retrieval unit. merchantId is denormalised so the vector scan can be filtered
// by tenant without joining back to the document table on every query.

export const evidenceChunks = pgTable(
  "evidence_chunks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => evidenceDocuments.id, { onDelete: "cascade" }),
    merchantId: uuid("merchant_id")
      .notNull()
      .references(() => merchants.id, { onDelete: "cascade" }),

    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("evidence_chunks_position_key").on(t.documentId, t.chunkIndex),
    index("evidence_chunks_merchant_idx").on(t.merchantId),
    // HNSW over cosine distance. Not CONCURRENTLY: migrations run inside a
    // transaction, and concurrent index builds cannot.
    index("evidence_chunks_embedding_idx").using(
      "hnsw",
      t.embedding.op("vector_cosine_ops"),
    ),
  ],
);

// ---------- PACKETS ----------
// One drafting attempt for one dispute. Superseded attempts are kept rather
// than overwritten, so the audit trail survives a re-draft.

export const packets = pgTable(
  "packets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    disputeId: text("dispute_id")
      .notNull()
      .references(() => disputes.disputeId, { onDelete: "cascade" }),

    state: packetStateEnum("state").notNull().default("QUEUED"),

    /** Which model and prompt produced this, for reproducibility. */
    model: text("model"),
    promptVersion: text("prompt_version"),

    winScore: integer("win_score"),
    scoreReasons: jsonb("score_reasons").$type<string[]>(),
    /** Prose submitted to PayPal as the evidence note. */
    narrative: text("narrative"),

    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    paypalResponse: jsonb("paypal_response"),
    lastError: text("last_error"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("packets_dispute_idx").on(t.disputeId),
    index("packets_state_idx").on(t.state),
  ],
);

// ---------- PACKET CLAIMS ----------
// The grounding contract, enforced by the schema: documentId is NOT NULL, so a
// claim without a source cannot be written to the database at all.

export const packetClaims = pgTable(
  "packet_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packetId: uuid("packet_id")
      .notNull()
      .references(() => packets.id, { onDelete: "cascade" }),

    ordinal: integer("ordinal").notNull(),
    text: text("text").notNull(),

    documentId: uuid("document_id")
      .notNull()
      .references(() => evidenceDocuments.id, { onDelete: "restrict" }),
    chunkId: uuid("chunk_id").references(() => evidenceChunks.id, { onDelete: "set null" }),

    /** Verbatim excerpt the claim rests on, checked against the chunk. */
    quote: text("quote").notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("packet_claims_position_key").on(t.packetId, t.ordinal)],
);

// ---------- WEBHOOK EVENTS ----------
// Written before any processing. PayPal retries deliveries, so the unique
// constraint on the event id is what makes ingestion idempotent.

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    paypalEventId: text("paypal_event_id").notNull(),
    eventType: text("event_type").notNull(),
    resourceType: text("resource_type"),
    summary: text("summary"),

    payload: jsonb("payload").notNull(),
    signatureVerified: boolean("signature_verified").notNull().default(false),

    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingError: text("processing_error"),
  },
  (t) => [
    uniqueIndex("webhook_events_paypal_id_key").on(t.paypalEventId),
    index("webhook_events_unprocessed_idx").on(t.processedAt),
  ],
);

// ---------- JOBS ----------
// Postgres-backed queue. Claimed with FOR UPDATE SKIP LOCKED, which lets
// several workers share the table without a broker. No Redis, nothing extra to
// keep alive during judging.

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),

    status: jobStatusEnum("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),

    /** Earliest time this job may be claimed. Drives exponential backoff. */
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),

    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),

    /** Optional natural key. Collapses duplicate enqueues of the same work. */
    dedupeKey: text("dedupe_key"),

    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The claim query's access path: pending jobs that are due, oldest first.
    index("jobs_claim_idx").on(t.status, t.runAfter),
    uniqueIndex("jobs_dedupe_key").on(t.dedupeKey),
    index("jobs_type_idx").on(t.type),
  ],
);

// ---------- INFERRED TYPES ----------

export type Merchant = typeof merchants.$inferSelect;
export type NewMerchant = typeof merchants.$inferInsert;
export type Dispute = typeof disputes.$inferSelect;
export type NewDispute = typeof disputes.$inferInsert;
export type EvidenceDocument = typeof evidenceDocuments.$inferSelect;
export type NewEvidenceDocument = typeof evidenceDocuments.$inferInsert;
export type EvidenceChunk = typeof evidenceChunks.$inferSelect;
export type NewEvidenceChunk = typeof evidenceChunks.$inferInsert;
export type Packet = typeof packets.$inferSelect;
export type NewPacket = typeof packets.$inferInsert;
export type PacketClaim = typeof packetClaims.$inferSelect;
export type NewPacketClaim = typeof packetClaims.$inferInsert;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;

export type PacketState = (typeof packetStateEnum.enumValues)[number];
export type JobStatus = (typeof jobStatusEnum.enumValues)[number];
export type DocumentKind = (typeof documentKindEnum.enumValues)[number];
