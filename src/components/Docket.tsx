"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { DocketRow, DocketSummary } from "@/lib/queries/docket";
import {
  deadlineBand,
  formatMoney,
  isPacketBusy,
  packetLabel,
  reasonLabel,
  stageLabel,
} from "@/lib/labels";
import { Countdown } from "./Countdown";
import { useLiveEvents } from "./useLiveEvents";
import styles from "./Docket.module.css";

// ---------- FILTERS ----------

const FILTERS = [
  { id: "action", label: "Needs a response" },
  { id: "closing", label: "Closing within 48h" },
  { id: "filed", label: "Filed" },
  { id: "all", label: "Everything" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

function matches(row: DocketRow, filter: FilterId): boolean {
  switch (filter) {
    case "action":
      return row.status === "WAITING_FOR_SELLER_RESPONSE";
    case "closing":
      return row.hoursRemaining !== null && row.hoursRemaining > 0 && row.hoursRemaining <= 48;
    case "filed":
      return row.packetState === "FILED";
    case "all":
      return true;
  }
}

interface Props {
  rows: DocketRow[];
  summary: DocketSummary;
}

export function Docket({ rows, summary }: Props) {
  const [filter, setFilter] = useState<FilterId>("action");

  // Refreshes the server-rendered rows whenever the worker reports progress.
  // Polling engages only while some row is actually being worked on.
  const anyBusy = rows.some((row) => isPacketBusy(row.packetState));
  const { connected } = useLiveEvents({ busy: anyBusy });

  const visible = useMemo(() => rows.filter((row) => matches(row, filter)), [rows, filter]);

  return (
    <>
      {/* ---------- HEADER ---------- */}
      <header className={styles.head}>
        <div className={styles.headMain}>
          <h1 className={styles.title}>Docket</h1>
          <p className={styles.standfirst}>
            Every open dispute, ordered by how long you have left to answer.
            PayPal closes an unanswered case in the buyer&rsquo;s favour.
          </p>
        </div>
        <dl className={styles.summary}>
          <div className={styles.summaryItem}>
            <dt className="label">Closing within 48h</dt>
            <dd className={`tabular ${styles.summaryValue}`}>{summary.closingSoonCount}</dd>
          </div>
          <div className={styles.summaryItem}>
            <dt className="label">Exposure</dt>
            <dd className={`tabular ${styles.summaryValue}`} data-accent>
              {formatMoney(summary.exposure, summary.currency)}
            </dd>
          </div>
        </dl>
      </header>

      {/* ---------- FILTERS ---------- */}
      <div className={styles.filterRow}>
        <div className={styles.filters} role="group" aria-label="Filter the docket">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={styles.filter}
              data-active={filter === f.id || undefined}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <span className={styles.live} data-connected={connected || undefined}>
          <span className={styles.liveDot} aria-hidden="true" />
          {connected ? "live" : "reconnecting"}
        </span>
      </div>

      {/* ---------- TABLE ---------- */}
      <div className={styles.table}>
        <div className={styles.columns} aria-hidden="true">
          <span className="label">Case</span>
          <span className="label">Claim</span>
          <span className={`label ${styles.right}`}>Amount</span>
          <span className="label">Response due</span>
          <span className="label">Packet</span>
        </div>

        {visible.length === 0 ? (
          <p className={styles.empty}>
            {rows.length === 0
              ? "No disputes yet. Run `npm run dispute:sync` to pull from PayPal."
              : "Nothing in this view."}
          </p>
        ) : (
          <ul className={styles.rows}>
            {visible.map((row) => (
              <li key={row.disputeId}>
                <Link
                  href={`/disputes/${row.disputeId}`}
                  className={styles.row}
                  data-band={deadlineBand(row.hoursRemaining)}
                >
                  <span className={styles.cell}>
                    <span className={`tabular ${styles.caseId}`}>{row.disputeId}</span>
                    <span className={styles.caseBuyer}>
                      {row.buyerName ?? "buyer unknown"}
                      {row.isFixture && <span className={styles.fixture}>practice</span>}
                    </span>
                  </span>

                  <span className={styles.cell}>
                    <span className={styles.reason}>{reasonLabel(row.reason)}</span>
                    <span className={styles.stage}>{stageLabel(row.lifecycleStage)}</span>
                  </span>

                  <span className={`tabular ${styles.amount}`}>
                    {formatMoney(row.amount, row.currency)}
                  </span>

                  <span className={styles.cell}>
                    <Countdown
                      hoursRemaining={row.hoursRemaining}
                      dueAt={row.sellerResponseDueAt}
                    />
                  </span>

                  <span className={styles.cell}>
                    <span
                      className={styles.packet}
                      data-state={row.packetState}
                      data-busy={isPacketBusy(row.packetState) || undefined}
                    >
                      <span className={styles.packetDot} aria-hidden="true" />
                      {packetLabel(row.packetState)}
                    </span>
                    {row.winScore !== null && (
                      <span className={`tabular ${styles.score}`}>
                        {row.winScore}
                        <span className={styles.scoreUnit}>% win read</span>
                      </span>
                    )}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
