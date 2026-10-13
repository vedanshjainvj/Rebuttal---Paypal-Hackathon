import { randomUUID } from "node:crypto";
import { childLogger } from "../logger";
import { payPalRequest } from "./client";
import type {
  DisputeListResponse,
  EvidenceType,
  PayPalDispute,
  TrackingInfo,
} from "./types";

const log = childLogger("paypal.disputes");

// ---------- READ ----------

export interface ListDisputesParams {
  disputedTransactionId?: string;
  /** PayPal returns open disputes only unless this is set. */
  disputeState?:
    | "REQUIRED_ACTION"
    | "REQUIRED_OTHER_PARTY_ACTION"
    | "UNDER_PAYPAL_REVIEW"
    | "RESOLVED"
    | "OPEN_INQUIRIES"
    | "APPEALABLE";
  updateTimeAfter?: string;
  updateTimeBefore?: string;
  pageSize?: number;
  nextPageToken?: string;
}

export async function listDisputes(
  params: ListDisputesParams = {},
): Promise<DisputeListResponse> {
  const { data } = await payPalRequest<DisputeListResponse>("/v1/customer/disputes", {
    query: {
      disputed_transaction_id: params.disputedTransactionId,
      dispute_state: params.disputeState,
      update_time_after: params.updateTimeAfter,
      update_time_before: params.updateTimeBefore,
      page_size: params.pageSize ?? 50,
      next_page_token: params.nextPageToken,
    },
  });
  return data ?? {};
}

/** Walks every page. The sandbox never has enough disputes for this to be slow. */
export async function listAllDisputes(
  params: ListDisputesParams = {},
): Promise<DisputeListResponse["items"]> {
  const collected: NonNullable<DisputeListResponse["items"]> = [];
  let nextPageToken: string | undefined;

  do {
    const page = await listDisputes({ ...params, nextPageToken });
    collected.push(...(page.items ?? []));

    const next = page.links?.find((l) => l.rel === "next")?.href;
    nextPageToken = next ? (new URL(next).searchParams.get("next_page_token") ?? undefined) : undefined;
  } while (nextPageToken);

  return collected;
}

export async function getDispute(disputeId: string): Promise<PayPalDispute> {
  const { data } = await payPalRequest<PayPalDispute>(
    `/v1/customer/disputes/${encodeURIComponent(disputeId)}`,
  );
  return data;
}

// ---------- WRITE ----------
// Every mutating call carries an idempotency key. A retry after a network
// timeout must not file the same evidence twice.

export interface EvidenceAttachment {
  filename: string;
  contentType: string;
  content: Buffer | Uint8Array;
}

export interface ProvideEvidenceInput {
  evidenceType: EvidenceType;
  notes: string;
  trackingInfo?: TrackingInfo[];
  refundIds?: string[];
  attachments?: EvidenceAttachment[];
}

/**
 * POST /provide-evidence — multipart. The JSON part must be named `input` and
 * declared as application/json, or PayPal rejects the request with a vague 400.
 */
export async function provideEvidence(
  disputeId: string,
  input: ProvideEvidenceInput,
  idempotencyKey: string = randomUUID(),
): Promise<PayPalDispute> {
  const payload = {
    evidences: [
      {
        evidence_type: input.evidenceType,
        notes: input.notes,
        ...(input.trackingInfo || input.refundIds
          ? {
              evidence_info: {
                ...(input.trackingInfo ? { tracking_info: input.trackingInfo } : {}),
                ...(input.refundIds ? { refund_ids: input.refundIds } : {}),
              },
            }
          : {}),
      },
    ],
  };

  const form = new FormData();
  form.append("input", new Blob([JSON.stringify(payload)], { type: "application/json" }));

  for (const [index, file] of (input.attachments ?? []).entries()) {
    form.append(
      `file${index + 1}`,
      new Blob([new Uint8Array(file.content)], { type: file.contentType }),
      file.filename,
    );
  }

  log.info(
    {
      disputeId,
      evidenceType: input.evidenceType,
      attachments: input.attachments?.length ?? 0,
    },
    "providing evidence",
  );

  const { data } = await payPalRequest<PayPalDispute>(
    `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`,
    { method: "POST", form, idempotencyKey, timeoutMs: 45_000 },
  );
  return data;
}

export async function sendMessage(
  disputeId: string,
  message: string,
  idempotencyKey: string = randomUUID(),
): Promise<PayPalDispute> {
  const { data } = await payPalRequest<PayPalDispute>(
    `/v1/customer/disputes/${encodeURIComponent(disputeId)}/send-message`,
    { method: "POST", body: { message }, idempotencyKey },
  );
  return data;
}

export type OfferType =
  | "REFUND"
  | "REFUND_WITH_RETURN"
  | "REFUND_WITH_REPLACEMENT"
  | "REPLACEMENT_WITHOUT_REFUND";

export async function makeOffer(
  disputeId: string,
  offer: { note: string; offerType: OfferType; amount?: { currencyCode: string; value: string } },
  idempotencyKey: string = randomUUID(),
): Promise<PayPalDispute> {
  const { data } = await payPalRequest<PayPalDispute>(
    `/v1/customer/disputes/${encodeURIComponent(disputeId)}/make-offer`,
    {
      method: "POST",
      body: {
        note: offer.note,
        offer_type: offer.offerType,
        ...(offer.amount
          ? { offer_amount: { currency_code: offer.amount.currencyCode, value: offer.amount.value } }
          : {}),
      },
      idempotencyKey,
    },
  );
  return data;
}

/**
 * Closes the dispute in the buyer's favour and refunds them. Irreversible —
 * callers must confirm with a human before reaching this.
 */
export async function acceptClaim(
  disputeId: string,
  note: string,
  idempotencyKey: string = randomUUID(),
): Promise<PayPalDispute> {
  log.warn({ disputeId }, "accepting claim — this refunds the buyer and cannot be undone");
  const { data } = await payPalRequest<PayPalDispute>(
    `/v1/customer/disputes/${encodeURIComponent(disputeId)}/accept-claim`,
    { method: "POST", body: { note }, idempotencyKey },
  );
  return data;
}

export async function escalate(
  disputeId: string,
  note: string,
  idempotencyKey: string = randomUUID(),
): Promise<PayPalDispute> {
  const { data } = await payPalRequest<PayPalDispute>(
    `/v1/customer/disputes/${encodeURIComponent(disputeId)}/escalate`,
    { method: "POST", body: { note }, idempotencyKey },
  );
  return data;
}

export async function provideSupportingInfo(
  disputeId: string,
  notes: string,
  idempotencyKey: string = randomUUID(),
): Promise<PayPalDispute> {
  const { data } = await payPalRequest<PayPalDispute>(
    `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-supporting-info`,
    { method: "POST", body: { notes }, idempotencyKey },
  );
  return data;
}

export type AcknowledgementType =
  | "ITEM_RECEIVED"
  | "ITEM_NOT_RECEIVED"
  | "DAMAGED"
  | "EMPTY_PACKAGE_OR_DIFFERENT"
  | "MISSING_ITEMS";

export async function acknowledgeReturnItem(
  disputeId: string,
  acknowledgementType: AcknowledgementType,
  note: string,
  idempotencyKey: string = randomUUID(),
): Promise<PayPalDispute> {
  const { data } = await payPalRequest<PayPalDispute>(
    `/v1/customer/disputes/${encodeURIComponent(disputeId)}/acknowledge-return-item`,
    { method: "POST", body: { note, acknowledgement_type: acknowledgementType }, idempotencyKey },
  );
  return data;
}

// ---------- ACTION DISCOVERY ----------
// PayPal states which actions are legal for a dispute through HATEOAS links.
// Reading them is more reliable than inferring from status and stage.

export function availableActions(dispute: PayPalDispute): string[] {
  return (dispute.links ?? [])
    .map((l) => l.rel)
    .filter((rel) => rel !== "self");
}

export function canProvideEvidence(dispute: PayPalDispute): boolean {
  return availableActions(dispute).includes("provide-evidence");
}
