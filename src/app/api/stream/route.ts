import { subscribe } from "@/lib/events/bus";
import { childLogger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = childLogger("api.stream");

// ---------- SERVER-SENT EVENTS ----------
// Bridges worker events to the browser.
//
// SSE rather than WebSockets: the data flows one way, EventSource reconnects
// by itself, and it survives proxies that mishandle upgrade requests — which
// includes the tunnel this runs behind in development.

/** Below the 30s idle timeout most proxies apply to a quiet connection. */
const HEARTBEAT_MS = 25_000;

/**
 * Hard lifetime. A tab left open overnight, or a client that vanished without
 * the runtime firing `abort`, would otherwise hold its stream indefinitely.
 * Closing on purpose is safe: EventSource reconnects on its own, so the user
 * sees nothing.
 */
const MAX_STREAM_MS = 10 * 60 * 1000;

export async function GET(request: Request) {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let lifetime: ReturnType<typeof setTimeout> | undefined;
      let unsubscribe: (() => void) | undefined;

      const send = (payload: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // The client went away mid-write. Tear down rather than looping.
          closed = true;
          cleanup();
        }
      };

      const cleanup = () => {
        if (heartbeat) clearInterval(heartbeat);
        if (lifetime) clearTimeout(lifetime);
        unsubscribe?.();
        if (!closed) closed = true;
        try {
          controller.close();
        } catch {
          /* already closed by the runtime */
        }
      };

      try {
        send(`: connected\n\n`);
        send(`event: ready\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);

        // Attaches to the process-wide listener; costs no extra connection.
        const subscription = await subscribe((event) => {
          send(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        unsubscribe = subscription.unsubscribe;

        // Comment frames keep the connection alive without reaching any
        // EventSource listener, so the client stays connected and sees nothing.
        heartbeat = setInterval(() => send(`: ping\n\n`), HEARTBEAT_MS);
        lifetime = setTimeout(() => {
          log.debug("stream reached its lifetime cap, closing for reconnect");
          cleanup();
        }, MAX_STREAM_MS);

        request.signal.addEventListener("abort", cleanup);
      } catch (error) {
        // The database is unreachable. Tell the client plainly and close
        // instead of holding a stream that can never deliver anything.
        log.error({ err: error }, "could not attach to the event bus");
        send(`event: unavailable\ndata: ${JSON.stringify({ reason: "event bus unavailable" })}\n\n`);
        cleanup();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tells nginx-style proxies not to buffer, which would batch every
      // event into one delivery at the end of the stream.
      "x-accel-buffering": "no",
    },
  });
}
