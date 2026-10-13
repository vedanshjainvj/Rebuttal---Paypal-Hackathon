import "dotenv/config";

// ---------- WORKER ENTRY ----------
//   npm run worker        long-running
//   npm run worker:once   drain the queue and exit
//
// Separate process from the web server. Drafting takes seconds and would tie
// up a request handler; on Render this deploys as its own background service.

async function main() {
  const { Worker } = await import("../src/lib/jobs/worker");
  const { closeDatabase } = await import("../src/lib/db/client");
  const { childLogger } = await import("../src/lib/logger");

  const log = childLogger("worker.main");
  const once = process.argv.includes("--once");
  const worker = new Worker({ exitWhenEmpty: once });

  // Graceful shutdown: stop claiming, let the in-flight job finish, then close
  // the pool. Killing mid-job would leave it RUNNING until the stale sweep
  // reclaims it minutes later.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) {
      log.warn({ signal }, "second signal received, exiting immediately");
      process.exit(1);
    }
    shuttingDown = true;
    log.info({ signal }, "shutdown requested, finishing current job");
    worker.stop();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason) => {
    log.error({ reason }, "unhandled rejection in worker");
  });

  try {
    await worker.run();
  } finally {
    await closeDatabase();
  }

  log.info("worker exited cleanly");
}

main().catch((error) => {
  console.error("✗ Worker crashed:", error instanceof Error ? error.message : error);
  process.exit(1);
});
