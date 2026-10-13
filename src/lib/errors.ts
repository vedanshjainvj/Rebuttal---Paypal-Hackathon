// ---------- ERROR TAXONOMY ----------
// Every failure in the system is one of these. The distinction that matters
// most is `retryable`: the job worker reschedules a retryable failure and
// dead-letters everything else, so getting this flag right is what stops a
// permanently malformed job from burning retries forever.

export type ErrorCode =
  | "CONFIG"
  | "DB"
  | "PAYPAL_AUTH"
  | "PAYPAL_REQUEST"
  | "PAYPAL_RATE_LIMIT"
  | "WEBHOOK_SIGNATURE"
  | "AI_PROVIDER"
  | "AI_RATE_LIMIT"
  | "AI_MALFORMED_OUTPUT"
  | "UNGROUNDED_CLAIM"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "INTERNAL";

export interface AppErrorOptions {
  code: ErrorCode;
  message: string;
  /** Whether a retry could plausibly succeed. Drives job rescheduling. */
  retryable?: boolean;
  /** HTTP status to use if this error reaches a route handler. */
  status?: number;
  /** Structured detail for logs. Never rendered to an end user. */
  context?: Record<string, unknown>;
  cause?: unknown;
  /** Honour an upstream Retry-After, in milliseconds. */
  retryAfterMs?: number;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;
  readonly context: Record<string, unknown>;
  readonly retryAfterMs?: number;

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "AppError";
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? 500;
    this.context = options.context ?? {};
    this.retryAfterMs = options.retryAfterMs;
    Error.captureStackTrace?.(this, AppError);
  }

  /** Safe to return over HTTP — carries no internal context. */
  toPublicJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

// ---------- CONSTRUCTORS ----------
// Named helpers so call sites stay short and the retryable flag is decided
// once, here, rather than guessed at each throw site.

export const configError = (message: string, context?: Record<string, unknown>) =>
  new AppError({ code: "CONFIG", message, retryable: false, status: 500, context });

export const dbError = (message: string, cause?: unknown) =>
  new AppError({ code: "DB", message, retryable: true, status: 503, cause });

export const notFound = (what: string, context?: Record<string, unknown>) =>
  new AppError({ code: "NOT_FOUND", message: `${what} not found`, status: 404, context });

export const validationError = (message: string, context?: Record<string, unknown>) =>
  new AppError({ code: "VALIDATION", message, retryable: false, status: 400, context });

export const conflictError = (message: string, context?: Record<string, unknown>) =>
  new AppError({ code: "CONFLICT", message, retryable: false, status: 409, context });

export const webhookSignatureError = (message: string, context?: Record<string, unknown>) =>
  new AppError({
    code: "WEBHOOK_SIGNATURE",
    message,
    retryable: false,
    status: 401,
    context,
  });

export const ungroundedClaimError = (message: string, context?: Record<string, unknown>) =>
  new AppError({
    code: "UNGROUNDED_CLAIM",
    message,
    // Regenerating can land a grounded draft, so this is worth one more pass.
    retryable: true,
    status: 422,
    context,
  });

// ---------- CLASSIFICATION ----------

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Unknown throwables are treated as non-retryable to avoid retry storms. */
export function isRetryable(error: unknown): boolean {
  return isAppError(error) ? error.retryable : false;
}

export function toAppError(error: unknown, fallbackMessage = "Unexpected error"): AppError {
  if (isAppError(error)) return error;
  return new AppError({
    code: "INTERNAL",
    message: error instanceof Error ? error.message : fallbackMessage,
    retryable: false,
    cause: error,
  });
}

/** Loggable shape — never includes the stack of a nested cause chain verbatim. */
export function describeError(error: unknown): Record<string, unknown> {
  const e = toAppError(error);
  return {
    code: e.code,
    message: e.message,
    retryable: e.retryable,
    status: e.status,
    context: e.context,
  };
}
