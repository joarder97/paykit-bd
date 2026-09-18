/**
 * Every error this library throws is a PaykitError, so a caller can write one
 * catch block and still tell a declined payment apart from a dead socket.
 *
 * `instanceof` is answered from a brand rather than from the prototype chain,
 * and that is deliberate. This package ships several entry points — `paykit-bd`,
 * `paykit-bd/bkash`, `paykit-bd/bkash/next` — and each is a separate bundle
 * carrying its own copy of these classes. A plain `instanceof` compares class
 * identity, so an error thrown by the bkash client would *not* match the class
 * imported from the root entry. It would fail silently, which in a payment
 * library means a customer's declined PIN handled as an unknown error. The
 * brand also holds when two versions of this package end up installed at once,
 * or across a worker boundary, where plain `instanceof` fails for the same
 * reason.
 */

const BRANDS: unique symbol = Symbol.for("paykit-bd.error.brands");

/**
 * Brands are string literals rather than `constructor.name` so the check keeps
 * working after a consumer's minifier has renamed the classes.
 */
function brandedInstanceOf(tag: string): (value: unknown) => boolean {
  return (value: unknown): boolean => {
    if (typeof value !== "object" || value === null) return false;
    const brands = (value as Record<PropertyKey, unknown>)[BRANDS];
    return Array.isArray(brands) && brands.includes(tag);
  };
}

export abstract class PaykitError extends Error {
  static override [Symbol.hasInstance] = brandedInstanceOf("PaykitError");

  /** Class lineage, innermost last. Read `instanceof` instead of this. */
  readonly [BRANDS]: readonly string[];

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
    brands: readonly string[] = [],
  ) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this[BRANDS] = ["PaykitError", ...brands];
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
  static override [Symbol.hasInstance] = brandedInstanceOf("ProviderError");

  constructor(
    message: string,
    opts: { provider: string; code: string; retryable?: boolean; raw?: unknown; cause?: unknown },
    brands: readonly string[] = [],
  ) {
    super(message, opts, ["ProviderError", ...brands]);
  }
}

/** The request never produced a usable answer: DNS, TLS, timeout, 5xx, bad JSON. */
export class NetworkError extends PaykitError {
  static override [Symbol.hasInstance] = brandedInstanceOf("NetworkError");

  /** HTTP status, when there was one. */
  readonly status?: number;

  constructor(
    message: string,
    opts: { provider: string; code?: string; status?: number; raw?: unknown; cause?: unknown },
  ) {
    super(
      message,
      {
        provider: opts.provider,
        code: opts.code ?? "network_error",
        retryable: true,
        raw: opts.raw,
        cause: opts.cause,
      },
      ["NetworkError"],
    );
    this.status = opts.status;
  }
}

/** Something is wrong with how the client was constructed or configured. */
export class ConfigError extends PaykitError {
  static override [Symbol.hasInstance] = brandedInstanceOf("ConfigError");

  constructor(message: string, opts: { provider?: string; code?: string } = {}) {
    super(
      message,
      {
        provider: opts.provider ?? "paykit",
        code: opts.code ?? "config_error",
        retryable: false,
      },
      ["ConfigError"],
    );
  }
}

/**
 * An inbound webhook did not prove it came from the gateway. Never treat the
 * payload as real after this — it is an unauthenticated stranger's JSON.
 */
export class WebhookVerificationError extends PaykitError {
  static override [Symbol.hasInstance] = brandedInstanceOf("WebhookVerificationError");

  constructor(message: string, opts: { provider: string; code?: string; raw?: unknown; cause?: unknown }) {
    super(
      message,
      {
        provider: opts.provider,
        code: opts.code ?? "webhook_verification_failed",
        retryable: false,
        raw: opts.raw,
        cause: opts.cause,
      },
      ["WebhookVerificationError"],
    );
  }
}

/**
 * A local guard stopped a call before it left the process — the refresh-token
 * budget being the one that matters in practice.
 */
export class RateLimitError extends PaykitError {
  static override [Symbol.hasInstance] = brandedInstanceOf("RateLimitError");

  /** Epoch ms when the guard will let the call through. */
  readonly retryAt?: number;

  constructor(message: string, opts: { provider: string; code?: string; retryAt?: number }) {
    super(
      message,
      {
        provider: opts.provider,
        code: opts.code ?? "rate_limited",
        retryable: true,
      },
      ["RateLimitError"],
    );
    this.retryAt = opts.retryAt;
  }
}

/**
 * Brand an error class defined outside this module, so a gateway's own error
 * type takes part in the same `instanceof` scheme.
 */
export function brandCheckFor(tag: string): (value: unknown) => boolean {
  return brandedInstanceOf(tag);
}
