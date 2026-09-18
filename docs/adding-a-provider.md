# Adding a gateway

The seam is `PaymentProvider` in [`src/core/provider.ts`](../src/core/provider.ts):
five methods, which is what an order flow actually needs. Anything a gateway does
beyond that — bKash agreements, for instance — stays on its own client rather
than being bent into a shape that fits nobody.

```ts
interface PaymentProvider {
  readonly id: string;
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;
  executePayment(paymentId: string): Promise<Payment>;
  getPayment(paymentId: string): Promise<Payment>;
  refund(input: RefundInput): Promise<Refund>;
  verifyWebhook(request: RawWebhookRequest): Promise<WebhookEvent>;
}
```

## What core already gives you

Reach for these before writing anything gateway-specific:

| | |
| --- | --- |
| `requestJson` | fetch with timeout, opt-in bounded retry, header redaction |
| `toAmountString`, `addAmount`, `sumAmounts` | integer-poisha money, no floats |
| `MemoryTokenStore`, `createKvTokenStore` | token persistence with a rate-budget history and optional cross-instance locking |
| `PaykitError` and subclasses | one catch block distinguishes decline from dead socket |
| `Logger` | inject your own; credentials are redacted before anything is logged |

## The shape to follow

1. `src/<gateway>/config.ts` — hosts per environment, endpoint map derived from
   one origin, `configFromEnv()`, and a `resolveConfig` that names a missing
   credential up front rather than failing at the first request.
2. `src/<gateway>/types.ts` — the gateway's wire shapes, with its own field
   names, including the inconsistent ones. Comment each inconsistency where it
   is declared.
3. `src/<gateway>/errors.ts` — every documented code, an envelope normaliser, and
   whatever date parsing the gateway's format needs.
4. `src/<gateway>/token-manager.ts` — only if it has tokens. Copy the bKash one's
   structure: rolling-window budget, single-flight de-duplication, circuit
   breaker.
5. `src/<gateway>/client.ts` — implements `PaymentProvider`, normalises into the
   core types, keeps the untouched response on `raw`.
6. `src/<gateway>/webhook.ts` — signature verification. Work out what actually
   signs the message before writing this.
7. Add the subpath to `exports` in `package.json` and an entry in `tsup.config.ts`.

## Things worth getting right early

**Never retry a money-moving call.** A create or execute that times out may well
have succeeded at the gateway. The recovery path is `getPayment`, not a second
attempt. `requestJson` defaults `retries` to 0 for that reason; raise it only for
reads and token calls.

**Find out what signs the webhook.** bKash uses Amazon SNS, so the signature is
RSA over a canonical string with the certificate named *inside the message* —
which has to be pinned to an Amazon host or it verifies nothing. Another gateway
may use an HMAC over the raw body, or nothing at all. If it is nothing, say so in
the README rather than implying a check exists.

**Keep the raw body raw.** Parsing and re-serialising a body invalidates every
signature scheme. Both adapters take the raw string for this reason.

**Test against the sandbox, not the docs.** Building bKash turned up a refund API
on a different path from the documented one, two undocumented live endpoints, two
mandatory fields documented as optional, a field renamed between endpoints, and a
timestamp format `new Date()` rejects. None of that was visible from the docs
alone. The pattern that found most of it: a request to a path that does not exist
answers `{"message":"Missing Authentication Token"}`, while a real path with a
bad token answers `{"message":"Unauthorized"}` — so you can map the real surface
before you have working credentials.

**Write the sandbox script.** `scripts/sandbox-smoke.ts` is what proves the
client works, as opposed to compiles. Unit tests with stubbed responses only
prove you handle the responses you imagined.
