"use client";

import { useEffect, useState } from "react";
import { deadlineBand } from "@/lib/labels";
import styles from "./Countdown.module.css";

// ---------- COUNTDOWN ----------
// The server renders a stable coarse figure; the per-second tick starts after
// mount. Rendering live seconds on the server would differ from the client's
// first paint and trip a hydration mismatch.

interface Props {
  hoursRemaining: number | null;
  dueAt: Date | string | null;
  /** Full window used to scale the depleting rule. */
  windowHours?: number;
  size?: "inline" | "large";
}

function pad(n: number) {
  return String(Math.floor(n)).padStart(2, "0");
}

function coarseLabel(hours: number | null): string {
  if (hours === null) return "no deadline";
  if (hours <= 0) return "closed";
  if (hours >= 48) return `${Math.floor(hours / 24)}d ${pad(hours % 24)}h`;
  return `${Math.floor(hours)}h ${pad((hours % 1) * 60)}m`;
}

export function Countdown({ hoursRemaining, dueAt, windowHours = 480, size = "inline" }: Props) {
  const [label, setLabel] = useState(() => coarseLabel(hoursRemaining));
  const [remaining, setRemaining] = useState(hoursRemaining);

  useEffect(() => {
    if (!dueAt || hoursRemaining === null) return;
    const target = new Date(dueAt).getTime();

    const tick = () => {
      const ms = target - Date.now();
      if (ms <= 0) {
        setLabel("closed");
        setRemaining(0);
        return;
      }
      const totalSeconds = ms / 1000;
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = Math.floor(totalSeconds % 60);

      // Seconds are noise beyond two days and make the column jitter.
      setLabel(h >= 48 ? `${Math.floor(h / 24)}d ${pad(h % 24)}h` : `${h}h ${pad(m)}m ${pad(s)}s`);
      setRemaining(totalSeconds / 3600);
    };

    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [dueAt, hoursRemaining]);

  const band = deadlineBand(remaining);
  const fill = remaining === null ? 0 : Math.max(0, Math.min(1, remaining / windowHours));

  return (
    <span className={styles.wrap} data-size={size}>
      <span className={`tabular ${styles.value}`} data-band={band}>
        {label}
      </span>
      <span className={styles.track} aria-hidden="true">
        <span
          className={styles.fill}
          data-band={band}
          style={{ transform: `scaleX(${fill})` }}
        />
      </span>
    </span>
  );
}
