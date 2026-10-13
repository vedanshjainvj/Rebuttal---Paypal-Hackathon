import "dotenv/config";

// ---------- JOB ADMIN ----------
//   npm run job list
//   npm run job enqueue ingest_dispute '{"disputeId":"PP-R-..."}'
//   npm run job retry <jobId>        return a dead job to the queue
//   npm run job clear-dead

async function main() {
  const { desc, eq } = await import("drizzle-orm");
  const { db, closeDatabase } = await import("../src/lib/db/client");
  const { jobs } = await import("../src/lib/db/schema");
  const { enqueue } = await import("../src/lib/jobs/queue");

  const [command, a, b] = process.argv.slice(2);

  try {
    switch (command) {
      case "list": {
        const rows = await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(25);
        if (rows.length === 0) {
          console.log("\nqueue is empty\n");
          return;
        }
        console.log(`\n${rows.length} most recent job(s)\n`);
        for (const job of rows) {
          console.log(
            `  ${job.status.padEnd(8)} ${job.type.padEnd(18)} ` +
              `attempt ${job.attempts}/${job.maxAttempts}  ${job.id}`,
          );
          console.log(`    payload ${JSON.stringify(job.payload)}`);
          if (job.lastError) console.log(`    error   ${job.lastError.slice(0, 160)}`);
        }
        console.log();
        return;
      }

      case "enqueue": {
        if (!a) {
          console.error('\nUsage: npm run job enqueue <type> \'{"key":"value"}\'\n');
          process.exitCode = 1;
          return;
        }
        const payload = b ? JSON.parse(b) : {};
        // Cast through unknown: the CLI cannot prove the payload shape, and
        // the handler validates it anyway.
        const job = await enqueue(a as never, payload as never, {
          dedupeKey: `cli:${a}:${Date.now()}`,
        });
        console.log(`\n✓ enqueued ${a} — ${job?.id ?? "(deduplicated)"}\n`);
        return;
      }

      case "retry": {
        if (!a) {
          console.error("\nUsage: npm run job retry <jobId>\n");
          process.exitCode = 1;
          return;
        }
        await db
          .update(jobs)
          .set({ status: "PENDING", attempts: 0, runAfter: new Date(), lastError: null })
          .where(eq(jobs.id, a));
        console.log(`\n✓ ${a} returned to the queue\n`);
        return;
      }

      case "clear-dead": {
        const removed = await db.delete(jobs).where(eq(jobs.status, "DEAD")).returning();
        console.log(`\n✓ removed ${removed.length} dead job(s)\n`);
        return;
      }

      default:
        console.error("\nUsage: npm run job <list|enqueue|retry|clear-dead>\n");
        process.exitCode = 1;
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error("\n✗ Failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
