import { corpusStats, listCorpus, type CorpusRow } from "@/lib/queries/docket";
import { kindLabel } from "@/lib/labels";
import styles from "./evidence.module.css";

export const dynamic = "force-dynamic";

// ---------- EVIDENCE ----------
// The corpus every packet is drawn from. Worth showing plainly: a claim can
// only ever quote something on this page, so the quality of the docket is
// bounded by what is here.

export default async function EvidencePage() {
  const [stats, rows] = await Promise.all([corpusStats(), listCorpus()]);

  // A chunk without an embedding is invisible to vector search, so retrieval
  // is quietly degraded rather than broken. Surface it rather than hide it.
  const unembedded = stats.chunks - stats.embedded;

  return (
    <>
      <header className={styles.head}>
        <div className={styles.headMain}>
          <h1 className={styles.title}>Evidence</h1>
          <p className={styles.standfirst}>
            The merchant&rsquo;s own records. Nothing reaches PayPal that cannot be
            quoted from this list.
          </p>
        </div>
        <dl className={styles.summary}>
          <div className={styles.summaryItem}>
            <dt className="label">Documents</dt>
            <dd className={`tabular ${styles.summaryValue}`}>{stats.documents}</dd>
          </div>
          <div className={styles.summaryItem}>
            <dt className="label">Chunks indexed</dt>
            <dd className={`tabular ${styles.summaryValue}`}>{stats.embedded}</dd>
          </div>
          <div className={styles.summaryItem}>
            <dt className="label">Cited so far</dt>
            <dd className={`tabular ${styles.summaryValue}`}>{stats.citedDocuments}</dd>
          </div>
        </dl>
      </header>

      {unembedded > 0 && (
        <p className={styles.warning}>
          {unembedded} chunk{unembedded === 1 ? "" : "s"} have no embedding and will
          not be found by semantic search. Re-run <code>npm run evidence:seed</code>.
        </p>
      )}

      <div className={styles.table}>
        <div className={styles.columns} aria-hidden="true">
          <span className="label">Record</span>
          <span className="label">Type</span>
          <span className="label">Occurred</span>
          <span className={`label ${styles.right}`}>Chunks</span>
          <span className={`label ${styles.right}`}>Cited</span>
        </div>

        {rows.length === 0 ? (
          <p className={styles.empty}>
            No records yet. Run <code>npm run evidence:seed</code> to index a sample
            corpus.
          </p>
        ) : (
          <ul className={styles.rows}>
            {rows.map((row: CorpusRow) => (
              <li key={row.id} className={styles.row}>
                <span className={styles.cell}>
                  <span className={styles.recordTitle}>{row.title}</span>
                  <span className={styles.source}>{row.sourceRef}</span>
                </span>
                <span className={styles.kind}>{kindLabel(row.kind)}</span>
                <span className={`tabular ${styles.date}`}>
                  {row.occurredAt
                    ? new Date(row.occurredAt).toISOString().slice(0, 10)
                    : "—"}
                </span>
                <span className={`tabular ${styles.number}`} data-muted={row.indexedAt ? undefined : true}>
                  {row.indexedAt ? row.chunkCount : "not indexed"}
                </span>
                <span className={`tabular ${styles.number}`}>
                  {row.citedCount > 0 ? row.citedCount : "—"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className={styles.note}>
        A production deployment would sync these from the merchant&rsquo;s order
        system, carrier webhooks and helpdesk. Here they are seeded from a fixture
        set so retrieval and grounding can be exercised end to end.
      </p>
    </>
  );
}
