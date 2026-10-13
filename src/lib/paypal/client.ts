import { randomUUID } from "node:crypto";
import { env } from "../env";
import { AppError } from "../errors";
import { childLogger } from "../logger";
import { getAccessToken, invalidateAccessToken } from "./token";
import type { PayPalErrorBody } from "./types";

const log = childLogger("paypal.client");

// ---------- REQUEST POLICY ----------

const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 8_000;

/** Statuses where another attempt is plausible. 4xx other than 429 is not. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  query?: Record<string, string | number | boolean | undefined>;
  /** Serialised as JSON. Mutually exclusive with `form`. */
  body?: unknown;
  /** Sent as multipart/form-data. Used by the evidence upload endpoints. */
  form?: FormData;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Makes a retried POST safe to replay. PayPal honours this header on
   * dispute actions, so a network timeout cannot produce a double submission.
   */
  idempotencyKey?: string;
  maxAttempts?: number;
}

export interface PayPalResponse<T> {
  data: T;
  status: number;
  /** PayPal's correlation id. Quote it verbatim in any support request. */
  debugId: string | null;
}

// ---------- HELPERS ----------

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(path.startsWith("http") ? path : `${env.PAYPAL_API_BASE}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

/** Exponential backoff with full jitter, so concurrent retries do not align. */
function backoffDelay(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, MAX_BACKOFF_MS);
  const ceiling = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  return Math.round(Math.random() * ceiling);
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function describePayPalError(body: PayPalErrorBody | null, status: number): string {
  if (!body) return `PayPal returned HTTP ${status}`;
  const detail = body.details?.[0];
  const specifics = detail
    ? ` (${detail.issue ?? detail.field ?? ""}${detail.description ? `: ${detail.description}` : ""})`
    : "";
  return `${body.name ?? "PayPal error"}: ${body.message ?? `HTTP ${status}`}${specifics}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- CORE REQUEST ----------

/**
 * Single entry point for every PayPal call. Handles auth, retries, backoff,
 * timeouts and error mapping so the endpoint wrappers stay declarative.
 */
export async function payPalRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<PayPalResponse<T>> {
  const method = options.method ?? "GET";
  const url = buildUrl(path, options.query);
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;
  const requestId = randomUUID();

  let lastError: AppError | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const token = await getAccessToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...options.headers,
    };

    // FormData sets its own multipart boundary; setting Content-Type by hand
    // omits the boundary and PayPal rejects the body.
    if (options.body !== undefined && !options.form) {
      headers["Content-Type"] = "application/json";
    }
    if (options.idempotencyKey) {
      headers["PayPal-Request-Id"] = options.idempotencyKey;
    }

    const started = performance.now();
    let response: Response;

    try {
      response = await fetch(url, {
        method,
        headers,
        body: options.form ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (cause) {
      lastError = new AppError({
        code: "PAYPAL_REQUEST",
        message: `Network failure calling PayPal ${method} ${path}`,
        retryable: true,
        status: 503,
        context: { attempt, requestId },
        cause,
      });
      if (attempt < maxAttempts) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    }

    const debugId = response.headers.get("paypal-debug-id");
    const durationMs = Math.round(performance.now() - started);

    // 204 and empty bodies are legitimate for several dispute actions.
    const text = await response.text();
    const data = text ? (JSON.parse(text) as unknown) : null;

    if (response.ok) {
      log.debug({ method, path, status: response.status, durationMs, debugId, requestId }, "paypal ok");
      return { data: data as T, status: response.status, debugId };
    }

    // An expired or revoked token: drop it so the next attempt re-authenticates.
    if (response.status === 401) {
      invalidateAccessToken();
      lastError = new AppError({
        code: "PAYPAL_AUTH",
        message: `PayPal rejected the access token on ${method} ${path}`,
        retryable: attempt < maxAttempts,
        status: 500,
        context: { attempt, debugId, requestId },
      });
      if (attempt < maxAttempts) {
        await sleep(backoffDelay(attempt));
        continue;
      }
      throw lastError;
    }

    const errorBody = data as PayPalErrorBody | null;
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    const retryable = RETRYABLE_STATUSES.has(response.status);

    lastError = new AppError({
      code: response.status === 429 ? "PAYPAL_RATE_LIMIT" : "PAYPAL_REQUEST",
      message: describePayPalError(errorBody, response.status),
      retryable,
      status: response.status,
      retryAfterMs,
      context: {
        method,
        path,
        status: response.status,
        debugId,
        requestId,
        attempt,
        details: errorBody?.details,
      },
    });

    if (!retryable || attempt === maxAttempts) {
      log.error(
        { method, path, status: response.status, debugId, requestId, durationMs },
        "paypal request failed",
      );
      throw lastError;
    }

    const delay = backoffDelay(attempt, retryAfterMs);
    log.warn(
      { method, path, status: response.status, debugId, requestId, attempt, delay },
      "paypal request failed, retrying",
    );
    await sleep(delay);
  }

  throw lastError ?? new AppError({ code: "PAYPAL_REQUEST", message: "PayPal request failed" });
}
