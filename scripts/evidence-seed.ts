import "dotenv/config";
import type { DocumentKind } from "../src/lib/db/schema";

// ---------- EVIDENCE CORPUS SEED ----------
// A plausible records set for one small merchant: orders, carrier scans,
// support threads, policies and ledger entries. This stands in for the
// connectors a real deployment would have (Shopify, FedEx, Zendesk, Stripe).
//
// Written so that some disputes are genuinely winnable on the evidence and
// others are not. A corpus where every case is a slam dunk would make the win
// scoring meaningless.

interface SeedDoc {
  kind: DocumentKind;
  title: string;
  sourceRef: string;
  content: string;
  occurredAt?: string;
}

const DOCUMENTS: SeedDoc[] = [
  // ---------- ORDER 4471 · strong delivery evidence ----------
  {
    kind: "ORDER",
    title: "Order 4471 — R. Okonjo",
    sourceRef: "orders table, row 4471",
    occurredAt: "2026-09-10T14:02:00Z",
    content: `Order 4471 placed 10 September 2026 by R. Okonjo.
Items: 1 × Fernleaf Wool Throw, colourway Slate, SKU TP-WT-SLA.
Order total 248.00 USD including 18.40 USD tax and free shipping.
Ship-to: 44 Larkspur Lane, Apt 3B, Portland OR 97214.
Billing address matches ship-to exactly. No address change was requested after checkout.
Payment captured via PayPal, transaction 8KJ21094TR884120N.`,
  },
  {
    kind: "CARRIER",
    title: "FedEx delivery scan — tracking 122533485",
    sourceRef: "carrier webhook, 14 September 2026 09:12",
    occurredAt: "2026-09-14T09:12:00Z",
    content: `Carrier FedEx, tracking number 122533485, service Ground.
Status: DELIVERED. Delivered 14 September 2026 at 09:12 local time.
Location: front door. Signature obtained: R OKONJO.
Delivery geotag recorded within 8 metres of the shipping address on file for order 4471.
Three prior scans: label created 11 Sep, in transit Memphis 12 Sep, out for delivery 14 Sep 06:40.`,
  },
  {
    kind: "SUPPORT",
    title: "Support thread #9120 — R. Okonjo",
    sourceRef: "helpdesk export, 15 September 2026",
    occurredAt: "2026-09-15T16:30:00Z",
    content: `Support thread #9120, opened 15 September 2026 by R. Okonjo.
Customer wrote at 16:30: "Package never showed up, I want my money back."
Agent replied at 16:48 with the FedEx tracking link and the signature image.
Customer wrote at 18:02: "found it, my neighbour took it in — sorry for the trouble."
Thread marked resolved by the agent at 18:05. No refund was requested afterwards.`,
  },

  // ---------- ORDER 4612 · contested description, weaker ----------
  {
    kind: "ORDER",
    title: "Order 4612 — M. Lindqvist",
    sourceRef: "orders table, row 4612",
    occurredAt: "2026-09-28T11:20:00Z",
    content: `Order 4612 placed 28 September 2026 by M. Lindqvist.
Items: 1 × Harbour Linen Cushion Cover, colourway Slate, SKU TP-LC-SLA.
Order total 89.50 USD. Paid via PayPal, transaction 3MN80221KL119044B.
Product page revision at time of purchase: rev 2026-08-14, which listed the colourway as Slate
and carried three photographs taken under neutral studio lighting.`,
  },
  {
    kind: "POLICY",
    title: "Returns and colour variance policy, clause 4",
    sourceRef: "policy.md, last edited 2 August 2026",
    occurredAt: "2026-08-02T00:00:00Z",
    content: `Clause 4 — Returns.
Unworn and unwashed items may be returned within 30 days of delivery for a full refund.
Clause 4.2 — Colour variance. Natural fibres are dyed in batches. Published photographs are
taken under neutral studio lighting and actual colour may vary by up to one shade.
This variance is disclosed on every product page and does not on its own constitute an item
being significantly not as described.`,
  },
  {
    kind: "SUPPORT",
    title: "Support thread #9388 — M. Lindqvist",
    sourceRef: "helpdesk export, 1 October 2026",
    occurredAt: "2026-10-01T10:15:00Z",
    content: `Support thread #9388, opened 1 October 2026 by M. Lindqvist.
Customer wrote: "The colour is much darker than the website photo."
Agent offered a prepaid return label and a full refund on receipt, or a 20 percent partial refund
to keep the item. Customer did not reply. No photographs were supplied by the customer.
Return window remains open until 28 October 2026.`,
  },

  // ---------- ORDER 4209 · refunded duplicate, strong ----------
  {
    kind: "LEDGER",
    title: "Refund 7741 — duplicate charge on order 4209",
    sourceRef: "ledger, 6 September 2026 11:03",
    occurredAt: "2026-09-06T11:03:00Z",
    content: `Refund 7741 issued 6 September 2026 at 11:03.
Reason: duplicate charge. Customer T. Nakamura was charged twice for order 4209 because a
checkout retry created a second capture.
Amount refunded 62.25 USD, the full value of the duplicate capture.
Original capture 5TY11009MN338211D retained. Duplicate capture 5TY11009MN338999X refunded.
Settlement confirmed by PayPal the same day.`,
  },
  {
    kind: "ORDER",
    title: "Order 4209 — T. Nakamura",
    sourceRef: "orders table, row 4209",
    occurredAt: "2026-09-05T19:44:00Z",
    content: `Order 4209 placed 5 September 2026 by T. Nakamura.
Items: 2 × Beeswax Taper Candles, SKU TP-BC-NAT.
Order total 62.25 USD including 4.60 USD tax.
Checkout logged one network timeout followed by a successful retry, which produced two captures.
The duplicate was identified by automated reconciliation the following morning.`,
  },

  // ---------- ORDER 4788 · pending refund, genuinely weak ----------
  {
    kind: "LEDGER",
    title: "Refund queue — order 4788 pending settlement",
    sourceRef: "ledger, pending batch",
    occurredAt: "2026-10-05T09:00:00Z",
    content: `Refund authorised 5 October 2026 for order 4788, customer C. Mwangi, amount 415.00 USD.
Original payment captured via PayPal, transaction 2AS77412BV905533E.
Status: PENDING. The refund is still sitting in the unsettled batch and has not reached the
customer's funding source. No settlement record exists.
Batch processor reported a delay affecting refunds authorised between 4 and 6 October.`,
  },
  {
    kind: "SUPPORT",
    title: "Support thread #9388b — C. Mwangi",
    sourceRef: "helpdesk export, 6 October 2026",
    occurredAt: "2026-10-06T12:00:00Z",
    content: `Support thread opened 6 October 2026 by C. Mwangi, regarding order 4788.
Agent told the customer: "Your refund has been processed and will land within three business days."
That commitment was made on 6 October. Three business days elapsed on 9 October.
The customer followed up on 10 October stating the money had not arrived. No agent reply logged.`,
  },

  // ---------- GENERAL RECORDS ----------
  {
    kind: "POLICY",
    title: "Shipping and delivery policy",
    sourceRef: "policy.md, section 2",
    occurredAt: "2026-08-02T00:00:00Z",
    content: `Section 2 — Shipping.
All orders ship from Portland, Oregon with tracked carrier service and delivery confirmation.
Orders over 150.00 USD require a signature on delivery.
Delivery estimates are 3 to 5 business days domestic, 7 to 14 international.
A delivery is considered complete when the carrier records a successful delivery scan at the
address supplied at checkout.`,
  },
  {
    kind: "POLICY",
    title: "Terms of sale — authorisation and chargebacks",
    sourceRef: "policy.md, section 7",
    occurredAt: "2026-08-02T00:00:00Z",
    content: `Section 7 — Authorisation.
Orders are accepted only when the billing address supplied matches the address held by the
payment provider. Device fingerprint and session details are retained for 180 days for every
completed checkout and are available on request for dispute investigation.`,
  },
  {
    kind: "LEDGER",
    title: "Device and session log — transaction 9QW44810ZX220871C",
    sourceRef: "auth log, 2 September 2026 22:41",
    occurredAt: "2026-09-02T22:41:00Z",
    content: `Checkout session for transaction 9QW44810ZX220871C, customer A. Haddad, amount 1240.00 USD.
Session originated from device fingerprint d41f8a2e, which appears on four prior completed orders
from this same customer account between March and August 2026, all delivered without dispute.
IP geolocation consistent with the billing address on file. No proxy or VPN indicators.
Email address on the account unchanged since registration in 2024.`,
  },
  {
    kind: "CARRIER",
    title: "UPS delivery scan — tracking 1Z99AA10123456784",
    sourceRef: "carrier webhook, 6 September 2026 15:28",
    occurredAt: "2026-09-06T15:28:00Z",
    content: `Carrier UPS, tracking number 1Z99AA10123456784, service 2nd Day Air.
Status: DELIVERED. Delivered 6 September 2026 at 15:28.
Location: reception desk. Signature obtained: A HADDAD.
Associated with transaction 9QW44810ZX220871C, order value 1240.00 USD, signature required.`,
  },
];

/**
 * Clears the corpus so edited fixtures replace their originals.
 *
 * Documents are keyed by a content hash, so changing a record's text produces
 * a new row rather than updating the old one — leaving both in the index.
 * Packets are removed first: packet_claims references documents with ON DELETE
 * RESTRICT, which is deliberate (a filed citation must never dangle) and means
 * the corpus cannot be cleared while anything still cites it.
 */
async function resetCorpus() {
  const { db } = await import("../src/lib/db/client");
  const { evidenceDocuments, packets } = await import("../src/lib/db/schema");

  const removedPackets = await db.delete(packets).returning({ id: packets.id });
  const removedDocs = await db.delete(evidenceDocuments).returning({ id: evidenceDocuments.id });

  console.log(
    `\n✓ cleared ${removedDocs.length} document(s) and ${removedPackets.length} packet(s)`,
  );
}

async function main() {
  const { eq } = await import("drizzle-orm");
  const { db, closeDatabase } = await import("../src/lib/db/client");
  const { merchants } = await import("../src/lib/db/schema");
  const { ingestDocument } = await import("../src/lib/evidence/ingest");

  if (process.argv.includes("--reset")) await resetCorpus();

  const merchantId = process.env.PAYPAL_MERCHANT_ID ?? "sandbox-merchant";

  const [merchant] = await db
    .select()
    .from(merchants)
    .where(eq(merchants.paypalMerchantId, merchantId))
    .limit(1);

  if (!merchant) {
    console.error(
      `\n✗ No merchant row for "${merchantId}". Run: npm run db:seed\n`,
    );
    process.exitCode = 1;
    await closeDatabase();
    return;
  }

  console.log(`\nseeding ${DOCUMENTS.length} documents for ${merchant.displayName}\n`);

  let indexed = 0;
  let skipped = 0;

  for (const doc of DOCUMENTS) {
    const result = await ingestDocument({
      merchantId: merchant.id,
      kind: doc.kind,
      title: doc.title,
      sourceRef: doc.sourceRef,
      content: doc.content,
      occurredAt: doc.occurredAt ? new Date(doc.occurredAt) : undefined,
    });

    if (result.skipped) {
      skipped += 1;
      console.log(`  · ${doc.title} (already indexed)`);
    } else {
      indexed += 1;
      console.log(`  ✓ ${doc.title} → ${result.chunks} chunk(s)`);
    }
  }

  console.log(`\n✓ ${indexed} indexed, ${skipped} already present\n`);
  await closeDatabase();
}

main().catch(async (error) => {
  console.error("\n✗ Seed failed:", error instanceof Error ? error.message : error, "\n");
  process.exitCode = 1;
});
