import { expect, test, type Page } from "@playwright/test";

const me = {
  user: { id: "user_123", displayName: "Ada Lovelace", email: "ada@example.com", githubLogin: "ada-lovelace", status: "active" },
  session: { id: "browser_123", expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  capabilities: ["account:read"],
};

async function deviceFixture(page: Page, overrides: Record<string, unknown> = {}) {
  const calls = { verify: 0, approve: 0, deny: 0, approvedBody: null as unknown, deniedBody: null as unknown };
  await page.route("**/v1/me", (route) => route.fulfill({ json: me }));
  await page.route("**/api/auth/device?**", async (route) => {
    calls.verify += 1;
    expect(new URL(route.request().url()).searchParams.get("user_code")).toBe("ABCD2345");
    await route.fulfill({ json: {
      user_code: "ABCD2345", status: "pending", client_id: "lomi-host", purpose: "host_enrollment", reviewerUserId: me.user.id,
      expiresAt: new Date(Date.now() + 600_000).toISOString(), ...overrides,
    } });
  });
  await page.route("**/api/auth/device/approve", async (route) => {
    calls.approve += 1;
    calls.approvedBody = route.request().postDataJSON();
    await route.fulfill({ json: { success: true } });
  });
  await page.route("**/api/auth/device/deny", async (route) => {
    calls.deny += 1;
    calls.deniedBody = route.request().postDataJSON();
    await route.fulfill({ json: { success: true } });
  });
  return calls;
}

for (const viewport of [{ width: 1280, height: 1000 }, { width: 390, height: 844 }]) {
  test(`host consent requires code review and explicit authorization at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const calls = await deviceFixture(page);
    await page.goto("/device?user_code=ABCD2345");
    await expect(page.getByText("Ada Lovelace")).toBeVisible();
    await expect(page).not.toHaveURL(/user_code/);
    await expect(page.getByRole("button", { name: "Authorize this host" })).toBeHidden();
    expect(calls).toMatchObject({ verify: 0, approve: 0, deny: 0 });
    await page.getByRole("button", { name: "Check code" }).click();
    await expect(page.getByRole("heading", { name: "Authorize this host" })).toBeVisible();
    await expect(page.getByText("Lomi Remote host", { exact: true })).toBeVisible();
    await expect(page.getByText("ada@example.com", { exact: true })).toBeVisible();
    await expect(page.getByText("ABCD 2345", { exact: true })).toBeVisible();
    await expect(page.getByText(/exactly matches the code on your host/)).toBeVisible();
    await expect(page.getByText("Signing out of this browser will not remove this host’s authorization.")).toBeVisible();
    await expect(page.getByText("Projects are shared only when sharing is enabled on the host.")).toBeVisible();
    expect(calls).toMatchObject({ verify: 1, approve: 0, deny: 0 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`host-consent-${viewport.width}.png`), fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "Authorize this host" }).click();
    await expect(page).toHaveURL(/status=approved&purpose=host_enrollment$/);
    await expect(page.getByRole("heading", { name: "Request approved" })).toBeVisible();
    await expect(page.getByText(/host will confirm when it is ready/)).toBeVisible();
    await expect(page.locator("body")).not.toContainText("session is saved");
    expect(calls).toMatchObject({ verify: 1, approve: 1, deny: 0, approvedBody: { userCode: "ABCD2345" } });
  });
}

test("the same desktop client ID gains host consent only with server purpose", async ({ page }) => {
  await deviceFixture(page, { client_id: "lomi-desktop-dev" });
  await page.goto("/device?user_code=ABCD2345");
  await page.getByRole("button", { name: "Check code" }).click();
  await expect(page.getByRole("button", { name: "Authorize this host" })).toBeVisible();
  await page.unroute("**/api/auth/device?**");
  await page.route("**/api/auth/device?**", (route) => route.fulfill({ json: {
    user_code: "ABCD2345", status: "pending", client_id: "lomi-desktop-dev",
  } }));
  await page.goto("/device?user_code=ABCD2345&purpose=host_enrollment&client_id=lomi-host");
  await expect(page.getByRole("heading", { name: "Connect to Lomi" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Authorize this host" })).toBeHidden();
  await page.getByRole("button", { name: "Check code" }).click();
  await expect(page.getByText("Lomi desktop", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Approve this device" })).toBeVisible();
  await expect(page.getByText("Lomi Remote host", { exact: true })).toBeHidden();
  await expect(page.locator("#host-consent")).toBeHidden();
});

for (const purpose of ["future_enrollment", "", null, 7, {}, ["host_enrollment"]]) {
  test(`invalid server purpose fails closed: ${JSON.stringify(purpose)}`, async ({ page }) => {
    const calls = await deviceFixture(page, { purpose, client_id: "lomi-desktop-dev" });
    await page.goto("/device?user_code=ABCD2345&purpose=host_enrollment");
    await page.getByRole("button", { name: "Check code" }).click();
    await expect(page.getByRole("status")).toContainText("unrecognized app");
    await expect(page.locator("#device-review")).toBeHidden();
    expect(calls).toMatchObject({ verify: 1, approve: 0, deny: 0 });
  });
}

for (const overrides of [
  { user_code: "EFGH2345" },
  { expiresAt: new Date(0).toISOString() },
  { client_id: "" },
  { client_id: "x".repeat(257) },
  { purpose: undefined, client_id: "lomi-host" },
]) {
  test(`invalid host review stays hidden: ${JSON.stringify(overrides).slice(0, 80)}`, async ({ page }) => {
    const calls = await deviceFixture(page, overrides);
    await page.goto("/device?user_code=ABCD2345&purpose=host_enrollment");
    await page.getByRole("button", { name: "Check code" }).click();
    await expect(page.getByRole("status")).toHaveClass(/notice-danger/);
    await expect(page.locator("#device-review")).toBeHidden();
    expect(calls.approve).toBe(0);
  });
}

test("host denial reports only denial and sends no approval", async ({ page }) => {
  const calls = await deviceFixture(page);
  await page.goto("/device?user_code=ABCD2345");
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByRole("button", { name: "Deny request" }).click();
  await expect(page.getByRole("heading", { name: "Request denied" })).toBeVisible();
  await expect(page.getByText("This action did not authorize the host.")).toBeVisible();
  await expect(page.locator("body")).not.toContainText("No desktop session");
  expect(calls).toMatchObject({ approve: 0, deny: 1, deniedBody: { userCode: "ABCD2345" } });
});

test("switching accounts clears host review and requires another code check", async ({ page }) => {
  const calls = await deviceFixture(page);
  await page.route("**/api/auth/sign-out", (route) => route.fulfill({ json: { success: true } }));
  await page.goto("/device?user_code=ABCD2345");
  await page.getByRole("button", { name: "Check code" }).click();
  await expect(page.getByRole("button", { name: "Authorize this host" })).toBeVisible();
  await page.getByRole("button", { name: "Switch account" }).click();
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Connect to Lomi" })).toBeVisible();
  await expect(page.locator("#device-review")).toBeHidden();
  await expect(page.locator("#host-consent")).toBeHidden();
  expect(calls).toMatchObject({ verify: 1, approve: 0, deny: 0 });
});

test("an expired host approval response clears the reviewed purpose", async ({ page }) => {
  await deviceFixture(page);
  await page.route("**/api/auth/device/approve", (route) => route.fulfill({ status: 400, json: { error: "expired_token" } }));
  await page.goto("/device?user_code=ABCD2345");
  await page.getByRole("button", { name: "Check code" }).click();
  await page.getByRole("button", { name: "Authorize this host" }).click();
  await expect(page.getByRole("status")).toContainText("expired");
  await expect(page.getByRole("heading", { name: "Connect to Lomi" })).toBeVisible();
  await expect(page.locator("#host-consent")).toBeHidden();
  await expect(page.getByRole("button", { name: "Check code" })).toBeEnabled();
});

for (const status of ["approved", "denied", "expired"]) {
  test(`already handled host request is neutral and cannot be approved: ${status}`, async ({ page }) => {
    const calls = await deviceFixture(page, { status });
    await page.goto("/device?user_code=ABCD2345");
    await page.getByRole("button", { name: "Check code" }).click();
    await expect(page.getByRole("heading", { name: "Code no longer active" })).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Lomi desktop");
    expect(calls).toMatchObject({ verify: 1, approve: 0, deny: 0 });
  });
}

test("a result URL changes descriptive copy without making an authorization request", async ({ page }) => {
  const calls: string[] = [];
  page.on("request", (request) => {
    if (/\/(?:v1|api\/auth)\//.test(new URL(request.url()).pathname)) calls.push(request.url());
  });
  await page.goto("/device/result?status=approved&purpose=host_enrollment&client_id=lomi-host");
  await expect(page.getByRole("heading", { name: "Request approved" })).toBeVisible();
  expect(calls).toEqual([]);
});

for (const reviewerUserId of [undefined, "", " ", null, 7, {}, [me.user.id]]) {
  test(`host reviewer identity fails closed: ${JSON.stringify(reviewerUserId)}`, async ({ page }) => {
    const calls = await deviceFixture(page, { reviewerUserId });
    await page.goto("/device?user_code=ABCD2345");
    await page.getByRole("button", { name: "Check code" }).click();
    await expect(page.getByRole("status")).toContainText("couldn’t confirm the account for this host");
    await expect(page.locator("#device-review")).toBeHidden();
    await expect(page.getByRole("button", { name: "Check code" })).toBeEnabled();
    expect(calls).toMatchObject({ verify: 1, approve: 0, deny: 0 });
  });
}

const otherAccount = {
  ...me,
  user: { ...me.user, id: "user_456", displayName: "Grace Hopper", email: "grace@example.com", githubLogin: "grace-hopper" },
  session: { ...me.session, id: "browser_456" },
};

test("a changed cookie during delayed host review refreshes the account and requires a new explicit code check", async ({ page }) => {
  const calls = await deviceFixture(page);
  let sessionChecks = 0;
  let claims = 0;
  let releaseClaim!: () => void;
  const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
  await page.route("**/v1/me", (route) => {
    sessionChecks += 1;
    const changed = route.request().headers().cookie?.includes("reviewer_session=B");
    return route.fulfill({ json: changed ? otherAccount : me });
  });
  await page.route("**/api/auth/device?**", async (route) => {
    claims += 1;
    expect(route.request().headers().cookie).toContain("reviewer_session=B");
    if (claims === 1) await claimGate;
    await route.fulfill({ json: {
      user_code: "ABCD2345", status: "pending", client_id: "lomi-host", purpose: "host_enrollment",
      reviewerUserId: otherAccount.user.id,
    } });
  });
  await page.context().addCookies([{ name: "reviewer_session", value: "A", url: test.info().project.use.baseURL! }]);
  await page.goto("/device?user_code=ABCD2345");
  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  // Simulate another tab replacing the shared browser session before the claim request.
  await page.context().addCookies([{ name: "reviewer_session", value: "B", url: test.info().project.use.baseURL! }]);
  await page.getByRole("button", { name: "Check code" }).click();
  await expect.poll(() => claims).toBe(1);
  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  await expect(page.locator("#device-review")).toBeHidden();
  expect(calls.approve).toBe(0);
  releaseClaim();
  await expect(page.getByText("Grace Hopper")).toBeVisible();
  await expect(page.getByText("grace@example.com", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("The signed-in account changed. Review the account above, then check the code again.");
  await expect(page.locator("#device-review")).toBeHidden();
  await expect(page.getByRole("button", { name: "Authorize this host" })).toBeHidden();
  expect(claims).toBe(1);
  expect(sessionChecks).toBe(2);
  expect(calls.approve).toBe(0);
  await page.getByRole("button", { name: "Check code" }).click();
  await expect(page.getByRole("button", { name: "Authorize this host" })).toBeVisible();
  await expect(page.getByText("Grace Hopper")).toBeVisible();
  expect(claims).toBe(2);
  expect(calls.approve).toBe(0);
  await page.getByRole("button", { name: "Authorize this host" }).click();
  await expect(page.getByRole("heading", { name: "Request approved" })).toBeVisible();
  expect(calls.approve).toBe(1);
});

for (const refreshStatus of [401, 503]) {
  test(`host account mismatch remains closed if account refresh fails: ${refreshStatus}`, async ({ page }) => {
    const calls = await deviceFixture(page, { reviewerUserId: otherAccount.user.id });
    let sessionChecks = 0;
    await page.route("**/v1/me", (route) => {
      sessionChecks += 1;
      if (sessionChecks === 1) return route.fulfill({ json: me });
      if (sessionChecks === 2) return route.fulfill({ status: refreshStatus, json: { error: { code: refreshStatus === 401 ? "SESSION_REQUIRED" : "SERVICE_UNAVAILABLE" } } });
      return route.fulfill({ json: otherAccount });
    });
    await page.goto("/device?user_code=ABCD2345");
    await page.getByRole("button", { name: "Check code" }).click();
    await expect(page.locator("#device-review")).toBeHidden();
    await expect(page.getByText("Ada Lovelace")).toBeHidden();
    if (refreshStatus === 401) {
      await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
    } else {
      await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
      await page.getByRole("button", { name: "Check again" }).click();
      await expect(page.getByText("Grace Hopper")).toBeVisible();
      await expect(page.locator("#device-review")).toBeHidden();
      expect(calls.verify).toBe(1);
      await page.getByRole("button", { name: "Check code" }).click();
      await expect(page.getByRole("button", { name: "Authorize this host" })).toBeVisible();
      expect(calls.verify).toBe(2);
    }
    expect(calls.approve).toBe(0);
  });
}

test("switching accounts while a host claim is pending discards its late review response", async ({ page }) => {
  const calls = await deviceFixture(page);
  let releaseClaim!: () => void;
  let claims = 0;
  const claimGate = new Promise<void>((resolve) => { releaseClaim = resolve; });
  await page.route("**/api/auth/device?**", async (route) => {
    claims += 1;
    await claimGate;
    await route.fulfill({ json: {
      user_code: "ABCD2345", status: "pending", client_id: "lomi-host", purpose: "host_enrollment", reviewerUserId: me.user.id,
    } });
  });
  await page.route("**/api/auth/sign-out", (route) => route.fulfill({ json: { success: true } }));
  await page.goto("/device?user_code=ABCD2345");
  await page.getByRole("button", { name: "Check code" }).click();
  await expect.poll(() => claims).toBe(1);
  await page.getByRole("button", { name: "Switch account" }).click();
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  const response = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/device");
  releaseClaim();
  await (await response).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  await expect(page.locator("#device-review")).toBeHidden();
  await expect(page.getByRole("heading", { name: "Connect to Lomi" })).toBeVisible();
  expect(calls.approve).toBe(0);
});
