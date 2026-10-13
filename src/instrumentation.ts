// ---------- INSTRUMENTATION ----------
// Next calls register() once per server process, before the first request.
//
// This file is deliberately thin. Next type-checks it against the edge
// runtime as well as Node, so anything touching process signals or the
// database lives in a sibling module that is only ever imported on Node.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { startBackgroundServices } = await import("./instrumentation.node");
  await startBackgroundServices();
}
