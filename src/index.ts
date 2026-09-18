/**
 * paykit-bd — provider-neutral core.
 *
 * Import a gateway from its own subpath: `paykit-bd/bkash`.
 */

export {
  PaykitError,
  ProviderError,
  NetworkError,
  ConfigError,
  WebhookVerificationError,
  RateLimitError,
} from "./core/errors.ts";

export {
  toPoisha,
  fromPoisha,
  toAmountString,
  compareAmount,
  addAmount,
  subtractAmount,
  sumAmounts,
} from "./core/money.ts";

export { requestJson, redactHeaders, noopLogger } from "./core/http.ts";
export type { Logger, HttpResponse, RequestOptions } from "./core/http.ts";

export { MemoryTokenStore, createKvTokenStore } from "./core/token-store.ts";
export type { TokenStore, TokenRecord, KvLike } from "./core/token-store.ts";

export { isPaymentProvider } from "./core/provider.ts";
export type { PaymentProvider } from "./core/provider.ts";

export type {
  PaymentStatus,
  PaymentIntent,
  CreatePaymentInput,
  CreatedPayment,
  Payment,
  RefundInput,
  Refund,
  WebhookEvent,
  WebhookEventType,
  RawWebhookRequest,
} from "./core/types.ts";
