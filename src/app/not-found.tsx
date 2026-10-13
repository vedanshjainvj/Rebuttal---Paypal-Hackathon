import Link from "next/link";
import styles from "./status.module.css";

// ---------- NOT FOUND ----------
// Reached most often by opening a dispute id that is not in the database —
// typically a PayPal case that has not been synced yet, which is why the
// remedy is named rather than left to guesswork.

export default function NotFound() {
  return (
    <section className={styles.wrap}>
      <h1 className={styles.title}>No such case</h1>
      <p className={styles.body}>
        Nothing here matches that address. If you were opening a PayPal dispute,
        it may not have been pulled in yet — <code className="tabular">npm run dispute:sync</code>{" "}
        reconciles the docket against PayPal.
      </p>

      <div className={styles.actions}>
        <Link href="/" className={styles.primary}>
          Back to the docket
        </Link>
      </div>
    </section>
  );
}
