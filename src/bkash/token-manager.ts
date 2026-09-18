import { NetworkError, RateLimitError } from "../core/errors.ts";
import { type Logger, noopLogger, requestJson } from "../core/http.ts";
import { MemoryTokenStore, type TokenRecord, type TokenStore } from "../core/token-store.ts";
import { endpoints, type ResolvedBkashConfig } from "./config.ts";
import { BkashError, toBkashError } from "./errors.ts";
import type { GrantTokenResponse } from "./types.ts";

const HOUR_MS = 60 * 60 * 1000;

/**
 * Total token acquisitions allowed per rolling hour before this refuses to call
 * bKash at all. A healthy integration needs one or two; hitting ten means
 * something is looping, and the cheap failure here is far better than the
 * expensive one at bKash, which is an hour-long block on the merchant account.
 */
const ACQUISITION_CIRCUIT_BREAKER = 10;

/**
 * Keeps exactly one valid bKash access token alive.
 *
 * The constraint worth knowing: bKash blocks the merchant account for an hour
 * if the Refresh Token API is called more than twice within an hour. The budget
 * belongs to the merchant account, not to your process, so:
 *
 *   - refreshes are counted in a rolling window and capped;
 *   - when the refresh budget runs out, a fresh Grant is used instead, which
 *     bKash's own token guide names as the alternative;
 *   - concurrent callers share one in-flight acquisition rather than each
 *     starting their own;
 *   - the count lives in the TokenStore, so a shared store makes it correct
 *     across instances. The default in-process store does not.
 */
export class BkashTokenManager {
  readonly #config: ResolvedBkashConfig;
  readonly #store: TokenStore;
  readonly #logger: Logger;
  readonly #urls: ReturnType<typeof endpoints>;
  #inFlight: Promise<string> | null = null;

  constructor(config: ResolvedBkashConfig, options: { store?: TokenStore; logger?: Logger } = {}) {
    this.#config = config;
    this.#store = options.store ?? new MemoryTokenStore();
    this.#logger = options.logger ?? noopLogger;
    this.#urls = endpoints(config.origin);
  }

  /** A token that is valid now, acquiring one only if the cached one will not do. */
  async getToken(): Promise<string> {
    const record = await this.#store.get(this.#config.tokenKey);
    if (record && !this.#needsRefresh(record)) return record.idToken;

    // One acquisition per process at a time, however many callers are waiting.
    this.#inFlight ??= this.#acquire(record).finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /**
   * Drop the cached token so the next call acquires a new one. Use this when
   * bKash answers 401 — it means the token died earlier than advertised.
   */
  async invalidate(): Promise<void> {
    const record = await this.#store.get(this.#config.tokenKey);
    if (!record) return;
    // Keep the acquisition history: the rate budget must survive invalidation,
    // otherwise a 401 loop would clear its own circuit breaker.
    await this.#store.set(this.#config.tokenKey, { ...record, expiresAt: 0 });
  }

  /** What the budget looks like right now. Useful for a health endpoint. */
  async budget(): Promise<{ refreshesUsed: number; refreshesAllowed: number; acquisitionsUsed: number }> {
    const record = await this.#store.get(this.#config.tokenKey);
    const now = Date.now();
    return {
      refreshesUsed: withinWindow(record?.refreshes, now).length,
      refreshesAllowed: this.#config.maxRefreshesPerHour,
      acquisitionsUsed: withinWindow(record?.acquisitions, now).length,
    };
  }

  #needsRefresh(record: TokenRecord): boolean {
    return Date.now() >= record.expiresAt - this.#config.refreshSkewMs;
  }

  async #acquire(cached: TokenRecord | null): Promise<string> {
    const run = async (): Promise<string> => {
      // Re-read under the lock: another instance may have just done this.
      const current = await this.#store.get(this.#config.tokenKey);
      if (current && !this.#needsRefresh(current)) return current.idToken;

      const record = current ?? cached;
      const now = Date.now();
      const acquisitions = withinWindow(record?.acquisitions, now);
      const refreshes = withinWindow(record?.refreshes, now);

      if (acquisitions.length >= ACQUISITION_CIRCUIT_BREAKER) {
        const retryAt = (acquisitions[0] ?? now) + HOUR_MS;
        throw new RateLimitError(
          `bKash: ${acquisitions.length} token acquisitions in the last hour, which is past the safety ceiling. ` +
            `Refusing to call bKash again until ${new Date(retryAt).toISOString()} — going further risks an ` +
            `hour-long block on the merchant account. This usually means a retry loop, or a per-request client ` +
            `instance with no shared token store.`,
          { provider: "bkash", code: "token_circuit_open", retryAt },
        );
      }

      const canRefresh = record?.refreshToken && refreshes.length < this.#config.maxRefreshesPerHour;
      if (record?.refreshToken && !canRefresh) {
        this.#logger.warn("paykit/bkash: refresh budget spent this hour, granting a new token instead", {
          refreshesUsed: refreshes.length,
          allowed: this.#config.maxRefreshesPerHour,
        });
      }

      const response = canRefresh
        ? await this.#call(this.#urls.refreshToken, {
            app_key: this.#config.appKey,
            app_secret: this.#config.appSecret,
            refresh_token: record.refreshToken,
          })
        : await this.#call(this.#urls.grantToken, {
            app_key: this.#config.appKey,
            app_secret: this.#config.appSecret,
          });

      if (!response.id_token) {
        throw new BkashError({
          code: response.statusCode ?? "no_token",
          message: `bKash returned no id_token: ${response.statusMessage ?? "no status message"}`,
          raw: response,
        });
      }

      const lifetimeMs = (Number(response.expires_in) || 3600) * 1000;
      const next: TokenRecord = {
        idToken: response.id_token,
        refreshToken: response.refresh_token ?? record?.refreshToken ?? "",
        expiresAt: Date.now() + lifetimeMs,
        acquisitions: [...acquisitions, Date.now()],
        refreshes: canRefresh ? [...refreshes, Date.now()] : refreshes,
      };
      await this.#store.set(this.#config.tokenKey, next);

      this.#logger.debug("paykit/bkash: token acquired", {
        method: canRefresh ? "refresh" : "grant",
        expiresInSeconds: Math.round(lifetimeMs / 1000),
        refreshesUsedThisHour: next.refreshes.length,
      });

      return next.idToken;
    };

    return this.#store.withLock
      ? this.#store.withLock(this.#config.tokenKey, 15_000, run)
      : run();
  }

  async #call(url: string, body: Record<string, string>): Promise<GrantTokenResponse> {
    const { body: parsed, status } = await requestJson<GrantTokenResponse>(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          username: this.#config.username,
          password: this.#config.password,
        },
        json: body,
        timeoutMs: this.#config.timeoutMs,
        // Token acquisition moves no money, but it does spend budget, so retry
        // transport failures only, and only once.
        retries: 1,
      },
      { provider: "bkash", logger: this.#logger },
    );

    const error = toBkashError(parsed, status);
    if (error) {
      if (error instanceof NetworkError) throw error;
      throw error;
    }
    return parsed;
  }
}

function withinWindow(timestamps: number[] | undefined, now: number): number[] {
  return (timestamps ?? []).filter((t) => now - t < HOUR_MS).sort((a, b) => a - b);
}
