import { ConfigError } from "../core/errors.ts";
import type { Logger } from "../core/http.ts";
import type { TokenStore } from "../core/token-store.ts";

export type BkashEnvironment = "sandbox" | "live";

/**
 * Hosts are the published tokenized-checkout endpoints, confirmed against the
 * sandbox. If bKash issued you a different host during onboarding, set
 * `baseUrl` and it wins over `environment`.
 */
export const BKASH_HOSTS: Record<BkashEnvironment, string> = {
  sandbox: "https://tokenized.sandbox.bka.sh",
  live: "https://tokenized.pay.bka.sh",
};

/** The version segment the checkout and agreement endpoints sit under. */
export const BKASH_API_VERSION = "v1.2.0-beta";

/**
 * bKash mode codes. They select what `/tokenized/checkout/create` actually does,
 * and getting one wrong is the most common integration bug.
 */
export const BKASH_MODE = {
  /** Create an agreement — no money moves, you get an agreementID back. */
  CREATE_AGREEMENT: "0000",
  /** Charge an existing agreement. Customer confirms with a PIN only. */
  AGREEMENT_PAYMENT: "0001",
  /** One-off payment, no agreement. Customer is redirected to bKash. */
  ONE_OFF_PAYMENT: "0011",
} as const;

export type BkashMode = (typeof BKASH_MODE)[keyof typeof BKASH_MODE];

export interface BkashConfig {
  /** Picks the base URL. Ignored when `baseUrl` is set. */
  environment?: BkashEnvironment;
  /** Host origin override, e.g. `https://tokenized.sandbox.bka.sh`. No trailing path. */
  baseUrl?: string;
  username: string;
  password: string;
  appKey: string;
  appSecret: string;
  /** Default redirect target after the customer approves, fails or cancels. */
  callbackUrl?: string;

  /**
   * Where tokens live between calls. Defaults to an in-process store, which is
   * only safe for a single instance — see {@link TokenStore}.
   */
  tokenStore?: TokenStore;
  /**
   * Namespaces the stored token. Change it if one process serves more than one
   * bKash merchant account. Defaults to a hash of the app key.
   */
  tokenKey?: string;
  /**
   * Refresh the token this long before it actually expires. bKash suggests the
   * 50th–55th minute of a 60-minute token; default is 10 minutes of headroom.
   */
  refreshSkewMs?: number;
  /**
   * Hard ceiling on token acquisitions per rolling hour. bKash blocks the
   * merchant for an hour past two refreshes, so the default leaves no slack.
   * Raise it only if bKash has told you your limit differs.
   */
  maxRefreshesPerHour?: number;

  /** Per-request timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Pin the SNS topic your IPN messages arrive on. Strongly recommended. */
  webhookTopicArn?: string;
  logger?: Logger;
}

export interface ResolvedBkashConfig extends Required<Omit<BkashConfig, "logger" | "tokenStore" | "callbackUrl" | "webhookTopicArn" | "baseUrl">> {
  origin: string;
  callbackUrl?: string;
  webhookTopicArn?: string;
}

/** Full URLs for every endpoint, derived from one origin. */
export function endpoints(origin: string) {
  const versioned = `${origin}/${BKASH_API_VERSION}`;
  return {
    grantToken: `${versioned}/tokenized/checkout/token/grant`,
    refreshToken: `${versioned}/tokenized/checkout/token/refresh`,
    /** Serves agreement creation and both payment modes; `mode` decides which. */
    create: `${versioned}/tokenized/checkout/create`,
    /** Finalises whatever `create` started, agreement or payment. */
    execute: `${versioned}/tokenized/checkout/execute`,
    queryPayment: `${versioned}/tokenized/checkout/payment/status`,
    // Undocumented in the public index but live in sandbox: both answer
    // "2051 Invalid Agreement ID" for a bad id rather than a routing error.
    queryAgreement: `${versioned}/tokenized/checkout/agreement/status`,
    cancelAgreement: `${versioned}/tokenized/checkout/agreement/cancel`,
    // The v2 refund API hangs off the host root, not off the version segment.
    // Probing the sandbox confirms it: the versioned path answers "Missing
    // Authentication Token", which is API Gateway for "no such route".
    refund: `${origin}/v2/tokenized-checkout/refund/payment/transaction`,
    refundStatus: `${origin}/v2/tokenized-checkout/refund/payment/status`,
    /** Pre-v2 refund, still provisioned for some merchants. */
    legacyRefund: `${versioned}/tokenized/checkout/payment/refund`,
  };
}

export function resolveConfig(config: BkashConfig): ResolvedBkashConfig {
  const missing = (["username", "password", "appKey", "appSecret"] as const).filter(
    (key) => !config[key] || String(config[key]).trim() === "",
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `bKash: missing required credential${missing.length > 1 ? "s" : ""} ${missing.join(", ")}. ` +
        `These are issued by bKash during merchant onboarding.`,
      { provider: "bkash", code: "missing_credentials" },
    );
  }

  const environment = config.environment ?? "sandbox";
  if (!config.baseUrl && !(environment in BKASH_HOSTS)) {
    throw new ConfigError(`bKash: unknown environment ${JSON.stringify(environment)}; expected "sandbox" or "live".`, {
      provider: "bkash",
      code: "invalid_environment",
    });
  }

  const origin = stripTrailingSlash(config.baseUrl ?? BKASH_HOSTS[environment]);

  return {
    environment,
    origin,
    username: config.username,
    password: config.password,
    appKey: config.appKey,
    appSecret: config.appSecret,
    callbackUrl: config.callbackUrl,
    tokenKey: config.tokenKey ?? `bkash:${environment}:${config.appKey.slice(0, 12)}`,
    refreshSkewMs: config.refreshSkewMs ?? 10 * 60 * 1000,
    maxRefreshesPerHour: config.maxRefreshesPerHour ?? 2,
    timeoutMs: config.timeoutMs ?? 30_000,
    webhookTopicArn: config.webhookTopicArn,
  };
}

/**
 * Build a config from process.env. Reads BKASH_ENV, BKASH_USERNAME,
 * BKASH_PASSWORD, BKASH_APP_KEY, BKASH_APP_SECRET, BKASH_BASE_URL,
 * BKASH_CALLBACK_URL and BKASH_WEBHOOK_TOPIC_ARN.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): BkashConfig {
  const environment = (env["BKASH_ENV"] ?? "sandbox") as BkashEnvironment;
  return {
    environment,
    baseUrl: env["BKASH_BASE_URL"],
    username: env["BKASH_USERNAME"] ?? "",
    password: env["BKASH_PASSWORD"] ?? "",
    appKey: env["BKASH_APP_KEY"] ?? "",
    appSecret: env["BKASH_APP_SECRET"] ?? "",
    callbackUrl: env["BKASH_CALLBACK_URL"],
    webhookTopicArn: env["BKASH_WEBHOOK_TOPIC_ARN"],
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
