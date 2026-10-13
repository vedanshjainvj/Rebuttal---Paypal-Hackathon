import "dotenv/config";

// ---------- PAYPAL DOCTOR ----------
// End-to-end check of the PayPal side: credentials, token exchange, Disputes
// API reachability and webhook registration. Run it whenever something stops
// working, before digging through application logs.

async function main() {
  const { env } = await import("../src/lib/env");
  const { getAccessToken } = await import("../src/lib/paypal/token");
  const { listDisputes, getDispute } = await import("../src/lib/paypal/disputes");
  type DisputeListResponse = Awaited<ReturnType<typeof listDisputes>>;
  const { listWebhooks } = await import("../src/lib/paypal/webhooks");

  console.log(`\nenvironment\n  api base    ${env.PAYPAL_API_BASE}`);
  console.log(`  merchant    ${env.PAYPAL_MERCHANT_ID ?? "(not set)"}`);
  console.log(`  app url     ${env.APP_BASE_URL}`);
  console.log(`  webhook id  ${env.PAYPAL_WEBHOOK_ID ?? "(not set)"}`);

  // ---------- TOKEN ----------
  console.log("\ncredentials");
  const started = performance.now();
  const token = await getAccessToken();
  console.log(
    `  ✓ token obtained (${token.slice(0, 6)}…, ${Math.round(performance.now() - started)}ms)`,
  );

  // ---------- WEBHOOKS ----------
  console.log("\nwebhooks");
  const webhooks = await listWebhooks();
  if (webhooks.length === 0) {
    console.log("  ! none registered — run: npm run paypal:webhook register");
  }
  for (const webhook of webhooks) {
    const active = webhook.id === env.PAYPAL_WEBHOOK_ID;
    console.log(`  ${active ? "✓" : " "} ${webhook.id}  ${webhook.url}`);
  }
  if (webhooks.length > 0 && !env.PAYPAL_WEBHOOK_ID) {
    console.log("  ! PAYPAL_WEBHOOK_ID is not set in .env — deliveries cannot be verified");
  }

  // ---------- SPECIFIC DISPUTE ----------
  // Fetching by id is the decisive test. A 404 here while the buyer can see
  // the case in their account means the REST app belongs to a different
  // sandbox business account than the one that received the payment — which
  // no amount of list filtering will fix.
  const requestedId = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (requestedId) {
    console.log(`\ndirect fetch: ${requestedId}`);
    try {
      const dispute = await getDispute(requestedId);
      console.log(`  ✓ visible to these credentials`);
      console.log(`    status  ${dispute.status}`);
      console.log(`    stage   ${dispute.dispute_life_cycle_stage}`);
      console.log(`    reason  ${dispute.reason}`);
      console.log(`    amount  ${dispute.dispute_amount?.value} ${dispute.dispute_amount?.currency_code}`);
      console.log(`    due     ${dispute.seller_response_due_date ?? "(none set)"}`);
      console.log(`    actions ${(dispute.links ?? []).map((l) => l.rel).join(", ")}`);
    } catch (error) {
      console.log(`  ✗ not visible: ${error instanceof Error ? error.message : error}`);
      console.log(
        "    If the buyer can see this case, the REST app is tied to a different\n" +
          "    sandbox business account than the one that was paid.",
      );
    }
  }

  // ---------- DISPUTES BY STATE ----------
  // The unfiltered list does not reliably surface inquiry-stage cases, so each
  // state is queried explicitly and the results merged.
  console.log("\ndisputes by state");

  const STATES = [
    "REQUIRED_ACTION",
    "REQUIRED_OTHER_PARTY_ACTION",
    "UNDER_PAYPAL_REVIEW",
    "OPEN_INQUIRIES",
    "APPEALABLE",
    "RESOLVED",
  ] as const;

  const seen = new Map<string, NonNullable<DisputeListResponse["items"]>[number]>();

  for (const state of STATES) {
    try {
      const page = await listDisputes({ disputeState: state, pageSize: 50 });
      const items = page.items ?? [];
      console.log(`  ${state.padEnd(28)} ${items.length}`);
      for (const d of items) seen.set(d.dispute_id, d);
    } catch (error) {
      console.log(`  ${state.padEnd(28)} error: ${error instanceof Error ? error.message : error}`);
    }
  }

  // Unfiltered, for comparison with the per-state sweep.
  const unfiltered = await listDisputes({ pageSize: 50 });
  console.log(`  ${"(no filter)".padEnd(28)} ${(unfiltered.items ?? []).length}`);
  for (const d of unfiltered.items ?? []) seen.set(d.dispute_id, d);

  console.log(`\n${seen.size} distinct dispute(s)`);

  if (seen.size === 0) {
    console.log("  file one as the sandbox buyer at https://www.sandbox.paypal.com");
    console.log("  note: a 'message to seller' is not a dispute — use Report a problem");
  }

  for (const dispute of seen.values()) {
    const amount = dispute.dispute_amount
      ? `${dispute.dispute_amount.value} ${dispute.dispute_amount.currency_code}`
      : "—";
    console.log(
      `  ${dispute.dispute_id}  ${String(dispute.status ?? "?").padEnd(28)} ` +
        `${String(dispute.dispute_life_cycle_stage ?? "?").padEnd(16)} ${amount}`,
    );
    if (dispute.seller_response_due_date) {
      const hours = Math.round(
        (Date.parse(dispute.seller_response_due_date) - Date.now()) / 3_600_000,
      );
      console.log(`    respond within ${hours}h — ${dispute.seller_response_due_date}`);
    }
  }

  console.log();
}

main().catch((error) => {
  console.error("\n✗ Failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
