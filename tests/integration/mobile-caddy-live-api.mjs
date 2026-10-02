// Run against the repository Caddyfile, the real development API, and an isolated
// PostgreSQL database. The caller owns the browser fixture and attempt cleanup.
// Enable the development mobile client/callback on the API. Create the protected
// fixture with auth-app/test/browser-fixture.ts; remove its user/session and the
// mobileLogin IDs written to LOMI_AUTH_MOBILE_ATTEMPTS_FILE in a caller finally.
// Invocation (from auth-frontend, with the API and Caddy already running):
// LOMI_AUTH_TEST_ORIGIN=http://127.0.0.1:<caddy-port> \
// LOMI_AUTH_BROWSER_FIXTURE_FILE=<protected-fixture.json> \
// LOMI_AUTH_MOBILE_ATTEMPTS_FILE=<owned-cleanup.json> \
// bun tests/integration/mobile-caddy-live-api.mjs
import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const base = process.env.LOMI_AUTH_TEST_ORIGIN;
const origin = new URL(base ?? "http://invalid");
assert.ok(origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname) && origin.origin === base,
  "An explicit local test origin is required");
const fixturePath = process.env.LOMI_AUTH_BROWSER_FIXTURE_FILE;
const attemptsPath = process.env.LOMI_AUTH_MOBILE_ATTEMPTS_FILE;
assert.ok(fixturePath && attemptsPath, "Fixture and attempt cleanup files are required");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
assert.match(fixture.userId, /^browser_probe_[a-f0-9-]{36}$/);
assert.ok(typeof fixture.cookie === "string" && fixture.cookie.includes("."));
const attempts = [];
const randomValue = () => randomBytes(32).toString("base64url");
let browser;
let phase = "setup";
let cspViolation = false;
let runtimeError = false;

async function start() {
  const state = randomValue();
  const response = await fetch(`${base}/v1/mobile-auth/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ clientId: "lomi-mobile-development",
      redirectUri: "dev.lomi.mobile.dev://auth/callback", state,
      codeChallenge: createHash("sha256").update(randomValue()).digest("base64url") }),
  });
  assert.equal(response.status, 200);
  const attempt = await response.json();
  attempts.push(attempt.requestId);
  await writeFile(attemptsPath, JSON.stringify(attempts), { mode: 0o600 });
  assert.equal(new URL(attempt.authorizationUrl).origin, base);
  return { ...attempt, state };
}

async function openPortal(page, attempt) {
  const response = await page.goto(attempt.authorizationUrl);
  assert.equal(response.status(), 200);
  const csp = response.headers()["content-security-policy"];
  const nonce = await page.locator("script[nonce]").evaluate((script) => script.nonce);
  assert.match(nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(csp.includes(`script-src 'nonce-${nonce}'`), "Caddy must preserve the backend nonce CSP");
  assert.ok(csp.includes("default-src 'none'") && csp.includes("frame-ancestors 'none'") && !csp.includes("unsafe-inline"));
  assert.equal(response.headers()["x-frame-options"], "DENY");
  assert.equal(response.headers()["x-content-type-options"], "nosniff");
}

try {
  browser = await chromium.launch({ headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to load|violat/i.test(message.text())) cspViolation = true;
  });
  page.on("pageerror", () => { runtimeError = true; });
  await page.route("https://github.com/**", (route) => route.fulfill({
    status: 200, contentType: "text/html", body: "<!doctype html><title>OAuth navigation intercepted</title>" }));

  phase = "static fallback policy";
  const staticResponse = await fetch(`${base}/login`);
  assert.equal(staticResponse.status, 200);
  const staticCsp = staticResponse.headers.get("content-security-policy");
  assert.ok(staticCsp.includes("script-src 'self'") && staticCsp.includes("style-src 'self'") && !staticCsp.includes("nonce-") && !staticCsp.includes("unsafe-inline"));

  phase = "unsigned login script through Caddy";
  const login = await start();
  await openPortal(page, login);
  const signedIn = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/sign-in/social" && r.request().method() === "POST");
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  const socialResponse = await signedIn;
  assert.equal(socialResponse.status(), 200);
  assert.deepEqual(socialResponse.request().postDataJSON(), { provider: "github", disableRedirect: true,
    callbackURL: `/v1/mobile-auth/request?requestId=${login.requestId}` });
  await page.waitForURL("https://github.com/**");

  await context.addCookies([{ name: "better-auth.session_token", value: fixture.cookie,
    url: base, httpOnly: true, sameSite: "Lax" }]);
  for (const decision of ["deny", "approve"]) {
    phase = `authenticated ${decision} script through Caddy`;
    const attempt = await start();
    await openPortal(page, attempt);
    const received = page.waitForResponse((r) => new URL(r.url()).pathname === "/v1/mobile-auth/request" && r.request().method() === "POST");
    await page.getByRole("button", { name: decision === "deny" ? "Deny" : "Authorize", exact: true }).click();
    const response = await received;
    assert.equal(response.status(), 200);
    assert.equal(response.request().postDataJSON().decision, decision);
    assert.equal(response.request().postDataJSON().requestId, attempt.requestId);
    const callback = new URL((await response.json()).redirectUrl);
    assert.equal(callback.origin, "null");
    assert.equal(callback.protocol, "dev.lomi.mobile.dev:");
    assert.equal(callback.hostname, "auth");
    assert.equal(callback.pathname, "/callback");
    assert.equal(callback.searchParams.get("state"), attempt.state);
    assert.equal(callback.searchParams.get("requestId"), attempt.requestId);
    if (decision === "deny") assert.equal(callback.searchParams.get("error"), "access_denied");
    else assert.match(callback.searchParams.get("code"), /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await fetch(attempt.authorizationUrl)).status, 410);
    await expect(page.locator("#error")).toBeEmpty();
  }
  assert.ok(!cspViolation, "Browser reported a CSP violation");
  assert.ok(!runtimeError, "Browser reported a page runtime error");
  console.log("PASS: real Caddy preserves backend nonce CSP; browser executes GitHub sign-in and authenticated deny/approve requests; strict static fallback and global headers remain; no CSP/runtime errors. GitHub navigation intercepted; OAuth completion not tested.");
} catch (error) {
  console.error(`FAIL during ${phase} (${error instanceof Error ? error.name : "Error"}); no credentials printed`);
  process.exitCode = 1;
} finally {
  await browser?.close();
}
