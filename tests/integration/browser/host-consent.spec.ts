import { expect, type Request } from "@playwright/test";
import { assertNoHostSecrets, configured, test } from "./fixture";

test.skip(!configured, "Opt in with a supervised synthetic real-backend fixture");

async function assertBrowserAuth(request: Request, origin: string, method: string) {
  const headers = await request.allHeaders();
  expect(request.method()).toBe(method);
  expect(new URL(request.url()).origin).toBe(origin);
  expect(headers["x-lomi-request"]).toBe("1");
  expect(headers["sec-fetch-site"]).toBe("same-origin");
  expect(Boolean(headers.cookie), "Real session cookie must accompany the request").toBe(true);
  expect(headers.authorization).toBeUndefined();
  if (method === "POST") {
    expect(headers.origin).toBe(origin);
    expect(headers["content-type"]).toContain("application/json");
  }
}

test("real host claim and approval require separate explicit actions", async ({ live }) => {
  const { backend, page } = live;
  const issued = await backend.createDeviceRequest("host");
  expect(issued.clientId).toMatch(/^lomi-desktop(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/i);
  const decisions: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/auth\/device(?:\?|\/approve|\/deny)/.test(request.url())) decisions.push(request.url());
  });
  await page.goto(`/device?user_code=${encodeURIComponent(issued.userCode)}`);
  await expect(page.locator("#device-name")).toHaveText(backend.accounts.primary.displayName);
  await expect(page).not.toHaveURL(/user_code/);
  await expect(page.locator("#device-review")).toBeHidden();
  expect(decisions).toHaveLength(0);
  expect(await backend.inspectDeviceRequest(issued)).toEqual({ status: "pending", reviewerUserId: null });

  const claimResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/device");
  await page.getByRole("button", { name: "Check code", exact: true }).click();
  const claimed = await claimResponse;
  expect(claimed.status()).toBe(200);
  await assertBrowserAuth(claimed.request(), backend.origin, "GET");
  expect(new URL(claimed.url()).searchParams.get("user_code")).toBe(issued.userCode);
  expect(await claimed.json()).toMatchObject({
    purpose: "host_enrollment", reviewerUserId: backend.accounts.primary.userId, client_id: issued.clientId,
  });
  await expect(page.getByRole("button", { name: "Authorize this host", exact: true })).toBeVisible();
  expect(await backend.inspectDeviceRequest(issued)).toEqual({ status: "pending", reviewerUserId: backend.accounts.primary.userId });
  expect(decisions).toHaveLength(1);
  await assertNoHostSecrets(live, issued);

  const approvalResponse = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/auth/device/approve");
  await page.getByRole("button", { name: "Authorize this host", exact: true }).click();
  const approved = await approvalResponse;
  expect(approved.status()).toBe(200);
  await assertBrowserAuth(approved.request(), backend.origin, "POST");
  expect(approved.request().postDataJSON()).toEqual({ userCode: issued.userCode });
  await expect(page).toHaveURL(/\/device\/result\?status=approved&purpose=host_enrollment$/);
  expect(await backend.inspectDeviceRequest(issued)).toEqual({ status: "approved", reviewerUserId: backend.accounts.primary.userId });
  expect(decisions).toHaveLength(2);
  // Only the supervisor's host-side API client redeems this credential.
  const bootstrap = await backend.pollHostBootstrap(issued);
  expect(Boolean(bootstrap.credential)).toBe(true);
  await assertNoHostSecrets(live, issued, bootstrap.credential);
});

test("a real changed session invalidates the displayed account before host review", async ({ live }) => {
  const { backend, page, context } = live;
  const issued = await backend.createDeviceRequest("host");
  await page.goto(`/device?user_code=${encodeURIComponent(issued.userCode)}`);
  await expect(page.locator("#device-name")).toHaveText(backend.accounts.primary.displayName);
  // Models a second tab signing in; no response interception or fake cookie names.
  await context.clearCookies();
  await context.addCookies(backend.accounts.secondary.cookies);
  await page.getByRole("button", { name: "Check code", exact: true }).click();
  await expect(page.locator("#device-name")).toHaveText(backend.accounts.secondary.displayName);
  await expect(page.getByRole("status")).toHaveText("The signed-in account changed. Review the account above, then check the code again.");
  await expect(page.locator("#device-review")).toBeHidden();
  expect(await backend.inspectDeviceRequest(issued)).toEqual({ status: "pending", reviewerUserId: backend.accounts.secondary.userId });
  await page.getByRole("button", { name: "Check code", exact: true }).click();
  await expect(page.getByRole("button", { name: "Authorize this host", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Switch account", exact: true }).click();
  await expect(page.getByRole("link", { name: "Sign in with GitHub" })).toBeVisible();
  await expect(page.locator("#device-review")).toBeHidden();
  expect((await backend.inspectDeviceRequest(issued)).status).toBe("pending");
  await assertNoHostSecrets(live, issued);
});

test("a forged URL cannot turn a real desktop request into host enrollment", async ({ live }) => {
  const { backend, page } = live;
  const issued = await backend.createDeviceRequest("desktop");
  expect(issued.clientId).toMatch(/^lomi-desktop(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/i);
  await page.goto(`/device?user_code=${encodeURIComponent(issued.userCode)}&purpose=host_enrollment&client_id=lomi-host`);
  await expect(page.locator("#device-name")).toHaveText(backend.accounts.primary.displayName);
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/api/auth/device");
  await page.getByRole("button", { name: "Check code", exact: true }).click();
  const claimed = await response;
  expect(claimed.status()).toBe(200);
  expect(Object.hasOwn(await claimed.json(), "purpose")).toBe(false);
  await expect(page.getByRole("button", { name: "Approve this device", exact: true })).toBeVisible();
  await expect(page.locator("#host-consent")).toBeHidden();
  expect((await backend.inspectDeviceRequest(issued)).status).toBe("pending");
  await assertNoHostSecrets(live, issued);
});
