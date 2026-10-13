import postgres from "postgres";
import { env } from "../env";
import { childLogger } from "../logger";

const log = childLogger("events.bus");

// ---------- DEDICATED CONNECTION ----------
// The event bus cannot share the application pool.
//
// Neon's pooled host runs PgBouncer in transaction pooling mode, which does
// not support LISTEN: the subscription belongs to a session, and the pooler
// reassigns that connection the moment the transaction ends. postgres.js
// reports success, and no event is ever delivered. Verified directly —
// `npm run db:notify-check` shows the pooled endpoint receiving nothing while
// the direct endpoint receives everything.
//
// Neon exposes the same database on a direct host without the -pooler suffix.
// Two connections: one held open by LISTEN, one for NOTIFY.

function directConnectionString(): string {
  return env.DATABASE_URL.replace("-pooler", "");
}

const globalForConnection = globalThis as unknown as { __rebuttalBusSql?: postgres.Sql };

const busSql: postgres.Sql = (globalForConnection.__rebuttalBusSql ??= postgres(
  directConnectionString(),
  {
    ssl: "require",
    max: 2,
    idle_timeout: 0, // the listener must never be reaped for being idle
    connect_timeout: 15,
    prepare: false,
    onnotice: () => {},
  },
));

// ---------- EVENT BUS ----------
// Postgres LISTEN/NOTIFY. The worker and the web server are separate
// processes, so an in-process emitter would never reach the browser. NOTIFY
// crosses the process boundary using the database that is already a hard
// dependency, with no broker to run.
//
// CRITICAL: exactly one LISTEN per process, fanned out in memory.
//
// postgres.js dedicates a connection to each sql.listen() call. Subscribing
// per SSE client therefore consumes one pooled connection per open browser
// tab. With a pool of five and streams that live for tens of minutes, a
// handful of tabs or hot reloads starves the pool and every query starts
// failing with CONNECT_TIMEOUT — the page goes down while the database is
// perfectly healthy.
//
// The single listener below costs one connection no matter how many clients
// are attached, and it is never torn down once established.

const CHANNEL = "rebuttal_events";

/** NOTIFY payloads are capped at 8000 bytes, so events carry ids, not objects. */
const MAX_PAYLOAD_BYTES = 7000;

export type EventType =
  | "dispute.ingested"
  | "dispute.updated"
  | "packet.queued"
  | "packet.retrieving"
  | "packet.drafting"
  | "packet.drafted"
  | "packet.failed"
  | "packet.submitted"
  | "job.dead";

export interface RebuttalEvent {
  type: EventType;
  disputeId?: string;
  packetId?: string;
  /** Short, human-readable line for the activity log in the UI. */
  message?: string;
  at: string;
}

export type EventHandler = (event: RebuttalEvent) => void;

// ---------- PUBLISH ----------

export async function publish(event: Omit<RebuttalEvent, "at">): Promise<void> {
  const payload = JSON.stringify({ ...event, at: new Date().toISOString() });

  if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
    log.warn({ type: event.type }, "event payload too large, dropping message field");
    await publish({ ...event, message: undefined });
    return;
  }

  try {
    await busSql.notify(CHANNEL, payload);
  } catch (error) {
    // Telemetry must never break the pipeline that emits it.
    log.warn({ type: event.type, err: error }, "failed to publish event");
  }
}

// ---------- SHARED LISTENER ----------
// Survives across HMR reloads in development for the same reason the database
// pool does: without the global cache, every edit would open another listener
// and leak its connection.

const globalForBus = globalThis as unknown as {
  __rebuttalHandlers?: Set<EventHandler>;
  __rebuttalListening?: Promise<void>;
};

const handlers: Set<EventHandler> = (globalForBus.__rebuttalHandlers ??= new Set());

function broadcast(raw: string): void {
  let event: RebuttalEvent;
  try {
    event = JSON.parse(raw) as RebuttalEvent;
  } catch {
    log.warn({ raw: raw.slice(0, 200) }, "received an unparseable event");
    return;
  }

  for (const handler of handlers) {
    // One misbehaving subscriber must not stop the others receiving the event.
    try {
      handler(event);
    } catch (error) {
      log.warn({ err: error }, "event handler threw");
    }
  }
}

function startListening(): Promise<void> {
  return busSql
    .listen(
      CHANNEL,
      broadcast,
      // onlisten fires on first connect and again after postgres.js
      // transparently reconnects a dropped listener.
      () => log.info({ channel: CHANNEL, subscribers: handlers.size }, "listening for events"),
    )
    .then(() => undefined)
    .catch((error) => {
      // Clear the cached promise so the next subscriber retries rather than
      // awaiting a rejection forever.
      globalForBus.__rebuttalListening = undefined;
      log.error({ err: error }, "failed to start event listener");
      throw error;
    });
}

export interface Subscription {
  unsubscribe: () => void;
}

/**
 * Attaches a handler to the shared stream.
 *
 * Unsubscribing removes the handler but deliberately leaves the underlying
 * LISTEN open. Churning the connection on every page navigation costs more
 * than holding one idle listener for the life of the process.
 */
export async function subscribe(onEvent: EventHandler): Promise<Subscription> {
  handlers.add(onEvent);

  globalForBus.__rebuttalListening ??= startListening();

  try {
    await globalForBus.__rebuttalListening;
  } catch (error) {
    handlers.delete(onEvent);
    throw error;
  }

  return {
    unsubscribe: () => {
      handlers.delete(onEvent);
    },
  };
}

/** Exposed for the health endpoint. */
export function subscriberCount(): number {
  return handlers.size;
}
