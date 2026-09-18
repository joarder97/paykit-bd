/**
 * Every error this library throws is a PaykitError, so a caller can write one
 * catch block and still tell a declined payment apart from a dead socket.
 */
export abstract class PaykitError extends Error {
  /** Gateway this came from — `"bkash"`, or `"paykit"` for local failures. */
  readonly provider: string;
  /** Stable machine-readable code. Gateway codes are passed through verbatim. */
  readonly code: string;
  /** True when retrying the identical request could plausibly succeed. */
  readonly retryable: boolean;
  /** Untouched gateway response body, for logging. */
  readonly raw: unknown;

  protected constructor(
    message: string,
    opts: { provider: string; code: string; retryable?: boolean; raw?: unknown; cause?: unknown },
  ) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.provider = opts.provider;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.raw = opts.raw;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      provider: this.provider,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}

/** The gateway answered, and the answer was an error. `code` is its own code. */
export class ProviderError extends PaykitError {
  constructor(
    message: string,
    opts: { provider: string; code: string; retryable?: boolean; raw?: unknown; cause?: unknown },
  ) {
    super(message, opts);
  }
}

/** The request never produced a usable answer: DNS, TLS, timeout, 5xx, bad JSON. */
export class NetworkError extends PaykitError {
  /** HTTP status, when there was one. */
  readonly status?: number;

  constructor(
    message: string,
    opts: { provider: string; code?: string; status?: number; raw?: unknown; cause?: unknown },
  ) {
    super(message, {
      provider: opts.provider,
      code: opts.code ?? "network_error",
      retryable: true,
      raw: opts.raw,
      cause: opts.cause,
    });
    this.status = opts.status;
  }
}

/** Something is wrong with how the client was constructed or configured. */
export class ConfigError extends PaykitError {
  constructor(message: string, opts: { provider?: string; code?: string } = {}) {
    super(message, {
      provider: opts.provider ?? "paykit",
      code: opts.code ?? "config_error",
      retryable: false,
    });
  }
}

/**
 * An inbound webhook did not prove it came from the gateway. Never treat the
 * payload as real after this — it is an unauthenticated stranger's JSON.
 */
export class WebhookVerificationError extends PaykitError {
  constructor(message: string, opts: { provider: string; code?: string; raw?: unknown; cause?: unknown }) {
    super(message, {
      provider: opts.provider,
      code: opts.code ?? "webhook_verification_failed",
      retryable: false,
      raw: opts.raw,
      cause: opts.cause,
    });
  }
}

/**
 * A local guard stopped a call before it left the process — the refresh-token
 * budget being the one that matters in practice.
 */
export class RateLimitError extends PaykitError {
  /** Epoch ms when the guard will let the call through. */
  readonly retryAt?: number;

  constructor(message: string, opts: { provider: string; code?: string; retryAt?: number }) {
    super(message, {
      provider: opts.provider,
      code: opts.code ?? "rate_limited",
      retryable: true,
    });
    this.retryAt = opts.retryAt;
  }
}
