import type {
  CreatePaymentInput,
  CreatedPayment,
  Payment,
  Refund,
  RefundInput,
  RawWebhookRequest,
  WebhookEvent,
} from "./types.ts";

/**
 * The seam every gateway implements.
 *
 * Deliberately small: the five things an order flow actually needs. Anything a
 * gateway does beyond this — bKash agreements, for one — stays on that
 * gateway's own client rather than being forced into a lowest common
 * denominator that fits nobody.
 */
export interface PaymentProvider {
  /** Stable id, e.g. `"bkash"`. Appears on every returned object and error. */
  readonly id: string;

  /** Start a payment. The customer is sent to `redirectUrl` when there is one. */
  createPayment(input: CreatePaymentInput): Promise<CreatedPayment>;

  /**
   * Finalise a payment after the customer returns. Call this exactly once per
   * payment id: gateways typically allow one execution only.
   */
  executePayment(paymentId: string): Promise<Payment>;

  /** Read current state. Safe to call repeatedly — this is the recovery path. */
  getPayment(paymentId: string): Promise<Payment>;

  refund(input: RefundInput): Promise<Refund>;

  /**
   * Prove an inbound webhook came from the gateway and normalise it.
   * Throws {@link import("./errors.ts").WebhookVerificationError} if it did not.
   */
  verifyWebhook(request: RawWebhookRequest): Promise<WebhookEvent>;
}

/** Narrow an unknown object to a PaymentProvider at a plugin boundary. */
export function isPaymentProvider(value: unknown): value is PaymentProvider {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate["id"] === "string" &&
    typeof candidate["createPayment"] === "function" &&
    typeof candidate["executePayment"] === "function" &&
    typeof candidate["getPayment"] === "function" &&
    typeof candidate["refund"] === "function" &&
    typeof candidate["verifyWebhook"] === "function"
  );
}
