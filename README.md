# paykit-bd

Typed, zero-dependency payment clients for Bangladeshi gateways. bKash tokenized
checkout today; the provider seam is there so Nagad and SSLCommerz slot in
without rewriting order handling.

Checked against the live bKash sandbox, not only against the docs — which turned
out to be wrong or silent in seven places, listed in
[docs/bkash.md](docs/bkash.md).

```bash
npm install paykit-bd
```

Node 20+. No runtime dependencies — `fetch` and `node:crypto` are enough.

## Quickstart

```ts
import { BkashClient, configFromEnv } from "paykit-bd/bkash";

const bkash = new BkashClient(configFromEnv());

// 1. Start the payment and send the customer to bKash.
const payment = await bkash.createPayment({ amount: "500", reference: "ORD-1042" });
redirect(payment.redirectUrl!);

// 2. When they come back, ask bKash what actually happened.
const settled = await bkash.executePayment(payment.paymentId);
if (settled.status === "completed") {
  await fulfilOrder("ORD-1042", settled.transactionId!);
}
```

The redirect back from bKash carries `status=success`, and it is worth nothing on
its own — the customer's browser followed that URL and could have edited it.
`executePayment` is what decides.

## Webhooks (IPN)

bKash delivers payment notifications through Amazon SNS, so what has to be
verified is an **SNS message signature** — not an HMAC of the body, which is what
most bKash integrations assume, and then skip.

```ts
// app/api/bkash/webhook/route.ts
import { createBkashWebhookHandler } from "paykit-bd/bkash/next";

export const POST = createBkashWebhookHandler(bkash, {
  onPaymentCompleted: async (event) => {
    await markPaid(event.reference!, event.transactionId!, event.amount!);
  },
});
```

Express needs the raw body, and bKash posts as `text/plain`, so `express.json()`
sees nothing:

```ts
import { bkashWebhookMiddleware, rawBodyParser } from "paykit-bd/bkash/express";

app.post("/api/bkash/webhook", rawBodyParser(), bkashWebhookMiddleware(bkash, {
  onPaymentCompleted: fulfilOrder,
}));
```

Set `BKASH_WEBHOOK_TOPIC_ARN` to your own SNS topic. Without it, any
Amazon-signed topic passes — including someone else's merchant account.

## What this handles that a hand-rolled client usually does not

**The refresh-token trap.** bKash blocks your merchant account for a full hour if
the Refresh Token API is called more than twice in an hour. The budget belongs to
the account, not to your process, so this counts refreshes in a rolling window,
falls back to a fresh Grant when the budget is spent, de-duplicates concurrent
callers into one acquisition, and opens a local circuit breaker at ten
acquisitions per hour rather than letting a retry loop get you blocked. Put the
token in a shared store and it stays correct across instances:

```ts
new BkashClient(config, { tokenStore: createKvTokenStore(redis) })
```

**Forged webhooks.** The SNS signature is verified against a certificate fetched
from a URL *inside the message*. A verifier that does not pin that URL to an
Amazon host will fetch an attacker's certificate and confirm the attacker's own
signature over a forged "payment completed" — free orders with a clean audit
trail. `SigningCertURL` is checked against `sns.<region>.amazonaws.com` before
anything is fetched.

**`sku` and `reason` are mandatory on refunds.** The docs read as though they were
optional. Omit either and the v2 refund API answers
`{"message": "Invalid request body"}` — no code, no field name. Defaults are
always sent.

**Timestamps that `Date` cannot parse.** bKash sends
`2026-09-18T06:00:19:952 GMT+0600` — a colon before the milliseconds. `new Date()`
returns `Invalid Date`. The refund API drops the offset entirely and means
Bangladesh time.

**Four different error envelopes**, depending on endpoint and version:
`{statusCode}` with HTTP 200 (a 200 is not success), `{errorCode}`,
`{internalCode, externalCode, errorMessageEn}` on the v2 refund API, and
`{message}` from the API Gateway in front of bKash. All four normalise to one
`BkashError` with the code, whether the customer caused it, and whether the
payment was already settled.

**Money as integers.** Amounts are handled in poisha, never floats, so partial
refunds still sum to the original.

**Field names that change between endpoints.** Create and execute return
`merchantInvoiceNumber`; query returns `merchantInvoice`. Every endpoint takes
`paymentID` except the v2 refund API, which takes `paymentId`.

## Try it without credentials

```bash
pnpm smoke
```

Runs against the real bKash sandbox using bKash's published demo credentials. It
grants a token, refreshes it and checks the budget moved, creates an agreement
and a payment, queries the payment, confirms a premature execute is refused,
exercises the error envelopes, and prints a URL you can open to finish the
payment by hand. It also runs in CI on every push.

## API

| | |
| --- | --- |
| `createPayment(input)` | Mode 0011, or 0001 with `extra.agreementID`. |
| `executePayment(paymentId)` | Finalise. Re-queries instead of throwing if bKash says it already ran. |
| `getPayment(paymentId)` | Current state. Safe to repeat — this is the recovery path. |
| `refund(input)` | Full or partial. Reads `maxRefundableAmount` when no amount is given. |
| `getRefunds({paymentId, transactionId})` | Every refund taken against a transaction. |
| `verifyWebhook(request)` | Verify an IPN message and normalise it. |
| `createAgreement` / `executeAgreement` | Two-step setup for PIN-only repeat payments. |
| `getAgreement` / `cancelAgreement` | Undocumented by bKash, live in sandbox. |
| `tokenBudget()` | Refreshes used this hour. Worth putting on a health endpoint. |

Details and the full endpoint map: [docs/bkash.md](docs/bkash.md).
Adding a gateway: [docs/adding-a-provider.md](docs/adding-a-provider.md).

## Status

bKash tokenized checkout is complete. Nagad and SSLCommerz are not written yet —
the `PaymentProvider` interface is the seam they plug into.

**Verified against the live sandbox:** grant token, refresh token, create
agreement (0000), create payment (0011, both `sale` and `authorization`), execute,
query payment, agreement status and cancel, refund and refund status on v2, and
all four error envelopes.

**Not verified end to end, because it needs a human with a test wallet:** a
completed payment, and therefore executing an agreement (0001), and a refund of
real money. Those paths are covered by unit tests against recorded response
shapes, which is weaker evidence — `pnpm smoke` prints a URL if you want to
finish a payment by hand and check.

**Not verified at all:** a real inbound IPN message, which needs bKash support to
register a listener URL against a live merchant account. The SNS verification is
tested against signatures generated with a real RSA key the same way Amazon
generates them, but no message from bKash itself has passed through it. If you
wire one up, an issue saying whether it verified would be useful.

## License

MIT
