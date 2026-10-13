import styles from "./WinRead.module.css";

// ---------- WIN READ ----------
// A judgement, not a guarantee. The number is only meaningful next to the
// reasons behind it, so the two are never rendered apart.

interface Props {
  score: number;
  reasons: string[];
}

function band(score: number) {
  if (score >= 70) return "strong";
  if (score >= 45) return "mixed";
  return "weak";
}

export function WinRead({ score, reasons }: Props) {
  return (
    <section className={styles.wrap} aria-labelledby="winread-head">
      <div className={styles.figure}>
        <h2 id="winread-head" className="label">
          Win read
        </h2>
        <p className={styles.number} data-band={band(score)}>
          {score}
          <span className={styles.unit}>%</span>
        </p>
      </div>

      <div className={styles.gauge}>
        <span className={styles.baseline} aria-hidden="true">
          <span
            className={styles.filled}
            data-band={band(score)}
            style={{ transform: `scaleX(${score / 100})` }}
          />
        </span>
        <ul className={styles.reasons}>
          {reasons.map((r) => (
            <li key={r} className={styles.reason}>
              {r}
            </li>
          ))}
        </ul>
        <p className={styles.caveat}>
          Estimated from the records retrieved for this case. It is not a
          prediction of how PayPal will rule.
        </p>
      </div>
    </section>
  );
}
