import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { disputes, merchants, type Dispute } from "../db/schema";
import { notFound } from "../errors";
import { childLogger } from "../logger";
import { getDispute, listDisputes, type ListDisputesParams } from "../paypal/disputes";
import type { PayPalDispute } from "../paypal/types";

const log = childLogger("disputes.sync");

// ---------- MAPPING ----------
// Projects the fields the application queries into columns and keeps the whole
// payload in `raw`. Anything PayPal adds later is preserved without a
// migration, and nothing is silently dropped.

function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

/** The first evidence item PayPal is asking the seller for, if any. */
function requestedEvidence(dispute: PayPalDispute): string | null {
  const requested = dispute.evidences?.find((e) => e.source === "REQUESTED_FROM_SELLER");
  return requested?.evidence_type ?? dispute.evidences?.[0]?.evidence_type ?? null;
}

function sellerTransactionId(dispute: PayPalDispute): string | null {
  const transaction = dispute.disputed_transactions?.[0];
  return transaction?.seller_transaction_id ?? transaction?.buyer_transaction_id ?? null;
}

export function mapDispute(dispute: PayPalDispute, merchantId: string) {
  const transaction = dispute.disputed_transactions?.[0];

  return {
    disputeId: dispute.dispute_id,
    merchantId,
    buyerName: transaction?.buyer?.name ?? null,
    // PayPal sends amounts as strings and numeric() takes strings. Keeping it
    // a string all the way through avoids a float round-trip on money.
    amountValue: dispute.dispute_amount?.value ?? "0.00",
    currency: dispute.dispute_amount?.currency_code ?? "USD",
    reason: dispute.reason ?? "OTHER",
    status: dispute.status ?? "OPEN",
    lifecycleStage: dispute.dispute_life_cycle_stage ?? "INQUIRY",
    evidenceRequested: requestedEvidence(dispute),
    transactionId: sellerTransactionId(dispute),
    sellerResponseDueAt: parseDate(dispute.seller_response_due_date),
    paypalCreatedAt: parseDate(dispute.create_time),
    raw: dispute,
    updatedAt: new Date(),
  };
}

// ---------- UPSERT ----------

async function resolveMerchantId(paypalMerchantId?: string): Promise<string> {
  const rows = paypalMerchantId
    ? await db.select().from(merchants).where(eq(merchants.paypalMerchantId, paypalMerchantId)).limit(1)
    : await db.select().from(merchants).limit(1);

  const merchant = rows[0];
  if (!merchant) {
    throw notFound("Merchant row — run `npm run db:seed`", { paypalMerchantId });
  }
  return merchant.id;
}

export interface UpsertResult {
  dispute: Dispute;
  created: boolean;
}

/**
 * Writes a dispute, preserving locally-owned state.
 *
 * packetState and winScore belong to this system, not to PayPal, so the
 * conflict branch leaves them alone. Overwriting them on every webhook would
 * reset a finished draft back to NONE each time PayPal touched the case.
 */
export async function upsertDispute(
  payPalDispute: PayPalDispute,
  paypalMerchantId?: string,
): Promise<UpsertResult> {
  const merchantId = await resolveMerchantId(paypalMerchantId);
  const values = mapDispute(payPalDispute, merchantId);

  const existing = await db
    .select({ id: disputes.disputeId })
    .from(disputes)
    .where(eq(disputes.disputeId, values.disputeId))
    .limit(1);

  const [row] = await db
    .insert(disputes)
    .values(values)
    .onConflictDoUpdate({
      target: disputes.disputeId,
      set: {
        buyerName: values.buyerName,
        amountValue: values.amountValue,
        currency: values.currency,
        reason: values.reason,
        status: values.status,
        lifecycleStage: values.lifecycleStage,
        evidenceRequested: values.evidenceRequested,
        transactionId: values.transactionId,
        sellerResponseDueAt: values.sellerResponseDueAt,
        raw: values.raw,
        updatedAt: values.updatedAt,
      },
    })
    .returning();

  const created = existing.length === 0;
  log.info(
    { disputeId: row.disputeId, status: row.status, stage: row.lifecycleStage, created },
    created ? "dispute ingested" : "dispute updated",
  );

  return { dispute: row, created };
}

/** Fetches one dispute from PayPal and stores it. Used by the ingest job. */
export async function syncDispute(
  disputeId: string,
  paypalMerchantId?: string,
): Promise<UpsertResult> {
  return upsertDispute(await getDispute(disputeId), paypalMerchantId);
}

// ---------- BULK SYNC ----------
// Reconciliation path. Webhooks can be missed — a dead tunnel, a restart, a
// delivery PayPal gave up retrying — so the system must be able to rebuild its
// view from PayPal rather than depending on having seen every event.

const SWEEP_STATES: NonNullable<ListDisputesParams["disputeState"]>[] = [
  "REQUIRED_ACTION",
  "REQUIRED_OTHER_PARTY_ACTION",
  "UNDER_PAYPAL_REVIEW",
  "OPEN_INQUIRIES",
  "APPEALABLE",
  "RESOLVED",
];

export interface SweepResult {
  seen: number;
  created: number;
  updated: number;
}

export async function syncAllDisputes(paypalMerchantId?: string): Promise<SweepResult> {
  // Each state is queried separately: the unfiltered listing does not reliably
  // include inquiry-stage cases, which is exactly where a new dispute starts.
  const found = new Map<string, PayPalDispute>();

  for (const state of SWEEP_STATES) {
    try {
      const page = await listDisputes({ disputeState: state, pageSize: 50 });
      for (const item of page.items ?? []) found.set(item.dispute_id, item);
    } catch (error) {
      log.warn({ state, err: error }, "dispute state sweep failed, continuing");
    }
  }

  const unfiltered = await listDisputes({ pageSize: 50 });
  for (const item of unfiltered.items ?? []) found.set(item.dispute_id, item);

  let created = 0;
  let updated = 0;

  for (const summary of found.values()) {
    // The list response is a summary. Detail carries evidences, allowed
    // actions and the response deadline, all of which the packet needs.
    const full = await getDispute(summary.dispute_id);
    const result = await upsertDispute(full, paypalMerchantId);
    if (result.created) created += 1;
    else updated += 1;
  }

  log.info({ seen: found.size, created, updated }, "dispute sweep complete");
  return { seen: found.size, created, updated };
}
