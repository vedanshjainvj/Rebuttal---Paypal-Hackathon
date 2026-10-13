"use client";

import type { CaseDetail } from "@/lib/queries/docket";
import {
  formatMoney,
  isPacketBusy,
  kindLabel,
  packetLabel,
  reasonLabel,
  stageLabel,
  statusLabel,
} from "@/lib/labels";
import { ActionBar } from "./ActionBar";
import { Countdown } from "./Countdown";
import { WinRead } from "./WinRead";
import { useLiveEvents } from "./useLiveEvents";
import styles from "./CaseView.module.css";

// ---------- CASE VIEW ----------
// Client component so the countdown ticks and the live stream can refresh the
// packet as the worker produces it. All data arrives already resolved from the
// server component above.

interface Props {
  detail: CaseDetail;
}

export function CaseView({ detail }: Props) {
  const packet = detail.packet;
  const busy = isPacketBusy(detail.packetState);
  // `busy` enables the polling fallback, so a stalled SSE stream cannot leave
  // this page spinning after the worker has finished.
  const { events } = useLiveEvents({ disputeId: detail.disputeId, busy });

  return (
    <>
      {/* ---------- HEADER ---------- */}
      <header className={styles.head}>
        <h1 className={`tabular ${styles.caseId}`}>{detail.disputeId}</h1>
        <p className={styles.claimLine}>
          {detail.buyerName ?? "The buyer"} disputes{" "}
          {formatMoney(detail.amount, detail.currency)} —{" "}
          <span className={styles.reason}>{reasonLabel(detail.reason).toLowerCase()}</span>
        </p>
        {detail.isFixture && (
          <p className={styles.fixtureNote}>
            Practice case — seeded locally, not a PayPal dispute.
          </p>
        )}
      </header>

      <dl className={styles.facts}>
        <div className={styles.fact}>
          <dt className="label">Status</dt>
          <dd>{statusLabel(detail.status)}</dd>
        </div>
        <div className={styles.fact}>
          <dt className="label">Stage</dt>
          <dd>{stageLabel(detail.lifecycleStage)}</dd>
        </div>
        <div className={styles.fact}>
          <dt className="label">Evidence requested</dt>
          <dd className="tabular">{detail.evidenceRequested ?? "unspecified"}</dd>
        </div>
        <div className={styles.fact}>
          <dt className="label">Transaction</dt>
          <dd className="tabular">{detail.transactionId ?? "—"}</dd>
        </div>
      </dl>

      {/* ---------- DEADLINE ---------- */}
      <section className={styles.deadline} aria-label="Response deadline">
        <span className="label">Response due</span>
        <Countdown
          hoursRemaining={detail.hoursRemaining}
          dueAt={detail.sellerResponseDueAt}
          size="large"
        />
        <p className={styles.deadlineNote}>
          {detail.hoursRemaining === null
            ? "PayPal has not set a response deadline on this case."
            : detail.hoursRemaining <= 0
              ? "This case is closed. No further response is accepted."
              : "Past this point PayPal decides on the evidence already on file."}
        </p>
      </section>

      {/* ---------- WIN READ ---------- */}
      {packet?.winScore !== null && packet?.winScore !== undefined && (
        <WinRead score={packet.winScore} reasons={packet.scoreReasons} />
      )}

      {/* ---------- ACTIVITY ---------- */}
      {events.length > 0 && (
        <section className={styles.activity} aria-label="Live activity">
          <span className="label">Activity</span>
          <ul className={styles.activityList}>
            {events.map((event) => (
              <li key={`${event.type}-${event.at}`} className={styles.activityItem}>
                <span className={`tabular ${styles.activityTime}`}>
                  {new Date(event.at).toLocaleTimeString("en-GB")}
                </span>
                <span>{event.message ?? event.type}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------- PACKET ---------- */}
      <section className={styles.packet} aria-labelledby="packet-head">
        <h2 id="packet-head" className={styles.sectionHead}>
          Drafted response
        </h2>

        {!packet ? (
          <p className={styles.pending}>
            {busy
              ? "Working through your records now."
              : detail.lastFailure
                ? "No packet was produced. The reason is below."
                : "Nothing drafted yet. Use Draft response below."}
          </p>
        ) : packet.claims.length === 0 ? (
          <p className={styles.pending}>
            This draft produced no claims that could be traced to a record, so none were
            kept. Nothing will be filed.
          </p>
        ) : (
          <div className={styles.annotated}>
            {packet.claims.map((claim) => (
              <div className={styles.claimRow} key={claim.ordinal}>
                <p className={styles.claim}>
                  {claim.text}
                  <sup className={`tabular ${styles.marker}`}>{claim.ordinal}</sup>
                </p>
                <aside className={styles.note}>
                  <span className={`tabular ${styles.noteNum}`}>{claim.ordinal}</span>
                  <span className={styles.noteKind}>{kindLabel(claim.documentKind)}</span>
                  <span className={styles.noteTitle}>{claim.documentTitle}</span>
                  <span className={styles.noteQuote}>&ldquo;{claim.quote}&rdquo;</span>
                </aside>
              </div>
            ))}
          </div>
        )}

        {packet?.narrative && (
          <div className={styles.narrative}>
            <span className="label">Note to PayPal</span>
            <p>{packet.narrative}</p>
          </div>
        )}

        {packet && (
          <p className={styles.provenance}>
            {packetLabel(packet.state)} · {packet.claims.length} cited claim
            {packet.claims.length === 1 ? "" : "s"} · {packet.model ?? "unknown model"} ·
            prompt {packet.promptVersion ?? "—"}
            {packet.submittedAt &&
              ` · filed ${new Date(packet.submittedAt).toLocaleString("en-GB")}`}
          </p>
        )}

        {(detail.lastFailure || packet?.lastError) && (
          <p className={styles.error}>
            {detail.lastFailure ?? packet?.lastError}
          </p>
        )}
      </section>

      {/* ---------- ACTIONS ---------- */}
      <ActionBar
        disputeId={detail.disputeId}
        packetId={packet?.id ?? null}
        packetState={detail.packetState}
        allowedActions={detail.allowedActions}
        isFixture={detail.isFixture}
        hasClaims={(packet?.claims.length ?? 0) > 0}
        closed={detail.hoursRemaining !== null && detail.hoursRemaining <= 0}
      />
    </>
  );
}
