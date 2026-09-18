/**
 * Talks to the real bKash sandbox and prints what happened.
 *
 * `pnpm smoke`
 *
 * With no BKASH_* variables set it uses bKash's own published sandbox demo
 * credentials, so the repo is runnable the moment it is cloned. Set your own in
 * `.env` (and export them) to exercise your merchant account instead.
 *
 * What it can and cannot prove: everything up to the point where a human enters
 * a PIN. Create, query, the error envelopes and the token lifecycle are real
 * calls against bKash. A completed payment needs a browser and a test wallet —
 * the script prints the URL for that and stops.
 */

import { BkashClient, configFromEnv } from "../src/bkash/index.ts";
import { BkashError } from "../src/bkash/errors.ts";
import { MemoryTokenStore } from "../src/core/token-store.ts";

const DEMO = {
  username: "sandboxTokenizedUser02",
  password: "sandboxTokenizedUser02@12345",
  appKey: "4f6o0cjiki2rfm34kfdadl1eqq",
  appSecret: "2is7hdktrekvrbljjh44ll3d9l1dtjo4pasmjvs5vl5qr3fug4b",
};

const fromEnv = configFromEnv();
const usingDemo = !fromEnv.username || !fromEnv.appKey;

const client = new BkashClient(
  {
    ...(usingDemo ? { environment: "sandbox" as const, ...DEMO } : fromEnv),
    callbackUrl: fromEnv.callbackUrl ?? "https://example.com/api/bkash/callback",
  },
  { tokenStore: new MemoryTokenStore() },
);

const line = (label: string, value: unknown) => console.log(`  ${label.padEnd(24)} ${String(value)}`);

console.log(`\nbKash sandbox smoke test`);
console.log(`  credentials              ${usingDemo ? "bKash public sandbox demo" : "from environment"}`);
console.log(`  host                     ${client.environment.origin}\n`);

let failures = 0;
async function step(name: string, fn: () => Promise<void>) {
  try {
    console.log(`▶ ${name}`);
    await fn();
  } catch (error) {
    failures += 1;
    console.log(`  FAILED  ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log();
}

const reference = `PAYKIT-SMOKE-${Date.now()}`;
let paymentId = "";

await step("grant a token", async () => {
  const budget = await client.tokenBudget();
  line("refreshes used", `${budget.refreshesUsed}/${budget.refreshesAllowed}`);
  // Any call forces the grant; use the cheapest failing one.
  await client.getPayment("TR0000000000000000000").catch((error) => {
    if (error instanceof BkashError && error.code === "2002") return;
    throw error;
  });
  const after = await client.tokenBudget();
  line("acquisitions this hour", after.acquisitionsUsed);
  if (after.acquisitionsUsed !== 1) throw new Error(`expected exactly 1 acquisition, got ${after.acquisitionsUsed}`);
});

await step("refresh the token (spends 1 of 2 for the hour)", async () => {
  const before = await client.tokenBudget();
  await client.refreshToken();
  const after = await client.tokenBudget();
  line("refreshes used", `${before.refreshesUsed} -> ${after.refreshesUsed}/${after.refreshesAllowed}`);
  if (after.refreshesUsed !== before.refreshesUsed + 1) {
    throw new Error("a refresh must be counted against the hourly budget");
  }
  // The budget is now spent down to 1. Anything past 2 in an hour gets the
  // merchant account blocked, which is why the manager counts rather than hopes.
});

await step("create an agreement (mode 0000)", async () => {
  const agreement = await client.createAgreement({ payerReference: "01770618575" });
  line("paymentId", agreement.paymentId);
  line("status", agreement.status);
  if (!agreement.redirectUrl) throw new Error("mode 0000 must return a bkashURL for the OTP step");

  // Executing before the customer has entered an OTP must be refused.
  const refused = await client.executeAgreement(agreement.paymentId).then(
    () => null,
    (error: unknown) => error,
  );
  if (!(refused instanceof BkashError) || refused.code !== "2054") {
    throw new Error(`expected 2054 Agreement execution pre-requisite, got ${(refused as BkashError)?.code}`);
  }
  line("premature execute", `${refused.code} (correctly refused)`);
});

await step("create a one-off payment (mode 0011)", async () => {
  const payment = await client.createPayment({ amount: "12.50", reference, payerReference: "01770618575" });
  paymentId = payment.paymentId;
  line("paymentId", payment.paymentId);
  line("status", payment.status);
  line("amount", `${payment.amount} ${payment.currency}`);
  line("reference", payment.reference);
  line("expires", payment.expiresAt?.toISOString() ?? "unknown");
  if (!payment.paymentId) throw new Error("no paymentID returned");
  if (!payment.redirectUrl) throw new Error("mode 0011 must return a bkashURL to redirect to");
  console.log(`\n  Open this to finish the payment by hand with a sandbox wallet:\n  ${payment.redirectUrl}`);
});

await step("query that payment", async () => {
  const payment = await client.getPayment(paymentId);
  line("status", payment.status);
  line("reference", payment.reference);
  line("transactionId", payment.transactionId ?? "none yet (customer has not paid)");
  const refundable = await client.getRefundableAmount(paymentId);
  line("maxRefundableAmount", refundable ?? "not reported");
  if (payment.reference !== reference) {
    throw new Error(`reference did not round-trip: sent ${reference}, got back ${payment.reference}`);
  }
});

await step("execute before the customer approves (should be refused)", async () => {
  try {
    await client.executePayment(paymentId);
    throw new Error("bKash accepted an execute for a payment nobody approved — that should not happen");
  } catch (error) {
    if (!(error instanceof BkashError)) throw error;
    line("code", error.code);
    line("message", error.message);
    line("customerFault", error.customerFault);
    line("alreadySettled", error.alreadySettled);
    if (error.code !== "2056") throw new Error(`expected 2056 Invalid Payment State, got ${error.code}`);
  }
});

await step("error envelopes are all understood", async () => {
  const badAgreement = await client.getAgreement("NOT-AN-AGREEMENT").then(
    () => null,
    (error: unknown) => error,
  );
  line("bad agreement", badAgreement instanceof BkashError ? `${badAgreement.code} (statusCode envelope)` : "unexpected");
  if (!(badAgreement instanceof BkashError) || badAgreement.code !== "2051") {
    throw new Error("expected 2051 Invalid Agreement ID");
  }

  const badRefund = await client
    .refund({ paymentId: "TR0000000000000000000", transactionId: "AAAAAAAAAA", amount: "1" })
    .then(
      () => null,
      (error: unknown) => error,
    );
  line("bad refund", badRefund instanceof BkashError ? `${badRefund.code} (v2 envelope)` : "unexpected");
  if (!(badRefund instanceof BkashError) || badRefund.code !== "2002") {
    throw new Error("expected 2002 from the v2 refund envelope");
  }
});

await step("one token served every call above", async () => {
  const budget = await client.tokenBudget();
  line("acquisitions this hour", budget.acquisitionsUsed);
  line("refreshes this hour", `${budget.refreshesUsed}/${budget.refreshesAllowed}`);
  // One grant plus the one deliberate refresh. Every payment, query, agreement
  // and refund call above rode on those two — no per-call token churn.
  if (budget.acquisitionsUsed !== 2) {
    throw new Error(
      `expected exactly 2 acquisitions (1 grant + 1 deliberate refresh), got ${budget.acquisitionsUsed}`,
    );
  }
  if (budget.refreshesUsed !== 1) {
    throw new Error(`expected 1 refresh against the hourly budget, got ${budget.refreshesUsed}`);
  }
});

console.log(failures === 0 ? "All sandbox steps passed.\n" : `${failures} step(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
