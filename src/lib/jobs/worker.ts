import { env } from "../env";
import { describeError, isRetryable } from "../errors";
import { publish } from "../events/bus";
import { childLogger } from "../logger";
import { handlerFor, onJobDead } from "./handlers";
import { JOB_TYPES, claimJobs, completeJob, enqueue, failJob, recoverStaleJobs } from "./queue";

const log = childLogger("jobs.worker");

// ---------- WORKER ----------
// Polls, claims, runs, records. Polling rather than LISTEN/NOTIFY for the work
// itself: a poll loop recovers on its own after a dropped connection, whereas
// a missed notification is simply gone. NOTIFY is used for UI events, where
// losing one costs nothing.

const STALE_SWEEP_EVERY = 30; // ticks

/**
 * How often the docket is rebuilt from PayPal.
 *
 * Scheduled by the worker rather than an external cron so a free Render
 * deploy needs no paid cron service. The dedupe key is derived from the time
 * bucket, so several workers racing the same tick still produce exactly one
 * reconciliation.
 */
const RECONCILE_INTERVAL_MS = 15 * 60 * 1000;

export interface WorkerOptions {
  workerId?: string;
  pollIntervalMs?: number;
  batchSize?: number;
  /** Stop once the queue drains. Used by `worker:once`. */
  exitWhenEmpty?: boolean;
}

export class Worker {
  private readonly workerId: string;
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private readonly exitWhenEmpty: boolean;

  private running = false;
  private ticks = 0;

  constructor(options: WorkerOptions = {}) {
    this.workerId = options.workerId ?? env.WORKER_ID;
    this.pollIntervalMs = options.pollIntervalMs ?? env.WORKER_POLL_INTERVAL_MS;
    this.batchSize = options.batchSize ?? env.WORKER_BATCH_SIZE;
    this.exitWhenEmpty = options.exitWhenEmpty ?? false;
  }

  stop(): void {
    if (this.running) log.info({ workerId: this.workerId }, "worker stopping");
    this.running = false;
  }

  async run(): Promise<void> {
    this.running = true;
    log.info(
      { workerId: this.workerId, pollIntervalMs: this.pollIntervalMs, batchSize: this.batchSize },
      "worker started",
    );

    while (this.running) {
      let processed = 0;

      try {
        if (this.ticks % STALE_SWEEP_EVERY === 0) {
          await recoverStaleJobs();
          await this.scheduleReconcile();
        }
        this.ticks += 1;

        const claimed = await claimJobs(this.workerId, this.batchSize);

        // Claimed jobs run in sequence. Concurrency here would multiply load on
        // the Gemini free tier, and the batch is small by design.
        for (const job of claimed) {
          if (!this.running) break;
          await this.execute(job);
          processed += 1;
        }
      } catch (error) {
        // A failure in the loop itself, not in a job — usually the database
        // being briefly unreachable. Log and keep polling.
        log.error(describeError(error), "worker tick failed");
      }

      if (processed === 0) {
        if (this.exitWhenEmpty) {
          log.info("queue empty, exiting");
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
    }

    this.running = false;
  }

  /**
   * Queues a reconciliation at most once per interval.
   *
   * The key is the interval bucket, so a second worker enqueueing in the same
   * window hits the unique constraint and is silently ignored — the queue's
   * own deduplication does the coordination, with no leader election.
   */
  private async scheduleReconcile(): Promise<void> {
    const bucket = Math.floor(Date.now() / RECONCILE_INTERVAL_MS);
    try {
      await enqueue(JOB_TYPES.RECONCILE, {}, { dedupeKey: `reconcile:${bucket}`, maxAttempts: 2 });
    } catch (error) {
      log.debug({ err: error }, "could not schedule reconciliation");
    }
  }

  private async execute(job: Awaited<ReturnType<typeof claimJobs>>[number]): Promise<void> {
    const jobLog = log.child({ jobId: job.id, type: job.type, attempt: job.attempts });
    const handler = handlerFor(job.type);

    if (!handler) {
      // An unknown type will never become known by waiting.
      await failJob(job, new Error(`No handler for job type "${job.type}"`), false);
      return;
    }

    const started = performance.now();

    try {
      await handler(job.payload as Record<string, unknown>);
      await completeJob(job.id);
      jobLog.info({ durationMs: Math.round(performance.now() - started) }, "job done");
    } catch (error) {
      const outcome = await failJob(job, error, isRetryable(error));

      if (outcome.status === "DEAD") {
        await onJobDead(job.type, job.payload as Record<string, unknown>);
        await publish({
          type: "job.dead",
          message: `${job.type} failed permanently`,
        });
      }
    }
  }
}
