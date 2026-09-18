import { NetworkError } from "./errors.ts";

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export const noopLogger: Logger = {
  debug() {},
  warn() {},
  error() {},
};

export interface HttpResponse<T> {
  status: number;
  headers: Headers;
  body: T;
  text: string;
}

export interface RequestOptions {
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  /** Serialised as JSON. Omit for GET. */
  json?: unknown;
  /** Per-request timeout. Default 30s — bKash PIN flows are genuinely slow. */
  timeoutMs?: number;
  /**
   * Retry count for transport failures and 5xx.
   *
   * Defaults to 0 and should stay 0 for anything that moves money. A create or
   * execute call that times out may still have succeeded at the gateway, so the
   * safe recovery is to query the payment, not to fire it again.
   */
  retries?: number;
  /** Base backoff in ms; each attempt waits base * 2^n plus jitter. */
  retryBaseMs?: number;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Headers whose values must never reach a log line. */
const SECRET_HEADERS = new Set(["authorization", "password", "username", "x-app-key", "x-app-secret"]);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SECRET_HEADERS.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return out;
}

/**
 * JSON-over-HTTP with a timeout, optional bounded retry and no dependencies.
 *
 * Resolves for any HTTP status that produced a parseable JSON body, including
 * 4xx — gateways signal business errors with a 200 and an errorCode as often as
 * with a status, so status interpretation belongs to the caller. Throws only
 * when there is no usable answer at all.
 */
export async function requestJson<T = unknown>(
  url: string,
  options: RequestOptions = {},
  ctx: { provider: string; logger?: Logger } = { provider: "paykit" },
): Promise<HttpResponse<T>> {
  const {
    method = "POST",
    headers = {},
    json,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = 0,
    retryBaseMs = 300,
    signal,
  } = options;
  const logger = ctx.logger ?? noopLogger;

  const requestHeaders: Record<string, string> = { Accept: "application/json", ...headers };
  let payload: string | undefined;
  if (json !== undefined) {
    payload = JSON.stringify(json);
    requestHeaders["Content-Type"] ??= "application/json";
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = retryBaseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * retryBaseMs);
      logger.warn("paykit: retrying request", { url, attempt, delay });
      await sleep(delay, signal);
    }

    try {
      const response = await fetch(url, {
        method,
        headers: requestHeaders,
        body: payload,
        signal: mergeSignals(signal, AbortSignal.timeout(timeoutMs)),
      });

      const text = await response.text();

      if (response.status >= 500) {
        lastError = new NetworkError(`${ctx.provider}: gateway returned HTTP ${response.status}`, {
          provider: ctx.provider,
          code: "upstream_error",
          status: response.status,
          raw: text.slice(0, 2000),
        });
        if (attempt < retries) continue;
        throw lastError;
      }

      let body: T;
      try {
        body = text ? (JSON.parse(text) as T) : ({} as T);
      } catch (cause) {
        throw new NetworkError(
          `${ctx.provider}: expected JSON but got ${describeBody(text)} (HTTP ${response.status})`,
          { provider: ctx.provider, code: "invalid_json", status: response.status, raw: text.slice(0, 2000), cause },
        );
      }

      logger.debug("paykit: request complete", {
        url,
        method,
        status: response.status,
        headers: redactHeaders(requestHeaders),
      });

      return { status: response.status, headers: response.headers, body, text };
    } catch (error) {
      if (error instanceof NetworkError && error.code === "invalid_json") throw error;
      lastError = error;
      const aborted = signal?.aborted === true;
      if (aborted || attempt >= retries) {
        if (error instanceof NetworkError) throw error;
        throw new NetworkError(`${ctx.provider}: request to ${url} failed`, {
          provider: ctx.provider,
          code: isTimeout(error) ? "timeout" : "network_error",
          cause: error,
        });
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new NetworkError(`${ctx.provider}: request to ${url} failed`, { provider: ctx.provider });
}

function describeBody(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "an empty body";
  if (trimmed.startsWith("<")) return "HTML (usually a proxy or WAF page)";
  return `${JSON.stringify(trimmed.slice(0, 80))}…`;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function mergeSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  return present.length === 1 ? present[0]! : AbortSignal.any(present);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
