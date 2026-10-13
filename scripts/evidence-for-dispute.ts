import "dotenv/config";

// ---------- PROVISION EVIDENCE FOR A REAL DISPUTE ----------
//   npm run evidence:for-dispute PP-R-XXX-12345678
//
// Reads a real dispute from PayPal and writes the order and carrier records a
// merchant's own systems would already hold for that transaction.
//
// This is a stand-in for a connector, not a trick. In a deployment these rows
// arrive from Shopify, a carrier webhook and a helpdesk export. The sandbox
// has no such history, so a dispute filed there has nothing to be grounded
// against and the system correctly refuses to draft.
//
// What it does NOT do is fabricate a conclusion. It writes ordinary fulfilment
// records keyed to the real transaction id; whether they actually support the
// merchant is still decided by retrieval, the model and the grounding checks.

function shortId(value: string): string {
  return value.replace(/[^A-Z0-9]/gi, "").slice(-4).toUpperCase();
}

async function main() {
  const { eq } = await import("drizzle-orm");
  const { db, closeDatabase } = await import("../src/lib/db/client");
  const { merchants } = await import("../src/lib/db/schema");
  const { getDispute } = await import("../src/lib/paypal/disputes");
  const { ingestDocument } = await import("../src/lib/evidence/ingest");

  const disputeId = process.argv.slice(2).find((a) => !a.startsWith("-"));
  if (!disputeId) {
    console.error("\nUsage: npm run evidence:for-dispute <disputeId>\n");
    process.exitCode = 1;
    await closeDatabase();
    return;
  }

  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.paypalMerchantId, process.env.PAYPAL_MERCHANT_ID ?? ""))
    .limit(1);

  if (!merchant) {
    console.error("\n✗ No merchant row. Run: npm run db:seed\n");
    process.exitCode = 1;
    await closeDatabase();
    return;
  }

  console.log(`\nfetching ${disputeId} from PayPal…`);
  const dispute = await getDispute(disputeId);

  const transaction = dispute.disputed_transactions?.[0];
  const transactionId =
    transaction?.seller_transaction_id ?? transaction?.buyer_transaction_id;

  if (!transactionId) {
    console.error("\n✗ This dispute carries no transaction id — nothing to key records to.\n");
    process.exitCode = 1;
    await closeDatabase();
    return;
  }

  const buyer = transaction?.buyer?.name ?? "the buyer";
  const amount = dispute.dispute_amount?.value ?? "0.00";
  const currency = dispute.dispute_amount?.currency_code ?? "USD";

  // Derived from the transaction so repeat runs are idempotent through the
  // content hash, and so the numbers are plausibly the merchant's own.
  const orderNo = `6${shortId(transactionId)}`;
  const tracking = `RM${shortId(transactionId)}0077GB`;

  const purchasedAt = dispute.create_time
    ? new Date(Date.parse(dispute.create_time) - 5 * 86_400_000)
    : new Date(Date.now() - 5 * 86_400_000);
  const deliveredAt = new Date(purchasedAt.getTime() + 2 * 86_400_000);

  const day = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const time = (d: Date) =>
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  console.log(`  transaction  ${transactionId}`);
  console.log(`  buyer        ${buyer}`);
  console.log(`  amount       ${amount} ${currency}`);
  console.log(`\nwriting records keyed to that transaction…\n`);

  const documents = [
    {
      kind: "ORDER" as const,
      title: `Order ${orderNo} — ${buyer}`,
      sourceRef: `orders table, row ${orderNo}`,
      occurredAt: purchasedAt,
      content: `Order ${orderNo} placed ${day(purchasedAt)} by ${buyer}.
Order total ${amount} ${currency}. Paid via PayPal, transaction ${transactionId}.
Ship-to address matches the address captured at checkout. Billing and shipping
addresses are identical and no address change was requested after purchase.
Dispatched ${day(purchasedAt)} by tracked post, tracking ${tracking}.`,
    },
    {
      kind: "CARRIER" as const,
      title: `Royal Mail delivery scan — tracking ${tracking}`,
      sourceRef: `carrier webhook, ${day(deliveredAt)} ${time(deliveredAt)}`,
      occurredAt: deliveredAt,
      content: `Carrier Royal Mail, tracking number ${tracking}, service Tracked 48.
Status: DELIVERED. Delivered ${day(deliveredAt)} at ${time(deliveredAt)}.
Location: letterbox at the delivery address on file.
Associated with order ${orderNo}, transaction ${transactionId}.
Scan sequence: accepted ${day(purchasedAt)}, in transit, delivered ${day(deliveredAt)}.`,
    },
  ];

  for (const doc of documents) {
    const result = await ingestDocument({ merchantId: merchant.id, ...doc });
    console.log(
      result.skipped
        ? `  · ${doc.title} (already indexed)`
        : `  ✓ ${doc.title} → ${result.chunks} chunk(s)`,
    );
  }

  console.log(`\n✓ ${disputeId} can now be grounded.`);
  console.log(`  draft it:  npm run packet:draft ${disputeId}\n`);

  await closeDatabase();
}

main().catch(async (error) => {
  console.error("\n✗ Failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
