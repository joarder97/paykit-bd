import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ConfigError,
  NetworkError,
  PaykitError,
  ProviderError,
  RateLimitError,
  WebhookVerificationError,
} from "../src/core/errors.ts";
import { BkashError } from "../src/bkash/errors.ts";

/**
 * `instanceof` on these classes is answered by a brand, not by the prototype
 * chain, because each published entry point is a separate bundle with its own
 * copy of the class. These tests pin the behaviour that makes a consumer's
 * single catch block work — see the note at the top of src/core/errors.ts.
 *
 * The cross-bundle case itself cannot be reproduced from source, where there is
 * only ever one copy. It is checked against the packed tarball by
 * `scripts/verify-package.ts`, which is what caught the original defect.
 */

const samples = {
  BkashError: new BkashError({ code: "2023", message: "Insufficient Balance" }),
  NetworkError: new NetworkError("timeout", { provider: "bkash", code: "timeout" }),
  ConfigError: new ConfigError("bad config"),
  WebhookVerificationError: new WebhookVerificationError("forged", { provider: "bkash" }),
  RateLimitError: new RateLimitError("slow down", { provider: "bkash" }),
};

describe("error identity", () => {
  it("makes every error a PaykitError, so one catch block suffices", () => {
    for (const [name, error] of Object.entries(samples)) {
      assert.ok(error instanceof PaykitError, `${name} should be a PaykitError`);
      assert.ok(error instanceof Error, `${name} should still be a real Error`);
    }
  });

  it("keeps the gateway error inside the ProviderError family", () => {
    assert.ok(samples.BkashError instanceof ProviderError);
    assert.ok(samples.BkashError instanceof BkashError);
  });

  it("does not let unrelated error types match each other", () => {
    assert.ok(!(samples.NetworkError instanceof BkashError));
    assert.ok(!(samples.NetworkError instanceof ProviderError));
    assert.ok(!(samples.ConfigError instanceof NetworkError));
    assert.ok(!(samples.BkashError instanceof ConfigError));
    assert.ok(!(samples.RateLimitError instanceof WebhookVerificationError));
  });

  it("does not claim ordinary errors and junk as its own", () => {
    for (const value of [new Error("plain"), new TypeError("t"), null, undefined, 42, "str", {}, []]) {
      assert.ok(!(value instanceof PaykitError), `${String(value)} must not be a PaykitError`);
      assert.ok(!(value instanceof BkashError), `${String(value)} must not be a BkashError`);
    }
  });

  it("survives a duplicate copy of the class, which is the whole point", () => {
    // Stand in for a second bundle: a structurally identical error carrying the
    // same brand, built without touching the real constructor.
    const fromAnotherBundle = Object.assign(new Error("Insufficient Balance"), {
      [Symbol.for("paykit-bd.error.brands")]: ["PaykitError", "ProviderError", "BkashError"],
      provider: "bkash",
      code: "2023",
    });

    assert.ok(fromAnotherBundle instanceof PaykitError, "a branded error from another copy must match");
    assert.ok(fromAnotherBundle instanceof ProviderError);
    assert.ok(fromAnotherBundle instanceof BkashError);
    assert.ok(!(fromAnotherBundle instanceof NetworkError));
  });

  it("keeps name, code and toJSON usable for logging", () => {
    assert.equal(samples.BkashError.name, "BkashError");
    assert.equal(samples.BkashError.code, "2023");
    assert.deepEqual(samples.BkashError.toJSON(), {
      name: "BkashError",
      provider: "bkash",
      code: "2023",
      message: "Insufficient Balance",
      retryable: false,
    });
  });

  it("does not serialise the brand into JSON noise", () => {
    assert.ok(!("brands" in samples.BkashError.toJSON()));
    assert.equal(JSON.stringify({ e: samples.BkashError }).includes("paykit-bd.error"), false);
  });
});
