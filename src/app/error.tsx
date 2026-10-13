"use client";

import { useEffect } from "react";
import styles from "./status.module.css";

// ---------- ERROR BOUNDARY ----------
// Covers the whole console. The most likely cause in practice is Neon waking
// from scale-to-zero and the first query timing out, so retry is the primary
// action rather than a dead end.

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Client-side, so this reaches the browser console rather than the server
    // log. The digest is what ties it to the server-side stack trace.
    console.error("Rebuttal error:", error.message, error.digest);
  }, [error]);

  return (
    <section className={styles.wrap}>
      <h1 className={styles.title}>Something broke</h1>
      <p className={styles.body}>
        This screen could not be rendered. If the database was idle, the first
        request after a pause can time out — trying again usually resolves it.
      </p>

      <div className={styles.actions}>
        <button type="button" className={styles.primary} onClick={reset}>
          Try again
        </button>
        <a href="/" className={styles.quiet}>
          Back to the docket
        </a>
      </div>

      {error.digest && (
        <p className={`tabular ${styles.meta}`}>
          Reference {error.digest}
        </p>
      )}
    </section>
  );
}
