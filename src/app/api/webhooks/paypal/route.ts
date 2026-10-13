import { NextResponse } from "next/server";
import { db } from "@/lib/db/client";
import { webhookEvents } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { describeError, isAppError } from "@/lib/errors";
import { JOB_TYPES, enqueue } from "@/lib/jobs/queue";
import { childLogger } from "@/lib/logger";
import { extractSignatureHeaders, verifyWebhookSignature } from "@/lib/paypal/webhooks";
import type { PayPalWebhookEvent } from "@/lib/paypal/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = childLogger("webhook.paypal");

// ---------- PAYPAL WEBHOOK INGEST ----------
// Contract with PayPal: verify, record, enqueue, return quickly. All real work
// happens in the worker. PayPal retries non-2xx responses with backoff, so the
// status code returned here is a scheduling instruction, not just a report.

interface DisputeResource {
  dispute_id?: string;
}

export async function POST(request: Request) {
  // The raw body is read first and parsed by hand. Verification is performed
  // against the exact bytes PayPal sent, not a re-serialised object.
  const rawBody = await request.text();

  let event: PayPalWebhookEvent<DisputeResource>;
  try {
    event = JSON.parse(rawBody) as PayPalWebhookEvent<DisputeResource>;
  } catch {
    log.warn({ bodyLength: rawBody.length }, "webhook body was not valid JSON");
    // Malformed bodies are never going to parse. 400 stops PayPal retrying.
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const signature = extractSignatureHeaders(request.headers);
  if (!signature) {
    return NextResponse.json({ error: "missing signature headers" }, { status: 401 });
  }

  // ---------- VERIFY ----------
  // Fails closed. An unverifiable delivery is never written to the database.
  try {
    const verified = await verifyWebhookSignature(signature, event);
    if (!verified) {
      log.warn(
        { eventId: event.id, eventType: event.event_type },
        "rejected webhook with an invalid signature",
      );
      return NextResponse.json({ error: "invalid signature" }, { status: 401 });
    }
  } catch (error) {
    const described = describeError(error);
    log.error({ eventId: event.id, ...described }, "webhook verification failed");

    // Config problems are ours and will not resolve on retry; verification
    // outages will. 503 asks PayPal to redeliver, 500 does not help either way
    // but at least distinguishes the two in the logs.
    const status = isAppError(error) && error.code === "CONFIG" ? 500 : 503;
    return NextResponse.json({ error: "verification unavailable" }, { status });
  }

  // ---------- RECORD ----------
  // PayPal redelivers on timeout, so the same event id can arrive repeatedly.
  // The unique index makes the insert the idempotency barrier: exactly one
  // caller gets a row back and therefore exactly one job is enqueued.
  let isNew = false;
  try {
    const inserted = await db
      .insert(webhookEvents)
      .values({
        paypalEventId: event.id,
        eventType: event.event_type,
        resourceType: event.resource_type ?? null,
        summary: event.summary ?? null,
        payload: event,
        signatureVerified: true,
      })
      .onConflictDoNothing({ target: webhookEvents.paypalEventId })
      .returning({ id: webhookEvents.id });

    isNew = inserted.length > 0;
  } catch (error) {
    log.error({ eventId: event.id, ...describeError(error) }, "failed to record webhook event");
    // The database is momentarily unavailable. Ask PayPal to send it again.
    return NextResponse.json({ error: "storage unavailable" }, { status: 503 });
  }

  if (!isNew) {
    log.info({ eventId: event.id, eventType: event.event_type }, "duplicate webhook ignored");
    return NextResponse.json({ status: "duplicate" }, { status: 200 });
  }

  // ---------- ENQUEUE ----------
  const disputeId = event.resource?.dispute_id;

  if (disputeId) {
    try {
      await enqueue(
        JOB_TYPES.INGEST_DISPUTE,
        { disputeId, webhookEventId: event.id },
        // One ingest per dispute per event, even if PayPal fans out several
        // event types for the same change.
        { dedupeKey: `ingest:${disputeId}:${event.id}` },
      );
    } catch (error) {
      log.error({ eventId: event.id, disputeId, ...describeError(error) }, "failed to enqueue");
      // The event is recorded; a reconciliation sweep can pick it up. Returning
      // 200 avoids a redelivery that would be discarded as a duplicate anyway.
    }
  } else {
    log.warn(
      { eventId: event.id, eventType: event.event_type },
      "webhook carried no dispute_id — recorded but not queued",
    );
  }

  log.info(
    { eventId: event.id, eventType: event.event_type, disputeId },
    "webhook accepted",
  );

  return NextResponse.json({ status: "accepted" }, { status: 200 });
}

// ---------- GET ----------
// Not part of the PayPal contract. Exists so you can confirm the tunnel reaches
// this route from a browser before any event is ever sent.

export async function GET() {
  return NextResponse.json({
    endpoint: "paypal-webhook",
    ready: Boolean(env.PAYPAL_WEBHOOK_ID),
    hint: env.PAYPAL_WEBHOOK_ID
      ? "Webhook id configured. Deliveries will be verified."
      : "PAYPAL_WEBHOOK_ID is not set — run `npm run paypal:webhook register`.",
  });
}
