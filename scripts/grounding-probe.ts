import "dotenv/config";

// ---------- GROUNDING PROBE ----------
//   npm run grounding:probe
//
// Runs hand-written claims against real retrieved records to show what the
// guard accepts and what it refuses. Three of these are the failure modes
// that matter: an invented citation, a paraphrased quote, and a quote that is
// subtly wrong in a way that reads as correct.
//
// This is a demonstration tool, not a test suite. It exists so the behaviour
// can be shown rather than asserted.

async function main() {
  const { eq } = await import("drizzle-orm");
  const { db, closeDatabase } = await import("../src/lib/db/client");
  const { merchants } = await import("../src/lib/db/schema");
  const { retrieveForDispute } = await import("../src/lib/evidence/retrieve");
  const { checkGrounding } = await import("../src/lib/packet/grounding");

  try {
    const [merchant] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.paypalMerchantId, process.env.PAYPAL_MERCHANT_ID ?? ""))
      .limit(1);

    if (!merchant) {
      console.error("\n✗ No merchant row. Run: npm run db:seed\n");
      process.exitCode = 1;
      return;
    }

    // The transaction behind order 4471. Both retrieval and the relevance
    // check need it: without a starting point, linkage cannot run and every
    // identified record is correctly treated as belonging to another case.
    const TRANSACTION_ID = "8KJ21094TR884120N";

    const hits = await retrieveForDispute({
      merchantId: merchant.id,
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      transactionId: TRANSACTION_ID,
      limit: 8,
    });

    const carrier = hits.find((h) => h.documentTitle.includes("FedEx"));
    if (!carrier) {
      console.error("\n✗ Expected the FedEx record in the retrieved set. Re-run evidence:seed.\n");
      process.exitCode = 1;
      return;
    }

    const claims = [
      {
        label: "honest — quote copied verbatim",
        text: "The carrier recorded a completed delivery with a signature.",
        chunkId: carrier.chunkId,
        quote: "Signature obtained: R OKONJO",
      },
      {
        label: "paraphrased — same meaning, different words",
        text: "The carrier recorded a completed delivery with a signature.",
        chunkId: carrier.chunkId,
        quote: "The signature of R. Okonjo was collected on delivery",
      },
      {
        label: "fabricated detail — plausible, not in the record",
        text: "The buyer was photographed accepting the parcel.",
        chunkId: carrier.chunkId,
        quote: "Photographic proof of delivery was captured at the door.",
      },
      {
        label: "invented citation — chunk id does not exist",
        text: "An independent courier audit confirmed the delivery.",
        chunkId: "00000000-0000-0000-0000-000000000000",
        quote: "Audit confirmed delivery to the correct address.",
      },
      {
        label: "wrong record — real quote, cited to the wrong source",
        text: "The carrier recorded a completed delivery.",
        chunkId: hits.find((h) => h.documentTitle.includes("Support"))?.chunkId ?? carrier.chunkId,
        quote: "Signature obtained: R OKONJO",
      },
    ];

    console.log(`\nchecked ${claims.length} claims against ${hits.length} retrieved records\n`);

    // Checked one at a time. Two of these claims deliberately share the same
    // quote text and differ only in which record they cite, so results cannot
    // be matched back by quote — only by position.
    let accepted = 0;

    for (const claim of claims) {
      const report = checkGrounding(
        [{ text: claim.text, chunkId: claim.chunkId, quote: claim.quote }],
        hits,
        { transactionId: TRANSACTION_ID },
      );
      const rejection = report.rejected[0];
      const ok = report.grounded.length === 1;
      if (ok) accepted += 1;

      console.log(`${ok ? "✓" : "✗"} ${claim.label}`);
      console.log(`  ${ok ? "ACCEPTED" : `REJECTED — ${rejection.reason}: ${rejection.detail}`}`);
      console.log(`  quote: "${claim.quote}"\n`);
    }

    console.log(`${accepted} accepted, ${claims.length - accepted} refused\n`);
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error("\n✗ Probe failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
