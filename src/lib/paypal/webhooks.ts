import { env } from "../env";
import { AppError, configError, webhookSignatureError } from "../errors";
import { childLogger } from "../logger";
import { payPalRequest } from "./client";
import {
  DISPUTE_WEBHOOK_EVENTS,
  type PayPalWebhookEvent,
  type WebhookRegistration,
  type WebhookSignatureHeaders,
} from "./types";

const log = childLogger("paypal.webhooks");

// ---------- HEADER EXTRACTION ----------

const HEADER_NAMES = {
  transmissionId: "paypal-transmission-id",
  transmissionTime: "paypal-transmission-time",
  transmissionSig: "paypal-transmission-sig",
  certUrl: "paypal-cert-url",
  authAlgo: "paypal-auth-algo",
} as const;

/**
 * Pulls the five signature headers off a request. Returns null when any are
 * missing, which means the caller is not PayPal.
 */
export function extractSignatureHeaders(headers: Headers): WebhookSignatureHeaders | null {
  const values: Partial<WebhookSignatureHeaders> = {};

  for (const [key, header] of Object.entries(HEADER_NAMES) as Array<
    [keyof WebhookSignatureHeaders, string]
  >) {
    const value = headers.get(header);
    if (!value) {
      log.warn({ missingHeader: header }, "webhook request is missing a signature header");
      return null;
    }
    values[key] = value;
  }

  return values as WebhookSignatureHeaders;
}

// ---------- CERT URL GUARD ----------
// The cert URL arrives from the caller. Fetching or trusting an arbitrary host
// is a known attack against naive webhook verifiers, so the host is pinned to
// PayPal before the value is used, even though PayPal's own API also checks it.

const ALLOWED_CERT_HOSTS = /(^|\.)paypal\.com$/i;

function certUrlIsTrusted(certUrl: string): boolean {
  try {
    const url = new URL(certUrl);
    return url.protocol === "https:" && ALLOWED_CERT_HOSTS.test(url.hostname);
  } catch {
    return false;
  }
}

// ---------- VERIFICATION ----------

interface VerifyResponse {
  verification_status: "SUCCESS" | "FAILURE";
}

/**
 * Verifies a delivery through PayPal's verify-webhook-signature endpoint.
 *
 * Deliberately chosen over local RSA verification: the local route requires
 * fetching and chain-validating PayPal's certificate, CRC32 of the exact raw
 * body, and precise signature-string assembly. Each is easy to get subtly
 * wrong in a way that silently accepts forged events. One extra round trip is
 * a fair price for an authoritative answer.
 */
export async function verifyWebhookSignature(
  signature: WebhookSignatureHeaders,
  event: PayPalWebhookEvent,
): Promise<boolean> {
  if (!env.PAYPAL_WEBHOOK_ID) {
    throw configError(
      "PAYPAL_WEBHOOK_ID is not set — webhook deliveries cannot be verified. " +
        "Register the webhook with `npm run paypal:webhook:register` and copy the id into .env.",
    );
  }

  if (!certUrlIsTrusted(signature.certUrl)) {
    throw webhookSignatureError("Webhook certificate URL is not a PayPal host", {
      certUrl: signature.certUrl,
    });
  }

  try {
    const { data } = await payPalRequest<VerifyResponse>(
      "/v1/notifications/verify-webhook-signature",
      {
        method: "POST",
        body: {
          auth_algo: signature.authAlgo,
          cert_url: signature.certUrl,
          transmission_id: signature.transmissionId,
          transmission_sig: signature.transmissionSig,
          transmission_time: signature.transmissionTime,
          webhook_id: env.PAYPAL_WEBHOOK_ID,
          webhook_event: event,
        },
      },
    );

    const verified = data?.verification_status === "SUCCESS";
    if (!verified) {
      log.warn(
        { eventId: event.id, eventType: event.event_type },
        "PayPal reported the webhook signature as invalid",
      );
    }
    return verified;
  } catch (error) {
    // A verification outage must not be read as "signature valid". Surface it
    // and let the route decide; failing closed is the only safe default.
    if (error instanceof AppError) throw error;
    throw new AppError({
      code: "WEBHOOK_SIGNATURE",
      message: "Webhook signature verification could not be completed",
      retryable: true,
      status: 503,
      cause: error,
    });
  }
}

// ---------- REGISTRATION ----------

export async function listWebhooks(): Promise<WebhookRegistration[]> {
  const { data } = await payPalRequest<{ webhooks?: WebhookRegistration[] }>(
    "/v1/notifications/webhooks",
  );
  return data?.webhooks ?? [];
}

export async function createWebhook(url: string): Promise<WebhookRegistration> {
  const { data } = await payPalRequest<WebhookRegistration>("/v1/notifications/webhooks", {
    method: "POST",
    body: {
      url,
      event_types: DISPUTE_WEBHOOK_EVENTS.map((name) => ({ name })),
    },
  });
  log.info({ webhookId: data.id, url }, "registered webhook");
  return data;
}

export async function deleteWebhook(webhookId: string): Promise<void> {
  await payPalRequest(`/v1/notifications/webhooks/${encodeURIComponent(webhookId)}`, {
    method: "DELETE",
  });
  log.info({ webhookId }, "deleted webhook");
}

/**
 * Registers `url`, replacing any existing registration for the same URL.
 * PayPal rejects duplicates, and a stale tunnel URL from a previous session is
 * the usual cause of a webhook that silently stops arriving.
 */
export async function ensureWebhook(url: string): Promise<WebhookRegistration> {
  const existing = await listWebhooks();
  const match = existing.find((w) => w.url === url);
  if (match) {
    log.info({ webhookId: match.id, url }, "webhook already registered");
    return match;
  }
  return createWebhook(url);
}
