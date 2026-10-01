import { expect, test } from "@playwright/test";
const requestId = "A".repeat(43);
const returnTo = `/remote?request=${requestId}`;
const loginUrl = `/login?returnTo=${encodeURIComponent(returnTo)}`;
const me = { user: { id: "user_123", displayName: "Ada Lovelace", githubLogin: "ada-lovelace", status: "active" }, session: { id: "browser_123", expiresAt: "2099-10-03T12:00:00Z" }, capabilities: ["account:read"] };

test("anonymous direct Remote login checks session before showing explicit GitHub sign-in", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let checks = 0;
  let signIns = 0;
  await page.route("**/v1/me", async route => {
    checks += 1;
    await gate;
    await route.fulfill({ status: 401, json: { error: { code: "SESSION_REQUIRED" } } });
  });
  await page.route("**/api/auth/sign-in/social", route => {
    signIns += 1;
    expect(route.request().postDataJSON()).toEqual({ provider: "github", callbackURL: returnTo, errorCallbackURL: `/error?returnTo=${encodeURIComponent(returnTo)}`, disableRedirect: true });
    return route.fulfill({ json: { url: "https://github.com/login/oauth/authorize?client_id=test", redirect: false } });
  });
  await page.route("https://github.com/**", route => route.fulfill({ body: "GitHub authorization" }));
  await page.goto(loginUrl);
  await expect(page.getByRole("status")).toHaveText("Checking your Lomi session…");
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeHidden();
  expect(signIns).toBe(0);
  release();
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
  await expect(page).toHaveURL(loginUrl);
  expect(checks).toBe(1);
  expect(signIns).toBe(0);
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect(page).toHaveURL(/github\.com\/login\/oauth\/authorize/);
  expect(signIns).toBe(1);
});

test("existing Remote session skips login and reaches consent without approval", async ({ page }) => {
  let checks = 0;
  let signIns = 0;
  let approvals = 0;
  await page.route("**/v1/me", route => { checks += 1; return route.fulfill({ json: me }); });
  await page.route("**/v1/remote-login/request?**", route => route.fulfill({ json: { application: "Lomi Remote", origin: "https://remote.lomi.dev", scope: ["remote:account:read"], expiresAt: "2099-10-03T12:00:00Z" } }));
  await page.route("**/v1/remote-login/complete", route => { approvals += 1; return route.abort(); });
  await page.route("**/api/auth/sign-in/social", route => { signIns += 1; return route.abort(); });
  await page.goto(loginUrl);
  await expect(page).toHaveURL(returnTo);
  await expect(page.getByRole("heading", { name: "Log in to Remote", exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Log in to Remote · Lomi");
  await expect(page.getByText("Ada Lovelace", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeEnabled();
  expect(checks).toBe(2);
  expect(signIns).toBe(0);
  expect(approvals).toBe(0);
});

for (const failure of ["network", "403", "suspended", "malformed"]) {
  test(`Remote login ${failure} session failure stays closed and retries without redirect loop`, async ({ page }) => {
    let checks = 0;
    let signIns = 0;
    await page.route("**/v1/me", route => {
      checks += 1;
      if (checks > 1) return route.fulfill({ status: 401, json: { error: { code: "SESSION_REQUIRED" } } });
      if (failure === "network") return route.abort();
      if (failure === "403") return route.fulfill({ status: 403, json: { error: { code: "FORBIDDEN" } } });
      if (failure === "malformed") return route.fulfill({ json: {} });
      return route.fulfill({ json: { ...me, user: { ...me.user, status: "suspended" } } });
    });
    await page.route("**/api/auth/sign-in/social", route => { signIns += 1; return route.abort(); });
    await page.goto(loginUrl);
    await expect(page.getByRole("status")).toContainText("We couldn’t confirm your Lomi session");
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeHidden();
    await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
    await expect(page).toHaveURL(loginUrl);
    expect(checks).toBe(1);
    expect(signIns).toBe(0);
    await page.getByRole("button", { name: "Check again" }).click();
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Check again" })).toBeHidden();
    await expect(page).toHaveURL(loginUrl);
    expect(checks).toBe(2);
    expect(signIns).toBe(0);
  });
}

for (const destination of ["/account", "/device?user_code=ABCD2345", `/desktop?request=${requestId}`, "/remote?request=invalid", `/remote?request=${requestId}&extra=1`, `https://evil.example/remote?request=${requestId}`]) {
  test(`non-Remote or invalid login return keeps existing behavior: ${destination}`, async ({ page }) => {
    let checks = 0;
    await page.route("**/v1/me", route => { checks += 1; return route.fulfill({ json: me }); });
    const url = `/login?returnTo=${encodeURIComponent(destination)}`;
    await page.goto(url);
    await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
    await expect(page).toHaveURL(url);
    expect(checks).toBe(0);
  });
}
