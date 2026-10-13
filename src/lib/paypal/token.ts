import { env } from "../env";
import { AppError } from "../errors";
import { childLogger } from "../logger";

const log = childLogger("paypal.token");

// ---------- ACCESS TOKEN ----------
// PayPal issues client-credentials tokens that live about nine hours. Fetching
// one per request would roughly double every call's latency, so the token is
// cached in memory and refreshed early.

/** Refresh this far before real expiry so an in-flight request never races it. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

const TOKEN_TIMEOUT_MS = 10_000;

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

let cached: CachedToken | null = null;

/**
 * In-flight request shared by concurrent callers. Without this, a cold start
 * that handles ten requests at once would open ten identical token requests
 * and PayPal would rate-limit the lot.
 */
let inFlight: Promise<string> | null = null;

function basicAuthHeader(): string {
  const raw = `${env.PAYPAL_CLIENT_ID}:${env.PAYPAL_CLIENT_SECRET}`;
  return `Basic ${Buffer.from(raw).toString("base64")}`;
}

async function requestToken(): Promise<string> {
  const url = `${env.PAYPAL_API_BASE}/v1/oauth2/token`;
  const started = performance.now();

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: basicAuthHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (cause) {
    // Network failure or timeout. Worth retrying — the credentials may be fine.
    throw new AppError({
      code: "PAYPAL_AUTH",
      message: "Could not reach PayPal to obtain an access token",
      retryable: true,
      status: 503,
      cause,
    });
  }

  const body = (await response.json().catch(() => null)) as
    | (TokenResponse & { error?: string; error_description?: string })
    | null;

  if (!response.ok || !body?.access_token) {
    const description = body?.error_description ?? body?.error ?? response.statusText;
    throw new AppError({
      code: "PAYPAL_AUTH",
      message: `PayPal rejected the client credentials: ${description}`,
      // 401 means the credentials are wrong; retrying cannot fix that.
      retryable: response.status >= 500,
      status: response.status === 401 ? 500 : response.status,
      context: { status: response.status, debugId: response.headers.get("paypal-debug-id") },
    });
  }

  cached = {
    accessToken: body.access_token,
    expiresAt: Date.now() + body.expires_in * 1000 - EXPIRY_MARGIN_MS,
  };

  log.info(
    {
      expiresInSeconds: body.expires_in,
      durationMs: Math.round(performance.now() - started),
    },
    "obtained PayPal access token",
  );

  return cached.accessToken;
}

/** Returns a valid bearer token, reusing the cached one whenever possible. */
export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.accessToken;
  if (inFlight) return inFlight;

  inFlight = requestToken().finally(() => {
    inFlight = null;
  });

  return inFlight;
}

/**
 * Drops the cached token. Called when PayPal returns 401 on an API call, so the
 * retry fetches a fresh token instead of replaying the rejected one.
 */
export function invalidateAccessToken(): void {
  if (cached) log.warn("discarding cached PayPal access token");
  cached = null;
}
