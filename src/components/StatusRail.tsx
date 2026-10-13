import { env } from "@/lib/env";
import { pendingJobCount } from "@/lib/jobs/queue";
import styles from "./StatusRail.module.css";

// ---------- STATUS RAIL ----------
// Replaces a marketing footer. States plainly where the data on screen comes
// from, so nothing can be mistaken for something it is not.

export async function StatusRail() {
  // Never let a status strip take the page down.
  const pending = await pendingJobCount().catch(() => null);
  const connected = Boolean(env.PAYPAL_WEBHOOK_ID);

  return (
    <footer className={styles.rail}>
      <span className={styles.item}>
        <span className={styles.dot} data-state={connected ? "live" : "pending"} aria-hidden="true" />
        {connected ? "PayPal sandbox — connected" : "PayPal sandbox — webhook not registered"}
      </span>
      <span className={styles.divider} aria-hidden="true" />
      <span className={`tabular ${styles.item}`}>Disputes API v1</span>
      <span className={styles.divider} aria-hidden="true" />
      <span className={`tabular ${styles.item}`}>{env.GEMINI_MODEL}</span>
      {pending !== null && pending > 0 && (
        <>
          <span className={styles.divider} aria-hidden="true" />
          <span className={`tabular ${styles.item}`}>{pending} job(s) queued</span>
        </>
      )}
    </footer>
  );
}
