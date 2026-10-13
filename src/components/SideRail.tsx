"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./SideRail.module.css";

// ---------- N3 SIDE RAIL ----------
// Counts are passed in from the server rather than fetched here: the rail is
// rendered in the root layout, and querying from a client component would mean
// a second round trip on every navigation.

interface Props {
  merchantName: string;
  merchantRef: string;
  openCount: number;
}

export function SideRail({ merchantName, merchantRef, openCount }: Props) {
  const pathname = usePathname();

  const nav = [
    { href: "/", label: "Docket", count: openCount },
    { href: "/timeline", label: "Deadlines", count: null },
    { href: "/evidence", label: "Evidence", count: null },
  ] as const;

  return (
    <nav className={styles.rail} aria-label="Primary">
      <div className={styles.brand}>
        <span className={styles.mark} aria-hidden="true" />
        <span className={styles.wordmark}>Rebuttal</span>
        <span className={`label ${styles.sub}`}>Evidence desk</span>
      </div>

      <ul className={styles.list}>
        {nav.map((item) => {
          const active =
            item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={styles.item}
                data-active={active || undefined}
                aria-current={active ? "page" : undefined}
              >
                <span className={styles.itemLabel}>{item.label}</span>
                {item.count !== null && item.count > 0 && (
                  <span className={`tabular ${styles.count}`}>{item.count}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <div className={styles.account}>
        <span className="label">Merchant</span>
        <span className={styles.accountName}>{merchantName}</span>
        <span className={`tabular ${styles.accountId}`}>{merchantRef}</span>
      </div>
    </nav>
  );
}
