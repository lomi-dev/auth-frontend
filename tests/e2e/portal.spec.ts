import { expect, test } from "@playwright/test";

const me = {
  user: {
    id: "user_123",
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    githubLogin: "ada-lovelace",
    status: "active",
  },
  session: { id: "browser_123", expiresAt: "2026-10-03T12:00:00.000Z" },
  capabilities: ["account:read"],
};

test("login uses a fixed local callback and only starts after an explicit click", async ({ page }, testInfo) => {
  const signInBody: { value: Record<string, unknown> | null } = { value: null };
  await page.route("**/api/auth/sign-in/social", async (route) => {
    signInBody.value = route.request().postDataJSON() as Record<string, unknown>;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://github.com/login/oauth/authorize?client_id=test", redirect: false }),
    });
  });
  await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "Mock GitHub authorization" }));

  await page.goto("/login?returnTo=https%3A%2F%2Fevil.example%2Fcallback");
  await expect(page.getByRole("button", { name: "Continue with GitHub" })).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("login-desktop.png"), fullPage: true });
  expect(signInBody.value).toBeNull();
  await page.getByRole("button", { name: "Continue with GitHub" }).click();
  await expect.poll(() => signInBody.value).not.toBeNull();
  expect(signInBody.value?.provider).toBe("github");
  expect(signInBody.value?.callbackURL).toBe("/account");
  await expect(page).toHaveURL(/github\.com\/login\/oauth\/authorize/);
});

test("device code is not checked on page load and approval waits for review", async ({ page }, testInfo) => {
  let verifyCount = 0;
  let verifyHeader: string | undefined;
  let approveHeader: string | undefined;

  await page.route("**/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/api/auth/device?**", async (route) => {
    verifyCount += 1;
    verifyHeader = route.request().headers()["x-lomi-request"];
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        user_code: "ABCD2345",
        status: "pending",
        client_id: "lomi-desktop-dev",
        expiresAt: "2026-10-03T12:00:00.000Z",
      }),
    });
  });
  await page.route("**/api/auth/device/approve", async (route) => {
    approveHeader = route.request().headers()["x-lomi-request"];
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true }) });
  });

  await page.goto("/device?user_code=ABCD2345");
  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  await expect(page).not.toHaveURL(/user_code=/);
  await expect.poll(() => verifyCount).toBe(0);
  await page.getByRole("button", { name: "Check code" }).click();
  await expect(page.getByText("Lomi desktop", { exact: true })).toBeVisible();
  await expect(page.getByText("ABCD 2345", { exact: true })).toBeVisible();
  await expect(page.getByText(/expires at/i)).toBeVisible();
  expect(verifyCount).toBe(1);
  expect(verifyHeader).toBe("1");
  await page.screenshot({ path: testInfo.outputPath("device-review-desktop.png"), fullPage: true });

  await page.getByRole("button", { name: "Approve this device" }).click();
  await expect(page).toHaveURL(/\/device\/result(?:\/)?\?status=approved/);
  await expect(page.getByRole("heading", { name: "Device approved" })).toBeVisible();
  await expect(page.getByText(/will confirm when your session is saved/i)).toBeVisible();
  expect(approveHeader).toBe("1");
});

test("invalid device code is rejected before any device lookup", async ({ page }) => {
  let verifyCount = 0;
  await page.route("**/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/api/auth/device?**", async (route) => {
    verifyCount += 1;
    await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "invalid_request" }) });
  });

  await page.goto("/device");
  await page.getByLabel("Enter the code from Lomi desktop").fill("ABCD-0000");
  await page.getByRole("button", { name: "Check code" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter all 8 characters from the code shown in Lomi desktop.");
  expect(verifyCount).toBe(0);
});

test("device review stays hidden when the session check fails and offers a retry", async ({ page }) => {
  let sessionChecks = 0;
  await page.route("**/v1/me", (route) => {
    sessionChecks += 1;
    if (sessionChecks === 1) {
      return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE" } }) });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) });
  });

  await page.goto("/device?user_code=ABCD2345");
  await expect(page.getByRole("button", { name: "Check again" })).toBeVisible();
  await expect(page.locator("#device-session")).toBeHidden();
  await expect(page.getByRole("button", { name: "Check code" })).toBeHidden();
  await page.getByRole("button", { name: "Check again" }).click();
  await expect(page.getByText("Ada Lovelace")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check code" })).toBeVisible();
  expect(sessionChecks).toBe(2);
});

test("device result page keeps its status script external under the deployment CSP", async ({ page }) => {
  const cspViolations: string[] = [];
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy|refused to execute/i.test(message.text())) {
      cspViolations.push(message.text());
    }
  });
  await page.route("**/device/result**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
  });

  await page.goto("/device/result?status=denied");
  await expect(page.getByRole("heading", { name: "Request denied" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Back to device sign-in" })).toHaveAttribute("href", "/device");
  expect(cspViolations).toEqual([]);
});

test("account lists sessions and sends guarded revoke mutation after confirmation", async ({ page }, testInfo) => {
  let listCount = 0;
  let deleteHeader: string | undefined;
  let deleteOrigin: string | undefined;
  const desktopSession = {
    id: "desktop_123",
    kind: "desktop",
    createdAt: "2026-09-25T10:00:00.000Z",
    updatedAt: "2026-09-26T10:00:00.000Z",
    expiresAt: "2026-10-03T10:00:00.000Z",
    isCurrent: false,
  };
  const browserSession = {
    id: "browser_123",
    kind: "browser",
    createdAt: "2026-09-24T10:00:00.000Z",
    updatedAt: "2026-09-26T11:00:00.000Z",
    expiresAt: "2026-10-03T11:00:00.000Z",
    isCurrent: true,
  };
  await page.route("**/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/v1/account/sessions", (route) => {
    listCount += 1;
    const sessions = listCount === 1 ? [browserSession, desktopSession] : [browserSession];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ sessions, nextCursor: null }) });
  });
  await page.route("**/v1/account/sessions/desktop_123", async (route) => {
    deleteHeader = route.request().headers()["x-lomi-request"];
    deleteOrigin = route.request().headers().origin;
    await route.fulfill({ status: 204, body: "" });
  });

  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Account details" })).toBeVisible();
  await expect(page.getByText("Lomi desktop", { exact: true })).toBeVisible();
  const desktopItem = page.locator(".session-item").filter({ hasText: "Lomi desktop" }).first();
  await expect(desktopItem).toBeVisible();
  const itemHeight = await desktopItem.evaluate((element) => element.getBoundingClientRect().height);
  const iconSize = await desktopItem.locator(".session-kind-icon svg").evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(itemHeight).toBeLessThan(120);
  expect(iconSize.width).toBeLessThanOrEqual(32);
  expect(iconSize.height).toBeLessThanOrEqual(32);
  await page.screenshot({ path: testInfo.outputPath("account-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Revoke Lomi desktop session" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "Revoke session" }).click();
  await expect(page.getByText("Lomi desktop", { exact: true })).toHaveCount(0);
  expect(deleteHeader).toBe("1");
  expect(deleteOrigin).toBe("http://127.0.0.1:4322");
});

test("fresh-session response requires GitHub verification and a second explicit confirmation", async ({ page }) => {
  let deleteCount = 0;
  let callbackURL: string | undefined;
  let resumedCallback = false;
  const sessions = [{
    id: "desktop_123",
    kind: "desktop",
    createdAt: "2026-09-25T10:00:00.000Z",
    updatedAt: "2026-09-26T10:00:00.000Z",
    expiresAt: "2026-10-03T10:00:00.000Z",
    isCurrent: false,
  }];

  await page.route("**/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/v1/account/sessions", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sessions, nextCursor: null }),
  }));
  await page.route("**/v1/account/sessions/desktop_123", async (route) => {
    deleteCount += 1;
    if (deleteCount === 1) {
      await route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify({ error: { code: "REAUTH_REQUIRED", requestId: "reauth-123" } }) });
      return;
    }
    await route.fulfill({ status: 204, body: "" });
  });
  await page.route("**/api/auth/sign-in/social", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    callbackURL = String(body.callbackURL ?? "");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://github.com/login/oauth/authorize?client_id=test", redirect: false }),
    });
  });
  await page.route("https://github.com/**", async (route) => {
    resumedCallback = true;
    const target = new URL(callbackURL ?? "/", "http://127.0.0.1:4322");
    await route.fulfill({ status: 302, headers: { location: target.href }, body: "" });
  });

  await page.goto("/account");
  await page.getByRole("button", { name: "Revoke Lomi desktop session" }).click();
  await page.getByRole("button", { name: "Revoke session" }).click();
  await expect(page.getByRole("button", { name: "Verify with GitHub" })).toBeVisible();
  await page.getByRole("button", { name: "Verify with GitHub" }).click();
  await expect(page.getByRole("button", { name: "Continue revoking session" })).toBeVisible();
  expect(callbackURL).toBe("/account?reauth=single&session=desktop_123");
  expect(resumedCallback).toBe(true);
  await page.getByRole("button", { name: "Continue revoking session" }).click();
  await expect(page.getByText("Selected session was revoked.")).toBeVisible();
  expect(deleteCount).toBe(2);
});

test("anonymous desktop handoff starts GitHub immediately with the guarded callback", async ({ page }) => {
  const requestId = "A".repeat(43);
  const returnTo = `/desktop?request=${requestId}`;
  let signInBody: Record<string, unknown> | null = null;
  let signInCount = 0;
  let loginPageCount = 0;
  let releaseSignIn!: () => void;
  const signInGate = new Promise<void>((resolve) => { releaseSignIn = resolve; });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/login") loginPageCount += 1;
  });
  await page.route("**/v1/me", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "SESSION_REQUIRED" } }),
  }));
  await page.route("**/api/auth/sign-in/social", async (route) => {
    signInCount += 1;
    signInBody = route.request().postDataJSON() as Record<string, unknown>;
    await signInGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://github.com/login/oauth/authorize?client_id=test", redirect: false }),
    });
  });
  await page.route("https://github.com/**", (route) => route.fulfill({ status: 200, body: "Mock GitHub authorization" }));

  await page.goto(returnTo);
  await expect(page.getByRole("heading", { name: "Authenticating with GitHub" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("You will automatically be redirected.");
  await expect.poll(() => signInCount).toBe(1);
  expect(signInBody).toEqual({
    provider: "github",
    callbackURL: returnTo,
    errorCallbackURL: `/error?returnTo=${encodeURIComponent(returnTo)}`,
    disableRedirect: true,
  });
  expect(loginPageCount).toBe(0);
  releaseSignIn();
  await expect(page).toHaveURL(/github\.com\/login\/oauth\/authorize/);
});

test("desktop handoff completes after GitHub returns with a browser session", async ({ page }) => {
  const requestId = "A".repeat(43);
  const code = "C".repeat(43);
  const state = "S".repeat(43);
  const callbackUrl = `http://127.0.0.1:14321/auth/callback?code=${code}&state=${state}`;
  let sessionChecks = 0;
  let signInCount = 0;
  let completeCount = 0;
  let completeBody: Record<string, unknown> | null = null;

  await page.route("**/v1/me", (route) => {
    sessionChecks += 1;
    return route.fulfill(sessionChecks === 1
      ? { status: 401, contentType: "application/json", body: JSON.stringify({ error: { code: "SESSION_REQUIRED" } }) }
      : { status: 200, contentType: "application/json", body: JSON.stringify(me) });
  });
  await page.route("**/api/auth/sign-in/social", (route) => {
    signInCount += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://github.com/login/oauth/authorize?client_id=test", redirect: false }),
    });
  });
  await page.route("https://github.com/**", (route) => route.fulfill({
    status: 302,
    headers: { location: `http://127.0.0.1:4322/desktop?request=${requestId}` },
    body: "",
  }));
  await page.route("**/v1/desktop/complete", (route) => {
    completeCount += 1;
    completeBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ redirectUrl: callbackUrl }) });
  });
  await page.route("http://127.0.0.1:14321/auth/callback**", (route) => route.fulfill({ status: 200, body: "Desktop callback received" }));

  await page.goto(`/desktop?request=${requestId}`);

  await expect(page).toHaveURL(callbackUrl);
  expect(sessionChecks).toBe(2);
  expect(signInCount).toBe(1);
  expect(completeCount).toBe(1);
  expect(completeBody).toEqual({ requestId });
});

test("invalid desktop request is rejected before any API call", async ({ page }) => {
  const apiCalls: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname.startsWith("/v1/") || pathname.startsWith("/api/auth/")) apiCalls.push(pathname);
  });

  await page.goto("/desktop?request=invalid");

  await expect(page.getByRole("heading", { name: "This sign-in link is invalid." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Start sign-in again in Lomi.");
  expect(apiCalls).toEqual([]);
});

test("desktop handoff reports OAuth start errors and rejects unsafe provider URLs", async ({ page }) => {
  const requestId = "A".repeat(43);
  let signInCount = 0;
  await page.route("**/v1/me", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "SESSION_REQUIRED" } }),
  }));
  await page.route("**/api/auth/sign-in/social", async (route) => {
    signInCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://github.com.evil.example/login/oauth/authorize", redirect: false }),
    });
  });

  await page.goto(`/desktop?request=${requestId}`);

  await expect(page.getByRole("heading", { name: "GitHub sign-in could not start." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Close this page and start sign-in again in Lomi.");
  await expect(page).toHaveURL(new RegExp(`/desktop\\?request=${requestId}$`));
  expect(signInCount).toBe(1);
});

test("desktop handoff reports a failed OAuth start without navigating to a provider", async ({ page }) => {
  const requestId = "A".repeat(43);
  let providerRequests = 0;
  await page.route("**/v1/me", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "SESSION_REQUIRED" } }),
  }));
  await page.route("**/api/auth/sign-in/social", (route) => route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ message: "OAuth unavailable" }),
  }));
  page.on("request", (request) => {
    if (new URL(request.url()).hostname === "github.com") providerRequests += 1;
  });

  await page.goto(`/desktop?request=${requestId}`);

  await expect(page.getByRole("heading", { name: "GitHub sign-in could not start." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Close this page and start sign-in again in Lomi.");
  await expect(page).toHaveURL(new RegExp(`/desktop\\?request=${requestId}$`));
  expect(providerRequests).toBe(0);
});

test("desktop handoff stops if session storage cannot guard an OAuth attempt", async ({ page }) => {
  const requestId = "A".repeat(43);
  let signInCount = 0;
  await page.addInitScript(() => {
    Object.defineProperty(Storage.prototype, "setItem", {
      configurable: true,
      value() { throw new DOMException("Storage is unavailable", "SecurityError"); },
    });
  });
  await page.route("**/v1/me", (route) => route.fulfill({
    status: 401,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "SESSION_REQUIRED" } }),
  }));
  await page.route("**/api/auth/sign-in/social", (route) => {
    signInCount += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "https://github.com/login/oauth/authorize" }) });
  });

  await page.goto(`/desktop?request=${requestId}`);

  await expect(page.getByRole("heading", { name: "GitHub sign-in could not start." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Allow browser storage, then start sign-in again in Lomi.");
  expect(signInCount).toBe(0);
});

test("a second anonymous desktop response does not automatically restart OAuth", async ({ page }) => {
  const requestId = "A".repeat(43);
  let sessionChecks = 0;
  let signInCount = 0;
  let completeCount = 0;
  await page.route("**/v1/me", (route) => {
    sessionChecks += 1;
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "SESSION_REQUIRED" } }),
    });
  });
  await page.route("**/v1/desktop/complete", (route) => {
    completeCount += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({}) });
  });
  await page.route("**/api/auth/sign-in/social", (route) => {
    signInCount += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ url: "https://github.com/login/oauth/authorize?client_id=test", redirect: false }),
    });
  });
  await page.route("https://github.com/**", (route) => route.fulfill({
    status: 302,
    headers: { location: `http://127.0.0.1:4322/desktop?request=${requestId}` },
    body: "",
  }));

  await page.goto(`/desktop?request=${requestId}`);

  await expect(page.getByRole("heading", { name: "GitHub sign-in could not be confirmed." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Close this page and start sign-in again in Lomi.");
  await expect(page).toHaveURL(new RegExp(`/desktop\\?request=${requestId}$`));
  expect(sessionChecks).toBe(2);
  expect(signInCount).toBe(1);
  expect(completeCount).toBe(0);
});

test("unauthorized desktop completion shows an error without restarting OAuth", async ({ page }) => {
  const requestId = "A".repeat(43);
  let signInCount = 0;
  let completeCount = 0;
  await page.route("**/v1/me", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(me),
  }));
  await page.route("**/v1/desktop/complete", (route) => {
    completeCount += 1;
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "SESSION_REQUIRED" } }),
    });
  });
  await page.route("**/api/auth/sign-in/social", (route) => {
    signInCount += 1;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ url: "https://github.com/login/oauth/authorize" }) });
  });

  await page.goto(`/desktop?request=${requestId}`);

  await expect(page.getByRole("heading", { name: "Your session could not be confirmed." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Close this page and start sign-in again in Lomi.");
  await expect(page).toHaveURL(new RegExp(`/desktop\\?request=${requestId}$`));
  expect(completeCount).toBe(1);
  expect(signInCount).toBe(0);
});

test("authenticated desktop handoff completes once and navigates only to the validated callback", async ({ page }) => {
  const requestId = "A".repeat(43);
  const code = "C".repeat(43);
  const state = "S".repeat(43);
  const callbackUrl = `http://127.0.0.1:14321/auth/callback?code=${code}&state=${state}`;
  let completeCount = 0;
  let completeBody: Record<string, unknown> | null = null;
  const completeHeaders: { value: Record<string, string> | null } = { value: null };
  let releaseSession!: () => void;
  const sessionGate = new Promise<void>((resolve) => { releaseSession = resolve; });
  let releaseComplete!: () => void;
  const completeGate = new Promise<void>((resolve) => { releaseComplete = resolve; });

  await page.route("**/v1/me", async (route) => {
    await sessionGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) });
  });
  await page.route("**/v1/desktop/complete", async (route) => {
    completeCount += 1;
    completeBody = route.request().postDataJSON() as Record<string, unknown>;
    completeHeaders.value = route.request().headers();
    await completeGate;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ redirectUrl: callbackUrl }) });
  });
  await page.route("http://127.0.0.1:14321/auth/callback**", (route) => route.fulfill({ status: 200, body: "Desktop callback received" }));

  await page.goto(`/desktop?request=${requestId}`);
  await expect(page.getByRole("heading", { name: "Authenticating with GitHub" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(requestId);
  releaseSession();
  await expect(page.getByRole("heading", { name: "Returning to Lomi" })).toBeVisible();
  await expect(page.getByRole("status")).toHaveText("Lomi desktop will confirm when your session is saved.");
  await expect.poll(() => completeCount).toBe(1);
  releaseComplete();

  await expect(page).toHaveURL(callbackUrl);
  expect(completeCount).toBe(1);
  expect(completeBody).toEqual({ requestId });
  expect(completeHeaders.value?.["x-lomi-request"]).toBe("1");
  expect(completeHeaders.value?.origin).toBe("http://127.0.0.1:4322");
});

test("desktop handoff blocks an unsafe completion redirect and shows a safe expiration message", async ({ page }) => {
  const requestId = "A".repeat(43);
  await page.route("**/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/v1/desktop/complete", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ redirectUrl: "https://evil.example/auth/callback?code=secret&state=secret" }),
  }));

  await page.goto(`/desktop?request=${requestId}`);
  await expect(page.getByRole("heading", { name: "This sign-in link is invalid." })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveText("Start sign-in again in Lomi.");
  await expect(page).toHaveURL(new RegExp(`/desktop\\?request=${requestId}$`));
  await expect(page.locator("body")).not.toContainText(requestId);

  await page.unrouteAll();
  await page.route("**/v1/me", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(me) }));
  await page.route("**/v1/desktop/complete", (route) => route.fulfill({
    status: 410,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "LOGIN_EXPIRED" } }),
  }));
  await page.reload();
  await expect(page.getByRole("alert")).toHaveText("This sign-in request expired or was already used. Start sign-in again in Lomi.");
  await expect(page).toHaveURL(new RegExp(`/desktop\\?request=${requestId}$`));
});

test("cancelled desktop OAuth offers only restart in Lomi without API calls", async ({ page }) => {
  const requestId = "A".repeat(43);
  let apiCalls = 0;
  page.on("request", (request) => {
    if (/\/(?:v1|api\/auth)\//.test(new URL(request.url()).pathname)) apiCalls += 1;
  });

  await page.goto(`/error?error=access_denied&returnTo=${encodeURIComponent(`/desktop?request=${requestId}`)}`);

  await expect(page.getByRole("heading", { name: "Desktop sign-in didn’t finish." })).toBeVisible();
  await expect(page.getByText("Start sign-in again in Lomi.", { exact: true })).toBeVisible();
  await expect(page.locator("#error-retry")).toBeHidden();
  await expect(page.locator("#error-back")).toBeHidden();
  expect(apiCalls).toBe(0);
});
