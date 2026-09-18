import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";
import { WebhookVerificationError } from "../src/core/errors.ts";
import { assertSnsUrl, BkashWebhookVerifier, canonicalString, type SnsEnvelope } from "../src/bkash/webhook.ts";

/**
 * A real RSA keypair, generated per run. The signatures below are produced the
 * same way Amazon produces them, so these tests exercise the actual crypto path
 * rather than a stub that returns true.
 */
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

const CERT_URL = "https://sns.ap-southeast-1.amazonaws.com/SimpleNotificationService-test.pem";
const TOPIC_ARN = "arn:aws:sns:ap-southeast-1:354285753755:bpt_01823072645";

function sign(envelope: SnsEnvelope, version: "1" | "2" = "1"): SnsEnvelope {
  const signed = { ...envelope, SignatureVersion: version, SigningCertURL: CERT_URL };
  const algorithm = version === "2" ? "RSA-SHA256" : "RSA-SHA1";
  const signature = createSign(algorithm).update(canonicalString(signed), "utf8").sign(privateKey, "base64");
  return { ...signed, Signature: signature };
}

function notification(message: Record<string, string>): SnsEnvelope {
  return sign({
    Type: "Notification",
    MessageId: "20d48143-6af4-571d-b7cb-d211e6a2ac69",
    TopicArn: TOPIC_ARN,
    Message: JSON.stringify(message),
    Timestamp: new Date().toISOString(),
  });
}

/** Serves the public key from the SNS URL, and refuses everything else. */
const certFetch: typeof fetch = async (input) => {
  const url = String(input);
  if (url === CERT_URL) return new Response(publicPem, { status: 200 });
  throw new Error(`test fetch: unexpected request to ${url}`);
};

function verifier(options: Partial<ConstructorParameters<typeof BkashWebhookVerifier>[0]> = {}) {
  return new BkashWebhookVerifier({ fetchImpl: certFetch, topicArn: TOPIC_ARN, ...options });
}

const PAYMENT = {
  dateTime: "20260918122246",
  debitMSISDN: "8801700000001",
  creditOrganizationName: "Org 01",
  creditShortCode: "01929918000",
  trxID: "4J420ANOXC",
  transactionStatus: "Completed",
  transactionType: "10002294",
  amount: "100",
  currency: "BDT",
  merchantInvoiceNumber: "ORD-1233",
};

describe("bKash IPN verification", () => {
  it("accepts a correctly signed notification and normalises it", async () => {
    const envelope = notification(PAYMENT);
    const event = await verifier().verify({ body: JSON.stringify(envelope), headers: {} });

    assert.equal(event.provider, "bkash");
    assert.equal(event.type, "payment.completed");
    assert.equal(event.transactionId, "4J420ANOXC");
    assert.equal(event.reference, "ORD-1233");
    assert.equal(event.amount, "100");
    assert.equal(event.payerAccount, "8801700000001");
    assert.equal(event.eventId, "20d48143-6af4-571d-b7cb-d211e6a2ac69");
    // 2026-09-18 12:22:46 Bangladesh time is 06:22:46 UTC.
    assert.equal(event.occurredAt?.toISOString(), "2026-09-18T06:22:46.000Z");
  });

  it("verifies SignatureVersion 2 (SHA256) as well as version 1", async () => {
    const envelope = sign(
      {
        Type: "Notification",
        MessageId: "m-2",
        TopicArn: TOPIC_ARN,
        Message: JSON.stringify(PAYMENT),
        Timestamp: new Date().toISOString(),
      },
      "2",
    );
    const event = await verifier().verify({ body: JSON.stringify(envelope), headers: {} });
    assert.equal(event.type, "payment.completed");
  });

  it("rejects a message whose body was altered after signing", async () => {
    const envelope = notification(PAYMENT);
    const tampered = {
      ...envelope,
      Message: JSON.stringify({ ...PAYMENT, amount: "100000" }),
    };

    await assert.rejects(
      () => verifier().verify({ body: JSON.stringify(tampered), headers: {} }),
      (error: unknown) => error instanceof WebhookVerificationError && error.code === "signature_mismatch",
    );
  });

  it("refuses a SigningCertURL that is not an Amazon SNS host", async () => {
    // The attack this exists to stop: a forged notification whose signature is
    // valid — against the attacker's own key, served from the attacker's host.
    const { privateKey: evilKey, publicKey: evilPublic } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const evilUrl = "https://sns.attacker.example.com/SimpleNotificationService-evil.pem";
    const base: SnsEnvelope = {
      Type: "Notification",
      MessageId: "evil-1",
      TopicArn: TOPIC_ARN,
      Message: JSON.stringify({ ...PAYMENT, amount: "999999" }),
      Timestamp: new Date().toISOString(),
      SignatureVersion: "1",
      SigningCertURL: evilUrl,
    };
    const forged: SnsEnvelope = {
      ...base,
      Signature: createSign("RSA-SHA1").update(canonicalString(base), "utf8").sign(evilKey, "base64"),
    };

    const evilFetch: typeof fetch = async (input) =>
      new Response(evilPublic.export({ type: "spki", format: "pem" }).toString(), {
        status: 200,
        // Would have been served happily by the attacker.
        headers: { "content-type": "application/x-pem-file" },
      });

    await assert.rejects(
      () =>
        new BkashWebhookVerifier({ fetchImpl: evilFetch, topicArn: TOPIC_ARN }).verify({
          body: JSON.stringify(forged),
          headers: {},
        }),
      (error: unknown) => error instanceof WebhookVerificationError && error.code === "cert_url_untrusted",
      "a cert URL outside amazonaws.com must be refused before the certificate is ever fetched",
    );
  });

  it("refuses a message from an SNS topic that is not ours", async () => {
    const envelope = sign({
      Type: "Notification",
      MessageId: "m-3",
      TopicArn: "arn:aws:sns:ap-southeast-1:999999999999:someone-elses-topic",
      Message: JSON.stringify(PAYMENT),
      Timestamp: new Date().toISOString(),
    });

    await assert.rejects(
      () => verifier().verify({ body: JSON.stringify(envelope), headers: {} }),
      (error: unknown) => error instanceof WebhookVerificationError && error.code === "topic_mismatch",
    );
  });

  it("normalises a subscription confirmation without confirming it", async () => {
    let fetched = false;
    const subscribeUrl = "https://sns.ap-southeast-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc";
    const envelope = sign({
      Type: "SubscriptionConfirmation",
      MessageId: "sub-1",
      TopicArn: TOPIC_ARN,
      Token: "abc",
      SubscribeURL: subscribeUrl,
      Message: "You have chosen to subscribe to the topic.",
      Timestamp: new Date().toISOString(),
    });

    const watchingFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url === CERT_URL) return new Response(publicPem, { status: 200 });
      fetched = true;
      return new Response("<ConfirmSubscriptionResponse/>", { status: 200 });
    };

    const subject = new BkashWebhookVerifier({ fetchImpl: watchingFetch, topicArn: TOPIC_ARN });
    const event = await subject.verify({ body: JSON.stringify(envelope), headers: {} });

    assert.equal(event.type, "subscription.confirmation");
    assert.equal(fetched, false, "verify() must not visit SubscribeURL on its own");

    await subject.confirmSubscription(event.raw as SnsEnvelope);
    assert.equal(fetched, true, "confirmSubscription() should visit SubscribeURL when asked");
  });

  it("marks a non-completed transaction as failed rather than completed", async () => {
    const envelope = notification({ ...PAYMENT, transactionStatus: "Failed" });
    const event = await verifier().verify({ body: JSON.stringify(envelope), headers: {} });
    assert.equal(event.type, "payment.failed");
  });

  it("reads coupon-funded payments without losing the real sale amount", async () => {
    const envelope = notification({
      ...PAYMENT,
      amount: "90",
      couponAmount: "10",
      merchantShareAmount: "5",
      saleAmount: "100.00",
    });
    const event = await verifier().verify({ body: JSON.stringify(envelope), headers: {} });
    const message = BkashWebhookVerifier.parseMessage(event.raw as SnsEnvelope);

    assert.equal(event.amount, "90", "amount is what bKash settles");
    assert.equal(message?.saleAmount, "100.00", "saleAmount is what the customer ordered");
    assert.equal(message?.couponAmount, "10");
  });

  it("rejects an empty or non-JSON body", async () => {
    await assert.rejects(() => verifier().verify({ body: "", headers: {} }));
    await assert.rejects(() => verifier().verify({ body: "not json", headers: {} }));
  });
});

describe("SNS URL checks", () => {
  it("accepts real SNS certificate hosts", () => {
    assert.ok(assertSnsUrl("https://sns.us-west-2.amazonaws.com/x.pem", "SigningCertURL"));
    assert.ok(assertSnsUrl("https://sns.ap-southeast-1.amazonaws.com.cn/x.pem", "SigningCertURL"));
  });

  it("refuses lookalikes, plain http and non-pem paths", () => {
    const bad = [
      "https://sns.ap-southeast-1.amazonaws.com.evil.net/x.pem",
      "https://amazonaws.com/x.pem",
      "http://sns.us-west-2.amazonaws.com/x.pem",
      "https://sns.us-west-2.amazonaws.com/x.txt",
      "not-a-url",
    ];
    for (const url of bad) {
      assert.throws(() => assertSnsUrl(url, "SigningCertURL"), WebhookVerificationError, `should refuse ${url}`);
    }
  });
});

describe("canonical string", () => {
  it("omits absent fields and keeps AWS's field order", () => {
    const canonical = canonicalString({
      Type: "Notification",
      MessageId: "id",
      TopicArn: "arn",
      Message: "body",
      Timestamp: "ts",
    });
    assert.equal(canonical, "Message\nbody\nMessageId\nid\nTimestamp\nts\nTopicArn\narn\nType\nNotification\n");
  });

  it("includes Subject only when present", () => {
    const withSubject = canonicalString({
      Type: "Notification",
      MessageId: "id",
      TopicArn: "arn",
      Message: "body",
      Subject: "hello",
      Timestamp: "ts",
    });
    assert.ok(withSubject.includes("Subject\nhello\n"));
  });

  it("uses the confirmation field set for SubscriptionConfirmation", () => {
    const canonical = canonicalString({
      Type: "SubscriptionConfirmation",
      MessageId: "id",
      TopicArn: "arn",
      Message: "body",
      Token: "tok",
      SubscribeURL: "https://sns.us-west-2.amazonaws.com/?x=1",
      Timestamp: "ts",
    });
    assert.ok(canonical.includes("SubscribeURL\n"));
    assert.ok(canonical.includes("Token\ntok\n"));
  });
});
