import "dotenv/config";

// ---------- PACKET DRAFT ----------
//   npm run packet:draft --demo            seed local practice disputes
//   npm run packet:draft <disputeId>       draft for one dispute
//
// The demo disputes are written straight into the database with a LOCAL-
// prefix and a raw payload that marks them as fixtures. They exist so the
// drafting pipeline can be exercised without waiting on a sandbox dispute,
// and so there is a working path if PayPal's sandbox is down during judging.
// They are never confused with real cases: the id prefix and raw._source
// both say otherwise.

interface DemoDispute {
  disputeId: string;
  buyerName: string;
  amountValue: string;
  reason: string;
  transactionId: string;
  dueInHours: number;
  lifecycleStage: string;
  evidenceRequested: string;
}

const DEMO_DISPUTES: DemoDispute[] = [
  {
    disputeId: "LOCAL-DEMO-4471",
    buyerName: "R. Okonjo",
    amountValue: "248.00",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    transactionId: "8KJ21094TR884120N",
    dueInHours: 31,
    lifecycleStage: "CHARGEBACK",
    evidenceRequested: "PROOF_OF_FULFILLMENT",
  },
  {
    disputeId: "LOCAL-DEMO-4612",
    buyerName: "M. Lindqvist",
    amountValue: "89.50",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    transactionId: "3MN80221KL119044B",
    dueInHours: 9,
    lifecycleStage: "INQUIRY",
    evidenceRequested: "OTHER",
  },
  {
    disputeId: "LOCAL-DEMO-4788",
    buyerName: "C. Mwangi",
    amountValue: "415.00",
    reason: "CREDIT_NOT_PROCESSED",
    transactionId: "2AS77412BV905533E",
    dueInHours: 3,
    lifecycleStage: "INQUIRY",
    evidenceRequested: "PROOF_OF_REFUND",
  },
  // Refund predates the dispute — the strongest possible position.
  {
    disputeId: "LOCAL-DEMO-4209",
    buyerName: "T. Nakamura",
    amountValue: "62.25",
    reason: "DUPLICATE_TRANSACTION",
    transactionId: "5TY11009MN338211D",
    dueInHours: 140,
    lifecycleStage: "CHARGEBACK",
    evidenceRequested: "PROOF_OF_REFUND",
  },
  // Highest value, and the only one that turns on device history rather than
  // delivery. Exercises a different retrieval path entirely.
  {
    disputeId: "LOCAL-DEMO-4902",
    buyerName: "A. Haddad",
    amountValue: "1240.00",
    reason: "UNAUTHORISED",
    transactionId: "9QW44810ZX220871C",
    dueInHours: 68,
    lifecycleStage: "PRE_ARBITRATION",
    evidenceRequested: "PROOF_OF_FULFILLMENT",
  },
  // No record anywhere references this transaction. Must refuse to draft.
  {
    disputeId: "LOCAL-DEMO-0000",
    buyerName: "K. Virtanen",
    amountValue: "74.00",
    reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
    transactionId: "0ZZ00000AA000000Z",
    dueInHours: 20,
    lifecycleStage: "INQUIRY",
    evidenceRequested: "PROOF_OF_FULFILLMENT",
  },
];

async function seedDemo() {
  const { db } = await import("../src/lib/db/client");
  const { disputes, merchants } = await import("../src/lib/db/schema");

  const [merchant] = await db.select().from(merchants).limit(1);
  if (!merchant) {
    console.error("\n✗ No merchant row. Run: npm run db:seed\n");
    process.exitCode = 1;
    return;
  }

  for (const demo of DEMO_DISPUTES) {
    await db
      .insert(disputes)
      .values({
        disputeId: demo.disputeId,
        merchantId: merchant.id,
        buyerName: demo.buyerName,
        amountValue: demo.amountValue,
        currency: "USD",
        reason: demo.reason,
        status: "WAITING_FOR_SELLER_RESPONSE",
        lifecycleStage: demo.lifecycleStage,
        evidenceRequested: demo.evidenceRequested,
        transactionId: demo.transactionId,
        sellerResponseDueAt: new Date(Date.now() + demo.dueInHours * 3_600_000),
        paypalCreatedAt: new Date(Date.now() - 19 * 3_600_000),
        raw: { _source: "local fixture", _note: "not a PayPal dispute" },
      })
      .onConflictDoNothing({ target: disputes.disputeId });

    console.log(`  ✓ ${demo.disputeId}  ${demo.reason}`);
  }
}

/**
 * Returns every practice case to its pre-draft state.
 *
 * The console offers "Draft response" only while a dispute has no packet, so
 * without this the live drafting flow can be demonstrated exactly once.
 * Touches LOCAL- disputes only; real PayPal cases are never reset, because
 * discarding a packet that was filed would lose the audit trail.
 */
async function resetDemo(disputeId?: string) {
  const { and, eq, isNull, like } = await import("drizzle-orm");
  const { db } = await import("../src/lib/db/client");
  const { disputes, packets } = await import("../src/lib/db/schema");

  // Scope: one named dispute, or every practice case. Real PayPal disputes
  // are only ever touched when named explicitly.
  const packetScope = disputeId
    ? eq(packets.disputeId, disputeId)
    : like(packets.disputeId, "LOCAL-%");
  const disputeScope = disputeId
    ? eq(disputes.disputeId, disputeId)
    : like(disputes.disputeId, "LOCAL-%");

  // Never discard a filed packet: it is the record of what PayPal received.
  // packet_claims cascades from packets.
  const removed = await db
    .delete(packets)
    .where(and(packetScope, isNull(packets.submittedAt)))
    .returning({ id: packets.id });

  const reset = await db
    .update(disputes)
    .set({ packetState: "NONE", winScore: null, updatedAt: new Date() })
    .where(disputeScope)
    .returning({ id: disputes.disputeId });

  // Practice deadlines are relative to when they were seeded, so the short
  // ones lapse within hours and the case renders as closed — untestable.
  // Re-anchoring them to now keeps the demo repeatable indefinitely.
  if (!disputeId) {
    for (const demo of DEMO_DISPUTES) {
      await db
        .update(disputes)
        .set({ sellerResponseDueAt: new Date(Date.now() + demo.dueInHours * 3_600_000) })
        .where(eq(disputes.disputeId, demo.disputeId));
    }
  }

  console.log(
    `\n✓ cleared ${removed.length} unfiled packet(s), reset ${reset.length} case(s)` +
      `${disputeId ? "" : ", deadlines re-anchored"}\n`,
  );
}

async function main() {
  const { closeDatabase } = await import("../src/lib/db/client");
  const argv = process.argv.slice(2);

  try {
    if (argv.includes("--reset")) {
      // `--reset` alone clears practice cases; `--reset <id>` targets one.
      await resetDemo(argv.find((a) => !a.startsWith("-")));
      if (!argv.includes("--demo")) return;
    }

    if (argv.includes("--demo")) {
      console.log("\nseeding local practice disputes\n");
      await seedDemo();
      console.log("\n  draft one with: npm run packet:draft LOCAL-DEMO-4471\n");
      return;
    }

    const disputeId = argv.find((a) => !a.startsWith("-"));
    if (!disputeId) {
      console.error(
        "\nUsage: npm run packet:draft <disputeId>\n" +
          "       npm run packet:draft --demo\n",
      );
      process.exitCode = 1;
      return;
    }

    const { draftPacket } = await import("../src/lib/packet/draft");
    const outcome = await draftPacket({ disputeId });

    console.log(`\n${"=".repeat(72)}`);
    console.log(`PACKET  ${outcome.packet.id}`);
    console.log(`state   ${outcome.packet.state}`);
    console.log(
      `model   ${outcome.model} (${outcome.provider}) · ${outcome.durationMs}ms · ` +
        `${outcome.retrievedCount} records retrieved`,
    );
    console.log("=".repeat(72));

    console.log(`\nWIN READ  ${outcome.packet.winScore}%`);
    for (const reason of outcome.packet.scoreReasons ?? []) {
      console.log(`  – ${reason}`);
    }

    console.log(`\nCLAIMS  ${outcome.grounding.grounded.length} grounded`);
    for (const [i, claim] of outcome.grounding.grounded.entries()) {
      console.log(`\n  ${i + 1}. ${claim.text}`);
      console.log(`     source: ${claim.documentTitle} — ${claim.sourceRef}`);
      console.log(`     quote:  "${claim.quote.replace(/\s+/g, " ").slice(0, 150)}"`);
    }

    if (outcome.grounding.rejected.length > 0) {
      console.log(`\nREJECTED  ${outcome.grounding.rejected.length} claim(s) failed grounding`);
      for (const rejected of outcome.grounding.rejected) {
        console.log(`\n  ✗ ${rejected.reason}: ${rejected.detail}`);
        console.log(`    claim: ${rejected.claim.text.slice(0, 120)}`);
      }
    }

    console.log(`\nNARRATIVE\n`);
    console.log(
      outcome.packet.narrative
        ?.split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );

    console.log(
      `\ngrounding rate ${(outcome.grounding.groundingRate * 100).toFixed(0)}%\n`,
    );
  } finally {
    await closeDatabase();
  }
}

main().catch((error) => {
  console.error("\n✗ Draft failed:", error instanceof Error ? error.message : error);
  // AppError carries the provider's own response body, which is the only
  // thing that distinguishes a wrong model name from a rejected schema.
  const context = (error as { context?: Record<string, unknown> })?.context;
  if (context && Object.keys(context).length > 0) {
    console.error("  context:", JSON.stringify(context, null, 2));
  }
  console.error();
  process.exitCode = 1;
});
