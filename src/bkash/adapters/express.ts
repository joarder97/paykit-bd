/**
 * Express middleware.
 *
 * ```ts
 * import express from "express";
 * import { bkashWebhookMiddleware, rawBodyParser } from "paykit-bd/bkash/express";
 *
 * app.post("/api/bkash/webhook",
 *   rawBodyParser(),
 *   bkashWebhookMiddleware(bkash, { onPaymentCompleted: fulfilOrder }));
 * ```
 *
 * **The body parser matters.** bKash sends its IPN with
 * `Content-Type: text/plain; charset=UTF-8`, so `express.json()` ignores it and
 * `req.body` arrives empty. Even with the right content type, a parsed and
 * re-serialised body no longer matches the signature. Use {@link rawBodyParser}
 * or `express.text({ type: "*​/*" })` on this route only.
 *
 * Typed structurally so Express is not a dependency of this package.
 */

import { WebhookVerificationError } from "../../core/errors.ts";
import type { WebhookEvent } from "../../core/types.ts";
import type { BkashClient } from "../client.ts";
import type { SnsEnvelope } from "../webhook.ts";

interface ExpressRequestLike {
  body?: unknown;
  headers: Record<string, string | string[] | undefined>;
  setEncoding?(encoding: string): void;
  on(event: string, listener: (chunk?: unknown) => void): unknown;
}

interface ExpressResponseLike {
  status(code: number): ExpressResponseLike;
  json(body: unknown): unknown;
}

type NextFn = (error?: unknown) => void;

export interface ExpressWebhookOptions {
  onPaymentCompleted?: (event: WebhookEvent) => Promise<void> | void;
  onOtherEvent?: (event: WebhookEvent) => Promise<void> | void;
  /** Return true to confirm the SNS subscription. Default false — see the Next adapter. */
  onSubscriptionConfirmation?: (envelope: SnsEnvelope) => Promise<boolean> | boolean;
  onVerificationFailure?: (error: unknown, rawBody: string) => Promise<void> | void;
}

/**
 * Collect the raw request body into `req.body` as a string, whatever the
 * content type. Mount it on the webhook route only.
 */
export function rawBodyParser(limitBytes = 1_000_000) {
  return function parse(req: ExpressRequestLike, res: ExpressResponseLike, next: NextFn): void {
    if (typeof req.body === "string") {
      next();
      return;
    }
    let data = "";
    let size = 0;
    req.setEncoding?.("utf8");
    req.on("data", (chunk) => {
      const text = String(chunk);
      size += Buffer.byteLength(text, "utf8");
      if (size > limitBytes) {
        next(new Error(`paykit/bkash: webhook body exceeded ${limitBytes} bytes`));
        return;
      }
      data += text;
    });
    req.on("end", () => {
      req.body = data;
      next();
    });
    req.on("error", (error) => next(error));
  };
}

export function bkashWebhookMiddleware(client: BkashClient, options: ExpressWebhookOptions = {}) {
  return async function handle(req: ExpressRequestLike, res: ExpressResponseLike): Promise<void> {
    const rawBody = typeof req.body === "string" ? req.body : Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";

    if (!rawBody) {
      res.status(400).json({
        ok: false,
        error:
          "paykit/bkash: empty raw body. bKash posts its IPN as text/plain, so mount rawBodyParser() " +
          "(or express.text({ type: '*/*' })) on this route before this middleware.",
      });
      return;
    }

    let event: WebhookEvent;
    try {
      event = await client.verifyWebhook({ body: rawBody, headers: req.headers });
    } catch (error) {
      await options.onVerificationFailure?.(error, rawBody);
      res.status(400).json({
        ok: false,
        error: error instanceof WebhookVerificationError ? error.message : "webhook verification failed",
      });
      return;
    }

    try {
      if (event.type === "subscription.confirmation") {
        const envelope = event.raw as SnsEnvelope;
        const shouldConfirm = (await options.onSubscriptionConfirmation?.(envelope)) ?? false;
        if (shouldConfirm) await client.webhooks.confirmSubscription(envelope);
        res.status(200).json({ ok: true, confirmed: shouldConfirm });
        return;
      }

      if (event.type === "payment.completed") {
        await options.onPaymentCompleted?.(event);
      } else {
        await options.onOtherEvent?.(event);
      }
      res.status(200).json({ ok: true });
    } catch (error) {
      // 5xx so SNS redelivers instead of dropping a real payment.
      res.status(500).json({ ok: false, error: error instanceof Error ? error.message : "handler failed" });
    }
  };
}
