import "dotenv/config";

// ---------- DISPUTE SYNC ----------
//   npm run dispute:sync              pull every dispute PayPal will show us
//   npm run dispute:sync PP-D-12345   pull one
//
// Reconciliation, not the primary path. Webhooks drive normal operation; this
// exists because a missed delivery must not mean a permanently missing case.

async function main() {
  const { closeDatabase } = await import("../src/lib/db/client");
  const { syncAllDisputes, syncDispute } = await import("../src/lib/disputes/sync");

  const requested = process.argv.slice(2).find((a) => !a.startsWith("-"));
  const merchantId = process.env.PAYPAL_MERCHANT_ID;

  try {
    if (requested) {
      const { dispute, created } = await syncDispute(requested, merchantId);
      console.log(`\n${created ? "✓ ingested" : "✓ updated"} ${dispute.disputeId}`);
      console.log(`  status  ${dispute.status}`);
      console.log(`  stage   ${dispute.lifecycleStage}`);
      console.log(`  reason  ${dispute.reason}`);
      console.log(`  amount  ${dispute.amountValue} ${dispute.currency}`);
      console.log(`  due     ${dispute.sellerResponseDueAt?.toISOString() ?? "(none)"}\n`);
    } else {
      const result = await syncAllDisputes(merchantId);
      console.log(
        `\n✓ ${result.seen} dispute(s) seen — ${result.created} new, ${result.updated} updated\n`,
      );
      if (result.seen === 0) {
        console.log("  PayPal returned no disputes for these credentials.");
        console.log("  Check that the REST app belongs to the business account that was paid.\n");
      }
    }
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error("\n✗ Sync failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
