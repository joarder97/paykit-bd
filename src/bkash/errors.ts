import { brandCheckFor, NetworkError, ProviderError } from "../core/errors.ts";

/** Every documented bKash status code, verbatim from the developer portal. */
export const BKASH_ERROR_CODES: Record<string, string> = {
  "0000": "Successful",
  "2001": "Invalid App Key",
  "2002": "Invalid Payment ID",
  "2003": "Process failed",
  "2004": "Invalid firstPaymentDate",
  "2005": "Invalid frequency",
  "2006": "Invalid amount",
  "2007": "Invalid currency",
  "2008": "Invalid intent",
  "2009": "Invalid Wallet",
  "2010": "Invalid OTP",
  "2011": "Invalid PIN",
  "2012": "Invalid Receiver MSISDN",
  "2013": "Resend Limit Exceeded",
  "2014": "Wrong PIN",
  "2015": "Wrong PIN count exceeded",
  "2016": "Wrong verification code",
  "2017": "Wrong verification limit exceeded",
  "2018": "OTP verification time expired",
  "2019": "PIN verification time expired",
  "2020": "Exception Occurred",
  "2021": "Invalid Mandate ID",
  "2022": "The mandate does not exist",
  "2023": "Insufficient Balance",
  "2024": "Exception occurred",
  "2025": "Invalid request body",
  "2026": "The reversal amount cannot be greater than the original transaction amount",
  "2027": "The mandate corresponding to the payer reference number already exists and cannot be created again",
  "2028": "Reverse failed because the transaction serial number does not exist",
  "2029": "Duplicate for all transactions",
  "2030": "Invalid mandate request type",
  "2031": "Invalid merchant invoice number",
  "2032": "Invalid transfer type",
  "2033": "Transaction not found",
  "2034": "The transaction cannot be reversed because the original transaction has been reversed",
  "2035": "Reverse failed because the initiator has no permission to reverse the transaction",
  "2036": "The direct debit mandate is not in Active state",
  "2037": "The account of the debit party is in a state which prohibits execution of this transaction",
  "2038": "Debit party identity tag prohibits execution of this transaction",
  "2039": "The account of the credit party is in a state which prohibits execution of this transaction",
  "2040": "Credit party identity tag prohibits execution of this transaction",
  "2041": "Credit party identity is in a state which does not support the current service",
  "2042": "Reverse failed because the initiator has no permission to reverse the transaction",
  "2043": "The security credential of the subscriber is incorrect",
  "2044": "Identity has not subscribed to a product that contains the expected service, or the identity is not in Active status",
  "2045": "The MSISDN of the customer does not exist",
  "2046": "Identity has not subscribed to a product that contains requested service",
  "2047": "TLV Data Format Error",
  "2048": "Invalid Payer Reference",
  "2049": "Invalid Merchant Callback URL",
  "2050": "Agreement already exists between payer and merchant",
  "2051": "Invalid Agreement ID",
  "2052": "Agreement is in incomplete state",
  "2053": "Agreement has already been cancelled",
  "2054": "Agreement execution pre-requisite hasn't been met",
  "2055": "Invalid Agreement State",
  "2056": "Invalid Payment State",
  "2057": "Not a bKash Account",
  "2058": "Not a Customer Wallet",
  "2059": "Multiple OTP request for a single session denied",
  "2060": "Payment execution pre-requisite hasn't been met",
  "2061": "This action can only be performed by the agreement or payment initiator party",
  "2062": "The payment has already been completed",
  "2063": "Mode is not valid as per request data",
  "2064": "This product mode currently unavailable",
  "2065": "Mandatory field missing",
  "2066": "Agreement is not shared with other merchant",
  "2067": "Invalid permission",
  "2068": "Transaction has already been completed",
  "2069": "Transaction has already been cancelled",
  "2116": "The agreement execution has already been completed",
  "2117": "The payment execution has already been completed",
  "2118": "The Platform value is invalid",
  "2119": "The authorized payment has already been processed",
};

/** Transient at bKash's end — the same request may work on a later attempt. */
const RETRYABLE_CODES = new Set(["2003", "2020", "2024"]);

/**
 * Codes meaning "this already happened". Not failures: the right response is to
 * read current state with getPayment rather than to treat the order as broken.
 */
export const ALREADY_SETTLED_CODES = new Set(["2062", "2068", "2116", "2117", "2119"]);

/** Codes caused by the customer, not by your integration. Show them, don't alert on them. */
export const CUSTOMER_FAULT_CODES = new Set([
  "2010", "2011", "2013", "2014", "2015", "2016", "2017", "2018", "2019", "2023", "2057", "2058", "2059",
]);

export class BkashError extends ProviderError {
  // Branded like the core errors so `instanceof` holds across this package's
  // separate entry-point bundles. See the note in src/core/errors.ts.
  static override [Symbol.hasInstance] = brandCheckFor("BkashError");

  /** True when bKash considers the payment already settled — re-query, don't retry. */
  readonly alreadySettled: boolean;
  /** True when the customer caused it (wrong PIN, no balance). */
  readonly customerFault: boolean;
  /** Bangla message, on the v2 refund API only. */
  readonly messageBn?: string;

  constructor(opts: { code: string; message: string; raw?: unknown; messageBn?: string; retryable?: boolean }) {
    super(
      opts.message,
      {
        provider: "bkash",
        code: opts.code,
        retryable: opts.retryable ?? RETRYABLE_CODES.has(opts.code),
        raw: opts.raw,
      },
      ["BkashError"],
    );
    this.alreadySettled = ALREADY_SETTLED_CODES.has(opts.code);
    this.customerFault = CUSTOMER_FAULT_CODES.has(opts.code);
    this.messageBn = opts.messageBn;
  }
}

/**
 * bKash signals failure in four different envelopes depending on which endpoint
 * and which API version you hit. All four were observed against the sandbox:
 *
 *   1. `{ statusCode: "2002", statusMessage: "Invalid Payment ID" }` with HTTP 200
 *      — the tokenized checkout endpoints. A 200 here is not success.
 *   2. `{ errorCode, errorMessage }` — documented for create and execute.
 *   3. `{ internalCode, externalCode, errorMessageEn, errorMessageBn }` with HTTP 400
 *      — the v2 refund API only.
 *   4. `{ message: "Unauthorized" }` with HTTP 401/403 — the AWS API Gateway in
 *      front of bKash, reached before any bKash logic runs.
 *
 * Returns the error to throw, or null when the body represents success.
 */
export function toBkashError(body: unknown, status: number): BkashError | NetworkError | null {
  if (typeof body !== "object" || body === null) {
    return new NetworkError(`bKash: unreadable response body (HTTP ${status})`, {
      provider: "bkash",
      raw: body,
      status,
    });
  }
  const b = body as Record<string, unknown>;

  // 3. v2 refund envelope.
  if (typeof b["externalCode"] === "string" || typeof b["internalCode"] === "string") {
    const code = (b["externalCode"] as string) ?? (b["internalCode"] as string);
    return new BkashError({
      code,
      message: describe(code, (b["errorMessageEn"] as string) ?? (b["internalCode"] as string)),
      messageBn: (b["errorMessageBn"] as string) ?? undefined,
      raw: body,
    });
  }

  // 2. Documented error envelope.
  if (typeof b["errorCode"] === "string" && b["errorCode"] !== "") {
    const code = b["errorCode"] as string;
    return new BkashError({ code, message: describe(code, b["errorMessage"] as string), raw: body });
  }

  // 1. statusCode envelope — "0000" is the only success value.
  if (typeof b["statusCode"] === "string") {
    const code = b["statusCode"] as string;
    if (code === "0000") return null;
    return new BkashError({ code, message: describe(code, b["statusMessage"] as string), raw: body });
  }

  // 4. API Gateway, or any other non-2xx without a bKash body.
  if (status >= 400) {
    const message = typeof b["message"] === "string" ? b["message"] : `HTTP ${status}`;
    if (status === 401 || status === 403) {
      return new BkashError({
        code: "unauthorized",
        message:
          `bKash rejected the request before reaching the payment API: ${message}. ` +
          `Usually an expired or malformed id_token, or an x-app-key that does not match the token.`,
        raw: body,
      });
    }
    return new BkashError({ code: `http_${status}`, message: `bKash: ${message}`, raw: body });
  }

  // No statusCode at all and a 2xx — the v2 refund success bodies look like this.
  return null;
}

function describe(code: string, message?: string): string {
  const known = BKASH_ERROR_CODES[code];
  const text = message?.trim() || known || "Unknown error";
  return known && message && known.toLowerCase() !== message.trim().toLowerCase()
    ? `bKash ${code}: ${text} (${known})`
    : `bKash ${code}: ${text}`;
}

/**
 * bKash timestamps are not ISO 8601 and `new Date()` returns Invalid Date for
 * them. Two formats appear on the wire:
 *
 *   "2026-09-18T06:00:19:952 GMT+0600"  — note the colon before milliseconds
 *   "2024-06-13T16:27:24:000"           — refund API, no offset at all
 *
 * A missing offset is read as Bangladesh time (UTC+6), which is what bKash means.
 */
export function parseBkashTime(value: string | undefined | null): Date | undefined {
  if (!value) return undefined;
  const match =
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?::(\d{1,3}))?(?:\s*(?:GMT|UTC)?\s*([+-])(\d{2}):?(\d{2}))?\s*$/.exec(
      value.trim(),
    );
  if (!match) {
    const fallback = new Date(value);
    return Number.isNaN(fallback.getTime()) ? undefined : fallback;
  }
  const [, y, mo, d, h, mi, s, ms, sign, offH, offM] = match;
  const offsetMinutes =
    sign && offH && offM ? (sign === "-" ? -1 : 1) * (Number(offH) * 60 + Number(offM)) : 6 * 60;
  const utcMs =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Number((ms ?? "0").padEnd(3, "0"))) -
    offsetMinutes * 60_000;
  const date = new Date(utcMs);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Webhook payloads carry a compact `dateTime` of "20180419122246"
 * (YYYYMMDDHHmmss), in Bangladesh time.
 */
export function parseBkashCompactTime(value: string | undefined | null): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const [, y, mo, d, h, mi, s] = match;
  const date = new Date(
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) - 6 * 60 * 60_000,
  );
  return Number.isNaN(date.getTime()) ? undefined : date;
}
