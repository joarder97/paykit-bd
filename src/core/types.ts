/**
 * The provider-neutral shapes. Every gateway client normalises into these, so
 * application code can switch bKash for Nagad without rewriting order handling,
 * while `raw` always keeps the untouched gateway response for the cases where
 * the normalisation is not enough.
 */

export type PaymentStatus = "initiated" | "pending" | "completed" | "failed" | "cancelled";

export type PaymentIntent = "sale" | "authorization";

export interface CreatePaymentInput {
  /** BDT. Accepts "12.50" or 12.5; normalised to a 2-decimal string. */
  amount: string | number;
  /** Your order or invoice id. Reaches the gateway and comes back on the webhook. */
  reference: string;
  /**
   * Identifies the payer to the gateway. For bKash, passing the wallet number
   * pre-fills it on the bKash entry screen.
   */
  payerReference?: string;
  /** Overrides the client's configured callback URL for this payment only. */
  callbackUrl?: string;
  /** `"sale"` captures immediately; `"authorization"` holds funds for later capture. */
  intent?: PaymentIntent;
  currency?: "BDT";
  /** Provider-specific extras, passed through untouched. */
  extra?: Record<string, string>;
}

export interface CreatedPayment {
  provider: string;
  /** Gateway id for this attempt. Store it against your order before redirecting. */
  paymentId: string;
  /**
   * Where to send the customer. `null` when the flow needs no redirect — a bKash
   * agreement payment, for instance, is authorised with a PIN alone.
   */
  redirectUrl: string | null;
  status: PaymentStatus;
  amount: string;
  currency: string;
  reference?: string;
  /** When the gateway stops accepting this payment id. bKash: 24 hours. */
  expiresAt?: Date;
  raw: unknown;
}

export interface Payment {
  provider: string;
  paymentId: string;
  /** The financial transaction id, present once money has actually moved. */
  transactionId: string | null;
  status: PaymentStatus;
  amount: string;
  currency: string;
  reference?: string;
  /** Payer's wallet or account number, when the gateway discloses it. */
  payerAccount?: string;
  completedAt?: Date;
  raw: unknown;
}

export interface RefundInput {
  paymentId: string;
  /** The original transaction id, not the payment id. */
  transactionId: string;
  /** Omit for a full refund — the provider reads the refundable balance itself. */
  amount?: string | number;
  /** Free text kept on the refund record. A default is substituted if omitted. */
  reason?: string;
  /** Item identifier. A default is substituted if omitted. */
  sku?: string;
}

export interface Refund {
  provider: string;
  refundTransactionId: string;
  originalTransactionId: string;
  status: PaymentStatus;
  amount: string;
  currency: string;
  completedAt?: Date;
  raw: unknown;
}

export type WebhookEventType =
  | "payment.completed"
  | "payment.failed"
  | "subscription.confirmation"
  | "unknown";

export interface WebhookEvent {
  provider: string;
  type: WebhookEventType;
  /** Gateway id for this message. Use it to make your handler idempotent. */
  eventId?: string;
  transactionId?: string;
  reference?: string;
  amount?: string;
  currency?: string;
  payerAccount?: string;
  occurredAt?: Date;
  raw: unknown;
}

/** What a verifier needs from an inbound HTTP request, framework-independent. */
export interface RawWebhookRequest {
  /** The exact bytes of the body. Parsing it before verification breaks the signature. */
  body: string;
  headers: Record<string, string | string[] | undefined>;
}
