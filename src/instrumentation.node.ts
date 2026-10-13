// ---------- NODE INSTRUMENTATION ----------
// Kept out of instrumentation.ts because Next statically analyses that file
// for the edge runtime and flags process.pid and process.once as unsupported,
// even behind a runtime guard. Loading this module dynamically means the edge
// bundle never contains these references at all.
//
// Two background concerns start here, both of which exist because of how
// Render's free tier behaves.

export async function startBackgroundServices() {
  const { env, isProduction, keepAliveEnabled, runWorkerInWeb } = await import("./lib/env");
  const { childLogger } = await import("./lib/logger");
  const log = childLogger("instrumentation");

  // ---------- IN-PROCESS WORKER ----------
  // Render's free plan offers web services only; Background Workers need a
  // paid instance. Rather than make a free deploy impossible, the worker can
  // run inside the web process.
  //
  // This is safe because the queue was never built around a single consumer:
  // jobs are claimed with FOR UPDATE SKIP LOCKED, so an embedded worker and a
  // standalone one can run side by side without ever handling the same job.
  // Moving to a dedicated worker later is a configuration change.
  if (!runWorkerInWeb && isProduction) {
    // The failure this guards against is silent: the service boots, serves
    // pages, and never drafts anything.
    log.warn(
      "embedded worker is OFF in production — no jobs will be processed. " +
        "Set RUN_WORKER_IN_WEB=true, or run a dedicated worker service.",
    );
  }

  if (runWorkerInWeb) {
    const { Worker } = await import("./lib/jobs/worker");
    const worker = new Worker({ workerId: `web-${process.pid}` });

    log.info("starting embedded worker");
    // Deliberately not awaited: register() must return so the server can
    // begin serving. A crash here must not take the web process down.
    void worker.run().catch((error) => {
      log.error({ err: error }, "embedded worker stopped unexpectedly");
    });

    const stop = () => worker.stop();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  }

  // ---------- KEEP-ALIVE ----------
  // A free Render service idles after 15 minutes without traffic and then
  // takes roughly a minute to wake. During judging that reads as a broken
  // link. Pinging the public URL keeps the instance warm.
  //
  // The request must leave and re-enter over the public hostname; Render
  // counts inbound traffic, so an internal localhost call would not reset the
  // idle timer.
  if (!keepAliveEnabled && isProduction) {
    log.warn(
      { appBaseUrl: env.APP_BASE_URL },
      "keep-alive is off in production — the service will sleep after 15 minutes idle. " +
        "Check APP_BASE_URL is the public URL, or set KEEPALIVE=true.",
    );
  }

  if (keepAliveEnabled) {
    const target = new URL("/api/health", env.APP_BASE_URL).toString();

    {
      log.info(
        { target, intervalMs: env.KEEPALIVE_INTERVAL_MS },
        "keep-alive enabled",
      );

      const ping = async () => {
        try {
          const response = await fetch(target, {
            headers: { "user-agent": "rebuttal-keepalive" },
            signal: AbortSignal.timeout(20_000),
          });
          if (!response.ok) log.warn({ status: response.status }, "keep-alive ping unhealthy");
        } catch (error) {
          // A failed ping is not worth escalating: the next one is seconds
          // away and the service is almost certainly just waking up.
          log.debug({ err: error }, "keep-alive ping failed");
        }
      };

      const timer = setInterval(ping, env.KEEPALIVE_INTERVAL_MS);
      // Must not hold the process open during a graceful shutdown.
      timer.unref?.();

      // First ping after a short delay so it does not race the server's own
      // startup and log a confusing failure.
      setTimeout(ping, 10_000).unref?.();
    }
  }

  log.info(
    {
      production: isProduction,
      embeddedWorker: runWorkerInWeb,
      keepAlive: keepAliveEnabled,
    },
    "server ready",
  );
}
