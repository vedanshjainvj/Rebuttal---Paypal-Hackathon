// ---------- PAYPAL DISPUTES API v1 ----------
// Shapes are declared as unions where PayPal documents a closed vocabulary,
// but every union is widened with `(string & {})` so an unrecognised value
// still type-checks. PayPal adds codes over time, and a webhook carrying a new
// reason must reach the database, not crash the handler.

type Open<T extends string> = T | (string & {});

export type DisputeReason = Open<
  | "MERCHANDISE_OR_SERVICE_NOT_RECEIVED"
  | "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"
  | "UNAUTHORISED"
  | "CREDIT_NOT_PROCESSED"
  | "DUPLICATE_TRANSACTION"
  | "INCORRECT_AMOUNT"
  | "PAYMENT_BY_OTHER_MEANS"
  | "CANCELED_RECURRING_BILLING"
  | "PROBLEM_WITH_REMITTANCE"
  | "OTHER"
>;

export type DisputeStatus = Open<
  | "OPEN"
  | "WAITING_FOR_BUYER_RESPONSE"
  | "WAITING_FOR_SELLER_RESPONSE"
  | "UNDER_REVIEW"
  | "RESOLVED"
  | "OTHER"
>;

export type DisputeLifecycleStage = Open<
  "INQUIRY" | "CHARGEBACK" | "PRE_ARBITRATION" | "ARBITRATION"
>;

export type EvidenceType = Open<
  | "PROOF_OF_FULFILLMENT"
  | "PROOF_OF_REFUND"
  | "PROOF_OF_DELIVERY_SIGNATURE"
  | "PROOF_OF_RECEIPT_COPY"
  | "RETURN_POLICY"
  | "BILLING_AGREEMENT"
  | "PROOF_OF_RESHIPMENT"
  | "ITEM_DESCRIPTION"
  | "POLICE_REPORT"
  | "AFFIDAVIT"
  | "PAID_WITH_OTHER_METHOD"
  | "COPY_OF_CONTRACT"
  | "TERMINAL_ATM_RECEIPT"
  | "PRICE_DIFFERENCE_REASON"
  | "SOURCE_CONVERSION_RATE"
  | "BANK_STATEMENT"
  | "CREDIT_DUE_REASON"
  | "REQUEST_CREDIT_RECEIPT"
  | "PROOF_OF_RETURN"
  | "OTHER"
>;

export type EvidenceSource = Open<"REQUESTED_FROM_SELLER" | "SUBMITTED_BY_BUYER" | "SUBMITTED_BY_SELLER">;

export interface Money {
  currency_code: string;
  value: string;
}

export interface HateoasLink {
  href: string;
  rel: string;
  method?: string;
}

export interface TrackingInfo {
  carrier_name?: string;
  tracking_number?: string;
  tracking_url?: string;
}

export interface EvidenceDocumentRef {
  name?: string;
  url?: string;
}

export interface DisputeEvidence {
  evidence_type?: EvidenceType;
  source?: EvidenceSource;
  date?: string;
  notes?: string;
  documents?: EvidenceDocumentRef[];
  evidence_info?: {
    tracking_info?: TrackingInfo[];
    refund_ids?: string[];
  };
}

export interface DisputedTransaction {
  seller_transaction_id?: string;
  buyer_transaction_id?: string;
  create_time?: string;
  transaction_status?: string;
  gross_amount?: Money;
  buyer?: { name?: string; email?: string };
  seller?: { merchant_id?: string; name?: string; email?: string };
  items?: Array<{ item_id?: string; item_name?: string; item_quantity?: string }>;
}

export interface AllowedResponseOptions {
  make_offer?: { offer_types?: string[] };
  accept_claim?: { accept_claim_types?: string[] };
  acknowledge_return_item?: { acknowledgement_types?: string[] };
}

export interface PayPalDispute {
  dispute_id: string;
  create_time?: string;
  update_time?: string;
  status?: DisputeStatus;
  reason?: DisputeReason;
  dispute_life_cycle_stage?: DisputeLifecycleStage;
  dispute_channel?: string;
  dispute_amount?: Money;
  seller_response_due_date?: string;
  buyer_response_due_date?: string;
  disputed_transactions?: DisputedTransaction[];
  evidences?: DisputeEvidence[];
  allowed_response_options?: AllowedResponseOptions;
  messages?: Array<{ posted_by?: string; time_posted?: string; content?: string }>;
  links?: HateoasLink[];
}

export interface DisputeListItem extends PayPalDispute {
  dispute_id: string;
}

export interface DisputeListResponse {
  items?: DisputeListItem[];
  links?: HateoasLink[];
}

// ---------- WEBHOOKS ----------

export interface PayPalWebhookEvent<T = unknown> {
  id: string;
  create_time?: string;
  event_type: string;
  event_version?: string;
  resource_type?: string;
  resource_version?: string;
  summary?: string;
  resource: T;
  links?: HateoasLink[];
}

/** Headers PayPal signs each delivery with. All are required to verify it. */
export interface WebhookSignatureHeaders {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
}

export interface WebhookRegistration {
  id: string;
  url: string;
  event_types: Array<{ name: string; description?: string }>;
  links?: HateoasLink[];
}

/** Dispute events worth subscribing to. Anything else is noise for this product. */
export const DISPUTE_WEBHOOK_EVENTS = [
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
] as const;

// ---------- ERROR BODY ----------

export interface PayPalErrorBody {
  name?: string;
  message?: string;
  debug_id?: string;
  information_link?: string;
  details?: Array<{
    field?: string;
    location?: string;
    issue?: string;
    description?: string;
  }>;
}
