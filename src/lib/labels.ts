// ---------- DISPLAY LABELS ----------
// Client-safe. No database or environment imports, so client components can
// pull from here without dragging server modules into the browser bundle.
//
// Lookups are partial and fall back to a readable form of the raw value:
// PayPal adds vocabulary over time, and an unrecognised reason should render
// as "Some New Reason", never as blank or "undefined".

function humanise(value: string): string {
  return value
    .toLowerCase()
    .split("_")
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(" ");
}

const REASON_LABELS: Record<string, string> = {
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: "Not received",
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: "Not as described",
  UNAUTHORISED: "Unauthorised",
  CREDIT_NOT_PROCESSED: "Credit not processed",
  DUPLICATE_TRANSACTION: "Duplicate charge",
  INCORRECT_AMOUNT: "Incorrect amount",
  PAYMENT_BY_OTHER_MEANS: "Paid by other means",
  CANCELED_RECURRING_BILLING: "Cancelled subscription",
  PROBLEM_WITH_REMITTANCE: "Remittance problem",
  OTHER: "Other",
};

const STAGE_LABELS: Record<string, string> = {
  INQUIRY: "Inquiry",
  CHARGEBACK: "Chargeback",
  PRE_ARBITRATION: "Pre-arbitration",
  ARBITRATION: "Arbitration",
};

const STATUS_LABELS: Record<string, string> = {
  OPEN: "Open",
  WAITING_FOR_SELLER_RESPONSE: "Your move",
  WAITING_FOR_BUYER_RESPONSE: "Buyer's move",
  UNDER_REVIEW: "PayPal reviewing",
  RESOLVED: "Resolved",
};

const PACKET_LABELS: Record<string, string> = {
  NONE: "Not started",
  QUEUED: "Queued",
  RETRIEVING: "Searching records",
  DRAFTING: "Drafting",
  NEEDS_REVIEW: "Needs review",
  DRAFTED: "Drafted",
  SUBMITTING: "Filing",
  FILED: "Filed",
  FAILED: "Failed",
};

const KIND_LABELS: Record<string, string> = {
  ORDER: "Order record",
  CARRIER: "Carrier",
  SUPPORT: "Support thread",
  POLICY: "Policy",
  LEDGER: "Ledger",
  OTHER: "Record",
};

export const reasonLabel = (v: string) => REASON_LABELS[v] ?? humanise(v);
export const stageLabel = (v: string) => STAGE_LABELS[v] ?? humanise(v);
export const statusLabel = (v: string) => STATUS_LABELS[v] ?? humanise(v);
export const packetLabel = (v: string) => PACKET_LABELS[v] ?? humanise(v);
export const kindLabel = (v: string) => KIND_LABELS[v] ?? humanise(v);

// ---------- MONEY ----------

export function formatMoney(amount: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(amount);
}

// ---------- DEADLINE ----------
// Drives the oxblood escalation. PayPal closes an unanswered dispute in the
// buyer's favour, so time remaining is the primary signal in the interface.

export type DeadlineBand = "critical" | "near" | "clear" | "closed" | "none";

export function deadlineBand(hoursRemaining: number | null): DeadlineBand {
  if (hoursRemaining === null) return "none";
  if (hoursRemaining <= 0) return "closed";
  if (hoursRemaining <= 12) return "critical";
  if (hoursRemaining <= 48) return "near";
  return "clear";
}

/** States where work is in flight and the row should look busy. */
export function isPacketBusy(state: string): boolean {
  return ["QUEUED", "RETRIEVING", "DRAFTING", "SUBMITTING"].includes(state);
}
