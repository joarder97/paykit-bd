import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MemoryTokenStore } from "../src/core/token-store.ts";
import { BkashClient } from "../src/bkash/client.ts";
import { BkashError } from "../src/bkash/errors.ts";

interface Call {
  url: string;
  body: Record<string, unknown>;
}

let calls: Call[] = [];
let realFetch: typeof fetch;
/** url suffix -> queue of responses; the last one is reused once exhausted. */
let routes: Record<string, unknown[]> = {};

function respond(url: string): unknown {
  for (const [suffix, queue] of Object.entries(routes)) {
    if (url.endsWith(suffix)) {
      return queue.length > 1 ? queue.shift() : queue[0];
    }
  }
  throw new Error(`test: no stub for ${url}`);
}

function client() {
  return new BkashClient(
    {
      environment: "sandbox",
      username: "u",
      password: "p",
      appKey: "app-key",
      appSecret: "app-secret",
      callbackUrl: "https://shop.example.com/api/bkash/callback",
    },
    { tokenStore: new MemoryTokenStore() },
  );
}

beforeEach(() => {
  realFetch = globalThis.fetch;
  calls = [];
  routes = {
    "/token/grant": [{ statusCode: "0000", id_token: "tok-1", refresh_token: "ref-1", expires_in: 3600 }],
    "/token/refresh": [{ statusCode: "0000", id_token: "tok-2", refresh_token: "ref-2", expires_in: 3600 }],
  };
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url, body });
    const stub = respond(url);
    const status = typeof stub === "object" && stub !== null && "__status" in stub ? Number((stub as Record<string, unknown>)["__status"]) : 200;
    return Response.json(stub, { status });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const lastCallTo = (suffix: string) => calls.filter((c) => c.url.endsWith(suffix)).at(-1);

describe("createPayment", () => {
  it("uses mode 0011 and returns a redirect URL for a one-off payment", async () => {
    routes["/tokenized/checkout/create"] = [
      {
        statusCode: "0000",
        paymentID: "TR0011abc",
        bkashURL: "https://sandbox.payment.bkash.com/?paymentId=TR0011abc",
        amount: "500.00",
        currency: "BDT",
        intent: "sale",
        transactionStatus: "Initiated",
        merchantInvoiceNumber: "ORD-1",
        paymentCreateTime: "2026-09-18T06:00:19:952 GMT+0600",
      },
    ];

    const payment = await client().createPayment({ amount: 500, reference: "ORD-1" });

    assert.equal(lastCallTo("/tokenized/checkout/create")?.body["mode"], "0011");
    assert.equal(lastCallTo("/tokenized/checkout/create")?.body["amount"], "500.00");
    assert.equal(payment.paymentId, "TR0011abc");
    assert.equal(payment.status, "initiated");
    assert.ok(payment.redirectUrl);
    // 24 hours after creation.
    assert.equal(payment.expiresAt?.toISOString(), "2026-09-19T00:00:19.952Z");
  });

  it("uses mode 0001 and expects no redirect when an agreement is charged", async () => {
    routes["/tokenized/checkout/create"] = [
      {
        statusCode: "0000",
        paymentID: "TR0001abc",
        amount: "12.00",
        currency: "BDT",
        transactionStatus: "Initiated",
        agreementID: "AGR-1",
      },
    ];

    const payment = await client().createPayment({
      amount: "12",
      reference: "ORD-2",
      extra: { agreementID: "AGR-1" },
    });

    const body = lastCallTo("/tokenized/checkout/create")?.body;
    assert.equal(body?.["mode"], "0001");
    assert.equal(body?.["agreementID"], "AGR-1");
    assert.equal(payment.redirectUrl, null);
  });

  it("refuses to send a malformed amount to bKash", async () => {
    await assert.rejects(() => client().createPayment({ amount: "12.345", reference: "ORD-3" }), /Invalid BDT amount/);
    assert.equal(calls.filter((c) => c.url.endsWith("/create")).length, 0, "nothing should have been sent");
  });
});

describe("executePayment", () => {
  it("maps a completed execution", async () => {
    routes["/tokenized/checkout/execute"] = [
      {
        statusCode: "0000",
        paymentID: "TR0011abc",
        trxID: "6H6201QDIY",
        amount: "12.00",
        currency: "BDT",
        transactionStatus: "Completed",
        customerMsisdn: "01770618575",
        merchantInvoiceNumber: "ORD-1",
        paymentExecuteTime: "2026-09-18T12:22:41:428 GMT+0600",
      },
    ];

    const payment = await client().executePayment("TR0011abc");

    assert.equal(payment.status, "completed");
    assert.equal(payment.transactionId, "6H6201QDIY");
    assert.equal(payment.payerAccount, "01770618575");
    assert.equal(payment.completedAt?.toISOString(), "2026-09-18T06:22:41.428Z");
  });

  it("reads real state instead of throwing when bKash says it already executed", async () => {
    routes["/tokenized/checkout/execute"] = [{ statusCode: "2117", statusMessage: "The payment execution has already been completed" }];
    routes["/tokenized/checkout/payment/status"] = [
      {
        statusCode: "0000",
        paymentID: "TR0011abc",
        trxID: "6H6201QDIY",
        amount: "12.00",
        transactionStatus: "Completed",
        merchantInvoice: "ORD-1",
      },
    ];

    const payment = await client().executePayment("TR0011abc");

    assert.equal(payment.status, "completed", "a double execute must not be reported as a failed order");
    assert.equal(payment.transactionId, "6H6201QDIY");
    assert.equal(payment.reference, "ORD-1");
  });

  it("propagates a genuine failure", async () => {
    routes["/tokenized/checkout/execute"] = [{ statusCode: "2023", statusMessage: "Insufficient Balance" }];

    await assert.rejects(
      () => client().executePayment("TR0011abc"),
      (error: unknown) => error instanceof BkashError && error.code === "2023" && error.customerFault,
    );
  });
});

describe("getPayment", () => {
  it("reads the reference from merchantInvoice, which is what query returns", async () => {
    routes["/tokenized/checkout/payment/status"] = [
      {
        statusCode: "0000",
        paymentID: "TR0011abc",
        amount: "12.50",
        transactionStatus: "Initiated",
        // The query endpoint spells it without the Number suffix.
        merchantInvoice: "ORD-9",
        maxRefundableAmount: "12.50",
        payerReference: "01770618575",
      },
    ];

    const payment = await client().getPayment("TR0011abc");
    assert.equal(payment.reference, "ORD-9");
    assert.equal(payment.payerAccount, "01770618575");
  });
});

describe("refund", () => {
  const refundOk = {
    originalTrxId: "BFD90JRLST",
    refundTrxId: "BFD90JRMH9",
    refundTransactionStatus: "Completed",
    originalTrxAmount: "4.59",
    refundAmount: "1.00",
    currency: "BDT",
    completedTime: "2026-06-13T16:27:25:422 GMT+0600",
  };

  it("always sends sku and reason, because bKash rejects the call without them", async () => {
    routes["/refund/payment/transaction"] = [refundOk];

    await client().refund({ paymentId: "TR1", transactionId: "BFD90JRLST", amount: "1.00" });

    const body = lastCallTo("/refund/payment/transaction")?.body;
    assert.equal(typeof body?.["sku"], "string");
    assert.equal(typeof body?.["reason"], "string");
    assert.notEqual(body?.["sku"], "", "an empty sku is rejected the same way a missing one is");
    assert.notEqual(body?.["reason"], "");
    // Lower-case d on this endpoint only.
    assert.equal(body?.["paymentId"], "TR1");
    assert.equal(body?.["trxId"], "BFD90JRLST");
  });

  it("keeps the caller's sku and reason when given", async () => {
    routes["/refund/payment/transaction"] = [refundOk];

    await client().refund({
      paymentId: "TR1",
      transactionId: "BFD90JRLST",
      amount: "1.00",
      sku: "TSHIRT-M",
      reason: "damaged on arrival",
    });

    const body = lastCallTo("/refund/payment/transaction")?.body;
    assert.equal(body?.["sku"], "TSHIRT-M");
    assert.equal(body?.["reason"], "damaged on arrival");
  });

  it("asks bKash what is refundable rather than assuming, for a full refund", async () => {
    routes["/tokenized/checkout/payment/status"] = [
      { statusCode: "0000", paymentID: "TR1", amount: "4.59", maxRefundableAmount: "3.59", transactionStatus: "Completed" },
    ];
    routes["/refund/payment/transaction"] = [{ ...refundOk, refundAmount: "3.59" }];

    const refund = await client().refund({ paymentId: "TR1", transactionId: "BFD90JRLST" });

    assert.equal(
      lastCallTo("/refund/payment/transaction")?.body["refundAmount"],
      "3.59",
      "a full refund after a partial one must use the remaining balance, not the original amount",
    );
    assert.equal(refund.amount, "3.59");
    assert.equal(refund.status, "completed");
  });

  it("normalises the v2 refund error envelope", async () => {
    routes["/refund/payment/transaction"] = [
      {
        __status: 400,
        internalCode: "invalid_payment_id",
        externalCode: "2002",
        errorMessageEn: "Invalid Payment ID",
        errorMessageBn: null,
      },
    ];

    await assert.rejects(
      () => client().refund({ paymentId: "nope", transactionId: "nope", amount: "1" }),
      (error: unknown) => error instanceof BkashError && error.code === "2002",
    );
  });

  it("lists every refund taken against one transaction", async () => {
    routes["/refund/payment/status"] = [
      {
        originalTrxId: "BFD90JRLST",
        originalTrxAmount: "4.59",
        refundTransactions: [
          { refundTrxId: "R1", refundTransactionStatus: "Completed", refundAmount: "1.00", completedTime: "2026-06-13T16:27:24:000" },
          { refundTrxId: "R2", refundTransactionStatus: "Completed", refundAmount: "2.00", completedTime: "2026-06-17T18:27:24:000" },
        ],
      },
    ];

    const result = await client().getRefunds({ paymentId: "TR1", transactionId: "BFD90JRLST" });

    assert.equal(result.refunds.length, 2);
    assert.equal(result.originalAmount, "4.59");
    assert.equal(result.refunds[0]?.amount, "1.00");
    assert.equal(result.refunds[1]?.completedAt?.toISOString(), "2026-06-17T12:27:24.000Z");
  });
});

describe("token recovery", () => {
  it("acquires a new token and retries once when bKash rejects the current one", async () => {
    routes["/tokenized/checkout/payment/status"] = [
      { __status: 401, message: "Unauthorized" },
      { statusCode: "0000", paymentID: "TR1", amount: "1.00", transactionStatus: "Completed" },
    ];

    const payment = await client().getPayment("TR1");

    assert.equal(payment.status, "completed");
    assert.equal(calls.filter((c) => c.url.endsWith("/payment/status")).length, 2, "one retry, not more");
    assert.equal(calls.filter((c) => c.url.includes("/token/")).length, 2, "a fresh token was acquired for the retry");
  });

  it("gives up after one retry rather than looping on 401", async () => {
    routes["/tokenized/checkout/payment/status"] = [{ __status: 401, message: "Unauthorized" }];

    await assert.rejects(
      () => client().getPayment("TR1"),
      (error: unknown) => error instanceof BkashError && error.code === "unauthorized",
    );
    assert.equal(calls.filter((c) => c.url.endsWith("/payment/status")).length, 2);
  });
});

describe("agreements", () => {
  it("returns the agreementID that must be stored", async () => {
    routes["/tokenized/checkout/execute"] = [
      {
        statusCode: "0000",
        paymentID: "TR0000abc",
        agreementID: "TokenizedMerchant01L3IKB6H1565072174986",
        payerReference: "01770618575",
        customerMsisdn: "01770618575",
        agreementStatus: "Completed",
        agreementExecuteTime: "2026-09-18T12:16:14:985 GMT+0600",
      },
    ];

    const agreement = await client().executeAgreement("TR0000abc");

    assert.equal(agreement.agreementId, "TokenizedMerchant01L3IKB6H1565072174986");
    assert.equal(agreement.status, "Completed");
    assert.equal(agreement.executedAt?.toISOString(), "2026-09-18T06:16:14.985Z");
  });

  it("sends mode 0000 when creating one", async () => {
    routes["/tokenized/checkout/create"] = [
      { statusCode: "0000", paymentID: "TR0000abc", bkashURL: "https://sandbox.payment.bkash.com/x", agreementStatus: "Initiated" },
    ];

    await client().createAgreement({ payerReference: "01770618575" });
    assert.equal(lastCallTo("/tokenized/checkout/create")?.body["mode"], "0000");
  });
});

describe("callback parsing", () => {
  it("reads bKash's redirect query string", () => {
    const query = BkashClient.parseCallback(
      "https://shop.example.com/api/bkash/callback?version=v1.2.0-beta&product=tokenized-checkout&paymentID=TR0011abc&status=success&signature=cm8HBfl65A",
    );

    assert.equal(query.paymentID, "TR0011abc");
    assert.equal(query.status, "success");
    assert.equal(query.signature, "cm8HBfl65A");
    assert.equal(query.apiVersion, "v1.2.0-beta");
  });

  it("accepts URLSearchParams and plain objects too", () => {
    assert.equal(BkashClient.parseCallback(new URLSearchParams("paymentID=A&status=cancel")).status, "cancel");
    assert.equal(BkashClient.parseCallback({ paymentID: "B", status: "failure" }).paymentID, "B");
  });
});

describe("config", () => {
  it("names the missing credential instead of failing at the first request", () => {
    assert.throws(
      () => new BkashClient({ username: "u", password: "", appKey: "", appSecret: "s" }),
      /missing required credentials password, appKey/,
    );
  });

  it("requires a callback URL before it can create anything", async () => {
    const bare = new BkashClient(
      { environment: "sandbox", username: "u", password: "p", appKey: "k", appSecret: "s" },
      { tokenStore: new MemoryTokenStore() },
    );
    await assert.rejects(() => bare.createPayment({ amount: "1", reference: "X" }), /callback URL/);
  });
});
