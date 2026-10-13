import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { embedMany } from "../ai/embeddings";
import { db } from "../db/client";
import {
  evidenceChunks,
  evidenceDocuments,
  type DocumentKind,
  type EvidenceDocument,
} from "../db/schema";
import { notFound } from "../errors";
import { childLogger } from "../logger";
import { chunkText } from "./chunk";

const log = childLogger("evidence.ingest");

// ---------- INGEST ----------
// Two stages, deliberately separable. Storing a document is cheap and must
// always succeed; embedding it costs an API call that can rate-limit. A
// document with indexedAt = null is stored but not yet searchable, which the
// worker can pick up later without losing the record.

export interface DocumentInput {
  merchantId: string;
  kind: DocumentKind;
  title: string;
  /** Human-readable provenance shown beside the citation in the packet. */
  sourceRef: string;
  content: string;
  occurredAt?: Date;
  metadata?: Record<string, unknown>;
}

export function hashContent(content: string): string {
  return createHash("sha256").update(content.trim()).digest("hex");
}

export interface StoreResult {
  document: EvidenceDocument;
  /** False when an identical document was already present for this merchant. */
  created: boolean;
}

/**
 * Stores a document. Idempotent on (merchantId, contentHash), so re-running an
 * export does not duplicate the corpus or waste embedding quota.
 */
export async function storeDocument(input: DocumentInput): Promise<StoreResult> {
  const contentHash = hashContent(input.content);

  const inserted = await db
    .insert(evidenceDocuments)
    .values({
      merchantId: input.merchantId,
      kind: input.kind,
      title: input.title,
      sourceRef: input.sourceRef,
      content: input.content.trim(),
      contentHash,
      occurredAt: input.occurredAt ?? null,
      metadata: input.metadata ?? {},
    })
    .onConflictDoNothing({
      target: [evidenceDocuments.merchantId, evidenceDocuments.contentHash],
    })
    .returning();

  if (inserted[0]) {
    log.info({ documentId: inserted[0].id, kind: input.kind }, "document stored");
    return { document: inserted[0], created: true };
  }

  // Conflict: the identical document already exists. Return it so callers can
  // still decide whether it needs indexing.
  const [existing] = await db
    .select()
    .from(evidenceDocuments)
    .where(eq(evidenceDocuments.contentHash, contentHash))
    .limit(1);

  if (!existing) throw notFound("Evidence document after insert conflict", { contentHash });

  log.debug({ documentId: existing.id }, "document already present");
  return { document: existing, created: false };
}

// ---------- INDEXING ----------

export interface IndexResult {
  documentId: string;
  chunks: number;
  skipped: boolean;
}

/**
 * Chunks and embeds a document, replacing any previous chunks for it.
 *
 * Chunks are deleted and re-inserted inside one transaction: a document must
 * never be half-indexed, because retrieval would then cite a stale fragment
 * alongside a fresh one.
 */
export async function indexDocument(documentId: string, force = false): Promise<IndexResult> {
  const [document] = await db
    .select()
    .from(evidenceDocuments)
    .where(eq(evidenceDocuments.id, documentId))
    .limit(1);

  if (!document) throw notFound("Evidence document", { documentId });

  if (document.indexedAt && !force) {
    log.debug({ documentId }, "document already indexed");
    return { documentId, chunks: 0, skipped: true };
  }

  const pieces = chunkText(document.content);
  if (pieces.length === 0) {
    log.warn({ documentId }, "document has no indexable content");
    await db
      .update(evidenceDocuments)
      .set({ indexedAt: new Date() })
      .where(eq(evidenceDocuments.id, documentId));
    return { documentId, chunks: 0, skipped: false };
  }

  // Prefixing each chunk with the title gives the embedding the context a bare
  // fragment lacks — "Delivered, front door" means little without "FedEx scan".
  const vectors = await embedMany(
    pieces.map((p) => `${document.title}\n\n${p}`),
    "RETRIEVAL_DOCUMENT",
  );

  await db.transaction(async (tx) => {
    await tx.delete(evidenceChunks).where(eq(evidenceChunks.documentId, documentId));

    await tx.insert(evidenceChunks).values(
      pieces.map((content, chunkIndex) => ({
        documentId,
        merchantId: document.merchantId,
        chunkIndex,
        content,
        embedding: vectors[chunkIndex],
      })),
    );

    await tx
      .update(evidenceDocuments)
      .set({ indexedAt: new Date() })
      .where(eq(evidenceDocuments.id, documentId));
  });

  log.info({ documentId, chunks: pieces.length }, "document indexed");
  return { documentId, chunks: pieces.length, skipped: false };
}

/** Convenience path for seeding and uploads: store then index in one call. */
export async function ingestDocument(input: DocumentInput): Promise<IndexResult> {
  const { document, created } = await storeDocument(input);
  return indexDocument(document.id, created);
}
