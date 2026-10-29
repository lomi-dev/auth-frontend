import { defineConfig } from "@playwright/test";

// The supervisor owns the frontend proxy, auth-app, database and their lifetime.
// In particular this config must never start the mocked suite's preview server.
export default defineConfig({
  testDir: "./tests/integration/browser",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  outputDir: "test-results/auth-integration",
  use: { trace: "off", screenshot: "off", video: "off" },
});
