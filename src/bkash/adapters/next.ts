/**
 * Next.js App Router route handlers.
 *
 * ```ts
 * // app/api/bkash/webhook/route.ts
 * import { createBkashWebhookHandler } from "paykit-bd/bkash/next";
 * export const POST = createBkashWebhookHandler(bkash, {
 *   onPaymentCompleted: async (event) => { await fulfilOrder(event.reference!); },
 * });
 * ```
 *
 * No Next.js import is needed — these are plain `Request` → `Response`
 * functions, so they also work in any fetch-based runtime.
 */

import { PaykitError, WebhookVerificationError } from "../../core/errors.ts";
import type { WebhookEvent } from "../../core/types.ts";
import type { BkashClient } from "../client.ts";
import { BkashWebhookVerifier, type SnsEnvelope } from "../webhook.ts";

export interface WebhookHandlerOptions {
  /** A genuine, completed payment. Do your fulfilment here. */
  onPaymentCompleted?: (event: WebhookEvent) => Promise<void> | void;
  /** A genuine notification that is not a completed payment. */
  onOtherEvent?: (event: WebhookEvent) => Promise<void> | void;
  /**
   * Called for an SNS SubscriptionConfirmation. Return true to confirm the
   * subscription, which turns on live notification delivery.
   *
   * Default is false — confirming is an outbound action that starts real
   * traffic, so it is yours to trigger, usually once during onboarding.
   */
  onSubscriptionConfirmation?: (envelope: SnsEnvelope) => Promise<boolean> | boolean;
  /** Called when verification fails. The request is already being rejected. */
  onVerificationFailure?: (error: unknown, rawBody: string) => Promise<void> | void;
}

/**
 * Build a POST handler for the bKash IPN endpoint.
 *
 * Status codes are chosen for how SNS behaves: 200 means delivered and SNS
 * stops; a 5xx makes SNS retry, which is what you want when your own
 * fulfilment threw. A forged message gets 400 and no retry.
 */
export function createBkashWebhookHandler(
  client: BkashClient,
  options: WebhookHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async function POST(request: Request): Promise<Response> {
    // The raw body, byte for byte. Parsing it first breaks the signature.
    const rawBody = await request.text();

    let event: WebhookEvent;
    try {
      event = await client.verifyWebhook({ body: rawBody, headers: headersToObject(request.headers) });
    } catch (error) {
      await options.onVerificationFailure?.(error, rawBody);
      const message = error instanceof WebhookVerificationError ? error.message : "webhook verification failed";
      return Response.json({ ok: false, error: message }, { status: 400 });
    }

    try {
      if (event.type === "subscription.confirmation") {
        const envelope = event.raw as SnsEnvelope;
        const shouldConfirm = (await options.onSubscriptionConfirmation?.(envelope)) ?? false;
        if (shouldConfirm) await client.webhooks.confirmSubscription(envelope);
        return Response.json({ ok: true, confirmed: shouldConfirm });
      }

      if (event.type === "payment.completed") {
        await options.onPaymentCompleted?.(event);
      } else {
        await options.onOtherEvent?.(event);
      }
      return Response.json({ ok: true });
    } catch (error) {
      // Signal failure so SNS redelivers rather than dropping a real payment.
      return Response.json(
        { ok: false, error: error instanceof PaykitError ? error.message : "handler failed" },
        { status: 500 },
      );
    }
  };
}

export interface CallbackHandlerOptions {
  /**
   * Called after the payment has been executed and its real outcome is known.
   * Return a Response to control the redirect; returning nothing sends the
   * customer to `successUrl` or `failureUrl`.
   */
  onSettled?: (result: Awaited<ReturnType<BkashClient["executePayment"]>>) => Promise<Response | void> | Response | void;
  onFailure?: (error: unknown, paymentId: string | undefined) => Promise<Response | void> | Response | void;
  successUrl?: string;
  failureUrl?: string;
}

/**
 * Build a GET handler for the URL bKash redirects the customer back to.
 *
 * It executes the payment, because the redirect itself proves nothing: the
 * customer's browser followed that URL and could have edited it. `status=success`
 * in the query string is a hint, never the decision.
 */
export function createBkashCallbackHandler(
  client: BkashClient,
  options: CallbackHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async function GET(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const query = (client.constructor as typeof BkashClient).parseCallback(url.searchParams);
    const paymentId = query.paymentID;

    if (!paymentId) {
      const handled = await options.onFailure?.(new Error("callback has no paymentID"), undefined);
      return handled ?? redirect(options.failureUrl ?? "/", url);
    }

    // A cancelled or failed redirect needs no execute call — bKash has already
    // decided. Read state rather than trusting the query string.
    try {
      const payment =
        query.status === "success"
          ? await client.executePayment(paymentId)
          : await client.getPayment(paymentId);

      const handled = await options.onSettled?.(payment);
      if (handled) return handled;

      const destination =
        payment.status === "completed" ? (options.successUrl ?? "/") : (options.failureUrl ?? "/");
      return redirect(destination, url);
    } catch (error) {
      const handled = await options.onFailure?.(error, paymentId);
      return handled ?? redirect(options.failureUrl ?? "/", url);
    }
  };
}

function redirect(destination: string, base: URL): Response {
  return Response.redirect(new URL(destination, base).toString(), 303);
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

export { BkashWebhookVerifier };
