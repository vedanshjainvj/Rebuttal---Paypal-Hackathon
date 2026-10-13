// ---------- RELEVANCE ----------
// The second half of grounding, and the one that is easy to miss.
//
// The quote check proves a claim came from a real record. It says nothing
// about whether that record concerns *this* dispute. Retrieval is similarity
// based, so a dispute with no matching records still returns the eight most
// similar ones — and a delivery scan for somebody else's order looks highly
// relevant to any not-received dispute.
//
// Observed in practice: a $1.00 dispute over transaction 5NA45408PT718622X
// was drafted with carrier evidence from order 4471, a different buyer and a
// different transaction. Every quote was verbatim. The packet scored 95%.
// Filing another customer's delivery proof is worse than filing nothing.
//
// The fix is identifier linkage. A record is admissible only if it can be
// traced back to the disputed transaction through identifiers the records
// themselves carry.

/** PayPal transaction ids: 17 characters, uppercase alphanumeric. */
const TRANSACTION_PATTERN = /\b[A-Z0-9]{17}\b/g;

/** "order 4471", "Order 4471" — the merchant's own numbering. */
const ORDER_PATTERN = /\border\s+(\d{3,8})\b/gi;

/** "tracking number 122533485", "tracking 1Z99AA10123456784". */
const TRACKING_PATTERN = /\btracking(?:\s+number)?\s+([A-Z0-9]{8,})\b/gi;

/** "Refund 7741", "refund 7741". */
const REFUND_PATTERN = /\brefund\s+(\d{3,8})\b/gi;

export interface RecordIdentifiers {
  transactions: Set<string>;
  orders: Set<string>;
  tracking: Set<string>;
  refunds: Set<string>;
}

function collect(text: string, pattern: RegExp, group = 0): Set<string> {
  const found = new Set<string>();
  // Patterns are module-level and carry /g, so lastIndex must be reset or a
  // second call silently starts mid-string.
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const value = match[group];
    if (value) found.add(value.toUpperCase());
  }
  return found;
}

export function extractIdentifiers(text: string): RecordIdentifiers {
  return {
    transactions: collect(text, TRANSACTION_PATTERN),
    orders: collect(text, ORDER_PATTERN, 1),
    tracking: collect(text, TRACKING_PATTERN, 1),
    refunds: collect(text, REFUND_PATTERN, 1),
  };
}

function isEmpty(ids: RecordIdentifiers): boolean {
  return (
    ids.transactions.size === 0 &&
    ids.orders.size === 0 &&
    ids.tracking.size === 0 &&
    ids.refunds.size === 0
  );
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

function absorb(target: RecordIdentifiers, source: RecordIdentifiers): void {
  for (const v of source.transactions) target.transactions.add(v);
  for (const v of source.orders) target.orders.add(v);
  for (const v of source.tracking) target.tracking.add(v);
  for (const v of source.refunds) target.refunds.add(v);
}

export interface LinkageInput {
  /** The disputed transaction. The only identifier PayPal gives us directly. */
  transactionId: string | null;
  records: Array<{ id: string; content: string }>;
}

export interface LinkageResult {
  /** Record ids provably connected to the disputed transaction. */
  linked: Set<string>;
  /**
   * Record ids carrying no identifiers at all — policies, terms, general
   * procedure. Admissible as supporting context: a returns policy is about
   * every order, so it cannot contradict this one.
   */
  general: Set<string>;
  /** Everything else: identified, but belonging to a different case. */
  foreign: Set<string>;
  /** Identifiers reached from the disputed transaction, after expansion. */
  reached: RecordIdentifiers;
}

/**
 * Walks outward from the disputed transaction id.
 *
 * Linkage is transitive because records cross-reference each other. The order
 * record names both the transaction and the order number; the carrier scan
 * names the order number and a tracking number; the support thread names the
 * thread and the order. Starting from one transaction id, repeated passes
 * reach the whole chain — and nothing outside it.
 */
export function linkRecords(input: LinkageInput): LinkageResult {
  const reached: RecordIdentifiers = {
    transactions: new Set(input.transactionId ? [input.transactionId.toUpperCase()] : []),
    orders: new Set(),
    tracking: new Set(),
    refunds: new Set(),
  };

  const identifiersByRecord = new Map<string, RecordIdentifiers>();
  for (const record of input.records) {
    identifiersByRecord.set(record.id, extractIdentifiers(record.content));
  }

  const linked = new Set<string>();
  const general = new Set<string>();

  for (const [id, ids] of identifiersByRecord) {
    if (isEmpty(ids)) general.add(id);
  }

  // Fixed-point expansion. Bounded by record count: each pass either links a
  // new record or the set has stopped growing.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [id, ids] of identifiersByRecord) {
      if (linked.has(id) || general.has(id)) continue;

      const connects =
        intersects(ids.transactions, reached.transactions) ||
        intersects(ids.orders, reached.orders) ||
        intersects(ids.tracking, reached.tracking) ||
        intersects(ids.refunds, reached.refunds);

      if (connects) {
        linked.add(id);
        absorb(reached, ids);
        grew = true;
      }
    }
  }

  const foreign = new Set<string>();
  for (const id of identifiersByRecord.keys()) {
    if (!linked.has(id) && !general.has(id)) foreign.add(id);
  }

  return { linked, general, foreign, reached };
}
