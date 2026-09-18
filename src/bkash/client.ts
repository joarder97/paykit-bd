import { ConfigError } from "../core/errors.ts";
import { type Logger, noopLogger, requestJson } from "../core/http.ts";
import { toAmountString } from "../core/money.ts";
import type { PaymentProvider } from "../core/provider.ts";
import type { TokenStore } from "../core/token-store.ts";
import type {
  CreatePaymentInput,
  CreatedPayment,
  Payment,
  PaymentStatus,
  RawWebhookRequest,
  Refund,
  RefundInput,
  WebhookEvent,
} from "../core/types.ts";
import { BKASH_MODE, type BkashConfig, endpoints, resolveConfig, type ResolvedBkashConfig } from "./config.ts";
import { BkashError, parseBkashTime, toBkashError } from "./errors.ts";
import { BkashTokenManager } from "./token-manager.ts";
import type {
  AgreementResponse,
  BkashCallbackQuery,
  CreatePaymentResponse,
  ExecutePaymentResponse,
  QueryPaymentResponse,
  RefundResponse,
  RefundStatusResponse,
} from "./types.ts";
import { BkashWebhookVerifier, type WebhookVerifierOptions } from "./webhook.ts";

export interface BkashClientOptions {
  tokenStore?: TokenStore;
  logger?: Logger;
  webhook?: Omit<WebhookVerifierOptions, "logger">;
}

export interface CreateAgreementInput {
  /** The customer's wallet number. Pre-fills the bKash entry screen. */
  payerReference: string;
  callbackUrl?: string;
}

export interface AgreementHandle {
  paymentId: string;
  /** Send the customer here to enter their wallet number and OTP. */
  redirectUrl: string | null;
  status: string;
  raw: AgreementResponse;
}

export interface Agreement {
  agreementId: string;
  paymentId?: string;
  customerMsisdn?: string;
  payerReference?: string;
  status: string;
  createdAt?: Date;
  executedAt?: Date;
  raw: AgreementResponse;
}

/**
 * bKash tokenized checkout.
 *
 * Implements {@link PaymentProvider}, plus the agreement operations that have no
 * equivalent at other gateways.
 *
 * ```ts
 * const bkash = new BkashClient(configFromEnv());
 * const payment = await bkash.createPayment({ amount: "500", reference: "ORD-1" });
 * // send the customer to payment.redirectUrl, then when they come back:
 * const settled = await bkash.executePayment(payment.paymentId);
 * ```
 */
export class BkashClient implements PaymentProvider {
  readonly id = "bkash";
  readonly #config: ResolvedBkashConfig;
  readonly #urls: ReturnType<typeof endpoints>;
  readonly #tokens: BkashTokenManager;
  readonly #logger: Logger;
  readonly #verifier: BkashWebhookVerifier;

  constructor(config: BkashConfig, options: BkashClientOptions = {}) {
    this.#config = resolveConfig(config);
    this.#urls = endpoints(this.#config.origin);
    this.#logger = options.logger ?? config.logger ?? noopLogger;
    this.#tokens = new BkashTokenManager(this.#config, {
      store: options.tokenStore ?? config.tokenStore,
      logger: this.#logger,
    });
    this.#verifier = new BkashWebhookVerifier({
      topicArn: this.#config.webhookTopicArn,
      ...options.webhook,
      logger: this.#logger,
    });
  }

  /** Which environment and host this client is pointed at. */
  get environment(): { environment: string; origin: string } {
    return { environment: this.#config.environment, origin: this.#config.origin };
  }

  /** Token budget for the current rolling hour. */
  tokenBudget(): Promise<{ refreshesUsed: number; refreshesAllowed: number; acquisitionsUsed: number }> {
    return this.#tokens.budget();
  }

  /**
   * Force a token refresh, spending one unit of the hourly budget. Normal use
   * should leave this alone and let the client renew when it needs to; it is
   * here so the refresh path can be exercised deliberately.
   */
  refreshToken(): Promise<string> {
    return this.#tokens.refreshNow();
  }

  // ---------------------------------------------------------------- agreements

  /**
   * Step 1 of 2. Start an agreement so this customer can later pay with a PIN
   * alone. Send them to `redirectUrl`, then call {@link executeAgreement}.
   */
  async createAgreement(input: CreateAgreementInput): Promise<AgreementHandle> {
    const callbackURL = input.callbackUrl ?? this.#config.callbackUrl;
    if (!callbackURL) throw missingCallback();

    const raw = await this.#post<AgreementResponse>(this.#urls.create, {
      mode: BKASH_MODE.CREATE_AGREEMENT,
      payerReference: input.payerReference,
      callbackURL,
    });

    return {
      paymentId: raw.paymentID ?? "",
      redirectUrl: raw.bkashURL ?? null,
      status: raw.agreementStatus ?? "Initiated",
      raw,
    };
  }

  /**
   * Step 2 of 2. Call once the customer returns to your callback URL. The
   * `agreementID` it returns is what you store against the customer — it is the
   * whole point of the flow and bKash will not hand it to you again.
   */
  async executeAgreement(paymentId: string): Promise<Agreement> {
    const raw = await this.#post<AgreementResponse>(this.#urls.execute, { paymentID: paymentId });
    return this.#toAgreement(raw);
  }

  async getAgreement(agreementId: string): Promise<Agreement> {
    const raw = await this.#post<AgreementResponse>(this.#urls.queryAgreement, { agreementID: agreementId });
    return this.#toAgreement(raw);
  }

  /** Ends the agreement. The customer must go through the OTP flow again after this. */
  async cancelAgreement(agreementId: string): Promise<Agreement> {
    const raw = await this.#post<AgreementResponse>(this.#urls.cancelAgreement, { agreementID: agreementId });
    return this.#toAgreement(raw);
  }

  // ------------------------------------------------------------------ payments

  /**
   * Start a payment.
   *
   * Passing `extra.agreementID` charges an existing agreement (mode 0001) and
   * returns no `redirectUrl` — the customer confirms with a PIN in the bKash
   * app. Without it this is a one-off payment (mode 0011) and the customer must
   * be sent to `redirectUrl`.
   */
  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    const callbackURL = input.callbackUrl ?? this.#config.callbackUrl;
    if (!callbackURL) throw missingCallback();

    const agreementID = input.extra?.["agreementID"];
    const amount = toAmountString(input.amount);

    const raw = await this.#post<CreatePaymentResponse>(this.#urls.create, {
      mode: agreementID ? BKASH_MODE.AGREEMENT_PAYMENT : BKASH_MODE.ONE_OFF_PAYMENT,
      payerReference: input.payerReference ?? input.reference,
      callbackURL,
      amount,
      currency: input.currency ?? "BDT",
      intent: input.intent ?? "sale",
      merchantInvoiceNumber: input.reference,
      ...(agreementID ? { agreementID } : {}),
      ...(input.extra?.["merchantAssociationInfo"]
        ? { merchantAssociationInfo: input.extra["merchantAssociationInfo"] }
        : {}),
    });

    const createdAt = parseBkashTime(raw.paymentCreateTime);
    return {
      provider: this.id,
      paymentId: raw.paymentID ?? "",
      redirectUrl: raw.bkashURL ?? null,
      status: toStatus(raw.transactionStatus),
      amount: raw.amount ?? amount,
      currency: raw.currency ?? "BDT",
      reference: raw.merchantInvoiceNumber ?? input.reference,
      // A payment id is good for 24 hours and one execution.
      expiresAt: createdAt ? new Date(createdAt.getTime() + 24 * 60 * 60 * 1000) : undefined,
      raw,
    };
  }

  /**
   * Finalise a payment after the customer approves it. Valid exactly once per
   * payment id.
   *
   * If bKash answers that the payment was already executed, this reads the real
   * outcome with {@link getPayment} instead of throwing — that response means
   * the money moved, and the caller wants the result, not an error.
   */
  async executePayment(paymentId: string): Promise<Payment> {
    try {
      const raw = await this.#post<ExecutePaymentResponse>(this.#urls.execute, { paymentID: paymentId });
      return {
        provider: this.id,
        paymentId: raw.paymentID ?? paymentId,
        transactionId: raw.trxID ?? null,
        status: toStatus(raw.transactionStatus),
        amount: raw.amount ?? "",
        currency: raw.currency ?? "BDT",
        reference: raw.merchantInvoiceNumber,
        payerAccount: raw.customerMsisdn ?? raw.payerReference,
        completedAt: parseBkashTime(raw.paymentExecuteTime),
        raw,
      };
    } catch (error) {
      if (error instanceof BkashError && error.alreadySettled) {
        this.#logger.warn("paykit/bkash: payment already executed, reading current state", {
          paymentId,
          code: error.code,
        });
        return this.getPayment(paymentId);
      }
      throw error;
    }
  }

  /** Read current state. Safe to call as often as you like — this is the recovery path. */
  async getPayment(paymentId: string): Promise<Payment> {
    const raw = await this.#post<QueryPaymentResponse>(this.#urls.queryPayment, { paymentID: paymentId });
    return {
      provider: this.id,
      paymentId: raw.paymentID ?? paymentId,
      transactionId: raw.trxID ?? null,
      status: toStatus(raw.transactionStatus),
      amount: raw.amount ?? "",
      currency: raw.currency ?? "BDT",
      // The query endpoint calls it merchantInvoice; create and execute call it
      // merchantInvoiceNumber. Same field.
      reference: raw.merchantInvoice ?? raw.merchantInvoiceNumber,
      payerAccount: raw.customerMsisdn ?? raw.payerReference,
      completedAt: parseBkashTime(raw.paymentExecuteTime),
      raw,
    };
  }

  /** How much of this payment can still be refunded, per bKash. */
  async getRefundableAmount(paymentId: string): Promise<string | null> {
    const raw = await this.#post<QueryPaymentResponse>(this.#urls.queryPayment, { paymentID: paymentId });
    return raw.maxRefundableAmount ?? null;
  }

  // ------------------------------------------------------------------- refunds

  /**
   * Refund all or part of a completed payment.
   *
   * The v2 API allows up to ten partial refunds per transaction, within 60 days.
   * Omit `amount` for a full refund, which is read from bKash's own
   * `maxRefundableAmount` rather than assumed.
   */
  async refund(input: RefundInput): Promise<Refund> {
    const refundAmount = input.amount
      ? toAmountString(input.amount)
      : ((await this.getRefundableAmount(input.paymentId)) ?? undefined);

    if (!refundAmount) {
      throw new ConfigError(
        `bKash: no refund amount given and bKash reported no refundable balance for payment ${input.paymentId}.`,
        { provider: "bkash", code: "refund_amount_unknown" },
      );
    }

    const raw = await this.#post<RefundResponse>(this.#urls.refund, {
      // Note the lower-case d: the v2 refund API alone spells it paymentId.
      paymentId: input.paymentId,
      trxId: input.transactionId,
      refundAmount,
      // Both are always sent. They are mandatory at bKash's schema layer even
      // though the docs present them as optional, and leaving either out gets
      // you "Invalid request body" with no indication of which field is wrong.
      sku: input.sku?.trim() || "refund",
      reason: input.reason?.trim() || "Merchant refund",
    });

    return {
      provider: this.id,
      refundTransactionId: raw.refundTrxId ?? "",
      originalTransactionId: raw.originalTrxId ?? input.transactionId,
      status: toStatus(raw.refundTransactionStatus),
      amount: raw.refundAmount ?? refundAmount,
      currency: raw.currency ?? "BDT",
      completedAt: parseBkashTime(raw.completedTime),
      raw,
    };
  }

  /** Every refund recorded against one transaction. */
  async getRefunds(input: { paymentId: string; transactionId: string }): Promise<{
    originalTransactionId: string;
    originalAmount: string;
    refunds: Refund[];
    raw: RefundStatusResponse;
  }> {
    const raw = await this.#post<RefundStatusResponse>(this.#urls.refundStatus, {
      paymentId: input.paymentId,
      trxId: input.transactionId,
    });

    return {
      originalTransactionId: raw.originalTrxId ?? input.transactionId,
      originalAmount: raw.originalTrxAmount ?? "",
      refunds: (raw.refundTransactions ?? []).map((entry) => ({
        provider: this.id,
        refundTransactionId: entry.refundTrxId ?? "",
        originalTransactionId: raw.originalTrxId ?? input.transactionId,
        status: toStatus(entry.refundTransactionStatus),
        amount: entry.refundAmount ?? "",
        currency: "BDT",
        completedAt: parseBkashTime(entry.completedTime),
        raw: entry,
      })),
      raw,
    };
  }

  // ------------------------------------------------------------------ webhooks

  /** Verify an inbound IPN message and normalise it. Throws if it is not genuine. */
  verifyWebhook(request: RawWebhookRequest): Promise<WebhookEvent> {
    return this.#verifier.verify(request);
  }

  get webhooks(): BkashWebhookVerifier {
    return this.#verifier;
  }

  /**
   * Read the query string bKash appends when it redirects a customer back.
   *
   * Nothing here is proof of payment — it is a URL the customer's own browser
   * followed and could have edited. Always confirm with {@link executePayment}
   * or {@link getPayment} before releasing an order.
   */
  static parseCallback(input: string | URL | URLSearchParams | Record<string, string>): BkashCallbackQuery {
    const params =
      input instanceof URLSearchParams
        ? input
        : typeof input === "string"
          ? new URL(input, "https://placeholder.invalid").searchParams
          : input instanceof URL
            ? input.searchParams
            : new URLSearchParams(input);

    return {
      paymentID: params.get("paymentID") ?? params.get("paymentId") ?? undefined,
      status: params.get("status") ?? undefined,
      signature: params.get("signature") ?? undefined,
      apiVersion: params.get("apiVersion") ?? params.get("version") ?? undefined,
      product: params.get("product") ?? undefined,
    };
  }

  // ------------------------------------------------------------------ internal

  #toAgreement(raw: AgreementResponse): Agreement {
    return {
      agreementId: raw.agreementID ?? "",
      paymentId: raw.paymentID,
      customerMsisdn: raw.customerMsisdn,
      payerReference: raw.payerReference,
      status: raw.agreementStatus ?? "Unknown",
      createdAt: parseBkashTime(raw.agreementCreateTime),
      executedAt: parseBkashTime(raw.agreementExecuteTime),
      raw,
    };
  }

  /**
   * One POST, with the token attached and the four bKash error envelopes turned
   * into a thrown BkashError.
   *
   * `retries` stays 0: a create or execute that times out may well have
   * succeeded at bKash, so the safe recovery is getPayment, never a second
   * attempt. The single exception is a 401, which means the token died early —
   * that is retried once with a fresh token.
   */
  async #post<T>(url: string, body: Record<string, unknown>, isRetry = false): Promise<T> {
    const token = await this.#tokens.getToken();

    const { body: parsed, status } = await requestJson<T>(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          authorization: token,
          "x-app-key": this.#config.appKey,
        },
        json: body,
        timeoutMs: this.#config.timeoutMs,
        retries: 0,
      },
      { provider: "bkash", logger: this.#logger },
    );

    const error = toBkashError(parsed, status);
    if (error) {
      if (!isRetry && error instanceof BkashError && error.code === "unauthorized") {
        this.#logger.warn("paykit/bkash: token rejected, acquiring a new one and retrying once", { url });
        await this.#tokens.invalidate();
        return this.#post<T>(url, body, true);
      }
      throw error;
    }
    return parsed;
  }
}

function toStatus(value: string | undefined): PaymentStatus {
  switch ((value ?? "").toLowerCase()) {
    case "completed":
      return "completed";
    case "initiated":
      return "initiated";
    case "pending":
    case "processing":
      return "pending";
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "failed":
      return "failed";
    default:
      return value ? "pending" : "initiated";
  }
}

function missingCallback(): ConfigError {
  return new ConfigError(
    "bKash: no callback URL. Set `callbackUrl` on the client config (or BKASH_CALLBACK_URL), " +
      "or pass `callbackUrl` on the call.",
    { provider: "bkash", code: "missing_callback_url" },
  );
}
