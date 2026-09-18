/**
 * Packs the package, installs the tarball into a throwaway project and checks
 * it the way a consumer would meet it.
 *
 * `pnpm verify:package`
 *
 * This exists because the unit tests cannot see the class of bug it catches.
 * Running from source there is exactly one copy of every module, so everything
 * agrees with itself. The published package is several bundles, and two of them
 * disagreeing is invisible until something installs it — which is how a broken
 * `instanceof` across entry points shipped right up to the moment of publish.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = process.cwd();
const failures: string[] = [];

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true });
}

function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok    ${name}`);
  } catch (error) {
    failures.push(name);
    const detail = error instanceof Error ? error.message.trim().split("\n").slice(0, 6).join("\n        ") : String(error);
    console.log(`  FAIL  ${name}\n        ${detail}`);
  }
}

console.log("\nBuilding and packing…");
run("npm", ["run", "build"], root);
const packed = JSON.parse(run("npm", ["pack", "--json"], root)) as Array<{ filename: string; files: Array<{ path: string }> }>;
const tarball = packed[0]!.filename;
const shipped = packed[0]!.files.map((f) => f.path);

const work = mkdtempSync(join(tmpdir(), "paykit-verify-"));
console.log(`Installing ${tarball} into a clean project…\n`);
run("cp", [tarball, work], root);
writeFileSync(
  join(work, "package.json"),
  JSON.stringify({ name: "verify", version: "1.0.0", type: "module", dependencies: { "paykit-bd": `file:./${tarball}` } }),
);
run("npm", ["install", "--silent", "--no-audit", "--no-fund"], work);

console.log("Checks:");

// ---------------------------------------------------------------- contents

check("ships only dist, README, LICENSE and package.json", () => {
  const unexpected = shipped.filter(
    (p) => !p.startsWith("dist/") && !["README.md", "LICENSE", "package.json"].includes(p),
  );
  if (unexpected.length) throw new Error(`unexpected files: ${unexpected.join(", ")}`);
});

check("ships no source, tests or env files", () => {
  const leaked = shipped.filter((p) => /^(src|test|scripts)\/|\.env|\.test\.|tsconfig|pnpm-lock/.test(p));
  if (leaked.length) throw new Error(`leaked: ${leaked.join(", ")}`);
});

check("carries no credentials, keys or personal addresses", () => {
  const pattern =
    /sandboxTokenizedUser|2is7hdktrekv|4f6o0cjiki2rfm|eyJ[A-Za-z0-9_-]{20,}|BEGIN [A-Z ]*PRIVATE KEY|gh[po]_[A-Za-z0-9]{20,}|npm_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}/;
  const dir = join(work, "node_modules", "paykit-bd");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((entry) => {
      const full = join(d, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const hits = walk(dir).filter((file) => pattern.test(readFileSync(file, "utf8")));
  if (hits.length) throw new Error(`secret-shaped content in: ${hits.map((h) => relative(dir, h)).join(", ")}`);
});

check("leaves no dangling sourceMappingURL", () => {
  const dir = join(work, "node_modules", "paykit-bd", "dist");
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((entry) => {
      const full = join(d, entry);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });
  const withMaps = walk(dir).filter(
    (f) => /\.(js|cjs)$/.test(f) && readFileSync(f, "utf8").includes("sourceMappingURL"),
  );
  const mapsPresent = walk(dir).some((f) => f.endsWith(".map"));
  if (withMaps.length && !mapsPresent) {
    throw new Error(`${withMaps.length} file(s) reference a sourcemap that is not shipped`);
  }
});

check("declares no install-time scripts", () => {
  const manifest = JSON.parse(readFileSync(join(work, "node_modules", "paykit-bd", "package.json"), "utf8")) as {
    scripts?: Record<string, string>;
  };
  const hooks = ["preinstall", "install", "postinstall", "prepare"].filter((k) => manifest.scripts?.[k]);
  if (hooks.length) throw new Error(`runs on install: ${hooks.join(", ")}`);
});

check("declares no runtime dependencies", () => {
  const manifest = JSON.parse(readFileSync(join(work, "node_modules", "paykit-bd", "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  const deps = Object.keys(manifest.dependencies ?? {});
  if (deps.length) throw new Error(`has runtime deps: ${deps.join(", ")}`);
});

// ---------------------------------------------------------------- runtime

check("every subpath imports and works under ESM", () => {
  writeFileSync(
    join(work, "esm.mjs"),
    `
import { BkashClient, BKASH_MODE, parseBkashTime, BkashWebhookVerifier } from "paykit-bd/bkash";
import { toAmountString, sumAmounts, MemoryTokenStore, isPaymentProvider } from "paykit-bd";
import { createBkashWebhookHandler, createBkashCallbackHandler } from "paykit-bd/bkash/next";
import { bkashWebhookMiddleware, rawBodyParser } from "paykit-bd/bkash/express";
const c = new BkashClient({ environment: "sandbox", username: "u", password: "p", appKey: "k", appSecret: "s", callbackUrl: "https://x.test/cb" }, { tokenStore: new MemoryTokenStore() });
const fail = (m) => { throw new Error(m); };
if (c.id !== "bkash") fail("wrong id");
if (!isPaymentProvider(c)) fail("client does not satisfy PaymentProvider");
if (BKASH_MODE.AGREEMENT_PAYMENT !== "0001") fail("wrong mode constant");
if (toAmountString(12.5) !== "12.50") fail("money formatting");
if (sumAmounts(["1.00", "2.00", "1.59"]) !== "4.59") fail("money sum");
if (parseBkashTime("2026-09-18T06:00:19:952 GMT+0600").toISOString() !== "2026-09-18T00:00:19.952Z") fail("date parsing");
for (const [n, f] of Object.entries({ createBkashWebhookHandler, createBkashCallbackHandler, bkashWebhookMiddleware, rawBodyParser }))
  if (typeof f !== "function") fail(n + " is not a function");
if (typeof new BkashWebhookVerifier({}).verify !== "function") fail("verifier missing verify");
`,
  );
  run("node", ["esm.mjs"], work);
});

check("root and bkash subpaths import and work under CJS", () => {
  writeFileSync(
    join(work, "cjs.cjs"),
    `
const { BkashClient } = require("paykit-bd/bkash");
const { toAmountString } = require("paykit-bd");
const { bkashWebhookMiddleware } = require("paykit-bd/bkash/express");
const { createBkashWebhookHandler } = require("paykit-bd/bkash/next");
if (new BkashClient({ environment: "sandbox", username: "u", password: "p", appKey: "k", appSecret: "s" }).id !== "bkash") throw new Error("wrong id");
if (toAmountString("500") !== "500.00") throw new Error("money formatting");
if (typeof bkashWebhookMiddleware !== "function" || typeof createBkashWebhookHandler !== "function") throw new Error("adapters missing");
`,
  );
  run("node", ["cjs.cjs"], work);
});

// The check that caught the real bug: an error thrown inside the bkash bundle
// must satisfy `instanceof` against the class imported from the root entry.
check("instanceof holds for errors crossing entry-point bundles", () => {
  writeFileSync(
    join(work, "identity.mjs"),
    `
import { PaykitError, WebhookVerificationError, NetworkError, ConfigError } from "paykit-bd";
import { assertSnsUrl, BkashError } from "paykit-bd/bkash";

let thrown;
try { assertSnsUrl("https://sns.ap-southeast-1.amazonaws.com.evil.net/x.pem", "SigningCertURL"); }
catch (e) { thrown = e; }
if (!thrown) throw new Error("the SNS host guard did not fire at all");

const must = (cond, m) => { if (!cond) throw new Error(m); };
must(thrown instanceof Error, "not an Error");
must(thrown instanceof PaykitError, "thrown from paykit-bd/bkash but does not match PaykitError from paykit-bd");
must(thrown instanceof WebhookVerificationError, "does not match WebhookVerificationError from the root entry");
must(!(thrown instanceof NetworkError), "wrongly matches NetworkError");
must(!(thrown instanceof ConfigError), "wrongly matches ConfigError");
must(thrown.code === "cert_url_untrusted", "wrong code: " + thrown.code);

const bkashErr = new BkashError({ code: "2023", message: "Insufficient Balance" });
must(bkashErr instanceof PaykitError, "BkashError does not match PaykitError across entries");
must(!(new Error("plain") instanceof PaykitError), "a plain Error wrongly matches PaykitError");
`,
  );
  run("node", ["identity.mjs"], work);
});

// ------------------------------------------------------------------ types

check("types resolve with no ambient @types/node and skipLibCheck off", () => {
  run("npm", ["install", "--silent", "--no-audit", "--no-fund", "-D", "typescript@5.9.3"], work);
  writeFileSync(
    join(work, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      files: ["types.ts"],
    }),
  );
  writeFileSync(
    join(work, "types.ts"),
    `
import { BkashClient, configFromEnv } from "paykit-bd/bkash";
import type { Payment, Refund, CreatedPayment, WebhookEvent, PaymentProvider } from "paykit-bd";
const c = new BkashClient({ environment: "sandbox", username: "u", password: "p", appKey: "k", appSecret: "s" });
const provider: PaymentProvider = c;
const a: Promise<CreatedPayment> = c.createPayment({ amount: "1", reference: "r" });
const b: Promise<Payment> = c.getPayment("x");
const d: Promise<Refund> = c.refund({ paymentId: "p", transactionId: "t" });
const e: Promise<WebhookEvent> = c.verifyWebhook({ body: "{}", headers: {} });
void provider; void a; void b; void d; void e; void configFromEnv({});
`,
  );
  run("npx", ["tsc"], work);
});

// ------------------------------------------------------------------ report

rmSync(join(root, tarball), { force: true });
rmSync(work, { recursive: true, force: true });

console.log(
  failures.length === 0
    ? `\nPackage verified: ${shipped.length} files, installs and works as a dependency.\n`
    : `\n${failures.length} check(s) failed: ${failures.join(", ")}\n`,
);
process.exit(failures.length === 0 ? 0 : 1);
