import { and, eq, lte, sql as raw } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, type Job } from "../db/schema";
import { childLogger } from "../logger";

const log = childLogger("jobs.queue");

// ---------- JOB TYPES ----------
// Payloads are declared here so producers and consumers cannot drift.

export const JOB_TYPES = {
  INGEST_DISPUTE: "ingest_dispute",
  BUILD_PACKET: "build_packet",
  INDEX_DOCUMENT: "index_document",
  SUBMIT_PACKET: "submit_packet",
  RECONCILE: "reconcile_disputes",
} as const;

export type JobType = (typeof JOB_TYPES)[keyof typeof JOB_TYPES];

export interface JobPayloads {
  [JOB_TYPES.INGEST_DISPUTE]: { disputeId: string; webhookEventId?: string };
  [JOB_TYPES.BUILD_PACKET]: { disputeId: string; force?: boolean };
  [JOB_TYPES.INDEX_DOCUMENT]: { documentId: string };
  [JOB_TYPES.SUBMIT_PACKET]: { packetId: string };
  [JOB_TYPES.RECONCILE]: Record<string, never>;
}

export interface EnqueueOptions {
  /** Delay before the job becomes claimable. */
  delayMs?: number;
  maxAttempts?: number;
  /**
   * Natural key that collapses duplicates. Two webhook deliveries for the same
   * dispute should produce one ingest job, not two.
   */
  dedupeKey?: string;
}

// ---------- ENQUEUE ----------

export async function enqueue<T extends JobType>(
  type: T,
  payload: JobPayloads[T],
  options: EnqueueOptions = {},
): Promise<Job | null> {
  const runAfter = new Date(Date.now() + (options.delayMs ?? 0));

  const inserted = await db
    .insert(jobs)
    .values({
      type,
      payload,
      runAfter,
      maxAttempts: options.maxAttempts ?? 5,
      dedupeKey: options.dedupeKey ?? null,
    })
    // A duplicate dedupeKey is the system working as intended, not an error.
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning();

  const job = inserted[0] ?? null;

  if (job) {
    log.info({ jobId: job.id, type, dedupeKey: options.dedupeKey }, "job enqueued");
  } else {
    log.debug({ type, dedupeKey: options.dedupeKey }, "job skipped — already queued");
  }

  return job;
}

// ---------- CLAIMING ----------
// FOR UPDATE SKIP LOCKED is what makes this a queue rather than a table.
// Several workers can run the same statement concurrently: each skips rows
// another transaction already holds, so no job is handed out twice and no
// worker blocks waiting for a peer.

/** A RUNNING job untouched for this long is assumed to belong to a dead worker. */
const STALE_LOCK_MS = 10 * 60 * 1000;

export async function claimJobs(workerId: string, batchSize: number): Promise<Job[]> {
  const rows = await db.execute<Job>(raw`
    update jobs
    set status = 'RUNNING',
        locked_at = now(),
        locked_by = ${workerId},
        attempts = attempts + 1,
        updated_at = now()
    where id in (
      select id from jobs
      where status = 'PENDING'
        and run_after <= now()
      order by run_after asc
      limit ${batchSize}
      for update skip locked
    )
    returning *
  `);

  return rows as unknown as Job[];
}

/**
 * Returns jobs abandoned by a crashed worker to the queue.
 *
 * Without this a worker killed mid-job leaves it RUNNING forever and the work
 * is silently lost. The attempt was already counted, so a job that keeps
 * crashing its worker still reaches the dead letter state eventually rather
 * than looping indefinitely.
 */
export async function recoverStaleJobs(): Promise<number> {
  const rows = await db.execute<{ id: string }>(raw`
    update jobs
    set status = 'PENDING',
        locked_at = null,
        locked_by = null,
        last_error = coalesce(last_error, 'recovered from a stale lock'),
        updated_at = now()
    where status = 'RUNNING'
      and locked_at < now() - interval '${raw.raw(String(Math.floor(STALE_LOCK_MS / 1000)))} seconds'
    returning id
  `);

  const count = (rows as unknown as { id: string }[]).length;
  if (count > 0) log.warn({ count }, "recovered stale jobs");
  return count;
}

// ---------- COMPLETION ----------

export async function completeJob(jobId: string): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "DONE", lockedAt: null, lockedBy: null, updatedAt: new Date() })
    .where(eq(jobs.id, jobId));
}

/** Exponential backoff with jitter, capped so a retry is never hours away. */
function retryDelayMs(attempt: number): number {
  const ceiling = Math.min(2_000 * 2 ** (attempt - 1), 5 * 60 * 1000);
  return Math.round(ceiling * (0.5 + Math.random() * 0.5));
}

export interface FailureOutcome {
  status: "PENDING" | "DEAD";
  nextAttemptAt?: Date;
}

/**
 * Records a failure and decides whether the job gets another attempt.
 *
 * `retryable` comes from the error taxonomy, not from the error's existence.
 * A malformed payload that will never parse is dead-lettered immediately
 * instead of consuming five attempts to reach the same conclusion.
 */
export async function failJob(
  job: Job,
  error: unknown,
  retryable: boolean,
): Promise<FailureOutcome> {
  const message = error instanceof Error ? error.message : String(error);
  const exhausted = job.attempts >= job.maxAttempts;

  if (!retryable || exhausted) {
    await db
      .update(jobs)
      .set({
        status: "DEAD",
        lockedAt: null,
        lockedBy: null,
        lastError: message.slice(0, 2000),
        updatedAt: new Date(),
      })
      .where(eq(jobs.id, job.id));

    log.error(
      { jobId: job.id, type: job.type, attempts: job.attempts, retryable, error: message },
      "job dead-lettered",
    );
    return { status: "DEAD" };
  }

  const nextAttemptAt = new Date(Date.now() + retryDelayMs(job.attempts));

  await db
    .update(jobs)
    .set({
      status: "PENDING",
      lockedAt: null,
      lockedBy: null,
      runAfter: nextAttemptAt,
      lastError: message.slice(0, 2000),
      updatedAt: new Date(),
    })
    .where(eq(jobs.id, job.id));

  log.warn(
    { jobId: job.id, type: job.type, attempt: job.attempts, nextAttemptAt, error: message },
    "job failed, will retry",
  );
  return { status: "PENDING", nextAttemptAt };
}

// ---------- INSPECTION ----------
// Used by the health endpoint and the status script.

export async function pendingJobCount(): Promise<number> {
  const [row] = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.status, "PENDING"), lte(jobs.runAfter, new Date())));
  return row?.count ?? 0;
}

export async function deadJobCount(): Promise<number> {
  const [row] = await db
    .select({ count: raw<number>`count(*)::int` })
    .from(jobs)
    .where(eq(jobs.status, "DEAD"));
  return row?.count ?? 0;
}
