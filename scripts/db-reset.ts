import "dotenv/config";

// ---------- RESET ----------
//   npm run db:reset              clears disputes, packets, webhooks, jobs
//   npm run db:reset -- --all     also clears the evidence corpus
//
// Keeps the merchant row and, by default, the evidence corpus — re-indexing
// fourteen documents costs a couple of minutes of embedding calls and is
// rarely what you actually want to throw away.
//
// Requires --yes. Everything here is irreversible.

async function main() {
  const { sql, closeDatabase } = await import("../src/lib/db/client");

  const argv = process.argv.slice(2);
  const wipeEvidence = argv.includes("--all");
  const confirmed = argv.includes("--yes");

  if (!confirmed) {
    console.log("\nThis permanently deletes:");
    console.log("  · every dispute, packet and cited claim");
    console.log("  · every recorded webhook event");
    console.log("  · the entire job queue");
    if (wipeEvidence) {
      console.log("  · the evidence corpus  (re-seeding costs ~2 min of embedding calls)");
    } else {
      console.log("\nKept: the merchant row and the evidence corpus.");
      console.log("Add --all to clear evidence too.");
    }
    console.log("\nRe-run with --yes to proceed.\n");
    await closeDatabase();
    return;
  }

  // Order matters. packet_claims cascades from packets; packets cascade from
  // disputes. Evidence is deleted last because packet_claims references it
  // with ON DELETE RESTRICT — deliberate, so a filed citation can never dangle.
  const steps: Array<[string, () => Promise<unknown>]> = [
    ["packets (cascades claims)", () => sql`delete from packets`],
    ["disputes", () => sql`delete from disputes`],
    ["webhook_events", () => sql`delete from webhook_events`],
    ["jobs", () => sql`delete from jobs`],
  ];

  if (wipeEvidence) {
    steps.push(["evidence_documents (cascades chunks)", () => sql`delete from evidence_documents`]);
  }

  console.log();
  for (const [label, run] of steps) {
    const result = (await run()) as unknown as { count: number };
    console.log(`  ✓ cleared ${label}${typeof result?.count === "number" ? ` (${result.count})` : ""}`);
  }

  const [counts] = await sql<
    Array<{ merchants: number; evidence: number }>
  >`
    select
      (select count(*)::int from merchants)          as merchants,
      (select count(*)::int from evidence_documents) as evidence
  `;

  console.log(`\nremaining: ${counts.merchants} merchant, ${counts.evidence} evidence document(s)`);
  console.log(
    wipeEvidence
      ? "\nNext: npm run evidence:seed\n"
      : "\nNext: npm run dispute:sync   (pull disputes back from PayPal)\n",
  );

  await closeDatabase();
}

main().catch((error) => {
  console.error("\n✗ Reset failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
