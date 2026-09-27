import { chromium, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const base = process.env.LOMI_AUTH_TEST_ORIGIN ?? "http://localhost:54330";
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
const issued = await fetch(base + "/api/auth/device/code", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_id: "lomi-desktop-dev" }),
});
if (issued.status !== 200)
  throw new Error("Device issuance failed: " + issued.status);
const grant = await issued.json();
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
try {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 850 },
  });
  await context.addCookies([
    {
      name: "better-auth.session_token",
      value: fixture.cookie,
      url: base,
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (
      m.type() === "error" &&
      /Content Security Policy|Refused/.test(m.text())
    )
      errors.push(m.text());
  });
  await page.goto(
    base + "/device?user_code=" + encodeURIComponent(grant.user_code),
  );
  await expect(
    page.getByText("Browser qualification", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Check code", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Approve this device", exact: true }),
  ).toBeVisible();
  if (process.env.LOMI_AUTH_SCREENSHOTS)
    await page.screenshot({
      path: process.env.LOMI_AUTH_SCREENSHOTS + "/device.png",
      fullPage: true,
    });
  await page
    .getByRole("button", { name: "Approve this device", exact: true })
    .click();
  await page.waitForURL(/device\/result/);
  const redeemed = await fetch(base + "/api/auth/device/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: "lomi-desktop-dev",
      device_code: grant.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  if (redeemed.status !== 200)
    throw new Error("Redemption failed: " + redeemed.status);
  const token = (await redeemed.json()).access_token;
  const nativeHeaders = { authorization: "Bearer " + token };
  if ((await fetch(base + "/v1/me", { headers: nativeHeaders })).status !== 200)
    throw new Error("Desktop bearer failed");
  await page.goto(base + "/account");
  await expect(
    page.getByRole("button", {
      name: "Revoke Lomi desktop session",
      exact: true,
    }),
  ).toBeVisible();
  const icon = await page
    .locator(".session-kind-icon svg")
    .first()
    .boundingBox();
  if (!icon || icon.width > 32 || icon.height > 32)
    throw new Error("Unbounded session icon");
  if (process.env.LOMI_AUTH_SCREENSHOTS)
    await page.screenshot({
      path: process.env.LOMI_AUTH_SCREENSHOTS + "/account.png",
      fullPage: true,
    });
  if (
    await page.evaluate(
      (token) => JSON.stringify(localStorage).includes(token),
      token,
    )
  )
    throw new Error("Token leaked to localStorage");
  await page
    .getByRole("button", { name: "Revoke Lomi desktop session", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke session", exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: "Revoke Lomi desktop session",
      exact: true,
    }),
  ).toHaveCount(0);
  if ((await fetch(base + "/v1/me", { headers: nativeHeaders })).status !== 401)
    throw new Error("Revoked bearer still valid");
  await page.getByRole("button", { name: "Revoke all", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke all sessions", exact: true })
    .click();
  await page.waitForURL(/login/);
  if (errors.length)
    throw new Error("Browser/CSP errors: " + JSON.stringify(errors));
  console.log(
    "PASS: real Caddy + Astro + Elysia + Better Auth + PostgreSQL claim/approval, Bearer access, revoke one/all; CSP clean; bounded session rows; no token in localStorage.",
  );
} finally {
  await browser.close();
}
