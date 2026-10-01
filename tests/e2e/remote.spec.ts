import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const requestId = "A".repeat(43);
const returnTo = `/remote?request=${requestId}`;
const origin = "https://remote.lomi.dev";
const callback = `${origin}/auth/callback?code=${"C".repeat(43)}&state=${"S".repeat(43)}`;
const avatarUrl = "https://avatars.githubusercontent.com/u/123?v=4";
const me = { user: { id: "user_123", displayName: "Ada Lovelace", githubLogin: "ada-lovelace", status: "active", image: null as string | null }, session: { id: "browser_123", expiresAt: "2099-10-03T12:00:00Z" }, capabilities: ["account:read"] };
const preview = { clientId: "lomi-remote", application: "Lomi Remote", origin, scope: ["remote:account:read"], expiresAt: "2099-10-03T12:00:00Z" };
const csp = readFileSync(new URL("../../ops/Caddyfile", import.meta.url), "utf8").match(/Content-Security-Policy "([^"]+)"/)![1]!;
async function mockAccount(page: Page, image: string | null = null) {
  await page.route("**/v1/me", route => route.fulfill({ json: { ...me, user: { ...me.user, image } } }));
  await page.route("**/v1/remote-login/request?**", route => route.fulfill({ json: preview }));
}
for (const width of [1280, 375]) {
  test(`remote account photo and compact layout at ${width}px under deployment CSP`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await mockAccount(page, avatarUrl);
    const violations: string[] = [];
    page.on("console", message => { if (/content security policy|refused to load/i.test(message.text())) violations.push(message.text()); });
    await page.route("**/remote?**", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
    });
    let referer: string | undefined;
    await page.route(avatarUrl, route => {
      referer = route.request().headers().referer;
      return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="56" height="56"><rect width="56" height="56" fill="#d9ded7"/><circle cx="28" cy="22" r="10" fill="#535c56"/><path d="M8 56v-7a20 20 0 0 1 40 0v7" fill="#535c56"/></svg>' });
    });
    await page.goto(returnTo);
    await expect(page.getByRole("heading", { name: "Log in to Lomi Remote" })).toBeVisible();
    await expect(page.locator("#remote-avatar")).toBeVisible();
    await expect(page.getByText("Ada Lovelace", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
    await expect(page.locator("#remote-status")).toBeHidden();
    expect(referer).toBeUndefined();
    expect(violations).toEqual([]);
    const dimensions = await page.locator(".remote-panel").evaluate(element => ({ width: element.getBoundingClientRect().width, overflow: document.documentElement.scrollWidth > innerWidth }));
    expect(dimensions.width).toBeLessThanOrEqual(440);
    expect(dimensions.overflow).toBe(false);
    await page.screenshot({ path: info.outputPath(`remote-${width}.png`), fullPage: true });
  });
}
for (const image of [null, "https://evil.example/avatar.png", "https://avatars.githubusercontent.com/u/broken"]) {
  test(`remote uses initials for ${image ?? "missing avatar"}`, async ({ page }) => {
    await mockAccount(page, image);
    await page.route("https://avatars.githubusercontent.com/**", route => route.abort());
    await page.goto(returnTo);
    await expect(page.locator("#remote-initials")).toHaveText("AL");
    await expect(page.locator("#remote-avatar")).toBeHidden();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  });
}
test("remote Continue is explicit, deduplicates busy clicks, and validates callback", async ({ page }) => {
  await mockAccount(page);
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/v1/remote-login/complete", async route => {
    count += 1;
    expect(route.request().postDataJSON()).toEqual({ requestId });
    expect(route.request().headers()["x-lomi-request"]).toBe("1");
    expect(route.request().headers()["content-type"]).toBe("application/json");
    await gate;
    await route.fulfill({ json: { redirectUrl: callback } });
  });
  await page.route(callback, route => route.fulfill({ body: "Remote callback received" }));
  await page.goto(returnTo);
  const button = page.getByRole("button", { name: "Continue", exact: true });
  await expect(button).toBeEnabled();
  expect(count).toBe(0);
  await button.evaluate((element: HTMLButtonElement) => { element.click(); element.click(); });
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect.poll(() => count).toBe(1);
  release();
  await expect(page).toHaveURL(callback);
  expect(count).toBe(1);
});
test("fresh remote visitor automatically reaches GitHub login with guarded return", async ({ page }) => {
  let count = 0;
  await page.route("**/v1/me", route => route.fulfill({ status: 401, json: { error: { code: "SESSION_REQUIRED" } } }));
  await page.route("**/v1/remote-login/**", route => { count += 1; return route.abort(); });
  await page.goto(returnTo);
  await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
  expect(count).toBe(0);
});
for (const invalid of ["invalid", `${requestId}&extra=1`, `${requestId}#fragment`]) {
  test(`remote rejects malformed request ${invalid}`, async ({ page }) => {
    let count = 0;
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/v1/")) count += 1; });
    await page.goto(`/remote?request=${invalid}`);
    await expect(page.getByRole("alert")).toContainText("This request is invalid");
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeHidden();
    expect(count).toBe(0);
  });
}
for (const invalid of [{ application: "Other app" }, { origin: "https://evil.example" }, { scope: ["remote:account:read", "terminal:control"] }, { scope: ["terminal:control"] }, { expiresAt: "2000-01-01T00:00:00Z" }, { expiresAt: "invalid" }]) {
  test(`remote fails closed for invalid preview ${JSON.stringify(invalid)}`, async ({ page }) => {
    await mockAccount(page);
    await page.route("**/v1/remote-login/request?**", route => route.fulfill({ json: { ...preview, ...invalid } }));
    await page.goto(returnTo);
    await expect(page.getByRole("alert")).toContainText("Start sign-in again on Lomi Remote");
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeHidden();
  });
}
test("remote keeps suspended account closed", async ({ page }) => {
  await mockAccount(page);
  await page.route("**/v1/me", route => route.fulfill({ json: { ...me, user: { ...me.user, status: "suspended" } } }));
  await page.goto(returnTo);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeHidden();
});
test("remote blocks unsafe completion callback and allows retry", async ({ page }) => {
  await mockAccount(page);
  await page.route("**/v1/remote-login/complete", route => route.fulfill({ json: { redirectUrl: "https://evil.example/auth/callback" } }));
  await page.goto(returnTo);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Try again");
  await expect(page).toHaveURL(returnTo);
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
});
test("remote Cancel explicitly denies with registered cancellation callback", async ({ page }) => {
  await mockAccount(page);
  await page.route("**/v1/remote-login/deny", route => {
    expect(route.request().postDataJSON()).toEqual({ requestId });
    expect(route.request().headers()["x-lomi-request"]).toBe("1");
    return route.fulfill({ json: { redirectUrl: `${origin}/?auth=cancelled` } });
  });
  await page.route(`${origin}/?auth=cancelled`, route => route.fulfill({ body: "Cancelled" }));
  await page.goto(returnTo);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page).toHaveURL(`${origin}/?auth=cancelled`);
});

test("remote preview 401 fails closed without redirecting to login", async ({ page }) => {
  await mockAccount(page);
  await page.route("**/v1/remote-login/request?**", route => route.fulfill({ status: 401, json: { error: { code: "SESSION_REQUIRED" } } }));
  await page.goto(returnTo);
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page).toHaveURL(returnTo);
  await expect(page.locator("#remote-login")).toBeHidden();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeHidden();
});

test("remote supports old account responses without an image field", async ({ page }) => {
  await mockAccount(page);
  await page.route("**/v1/me", route => {
    const { image: _image, ...user } = me.user;
    return route.fulfill({ json: { ...me, user } });
  });
  await page.goto(returnTo);
  await expect(page.locator("#remote-initials")).toHaveText("AL");
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
});
