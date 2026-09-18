import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { RateLimitError } from "../src/core/errors.ts";
import { MemoryTokenStore } from "../src/core/token-store.ts";
import { resolveConfig } from "../src/bkash/config.ts";
import { BkashTokenManager } from "../src/bkash/token-manager.ts";

/**
 * The behaviour under test is the one that bites in production: bKash blocks a
 * merchant account for an hour once the Refresh Token API is called more than
 * twice within an hour.
 */

const CONFIG = resolveConfig({
  environment: "sandbox",
  username: "u",
  password: "p",
  appKey: "app-key-1234567890",
  appSecret: "app-secret",
});

interface Call {
  url: string;
  body: Record<string, unknown>;
}

let calls: Call[] = [];
let realFetch: typeof fetch;
let tokenCounter = 0;

function installFetch(handler?: (call: Call) => Response) {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    if (handler) return handler({ url, body });
    tokenCounter += 1;
    return Response.json({
      statusCode: "0000",
      statusMessage: "Successful",
      token_type: "Bearer",
      id_token: `token-${tokenCounter}`,
      refresh_token: `refresh-${tokenCounter}`,
      expires_in: 3600,
    });
  }) as typeof fetch;
}

const grants = () => calls.filter((c) => c.url.endsWith("/token/grant")).length;
const refreshes = () => calls.filter((c) => c.url.endsWith("/token/refresh")).length;

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  tokenCounter = 0;
  installFetch();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Push the stored token past its refresh threshold without waiting an hour. */
async function expireToken(store: MemoryTokenStore) {
  const record = await store.get(CONFIG.tokenKey);
  assert.ok(record, "expected a stored token");
  await store.set(CONFIG.tokenKey, { ...record, expiresAt: Date.now() + 60_000 });
}

describe("bKash token manager", () => {
  it("grants once and then reuses the token", async () => {
    const manager = new BkashTokenManager(CONFIG, { store: new MemoryTokenStore() });

    assert.equal(await manager.getToken(), "token-1");
    assert.equal(await manager.getToken(), "token-1");
    assert.equal(await manager.getToken(), "token-1");
    assert.equal(calls.length, 1, "a valid cached token must not cause another call");
  });

  it("de-duplicates concurrent callers into one acquisition", async () => {
    const manager = new BkashTokenManager(CONFIG, { store: new MemoryTokenStore() });

    const tokens = await Promise.all(Array.from({ length: 20 }, () => manager.getToken()));

    assert.equal(calls.length, 1, "20 concurrent callers must produce one token call, not 20");
    assert.ok(tokens.every((t) => t === "token-1"));
  });

  it("refreshes when the token nears expiry", async () => {
    const store = new MemoryTokenStore();
    const manager = new BkashTokenManager(CONFIG, { store });

    await manager.getToken();
    await expireToken(store);

    assert.equal(await manager.getToken(), "token-2");
    assert.equal(grants(), 1);
    assert.equal(refreshes(), 1);
  });

  it("stops refreshing at the budget and grants instead", async () => {
    const store = new MemoryTokenStore();
    const manager = new BkashTokenManager(CONFIG, { store });

    await manager.getToken(); // grant
    for (let i = 0; i < 4; i++) {
      await expireToken(store);
      await manager.getToken();
    }

    assert.equal(
      refreshes(),
      2,
      "bKash blocks the merchant for an hour past two refreshes, so the third must not be a refresh",
    );
    assert.equal(grants(), 3, "the remaining acquisitions fall back to Grant Token");

    const budget = await manager.budget();
    assert.equal(budget.refreshesUsed, 2);
    assert.equal(budget.refreshesAllowed, 2);
  });

  it("opens a circuit breaker before a runaway loop reaches bKash", async () => {
    const store = new MemoryTokenStore();
    const manager = new BkashTokenManager(CONFIG, { store });

    for (let i = 0; i < 10; i++) {
      await expireToken(store).catch(() => {});
      await manager.getToken();
    }
    await expireToken(store);

    await assert.rejects(
      () => manager.getToken(),
      (error: unknown) => error instanceof RateLimitError && error.code === "token_circuit_open",
      "an eleventh acquisition inside one hour must fail locally rather than at bKash",
    );
    assert.equal(calls.length, 10, "no further request should reach bKash once the breaker is open");
  });

  it("keeps the rate history when a token is invalidated", async () => {
    const store = new MemoryTokenStore();
    const manager = new BkashTokenManager(CONFIG, { store });

    await manager.getToken();
    await manager.invalidate();
    await manager.getToken();

    const budget = await manager.budget();
    assert.equal(budget.acquisitionsUsed, 2, "invalidation must not reset the budget, or a 401 loop clears its own guard");
  });

  it("surfaces a bKash error instead of caching a broken token", async () => {
    installFetch(() => Response.json({ statusCode: "2001", statusMessage: "Invalid App Key" }));
    const manager = new BkashTokenManager(CONFIG, { store: new MemoryTokenStore() });

    await assert.rejects(() => manager.getToken(), /2001/);
  });

  it("uses the store's lock when one is offered", async () => {
    let locked = 0;
    const store = new MemoryTokenStore();
    const locking = Object.assign(store, {
      async withLock<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
        locked += 1;
        return fn();
      },
    });

    const manager = new BkashTokenManager(CONFIG, { store: locking });
    await manager.getToken();
    assert.equal(locked, 1);
  });
});
