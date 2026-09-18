import type { BkashMode } from "./config.ts";

export type { BkashMode };

/** bKash spells these lower-case on the wire. */
export type BkashIntent = "sale" | "authorization";

/** bKash's own wire shapes. Field names are theirs, including the inconsistent ones. */

export interface GrantTokenResponse {
  statusCode?: string;
  statusMessage?: string;
  token_type?: string;
  id_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

export interface CreateAgreementRequest {
  mode: "0000";
  payerReference: string;
  callbackURL: string;
  /** bKash's docs list these as mandatory; the sandbox accepts a create without them. */
  amount?: string;
  currency?: "BDT";
  intent?: "sale";
  merchantInvoiceNumber?: string;
}

export interface AgreementResponse {
  statusCode?: string;
  statusMessage?: string;
  errorCode?: string;
  errorMessage?: string;
  paymentID?: string;
  bkashURL?: string;
  callbackURL?: string;
  successCallbackURL?: string;
  failureCallbackURL?: string;
  cancelledCallbackURL?: string;
  agreementID?: string;
  agreementStatus?: string;
  agreementCreateTime?: string;
  agreementExecuteTime?: string;
  payerReference?: string;
  customerMsisdn?: string;
}

export interface CreatePaymentRequest {
  mode: BkashMode;
  payerReference: string;
  callbackURL: string;
  amount: string;
  currency: "BDT";
  intent: BkashIntent;
  merchantInvoiceNumber?: string;
  /** Required for mode 0001 — the agreement being charged. */
  agreementID?: string;
  /** Aggregator / sub-merchant identifier, where bKash has issued one. */
  merchantAssociationInfo?: string;
}

export interface CreatePaymentResponse {
  statusCode?: string;
  statusMessage?: string;
  errorCode?: string;
  errorMessage?: string;
  paymentID?: string;
  /** Absent for mode 0001: an agreement payment needs no redirect. */
  bkashURL?: string;
  callbackURL?: string;
  successCallbackURL?: string;
  failureCallbackURL?: string;
  cancelledCallbackURL?: string;
  amount?: string;
  intent?: string;
  currency?: string;
  agreementID?: string;
  paymentCreateTime?: string;
  transactionStatus?: string;
  merchantInvoiceNumber?: string;
}

export interface ExecutePaymentResponse {
  statusCode?: string;
  statusMessage?: string;
  errorCode?: string;
  errorMessage?: string;
  paymentID?: string;
  agreementID?: string;
  payerReference?: string;
  customerMsisdn?: string;
  /** The financial transaction id. Only present once the payment completed. */
  trxID?: string;
  amount?: string;
  transactionStatus?: string;
  paymentExecuteTime?: string;
  currency?: string;
  intent?: string;
  merchantInvoiceNumber?: string;
}

/**
 * Query Payment. Note `merchantInvoice` — the query endpoint drops the `Number`
 * suffix that create and execute both use. Confirmed against sandbox.
 */
export interface QueryPaymentResponse {
  statusCode?: string;
  statusMessage?: string;
  errorCode?: string;
  errorMessage?: string;
  paymentID?: string;
  mode?: string;
  paymentCreateTime?: string;
  paymentExecuteTime?: string;
  amount?: string;
  currency?: string;
  intent?: string;
  merchantInvoice?: string;
  merchantInvoiceNumber?: string;
  trxID?: string;
  transactionStatus?: string;
  verificationStatus?: string;
  /** Undocumented, but returned: what is still refundable on this payment. */
  maxRefundableAmount?: string;
  payerReference?: string;
  customerMsisdn?: string;
  agreementID?: string;
  agreementStatus?: string;
  agreementCreateTime?: string;
  agreementExecuteTime?: string;
}

export interface RefundRequest {
  /** Lower-case `d` on the v2 API, unlike every other endpoint's `paymentID`. */
  paymentId: string;
  trxId: string;
  refundAmount: string;
  /**
   * Mandatory in practice, though the docs read as though it were optional.
   * Omit `sku` or `reason` and the v2 refund API rejects the call at its schema
   * layer with `{"message": "Invalid request body"}` — no code, no field name,
   * nothing to debug from. Verified against the sandbox: the identical request
   * succeeds once both are present.
   */
  sku: string;
  reason: string;
}

export interface RefundResponse {
  originalTrxId?: string;
  refundTrxId?: string;
  refundTransactionStatus?: string;
  originalTrxAmount?: string;
  refundAmount?: string;
  currency?: string;
  completedTime?: string;
  sku?: string;
  reason?: string;
  /** v2 error envelope. */
  internalCode?: string;
  externalCode?: string;
  errorMessageEn?: string;
  errorMessageBn?: string;
}

export interface RefundStatusResponse {
  originalTrxId?: string;
  originalTrxAmount?: string;
  originalTrxCompletedTime?: string;
  refundTransactions?: Array<{
    refundTrxId?: string;
    refundTransactionStatus?: string;
    refundAmount?: string;
    completedTime?: string;
  }>;
  internalCode?: string;
  externalCode?: string;
  errorMessageEn?: string;
  errorMessageBn?: string;
}

/**
 * The query string bKash appends when it redirects the customer back to your
 * callback URL. `status` is the only field worth branching on, and none of it
 * is trustworthy on its own — always confirm with executePayment or getPayment.
 */
export interface BkashCallbackQuery {
  paymentID?: string;
  status?: "success" | "failure" | "cancel" | string;
  /** Present from v1.2.0-beta. Opaque; bKash publishes no verification scheme. */
  signature?: string;
  apiVersion?: string;
  product?: string;
}
