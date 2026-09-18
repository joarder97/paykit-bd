import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, NetworkError } from "../src/core/errors.ts";
import { addAmount, compareAmount, subtractAmount, sumAmounts, toAmountString, toPoisha } from "../src/core/money.ts";
import { BkashError, parseBkashCompactTime, parseBkashTime, toBkashError } from "../src/bkash/errors.ts";

describe("money", () => {
  it("normalises every accepted form to two decimals", () => {
    assert.equal(toAmountString("500"), "500.00");
    assert.equal(toAmountString("12.5"), "12.50");
    assert.equal(toAmountString(12.5), "12.50");
    assert.equal(toAmountString("4.59"), "4.59");
    assert.equal(toAmountString(0), "0.00");
  });

  it("adds without the float error that floats would give", () => {
    // 0.1 + 0.2 === 0.30000000000000004 in float arithmetic.
    assert.equal(addAmount("0.10", "0.20"), "0.30");
    assert.equal(sumAmounts(["4.59", "1.00", "2.00"]), "7.59");
    assert.equal(subtractAmount("4.59", "1.00"), "3.59");
  });

  it("orders amounts correctly at boundaries", () => {
    assert.equal(compareAmount("10.00", "9.99"), 1);
    assert.equal(compareAmount("9.99", "10.00"), -1);
    assert.equal(compareAmount("10", "10.00"), 0);
  });

  it("counts a partial refund against the original without drift", () => {
    const original = "4.59";
    const refunds = ["1.00", "2.00", "1.59"];
    assert.equal(sumAmounts(refunds), original);
    assert.equal(subtractAmount(original, sumAmounts(refunds)), "0.00");
  });

  it("refuses amounts the gateway would reject", () => {
    for (const bad of ["12.345", "abc", "", "1,000", "1e3", Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(() => toPoisha(bad as string), ConfigError, `should refuse ${String(bad)}`);
    }
  });
});

describe("bKash timestamps", () => {
  it("parses the format bKash actually sends, which Date cannot", () => {
    const raw = "2026-09-18T06:00:19:952 GMT+0600";
    assert.ok(Number.isNaN(new Date(raw).getTime()), "precondition: plain Date fails on this format");

    const parsed = parseBkashTime(raw);
    assert.equal(parsed?.toISOString(), "2026-09-18T00:00:19.952Z");
  });

  it("treats a missing offset as Bangladesh time, as the refund API intends", () => {
    assert.equal(parseBkashTime("2024-06-13T16:27:24:000")?.toISOString(), "2024-06-13T10:27:24.000Z");
  });

  it("handles a negative and a non-Bangladesh offset", () => {
    assert.equal(parseBkashTime("2019-05-23T07:03:02:972 GMT+0000")?.toISOString(), "2019-05-23T07:03:02.972Z");
    assert.equal(parseBkashTime("2019-05-23T07:03:02:972 GMT-0500")?.toISOString(), "2019-05-23T12:03:02.972Z");
  });

  it("parses the compact webhook dateTime", () => {
    assert.equal(parseBkashCompactTime("20180419122246")?.toISOString(), "2018-04-19T06:22:46.000Z");
  });

  it("returns undefined rather than an Invalid Date", () => {
    assert.equal(parseBkashTime(undefined), undefined);
    assert.equal(parseBkashTime(""), undefined);
    assert.equal(parseBkashCompactTime("nonsense"), undefined);
  });
});

describe("bKash error envelopes", () => {
  it("treats statusCode 0000 as success", () => {
    assert.equal(toBkashError({ statusCode: "0000", statusMessage: "Successful" }, 200), null);
  });

  it("catches a business error hiding behind HTTP 200", () => {
    const error = toBkashError({ statusCode: "2002", statusMessage: "Invalid Payment ID" }, 200);
    assert.ok(error instanceof BkashError);
    assert.equal(error.code, "2002");
    assert.match(error.message, /Invalid Payment ID/);
  });

  it("reads the documented errorCode envelope", () => {
    const error = toBkashError({ errorCode: "2051", errorMessage: "Invalid Agreement ID" }, 200);
    assert.ok(error instanceof BkashError);
    assert.equal(error.code, "2051");
  });

  it("reads the v2 refund envelope, which shares no field names with the others", () => {
    const error = toBkashError(
      {
        internalCode: "invalid_payment_id",
        externalCode: "2002",
        errorMessageEn: "Invalid Payment ID",
        errorMessageBn: null,
      },
      400,
    );
    assert.ok(error instanceof BkashError);
    assert.equal(error.code, "2002");
    assert.match(error.message, /Invalid Payment ID/);
  });

  it("explains an API Gateway 401 rather than passing on 'Unauthorized'", () => {
    const error = toBkashError({ message: "Unauthorized" }, 401);
    assert.ok(error instanceof BkashError);
    assert.equal(error.code, "unauthorized");
    assert.match(error.message, /id_token/);
  });

  it("flags already-settled codes so the caller re-queries instead of failing", () => {
    for (const code of ["2062", "2117", "2119"]) {
      const error = toBkashError({ statusCode: code, statusMessage: "x" }, 200);
      assert.ok(error instanceof BkashError);
      assert.equal(error.alreadySettled, true, `${code} should be treated as already settled`);
    }
  });

  it("separates customer fault from integration fault", () => {
    const wrongPin = toBkashError({ statusCode: "2014", statusMessage: "Wrong PIN" }, 200);
    const badAppKey = toBkashError({ statusCode: "2001", statusMessage: "Invalid App Key" }, 200);
    assert.ok(wrongPin instanceof BkashError && wrongPin.customerFault);
    assert.ok(badAppKey instanceof BkashError && !badAppKey.customerFault);
  });

  it("marks only transient codes retryable", () => {
    const transient = toBkashError({ statusCode: "2003", statusMessage: "Process failed" }, 200);
    const permanent = toBkashError({ statusCode: "2023", statusMessage: "Insufficient Balance" }, 200);
    assert.ok(transient instanceof BkashError && transient.retryable);
    assert.ok(permanent instanceof BkashError && !permanent.retryable);
  });

  it("reports a non-object body as a network fault, not a payment failure", () => {
    assert.ok(toBkashError("<html>gateway timeout</html>", 200) instanceof NetworkError);
  });
});
