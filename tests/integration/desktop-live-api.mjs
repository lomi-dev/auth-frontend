import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const base = process.env.LOMI_AUTH_TEST_ORIGIN;
if (!base) throw new Error("LOMI_AUTH_TEST_ORIGIN is required");
const origin = new URL(base);
if (
  origin.protocol !== "http:" ||
  !["localhost", "127.0.0.1"].includes(origin.hostname) ||
  origin.origin !== base
)
  throw new Error("Only an explicit local test origin is allowed");

const fixturePath = process.env.LOMI_AUTH_BROWSER_FIXTURE_FILE;
if (!fixturePath) throw new Error("LOMI_AUTH_BROWSER_FIXTURE_FILE is required");
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
if (
  typeof fixture.userId !== "string" ||
  !/^browser_probe_[a-f0-9-]{36}$/.test(fixture.userId) ||
  typeof fixture.cookie !== "string" ||
  !fixture.cookie.includes(".")
)
  throw new Error("The browser probe fixture is invalid");

const sourceSessionToken = fixture.cookie.split(".", 1)[0];
const randomLoginValue = () => randomBytes(32).toString("base64url");
const sha256Base64Url = (value) =>
  createHash("sha256").update(value, "ascii").digest("base64url");
const check = (condition, message) => assert.ok(condition, message);
const requireStatus = (response, status, label) =>
  check(response.status === status, `${label} returned HTTP ${response.status}`);

const verifier = randomLoginValue();
const state = randomLoginValue();
const codeChallenge = sha256Base64Url(verifier);
let browser;
let callbackServer;
let callbackTimer;
const auditSnapshots = [];
const responseChecks = [];
let cspViolation = false;
let browserRuntimeError = false;
let browserCredentialLeak = false;
let phase = "setup";

const auditResponse = (response) => {
  let responseUrl;
  try {
    responseUrl = new URL(response.url());
  } catch {
    return;
  }
  if (responseUrl.origin !== origin.origin || !responseUrl.pathname.startsWith("/v1/"))
    return;
  responseChecks.push(
    (async () => {
      const body = await response.text().catch(() => "");
      if (
        body.includes(sourceSessionToken) ||
        /"(?:access_token|refresh_token|token_type)"\s*:/i.test(body)
      )
        browserCredentialLeak = true;
    })(),
  );
};

try {
  callbackServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/auth/callback") {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    const callback = {
      method: request.method,
      pathname: url.pathname,
      keys: [...url.searchParams.keys()],
      code: url.searchParams.get("code"),
      state: url.searchParams.get("state"),
    };
    response.writeHead(request.method === "GET" ? 200 : 405, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end("<!doctype html><title>Lomi</title><p>Sign-in complete. Return to Lomi.</p>");
    callbackServer.callback = callback;
    callbackServer.resolveCallback?.(callback);
  });
  await new Promise((resolve, reject) => {
    callbackServer.once("error", reject);
    callbackServer.listen(0, "127.0.0.1", resolve);
  });
  const address = callbackServer.address();
  check(address && typeof address === "object", "Could not open loopback callback");
  const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;

  const startResponse = await fetch(`${base}/v1/desktop/start`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: "lomi-desktop-dev",
      redirectUri,
      state,
      codeChallenge,
    }),
  });
  requireStatus(startResponse, 200, "Desktop start");
  const startBody = await startResponse.json();
  const authorizationUrl = new URL(startBody.authorizationUrl);
  check(authorizationUrl.origin === origin.origin, "Authorization URL has the wrong origin");
  check(authorizationUrl.pathname === "/desktop", "Authorization URL has the wrong path");
  check(
    [...authorizationUrl.searchParams.keys()].join(",") === "request" &&
      /^[A-Za-z0-9_-]{43}$/.test(authorizationUrl.searchParams.get("request") ?? ""),
    "Authorization URL does not contain one opaque request ID",
  );
  check(!JSON.stringify(startBody).includes(sourceSessionToken), "Start response exposed the source session");

  phase = "launching the real browser";
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
  });
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
  await context.addCookies([
    {
      name: "better-auth.session_token",
      value: fixture.cookie,
      url: base,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await context.exposeBinding("__lomiAuditSnapshot", (_source, snapshot) => {
    auditSnapshots.push(snapshot);
  });
  await context.addInitScript((sessionToken) => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        let serialized = document.documentElement?.innerText ?? "";
        try {
          serialized += JSON.stringify({
            local: localStorage,
            session: sessionStorage,
            cookie: document.cookie,
          });
        } catch {
          // A storage access error does not expose credentials.
        }
        void window.__lomiAuditSnapshot?.({
          host: location.hostname,
          path: location.pathname,
          sourceTokenPresent: serialized.includes(sessionToken),
        });
      },
      { once: true },
    );
  }, sourceSessionToken);

  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to load|violat/i.test(message.text()))
      cspViolation = true;
  });
  page.on("pageerror", () => {
    browserRuntimeError = true;
  });
  page.on("response", auditResponse);

  phase = "opening the authorization page";
  const callbackReceived = new Promise((resolve) => {
    callbackServer.resolveCallback = resolve;
  });
  const desktopResponse = await page.goto(authorizationUrl.toString(), {
    waitUntil: "domcontentloaded",
    timeout: 20_000,
  });
  check(desktopResponse, "Desktop authorization page did not return a response");
  const headers = desktopResponse.headers();
  const csp = headers["content-security-policy"] ?? "";
  check(
    csp.includes("default-src 'none'") &&
      csp.includes("script-src 'self'") &&
      csp.includes("style-src 'self'") &&
      !csp.includes("unsafe-inline"),
    "Desktop page did not receive the strict Caddy CSP",
  );
  const callbackTimeout = new Promise((_, reject) => {
    callbackTimer = setTimeout(() => reject(new Error("Loopback callback timed out")), 20_000);
  });
  await Promise.race([callbackReceived, callbackTimeout]);
  clearTimeout(callbackTimer);
  await page.waitForURL(
    (url) => url.hostname === "127.0.0.1" && url.port === String(address.port),
    { timeout: 10_000 },
  );

  const callback = callbackServer.callback;
  check(callback?.method === "GET", "Browser did not navigate to the callback with GET");
  check(callback.pathname === "/auth/callback", "Browser reached the wrong callback path");
  check(callback.keys.length === 2 && callback.keys.every((key) => key === "code" || key === "state"), "Loopback URL contains extra query fields");
  check(/^[A-Za-z0-9_-]{43}$/.test(callback.code ?? ""), "Loopback URL did not contain a valid one-time code");
  check(callback.state === state, "Loopback URL state did not match the native request");
  check(!page.url().includes(sourceSessionToken), "Loopback URL exposed the source session");
  check(!(await page.locator("body").innerText()).includes(sourceSessionToken), "Loopback page DOM exposed the source session");

  phase = "exchanging the one-time code";
  const exchangeResponse = await fetch(`${base}/v1/desktop/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: "lomi-desktop-dev",
      redirectUri,
      code: callback.code,
      codeVerifier: verifier,
    }),
  });
  requireStatus(exchangeResponse, 200, "Desktop exchange");
  check(!exchangeResponse.headers.has("set-cookie"), "Native exchange set a browser cookie");
  const exchangeBody = await exchangeResponse.json();
  check(
    typeof exchangeBody.access_token === "string" &&
      exchangeBody.token_type === "Bearer" &&
      typeof exchangeBody.expires_in === "number",
    "Native exchange returned an invalid bearer response",
  );
  check(!JSON.stringify(exchangeBody).includes(sourceSessionToken), "Exchange reused the source browser session");

  const replayResponse = await fetch(`${base}/v1/desktop/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: "lomi-desktop-dev",
      redirectUri,
      code: callback.code,
      codeVerifier: verifier,
    }),
  });
  requireStatus(replayResponse, 400, "One-time code replay");

  const bearerHeaders = { authorization: `Bearer ${exchangeBody.access_token}` };
  const meResponse = await fetch(`${base}/v1/me`, { headers: bearerHeaders });
  requireStatus(meResponse, 200, "Native bearer session check");
  const me = await meResponse.json();
  check(me.user?.id === fixture.userId, "Native bearer resolved to the wrong user");
  check(me.session?.id && me.session.id !== fixture.sessionId, "Desktop received the source browser session");

  phase = "checking protected session revocation";
  const accountPage = await context.newPage();
  accountPage.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to load|violat/i.test(message.text()))
      cspViolation = true;
  });
  accountPage.on("pageerror", () => {
    browserRuntimeError = true;
  });
  accountPage.on("response", auditResponse);
  await accountPage.goto(`${base}/account`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const desktopRevokeButton = accountPage.getByRole("button", {
    name: "Revoke Lomi desktop session",
    exact: true,
  });
  await expect(desktopRevokeButton).toBeVisible({ timeout: 15_000 });
  const browserContents = await accountPage.evaluate(() => {
    return JSON.stringify({
      text: document.documentElement.innerText,
      local: localStorage,
      session: sessionStorage,
      cookie: document.cookie,
    });
  });
  check(!browserContents.includes(sourceSessionToken), "Portal DOM or storage exposed the source session");

  await desktopRevokeButton.click();
  await accountPage
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke session", exact: true })
    .click();
  await expect(desktopRevokeButton).toHaveCount(0, { timeout: 15_000 });
  const revokedMeResponse = await fetch(`${base}/v1/me`, { headers: bearerHeaders });
  requireStatus(revokedMeResponse, 401, "Revoked native bearer session");

  await Promise.all(responseChecks);
  check(!browserCredentialLeak, "A browser API response exposed a session credential");
  check(!cspViolation, "The browser reported a CSP violation");
  check(!browserRuntimeError, "The browser reported a page runtime error");
  check(
    auditSnapshots.some((snapshot) => snapshot.host === "localhost" && ["/desktop", "/desktop/"].includes(snapshot.path) && !snapshot.sourceTokenPresent),
    "Desktop page DOM or storage exposed the source session",
  );

  console.log(
    "PASS: real Caddy + portal + API + PostgreSQL browser redirect, loopback state, PKCE exchange, replay rejection, bearer access and protected revocation; no browser session credential exposure; CSP clean.",
  );
} catch (error) {
  const kind = error instanceof Error ? error.name : "Error";
  console.error(`FAIL during ${phase} (${kind})`);
  process.exitCode = 1;
} finally {
  if (callbackTimer) clearTimeout(callbackTimer);
  if (browser) await browser.close();
  if (callbackServer?.listening)
    await new Promise((resolve) => callbackServer.close(resolve));
}
