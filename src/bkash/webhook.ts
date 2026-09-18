import { createVerify } from "node:crypto";
import { WebhookVerificationError } from "../core/errors.ts";
import { type Logger, noopLogger } from "../core/http.ts";
import type { RawWebhookRequest, WebhookEvent } from "../core/types.ts";
import { parseBkashCompactTime } from "./errors.ts";

/**
 * bKash's Instant Payment Notification is delivered by Amazon SNS, so the thing
 * that has to be verified is an SNS message signature — not an HMAC of the body,
 * which is what most bKash integrations assume and skip.
 *
 * The check that actually matters is `SigningCertURL`. The signature is verified
 * against a certificate fetched from a URL *inside the message*, so a verifier
 * that does not pin that URL to an Amazon SNS host will happily fetch an
 * attacker's certificate and confirm the attacker's own signature over a forged
 * "payment completed" — a free-order bug with a valid-looking audit trail.
 */

const SNS_CERT_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i;

export interface SnsEnvelope {
  Type?: string;
  MessageId?: string;
  TopicArn?: string;
  Subject?: string;
  Message?: string;
  Timestamp?: string;
  SignatureVersion?: string;
  Signature?: string;
  SigningCertURL?: string;
  SubscribeURL?: string;
  Token?: string;
  UnsubscribeURL?: string;
}

/** The JSON string inside `Message` for a payment notification. */
export interface BkashIpnMessage {
  dateTime?: string;
  debitMSISDN?: string;
  creditOrganizationName?: string;
  creditShortCode?: string;
  trxID?: string;
  transactionStatus?: string;
  transactionType?: string;
  amount?: string;
  currency?: string;
  transactionReference?: string;
  merchantInvoiceNumber?: string;
  /** Coupon-funded payments carry three extra fields. */
  couponAmount?: string;
  merchantShareAmount?: string;
  saleAmount?: string;
}

/** bKash's numeric transactionType codes, as published with the IPN docs. */
export const BKASH_TRANSACTION_TYPES: Record<string, string> = {
  "10002294": "Payment via API",
  "10003126": "Payment via QR",
  "10002175": "Payment via USSD",
  "10002809": "Voucher Redeem",
  "10002264": "M2M Payment via API",
  "10003209": "M2M Payment via QR",
  "10002177": "M2M Payment via USSD",
  "10003476": "Bank Payment",
  "10003237": "B2B Collection",
};

export interface WebhookVerifierOptions {
  /**
   * Accept messages only from these SNS topic ARNs. Leave unset and any topic
   * with a valid Amazon signature is accepted — which includes topics belonging
   * to someone else's merchant account. Pin it: the ARN is in the TopicArn field
   * of the first message you receive.
   */
  topicArn?: string | string[];
  /**
   * Reject messages older than this. Unset by default, because SNS legitimately
   * retries for days and a tight window silently drops real payments. Make the
   * handler idempotent on `eventId` instead.
   */
  maxAgeMs?: number;
  /** How long a fetched signing certificate is reused. Default 24h. */
  certCacheMs?: number;
  logger?: Logger;
  /** Injected in tests. Defaults to `fetch`. */
  fetchImpl?: typeof fetch;
}

interface CachedCert {
  pem: string;
  fetchedAt: number;
}

export class BkashWebhookVerifier {
  readonly #options: WebhookVerifierOptions;
  readonly #logger: Logger;
  readonly #fetch: typeof fetch;
  readonly #certCache = new Map<string, CachedCert>();

  constructor(options: WebhookVerifierOptions = {}) {
    this.#options = options;
    this.#logger = options.logger ?? noopLogger;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /**
   * Verify an inbound request and normalise it.
   *
   * `request.body` must be the raw bytes as received. A body that has been
   * parsed and re-serialised will not match the signature.
   */
  async verify(request: RawWebhookRequest): Promise<WebhookEvent> {
    const envelope = this.#parseEnvelope(request.body);
    await this.#verifySignature(envelope);
    this.#checkTopic(envelope);
    this.#checkAge(envelope);
    return this.#normalise(envelope);
  }

  /**
   * Confirm an SNS subscription by visiting its SubscribeURL.
   *
   * Deliberately not automatic: it is an outbound call that switches on real
   * payment traffic, so your handler decides when to make it. Verify the
   * message first — this method re-checks the URL host but assumes the
   * signature was already proven.
   */
  async confirmSubscription(envelope: SnsEnvelope): Promise<void> {
    const url = envelope.SubscribeURL;
    if (!url) {
      throw new WebhookVerificationError("bKash: subscription confirmation has no SubscribeURL", {
        provider: "bkash",
        code: "missing_subscribe_url",
        raw: envelope,
      });
    }
    assertSnsUrl(url, "SubscribeURL");
    const response = await this.#fetch(url, { method: "GET" });
    if (!response.ok) {
      throw new WebhookVerificationError(
        `bKash: SNS subscription confirmation failed with HTTP ${response.status}`,
        { provider: "bkash", code: "subscribe_failed", raw: await response.text().catch(() => "") },
      );
    }
    this.#logger.debug("paykit/bkash: SNS subscription confirmed", { topicArn: envelope.TopicArn });
  }

  /** Parse an already-verified envelope's inner payment message. */
  static parseMessage(envelope: SnsEnvelope): BkashIpnMessage | null {
    if (!envelope.Message) return null;
    try {
      return JSON.parse(envelope.Message) as BkashIpnMessage;
    } catch {
      return null;
    }
  }

  #parseEnvelope(body: string): SnsEnvelope {
    if (!body || body.trim() === "") {
      throw new WebhookVerificationError("bKash: empty webhook body", {
        provider: "bkash",
        code: "empty_body",
      });
    }
    try {
      return JSON.parse(body) as SnsEnvelope;
    } catch (cause) {
      throw new WebhookVerificationError("bKash: webhook body is not JSON", {
        provider: "bkash",
        code: "invalid_body",
        raw: body.slice(0, 500),
        cause,
      });
    }
  }

  async #verifySignature(envelope: SnsEnvelope): Promise<void> {
    const { Signature, SignatureVersion, SigningCertURL, Type } = envelope;
    if (!Signature || !SigningCertURL || !Type) {
      throw new WebhookVerificationError(
        "bKash: webhook is missing Type, Signature or SigningCertURL — it is not an SNS message",
        { provider: "bkash", code: "not_sns", raw: envelope },
      );
    }

    const algorithm = SignatureVersion === "2" ? "RSA-SHA256" : "RSA-SHA1";
    if (SignatureVersion !== "1" && SignatureVersion !== "2") {
      throw new WebhookVerificationError(
        `bKash: unsupported SNS SignatureVersion ${JSON.stringify(SignatureVersion)}`,
        { provider: "bkash", code: "unsupported_signature_version", raw: envelope },
      );
    }

    assertSnsUrl(SigningCertURL, "SigningCertURL");
    const pem = await this.#loadCertificate(SigningCertURL);
    const canonical = canonicalString(envelope);

    let valid: boolean;
    try {
      valid = createVerify(algorithm).update(canonical, "utf8").verify(pem, Signature, "base64");
    } catch (cause) {
      throw new WebhookVerificationError("bKash: SNS signature could not be checked", {
        provider: "bkash",
        code: "signature_check_failed",
        cause,
      });
    }

    if (!valid) {
      throw new WebhookVerificationError(
        "bKash: SNS signature does not match the message. Treat the payload as forged, " +
          "and check that the raw request body reached the verifier unmodified.",
        { provider: "bkash", code: "signature_mismatch" },
      );
    }
  }

  #checkTopic(envelope: SnsEnvelope): void {
    const expected = this.#options.topicArn;
    if (!expected) {
      this.#logger.warn(
        "paykit/bkash: webhook accepted without a pinned topicArn — any Amazon-signed SNS topic will pass",
      );
      return;
    }
    const allowed = Array.isArray(expected) ? expected : [expected];
    if (!envelope.TopicArn || !allowed.includes(envelope.TopicArn)) {
      throw new WebhookVerificationError(
        `bKash: message came from SNS topic ${JSON.stringify(envelope.TopicArn)}, which is not one of yours`,
        { provider: "bkash", code: "topic_mismatch", raw: envelope.TopicArn },
      );
    }
  }

  #checkAge(envelope: SnsEnvelope): void {
    const maxAgeMs = this.#options.maxAgeMs;
    if (!maxAgeMs || !envelope.Timestamp) return;
    const sent = new Date(envelope.Timestamp).getTime();
    if (Number.isNaN(sent)) return;
    if (Date.now() - sent > maxAgeMs) {
      throw new WebhookVerificationError(
        `bKash: message is older than the configured maxAgeMs (${maxAgeMs}ms)`,
        { provider: "bkash", code: "message_too_old", raw: envelope.Timestamp },
      );
    }
  }

  #normalise(envelope: SnsEnvelope): WebhookEvent {
    const base = {
      provider: "bkash" as const,
      eventId: envelope.MessageId,
      raw: envelope,
    };

    if (envelope.Type === "SubscriptionConfirmation" || envelope.Type === "UnsubscribeConfirmation") {
      return { ...base, type: "subscription.confirmation" };
    }

    const message = BkashWebhookVerifier.parseMessage(envelope);
    if (!message) return { ...base, type: "unknown" };

    const completed = (message.transactionStatus ?? "").toLowerCase() === "completed";
    return {
      ...base,
      type: completed ? "payment.completed" : "payment.failed",
      transactionId: message.trxID,
      reference: message.merchantInvoiceNumber ?? message.transactionReference,
      amount: message.amount,
      currency: message.currency ?? "BDT",
      payerAccount: message.debitMSISDN,
      occurredAt: parseBkashCompactTime(message.dateTime),
    };
  }

  async #loadCertificate(url: string): Promise<string> {
    const ttl = this.#options.certCacheMs ?? 24 * 60 * 60 * 1000;
    const cached = this.#certCache.get(url);
    if (cached && Date.now() - cached.fetchedAt < ttl) return cached.pem;

    const response = await this.#fetch(url, { method: "GET", signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new WebhookVerificationError(
        `bKash: could not fetch the SNS signing certificate (HTTP ${response.status})`,
        { provider: "bkash", code: "cert_fetch_failed", raw: url },
      );
    }
    const pem = await response.text();
    // A certificate is what SNS actually serves; a bare public key verifies
    // identically and is what the tests generate. Neither is a trust decision —
    // the trust came from the host check above and from HTTPS.
    if (!pem.includes("BEGIN CERTIFICATE") && !pem.includes("BEGIN PUBLIC KEY")) {
      throw new WebhookVerificationError("bKash: SigningCertURL did not return a PEM certificate", {
        provider: "bkash",
        code: "cert_invalid",
        raw: pem.slice(0, 200),
      });
    }
    this.#certCache.set(url, { pem, fetchedAt: Date.now() });
    return pem;
  }
}

/**
 * The exact byte sequence SNS signed: each present field as `name\nvalue\n`, in
 * this order. Field order and the choice of fields are part of the signature —
 * changing either makes every message fail to verify.
 */
export function canonicalString(envelope: SnsEnvelope): string {
  const fields =
    envelope.Type === "SubscriptionConfirmation" || envelope.Type === "UnsubscribeConfirmation"
      ? (["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const)
      : (["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const);

  let canonical = "";
  for (const field of fields) {
    const value = envelope[field as keyof SnsEnvelope];
    if (value === undefined || value === null) continue;
    canonical += `${field}\n${value}\n`;
  }
  return canonical;
}

/** Reject any URL that is not an Amazon SNS certificate or confirmation endpoint. */
export function assertSnsUrl(rawUrl: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookVerificationError(`bKash: ${field} is not a URL`, {
      provider: "bkash",
      code: "cert_url_invalid",
      raw: rawUrl,
    });
  }
  if (url.protocol !== "https:") {
    throw new WebhookVerificationError(`bKash: ${field} must be https`, {
      provider: "bkash",
      code: "cert_url_insecure",
      raw: rawUrl,
    });
  }
  if (!SNS_CERT_HOST.test(url.hostname)) {
    throw new WebhookVerificationError(
      `bKash: ${field} points at ${url.hostname}, which is not an Amazon SNS host. ` +
        `This is what a forged notification looks like — the payload is not from bKash.`,
      { provider: "bkash", code: "cert_url_untrusted", raw: rawUrl },
    );
  }
  if (field === "SigningCertURL" && !url.pathname.endsWith(".pem")) {
    throw new WebhookVerificationError(`bKash: ${field} does not point at a .pem file`, {
      provider: "bkash",
      code: "cert_url_invalid",
      raw: rawUrl,
    });
  }
  return url;
}
