import { chromium, expect, test as base, type BrowserContext, type Page } from "@playwright/test";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

export interface SyntheticAccount {
  userId: string;
  displayName: string;
  email: string;
  cookies: Parameters<BrowserContext["addCookies"]>[0];
}

export interface SyntheticDeviceRequest {
  userCode: string;
  clientId: string;
  // Host-only data. Never pass this object to page.evaluate or browser storage.
  deviceCode: string;
}

/** Implement in a supervised test module, never in a production route. */
export interface FrontendBackendFixture {
  origin: string;
  accounts: { primary: SyntheticAccount; secondary: SyntheticAccount };
  createDeviceRequest(kind: "host" | "desktop"): Promise<SyntheticDeviceRequest>;
  inspectDeviceRequest(request: SyntheticDeviceRequest): Promise<{
    status: "pending" | "approved" | "denied";
    reviewerUserId: string | null;
  }>;
  pollHostBootstrap(request: SyntheticDeviceRequest): Promise<{ credential: string }>;
  dispose(): Promise<void>;
}

interface LiveFixture {
  backend: FrontendBackendFixture;
  page: Page;
  context: BrowserContext;
  browserObservations: string[];
  pendingObservations: Promise<void>[];
}

export const configured = process.env.LOMI_AUTH_FRONTEND_INTEGRATION === "1"
  && Boolean(process.env.LOMI_AUTH_FRONTEND_FIXTURE_MODULE);

export const test = base.extend<{ live: LiveFixture }>({
  live: async ({}, use, testInfo) => {
    const modulePath = process.env.LOMI_AUTH_FRONTEND_FIXTURE_MODULE;
    testInfo.skip(!configured || !modulePath, "Synthetic real-backend fixture is not configured");
    if (!modulePath) return;
    if (!isAbsolute(modulePath)) throw new Error("Fixture module path must be absolute");
    // Import failures are failures, not skips: a configured broken fixture is actionable.
    const module = await import(pathToFileURL(modulePath).href);
    // A supervisor can explicitly report that its isolated backend is unavailable.
    const backend: FrontendBackendFixture | null = await module.createFrontendFixture();
    testInfo.skip(backend === null, "Supervisor reports synthetic backend unavailable");
    if (!backend) return;
    try {
      const origin = new URL(backend.origin);
      if (origin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
        || origin.origin !== backend.origin) throw new Error("Fixture must use an explicit HTTP loopback origin");
      const browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      });
      try {
        const context = await browser.newContext({ baseURL: backend.origin, serviceWorkers: "block" });
        await context.addCookies(backend.accounts.primary.cookies);
        const page = await context.newPage();
        const browserObservations: string[] = [];
        const pendingObservations: Promise<void>[] = [];
        page.on("request", (request) => {
          browserObservations.push(request.url(), request.postData() ?? "", JSON.stringify(request.headers()));
        });
        page.on("response", (response) => {
          const path = new URL(response.url()).pathname;
          if (path.startsWith("/api/auth/") || path.startsWith("/v1/")) {
            pendingObservations.push((async () => {
              browserObservations.push(JSON.stringify(await response.allHeaders()), await response.text());
            })());
          }
        });
        await use({ backend, page, context, browserObservations, pendingObservations });
      } finally {
        await browser.close();
      }
    } finally {
      await backend.dispose();
    }
  },
});

export async function assertNoHostSecrets(live: LiveFixture, request: SyntheticDeviceRequest, bootstrap?: string) {
  await Promise.all(live.pendingObservations);
  const browserState = [
    ...live.browserObservations,
    JSON.stringify(await live.context.storageState({ indexedDB: true })),
    await live.page.evaluate(() => JSON.stringify({
      url: location.href, history: history.state, dom: document.documentElement.outerHTML,
      local: { ...localStorage }, session: { ...sessionStorage },
    })),
  ].join("\n");
  // Boolean assertions keep synthetic credentials out of failure reports.
  expect(browserState.includes(request.deviceCode), "Device credential must stay outside the browser").toBe(false);
  if (bootstrap) expect(browserState.includes(bootstrap), "Bootstrap must stay outside the browser").toBe(false);
  expect(/"(?:access_token|refresh_token|bootstrap)"\s*:/.test(browserState), "Browser must not receive host credential fields").toBe(false);
}
