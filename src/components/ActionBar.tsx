"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { isPacketBusy } from "@/lib/labels";
import styles from "./ActionBar.module.css";

// ---------- ACTION BAR ----------
// Offers only what PayPal says is legal right now, read from the HATEOAS links
// stored on the dispute. Rendering a button PayPal would reject is worse than
// not rendering it: the operator learns the action was impossible only after
// committing to it.

type Phase = "idle" | "drafting" | "filing" | "filed" | "error";

interface Props {
  disputeId: string;
  packetId: string | null;
  packetState: string;
  allowedActions: string[];
  isFixture: boolean;
  hasClaims: boolean;
  closed: boolean;
}

export function ActionBar({
  disputeId,
  packetId,
  packetState,
  allowedActions,
  isFixture,
  hasClaims,
  closed,
}: Props) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>(packetState === "FILED" ? "filed" : "idle");
  const [message, setMessage] = useState<string | null>(null);
  const previousState = useRef(packetState);

  // Server state is the authority on whether work is still running.
  //
  // router.refresh() re-renders this component with fresh props but preserves
  // local state, so a `phase` of "drafting" survives the very update that says
  // the draft finished — the button reads "Drafting" forever beside a packet
  // that is plainly complete. Reconciling against packetState is what closes
  // that gap, and it also covers a draft completed in another tab or by the
  // worker picking up a queued job on its own.
  useEffect(() => {
    if (previousState.current === packetState) return;
    previousState.current = packetState;

    if (isPacketBusy(packetState)) return;

    if (packetState === "FILED") {
      setPhase("filed");
      return;
    }
    if (packetState === "FAILED") {
      setPhase("error");
      setMessage("Drafting failed. See the reason above.");
      return;
    }
    // DRAFTED, NEEDS_REVIEW or NONE: whatever was in flight has settled.
    setPhase("idle");
    setMessage(null);
  }, [packetState]);

  const busy = phase === "drafting" || phase === "filing" || isPacketBusy(packetState);

  // A local practice case has no PayPal links, so evidence filing is offered
  // only for real disputes PayPal is currently accepting evidence on.
  const canFile =
    !isFixture && !closed && hasClaims && allowedActions.includes("provide_evidence");

  async function requestDraft() {
    setPhase("drafting");
    setMessage(null);
    try {
      const response = await fetch(`/api/disputes/${disputeId}/draft`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "could not queue drafting");
      setMessage("Queued. The worker picks this up within a couple of seconds.");
      router.refresh();
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "could not queue drafting");
    }
  }

  async function file() {
    if (!packetId) return;
    setPhase("filing");
    setMessage(null);
    try {
      const response = await fetch(`/api/packets/${packetId}/submit`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "submission failed");
      setPhase("filed");
      setMessage(`Filed as ${body.evidenceType}.`);
      router.refresh();
    } catch (error) {
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "submission failed");
    }
  }

  return (
    <section className={styles.bar} aria-label="Respond to this dispute">
      <div className={styles.primaryGroup}>
        {canFile || packetState === "FILED" ? (
          <button
            type="button"
            className={styles.primary}
            data-phase={phase === "filing" ? "submitting" : phase}
            disabled={busy || phase === "filed" || !packetId}
            aria-busy={phase === "filing"}
            onClick={file}
          >
            <span className={styles.spinner} aria-hidden="true" />
            {phase === "filed"
              ? "Filed"
              : phase === "filing"
                ? "Filing"
                : "File evidence with PayPal"}
          </button>
        ) : (
          <button
            type="button"
            className={styles.primary}
            data-phase={phase === "drafting" ? "submitting" : phase}
            disabled={busy || closed}
            aria-busy={phase === "drafting"}
            onClick={requestDraft}
          >
            <span className={styles.spinner} aria-hidden="true" />
            {busy ? "Drafting" : packetId ? "Draft again" : "Draft response"}
          </button>
        )}

        <p className={styles.endpoint} aria-live="polite">
          {message ??
            (closed
              ? "The response window has closed."
              : isFixture
                ? "Practice case — drafting runs for real, filing is disabled."
                : canFile
                  ? `POST /v1/customer/disputes/${disputeId}/provide-evidence`
                  : !hasClaims
                    ? "No cited claims yet — draft before filing."
                    : "PayPal is not accepting evidence on this case right now.")}
        </p>
      </div>

      <div className={styles.alternates}>
        {packetId && !isFixture && (
          <button type="button" className={styles.secondary} disabled={busy} onClick={requestDraft}>
            Re-draft
          </button>
        )}
        {allowedActions.includes("make_offer") && (
          <button type="button" className={styles.secondary} disabled>
            Make an offer
          </button>
        )}
        {allowedActions.includes("accept_claim") && (
          <button type="button" className={styles.quiet} disabled>
            Accept the claim
          </button>
        )}
      </div>
    </section>
  );
}
