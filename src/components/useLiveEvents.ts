"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

// ---------- LIVE EVENTS ----------
// Subscribes to the SSE stream and refreshes server-rendered data when the
// worker reports progress.
//
// router.refresh() rather than client-side state patching: the page is a
// server component reading from Postgres, so re-running that query is both
// simpler and guaranteed consistent with what a reload would show.

export interface LiveEvent {
  type: string;
  disputeId?: string;
  packetId?: string;
  message?: string;
  at: string;
}

/** Events that change rendered data. Heartbeats and `ready` do not. */
const REFRESH_ON = new Set([
  "dispute.ingested",
  "dispute.updated",
  "packet.queued",
  "packet.retrieving",
  "packet.drafting",
  "packet.drafted",
  "packet.failed",
  "packet.submitted",
]);

/** Collapses a burst of events into one refresh. */
const REFRESH_DEBOUNCE_MS = 400;

/**
 * Fallback poll used only while work is in flight.
 *
 * SSE is the fast path, but it has more ways to fail than the page can
 * detect: a proxy that buffers, a dropped tunnel, a Postgres listener that
 * silently never registered. Any of those leaves the interface spinning on
 * "Drafting" forever while the worker has long since finished. Polling only
 * when something is actually running keeps the idle page free of traffic.
 */
const BUSY_POLL_MS = 3000;

export function useLiveEvents(options: { disputeId?: string; busy?: boolean } = {}) {
  const router = useRouter();
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/stream");

    const scheduleRefresh = () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      refreshTimer.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS);
    };

    const handle = (raw: MessageEvent) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(raw.data) as LiveEvent;
      } catch {
        return;
      }

      // On a case page, ignore traffic about other disputes.
      if (options.disputeId && event.disputeId && event.disputeId !== options.disputeId) {
        return;
      }

      setEvents((previous) => [event, ...previous].slice(0, 12));
      if (REFRESH_ON.has(event.type)) scheduleRefresh();
    };

    for (const type of REFRESH_ON) source.addEventListener(type, handle);
    source.addEventListener("job.dead", handle);

    source.addEventListener("ready", () => setConnected(true));
    source.onopen = () => setConnected(true);
    // EventSource reconnects on its own; this only reflects the gap in the UI.
    source.onerror = () => setConnected(false);

    return () => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current);
      source.close();
    };
  }, [router, options.disputeId]);

  // Safety net. Runs alongside SSE and stops as soon as the server reports
  // the work finished, because `busy` is derived from server state.
  useEffect(() => {
    if (!options.busy) return;
    const id = setInterval(() => router.refresh(), BUSY_POLL_MS);
    return () => clearInterval(id);
  }, [options.busy, router]);

  return { connected, events };
}
