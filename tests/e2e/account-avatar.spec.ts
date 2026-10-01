import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const avatarUrl = "https://avatars.githubusercontent.com/u/123?v=4";
const csp = readFileSync(new URL("../../ops/Caddyfile", import.meta.url), "utf8").match(/Content-Security-Policy "([^"]+)"/)![1]!;

async function mockAccount(page: Page, image?: string | null) {
  await page.route("**/v1/me", route => route.fulfill({ json: {
    user: { id: "user_123", displayName: "Ada Lovelace", email: "ada@example.com", githubLogin: "ada-lovelace", status: "active", image },
    session: { id: "browser_123", expiresAt: "2099-10-03T12:00:00Z" },
    capabilities: ["account:read"],
  } }));
  await page.route("**/v1/account/sessions", route => route.fulfill({ json: { sessions: [], nextCursor: null } }));
  await page.route("**/account", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": csp } });
  });
}

for (const width of [1280, 375]) {
  test(`Account details displays the user avatar at ${width}px under deployment CSP`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await mockAccount(page, avatarUrl);
    const violations: string[] = [];
    page.on("console", message => { if (/content security policy|refused to load/i.test(message.text())) violations.push(message.text()); });
    let referer: string | undefined;
    await page.route(avatarUrl, route => {
      referer = route.request().headers().referer;
      return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="55" height="55"><rect width="55" height="55" fill="#d9ded7"/><circle cx="28" cy="22" r="10" fill="#535c56"/><path d="M8 55v-6a20 20 0 0 1 40 0v6" fill="#535c56"/></svg>' });
    });
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Account details" })).toBeVisible();
    const avatar = page.locator("#profile-avatar img");
    await expect(avatar).toBeVisible();
    await expect(avatar).toHaveAttribute("src", avatarUrl);
    await expect.poll(() => avatar.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    const size = await avatar.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
    expect(size).toEqual({ width: 55, height: 55 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
    expect(referer).toBeUndefined();
    expect(violations).toEqual([]);
    await page.screenshot({ path: info.outputPath(`account-avatar-${width}.png`), fullPage: true });
  });
}

for (const image of [undefined, null, "https://evil.example/avatar.png", "https://avatars.githubusercontent.com/u/broken"]) {
  test(`Account details keeps initials for ${image ?? "missing avatar"} (${typeof image})`, async ({ page }) => {
    await mockAccount(page, image);
    const requestedImages: string[] = [];
    await page.route("https://avatars.githubusercontent.com/**", route => {
      requestedImages.push(route.request().url());
      return route.abort();
    });
    await page.route("https://evil.example/**", route => {
      requestedImages.push(route.request().url());
      return route.abort();
    });
    await page.goto("/account");
    await expect(page.locator("#profile-initials")).toHaveText("AL");
    await expect(page.locator("#profile-initials")).toBeVisible();
    await expect(page.locator("#profile-avatar img")).toBeHidden();
    await expect(page.locator("#profile-name")).toHaveText("Ada Lovelace");
    if (image === "https://avatars.githubusercontent.com/u/broken") {
      await expect.poll(() => requestedImages).toEqual([image]);
    } else {
      expect(requestedImages).toEqual([]);
    }
  });
}
