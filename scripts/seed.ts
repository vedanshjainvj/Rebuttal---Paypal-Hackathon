import "dotenv/config";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { merchants } from "../src/lib/db/schema";

// ---------- SEED ----------
// Creates the single merchant row the rest of the system hangs off. Idempotent:
// safe to run repeatedly, and safe to run against a database that already has
// disputes attached to this merchant.

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const MERCHANT = {
  paypalMerchantId: process.env.PAYPAL_MERCHANT_ID ?? "sandbox-merchant",
  displayName: process.env.MERCHANT_DISPLAY_NAME ?? "Thistle & Pine",
};

const sql = postgres(url, { ssl: "require", max: 1, prepare: false });
const db = drizzle(sql);

/** Placeholder written before the real sandbox merchant id was known. */
const PLACEHOLDER_ID = "sandbox-merchant";

async function main() {
  const existing = await db
    .select()
    .from(merchants)
    .where(eq(merchants.paypalMerchantId, MERCHANT.paypalMerchantId))
    .limit(1);

  if (existing.length > 0) {
    console.log(`✓ merchant already present: ${existing[0].displayName} (${existing[0].id})`);
    return;
  }

  // The first run happens before PAYPAL_MERCHANT_ID is known, so the row gets a
  // placeholder key. Adopt that row rather than inserting a second merchant,
  // which would orphan any evidence already attached to it.
  if (MERCHANT.paypalMerchantId !== PLACEHOLDER_ID) {
    const [placeholder] = await db
      .select()
      .from(merchants)
      .where(eq(merchants.paypalMerchantId, PLACEHOLDER_ID))
      .limit(1);

    if (placeholder) {
      const [updated] = await db
        .update(merchants)
        .set({ paypalMerchantId: MERCHANT.paypalMerchantId, displayName: MERCHANT.displayName })
        .where(eq(merchants.id, placeholder.id))
        .returning();
      console.log(
        `✓ merchant adopted: ${updated.displayName} (${updated.id}) ` +
          `— key updated from placeholder to ${MERCHANT.paypalMerchantId}`,
      );
      return;
    }
  }

  const [created] = await db.insert(merchants).values(MERCHANT).returning();
  console.log(`✓ merchant created: ${created.displayName} (${created.id})`);
}

main()
  .catch((error) => {
    console.error("✗ seed failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 5 });
  });
