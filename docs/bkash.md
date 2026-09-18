# bKash tokenized checkout — reference

Distilled from [developer.bka.sh](https://developer.bka.sh) and corrected against
the live sandbox. Where the two disagree, the sandbox wins and the difference is
noted.

## Endpoints

`origin` is `https://tokenized.sandbox.bka.sh` or `https://tokenized.pay.bka.sh`.
Everything except the refund API sits under `origin/v1.2.0-beta`.

| Purpose | Method | Path |
| --- | --- | --- |
| Grant token | POST | `/v1.2.0-beta/tokenized/checkout/token/grant` |
| Refresh token | POST | `/v1.2.0-beta/tokenized/checkout/token/refresh` |
| Create agreement or payment | POST | `/v1.2.0-beta/tokenized/checkout/create` |
| Execute agreement or payment | POST | `/v1.2.0-beta/tokenized/checkout/execute` |
| Query payment | POST | `/v1.2.0-beta/tokenized/checkout/payment/status` |
| Query agreement † | POST | `/v1.2.0-beta/tokenized/checkout/agreement/status` |
| Cancel agreement † | POST | `/v1.2.0-beta/tokenized/checkout/agreement/cancel` |
| Refund (v2) | POST | `/v2/tokenized-checkout/refund/payment/transaction` |
| Refund status (v2) | POST | `/v2/tokenized-checkout/refund/payment/status` |
| Refund (pre-v2) | POST | `/v1.2.0-beta/tokenized/checkout/payment/refund` |

† Not in bKash's published docs index, but live: both answer `2051 Invalid
Agreement ID` for a bad id, rather than a routing error.

**The refund API hangs off the host root, not off the version segment.** The path
carries its own `/v2`. `origin/v1.2.0-beta/v2/tokenized-checkout/...` answers
`{"message":"Missing Authentication Token"}`, which is API Gateway for "no such
route" — a useful way to tell a wrong path from a wrong credential, since a real
route with a bad token gives `401 {"message":"Unauthorized"}`.

There is **no search-transaction endpoint on the tokenized product**. It exists
only on the non-tokenized checkout family (`/checkout/payment/search/{trxID}`).
Use query payment and refund status instead.

## Headers

Token endpoints take `username` and `password` as headers, with `app_key` and
`app_secret` in the body. Every other endpoint takes:

```
Content-Type: application/json
Accept: application/json
authorization: <id_token>        ← the raw token, with no "Bearer " prefix
x-app-key: <app_key>
```

The token response says `token_type: "Bearer"`. The sandbox accepts the header
either way — bare token or `Bearer <token>` — so this is one thing you cannot get
wrong. This client sends it bare, as bKash's own samples do.

## Modes

`/tokenized/checkout/create` does three different things depending on `mode`:

| Mode | What it does | Returns `bkashURL`? |
| --- | --- | --- |
| `0000` | Create an agreement. No money moves. | Yes — wallet number and OTP |
| `0001` | Charge an existing `agreementID`. | No — customer confirms with a PIN |
| `0011` | One-off payment, no agreement. | Yes — full bKash flow |

`intent` is `sale` (capture now) or `authorization` (hold, capture later).

## Token lifecycle

Tokens last 3600 seconds. bKash's guidance is to renew at the 50th–55th minute.

> Do not call this API more than two times within an hour. If you exceed this
> limit, the API will return an error, and you will be blocked for one hour.

That is about the **Refresh Token** API, and the block is on the merchant
account. Two consequences worth designing around:

1. **The budget is not per-process.** Two instances, or a serverless function
   that cold-starts per request, will each believe they have a fresh budget.
   A shared token store is the fix, not a longer cache.
2. **Grant is a legitimate alternative.** bKash's own token guide names Grant
   Token as an option for renewal, so once the refresh budget is spent, granting
   a new token is correct rather than a workaround.

`BkashTokenManager` implements exactly that, plus a circuit breaker at ten
acquisitions per rolling hour — a runaway loop should fail locally, not earn an
hour-long block.

## Error envelopes

Four shapes, all observed in the sandbox:

```jsonc
// 1. Tokenized checkout endpoints. HTTP 200 — a 200 is not success.
{ "statusCode": "2002", "statusMessage": "Invalid Payment ID" }

// 2. Documented for create and execute.
{ "errorCode": "2051", "errorMessage": "Invalid Agreement ID" }

// 3. The v2 refund API only. HTTP 400. Shares no field names with the others.
{ "internalCode": "invalid_payment_id", "externalCode": "2002",
  "errorMessageEn": "Invalid Payment ID", "errorMessageBn": null }

// 4. The AWS API Gateway in front of bKash, before any bKash logic runs.
{ "message": "Unauthorized" }        // HTTP 401 — bad or expired token
{ "message": "Invalid request body" } // HTTP 400 — failed bKash's schema
```

Envelope 4's `Invalid request body` is the one that wastes an afternoon: it names
no field. On the refund API it usually means `sku` or `reason` is missing.

`statusCode: "0000"` is the only success value. Full code list in
[`src/bkash/errors.ts`](../src/bkash/errors.ts).

Three groupings the client exposes, because they need different handling:

- **already settled** (`2062`, `2068`, `2116`, `2117`, `2119`) — the money moved.
  Re-query; do not treat the order as failed.
- **customer fault** (wrong PIN, insufficient balance, expired OTP…) — show it,
  do not page anyone.
- **retryable** (`2003`, `2020`, `2024`) — transient at bKash's end.

## Field names that change between endpoints

| Thing | Create / Execute | Query | Refund v2 |
| --- | --- | --- | --- |
| Payment id | `paymentID` | `paymentID` | `paymentId` |
| Transaction id | `trxID` | `trxID` | `trxId` |
| Your order id | `merchantInvoiceNumber` | `merchantInvoice` | — |

## Timestamps

```
2026-09-18T06:00:19:952 GMT+0600   create, execute, query
2024-06-13T16:27:24:000            refund API — no offset at all
20180419122246                     webhook dateTime (YYYYMMDDHHmmss)
```

The first is not ISO 8601: the separator before the milliseconds is a colon, and
`new Date()` returns `Invalid Date`. A missing offset means Bangladesh time
(UTC+6). `parseBkashTime` and `parseBkashCompactTime` handle all three.

## Undocumented but returned

- `maxRefundableAmount` on query payment — what is still refundable after any
  earlier partial refunds. Use it rather than assuming the original amount.
- `verificationStatus` on query payment — `Incomplete` until the customer has
  authorised.
- `signature` on the callback redirect, from v1.2.0-beta. bKash publishes no way
  to verify it, so treat it as opaque and confirm the payment through the API.

## Refunds

- v2 allows up to ten partial refunds per transaction until the total is reached.
  The pre-v2 API allowed one.
- 60 days from the original transaction.
- Funded from the merchant's current collection balance.
- **`sku` and `reason` are both mandatory**, despite reading as optional. Verified:
  the identical request succeeds with both present and fails with either missing.

## IPN webhooks

Delivered by Amazon SNS, which means:

- The body is an SNS envelope; your payment data is a **JSON string inside
  `Message`**, not the body itself.
- `Content-Type` is `text/plain; charset=UTF-8`, so JSON body parsers skip it.
- Verification is an RSA signature over a canonical string, checked against a
  certificate fetched from `SigningCertURL`. **Pin that URL to
  `sns.<region>.amazonaws.com` before fetching it** — it comes from inside the
  message, so an unpinned verifier validates the attacker's own signature.
- `SignatureVersion` `1` is SHA1, `2` is SHA256.
- The first message is a `SubscriptionConfirmation` that must be acknowledged by
  visiting its `SubscribeURL` before any payment notification arrives.
- SNS retries for days. Don't reject on age — make the handler idempotent on
  `MessageId`.
- Notifications arrive for completed payments across every channel: API, QR,
  `*247#`, the bKash app.

Coupon-funded payments carry `couponAmount`, `merchantShareAmount` and
`saleAmount`, where `amount` is what bKash settles and `saleAmount` is what the
customer ordered. Reconcile against `saleAmount`.

`transactionReference` is only populated for checkout-iframe and customer-app
payments. Use `merchantInvoiceNumber` as the join key.

## Sandbox

```
origin      https://tokenized.sandbox.bka.sh
username    sandboxTokenizedUser02
password    sandboxTokenizedUser02@12345
app_key     4f6o0cjiki2rfm34kfdadl1eqq
app_secret  2is7hdktrekvrbljjh44ll3d9l1dtjo4pasmjvs5vl5qr3fug4b
```

bKash's own published demo credentials, shared by every merchant testing against
the sandbox. `pnpm smoke` uses them when no `BKASH_*` variables are set.
