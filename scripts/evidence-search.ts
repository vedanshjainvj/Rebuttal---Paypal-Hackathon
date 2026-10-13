import "dotenv/config";

// ---------- RETRIEVAL PROBE ----------
//   npm run evidence:search "signed delivery confirmation"
//   npm run evidence:search --reason MERCHANDISE_OR_SERVICE_NOT_RECEIVED
//
// Shows which half of the hybrid search produced each hit, so a bad result set
// can be diagnosed as a vector problem or a keyword problem rather than guessed at.

async function main() {
  const { eq } = await import("drizzle-orm");
  const { db, closeDatabase } = await import("../src/lib/db/client");
  const { merchants } = await import("../src/lib/db/schema");
  const { retrieveEvidence, retrieveForDispute } = await import(
    "../src/lib/evidence/retrieve"
  );

  const argv = process.argv.slice(2);
  const reasonFlag = argv.indexOf("--reason");
  const reason = reasonFlag >= 0 ? argv[reasonFlag + 1] : undefined;
  const query = reasonFlag >= 0 ? undefined : argv.join(" ").trim();

  if (!reason && !query) {
    console.error('\nUsage: npm run evidence:search "your query"\n' +
      "       npm run evidence:search --reason MERCHANDISE_OR_SERVICE_NOT_RECEIVED\n");
    process.exitCode = 1;
    await closeDatabase();
    return;
  }

  const merchantId = process.env.PAYPAL_MERCHANT_ID ?? "sandbox-merchant";
  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.paypalMerchantId, merchantId))
    .limit(1);

  if (!merchant) {
    console.error(`\n✗ No merchant row for "${merchantId}". Run: npm run db:seed\n`);
    process.exitCode = 1;
    await closeDatabase();
    return;
  }

  const hits = reason
    ? await retrieveForDispute({ merchantId: merchant.id, reason, limit: 8 })
    : await retrieveEvidence({ merchantId: merchant.id, query: query!, limit: 8 });

  console.log(`\n${hits.length} hit(s)\n`);

  for (const [i, hit] of hits.entries()) {
    const origin =
      hit.vectorRank !== null && hit.textRank !== null
        ? `both (v${hit.vectorRank} t${hit.textRank})`
        : hit.vectorRank !== null
          ? `vector (v${hit.vectorRank})`
          : `text (t${hit.textRank})`;

    console.log(`${i + 1}. ${hit.documentTitle}`);
    console.log(`   ${hit.documentKind} · ${hit.sourceRef}`);
    console.log(`   score ${hit.score.toFixed(5)} · matched by ${origin}`);
    console.log(`   ${hit.chunkContent.replace(/\s+/g, " ").slice(0, 160)}…`);
    console.log();
  }

  await closeDatabase();
}

main().catch(async (error) => {
  console.error("\n✗ Search failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
