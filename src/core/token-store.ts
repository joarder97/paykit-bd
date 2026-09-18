/**
 * Where an access token lives between requests.
 *
 * This matters more than it looks. bKash blocks a merchant for an hour if the
 * Refresh Token API is called more than twice in one hour, and the budget is
 * counted per merchant account — not per process. A single-process memory store
 * is therefore only correct while exactly one instance is running. Two pods, or
 * a serverless function that cold-starts per request, will each believe they
 * have a fresh budget and between them blow through it.
 *
 * For anything beyond one process, back this with something shared: Redis, a
 * database row, or any KV — see {@link createKvTokenStore}.
 */
export interface TokenRecord {
  idToken: string;
  refreshToken: string;
  /** Epoch ms at which the gateway stops accepting `idToken`. */
  expiresAt: number;
  /**
   * Epoch ms of every token acquisition still inside the rolling window,
   * oldest first — grants and refreshes alike.
   */
  acquisitions: number[];
  /**
   * The subset of {@link acquisitions} that were refreshes. This is what the
   * gateway's refresh budget is actually counted against.
   */
  refreshes: number[];
}

export interface TokenStore {
  get(key: string): Promise<TokenRecord | null>;
  set(key: string, record: TokenRecord): Promise<void>;
  delete(key: string): Promise<void>;
  /**
   * Optional mutual exclusion around a token acquisition. Implement it on a
   * shared store to stop N instances refreshing at the same moment; without it
   * the client still de-duplicates in-flight refreshes within its own process.
   */
  withLock?<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
}

/** Per-process store. Correct for a single long-lived instance, and nothing else. */
export class MemoryTokenStore implements TokenStore {
  #records = new Map<string, TokenRecord>();

  async get(key: string): Promise<TokenRecord | null> {
    return this.#records.get(key) ?? null;
  }

  async set(key: string, record: TokenRecord): Promise<void> {
    this.#records.set(key, record);
  }

  async delete(key: string): Promise<void> {
    this.#records.delete(key);
  }
}

export interface KvLike {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string, ttlSeconds?: number): Promise<unknown>;
  del(key: string): Promise<unknown>;
  /**
   * Set only if absent, returning whether the write happened. Supplying this
   * turns on cross-instance locking; without it, locking is skipped.
   */
  setIfAbsent?(key: string, value: string, ttlSeconds: number): Promise<boolean>;
}

/**
 * Wrap any string KV — Redis, Upstash, Cloudflare KV, a Prisma table behind
 * three functions — into a TokenStore.
 */
export function createKvTokenStore(kv: KvLike, opts: { prefix?: string } = {}): TokenStore {
  const prefix = opts.prefix ?? "paykit:token:";

  const store: TokenStore = {
    async get(key) {
      const raw = await kv.get(prefix + key);
      if (!raw) return null;
      try {
        return JSON.parse(raw) as TokenRecord;
      } catch {
        return null;
      }
    },
    async set(key, record) {
      // Keep the row a little past expiry so the acquisition history — and with
      // it the refresh budget — survives a token going stale.
      const ttlSeconds = Math.max(60, Math.ceil((record.expiresAt - Date.now()) / 1000) + 3600);
      await kv.set(prefix + key, JSON.stringify(record), ttlSeconds);
    },
    async delete(key) {
      await kv.del(prefix + key);
    },
  };

  if (kv.setIfAbsent) {
    const setIfAbsent = kv.setIfAbsent.bind(kv);
    store.withLock = async function withLock<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
      const lockKey = `${prefix}lock:${key}`;
      const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
      const deadline = Date.now() + ttlMs;

      while (Date.now() < deadline) {
        if (await setIfAbsent(lockKey, String(Date.now()), ttlSeconds)) {
          try {
            return await fn();
          } finally {
            await kv.del(lockKey);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 100)));
      }
      // Lock never came free — run anyway rather than failing the payment. The
      // in-process de-duplication still applies.
      return fn();
    };
  }

  return store;
}
