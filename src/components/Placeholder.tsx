import styles from "./Placeholder.module.css";

// ---------- PLACEHOLDER ----------
// Routes that are planned but not built. Says so plainly rather than
// shipping a hollow screen that looks finished.

interface Props {
  title: string;
  intent: string;
  items: string[];
}

export function Placeholder({ title, intent, items }: Props) {
  return (
    <section className={styles.wrap}>
      <h1 className={styles.title}>{title}</h1>
      <p className={styles.intent}>{intent}</p>
      <p className="label">Not built yet — planned for this surface</p>
      <ul className={styles.list}>
        {items.map((i) => (
          <li key={i} className={styles.item}>
            {i}
          </li>
        ))}
      </ul>
    </section>
  );
}
