/**
 * bKash tokenized checkout.
 *
 * ```ts
 * import { BkashClient, configFromEnv } from "paykit-bd/bkash";
 *
 * const bkash = new BkashClient(configFromEnv());
 * const payment = await bkash.createPayment({ amount: "500", reference: "ORD-1" });
 * ```
 */

export { BkashClient } from "./client.ts";
export type {
  BkashClientOptions,
  CreateAgreementInput,
  AgreementHandle,
  Agreement,
} from "./client.ts";

export {
  BKASH_HOSTS,
  BKASH_API_VERSION,
  BKASH_MODE,
  configFromEnv,
  resolveConfig,
  endpoints,
} from "./config.ts";
export type { BkashConfig, BkashEnvironment, BkashMode, ResolvedBkashConfig } from "./config.ts";

export {
  BkashError,
  BKASH_ERROR_CODES,
  ALREADY_SETTLED_CODES,
  CUSTOMER_FAULT_CODES,
  toBkashError,
  parseBkashTime,
  parseBkashCompactTime,
} from "./errors.ts";

export { BkashTokenManager } from "./token-manager.ts";

export {
  BkashWebhookVerifier,
  BKASH_TRANSACTION_TYPES,
  canonicalString,
  assertSnsUrl,
} from "./webhook.ts";
export type { SnsEnvelope, BkashIpnMessage, WebhookVerifierOptions } from "./webhook.ts";

export type {
  BkashIntent,
  BkashCallbackQuery,
  CreatePaymentRequest,
  CreatePaymentResponse,
  ExecutePaymentResponse,
  QueryPaymentResponse,
  AgreementResponse,
  RefundRequest,
  RefundResponse,
  RefundStatusResponse,
  GrantTokenResponse,
} from "./types.ts";
