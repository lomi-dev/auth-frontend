# Synthetic auth-app browser integration

This opt-in suite uses the portal's shipped Better Auth client against a real,
separately supervised auth-app. It never intercepts routes and starts no servers.
The regular `test:e2e` mocked suite is unchanged. A skipped run proves no backend
integration behavior. Real GitHub OAuth and production services are out of scope.

The supervisor must provide an absolute ESM module path in
`LOMI_AUTH_FRONTEND_FIXTURE_MODULE` and set `LOMI_AUTH_FRONTEND_INTEGRATION=1`.
That module exports `createFrontendFixture()`, returning the
`FrontendBackendFixture` interface in [fixture.ts](./fixture.ts), or `null` when
its isolated backend is unavailable. Missing opt-in/configuration skips all
tests before launching Chromium. Invalid configured modules fail visibly.

Fixture responsibilities:

- Serve the current frontend and real auth-app through one HTTP loopback origin,
  with the auth-app public origin matching it. Use an isolated synthetic database
  and the actual auth middleware, transaction wrappers, and Better Auth 1.7.6.
- Supply two distinct synthetic active users and their real browser session
  cookies. Include the full cookie attributes accepted by Playwright `addCookies`.
  Each test gets a new fixture; do not return a shared consumed request/session.
- `createDeviceRequest("host")` issues through the existing signed host-key
  initiation flow. `createDeviceRequest("desktop")` uses the existing device-code
  endpoint. Use the same allowed desktop client ID for both kinds so the suite
  proves server enrollment metadata determines purpose. Return the unformatted
  eight-character `userCode`, `clientId`, and host-side `deviceCode`.
- `inspectDeviceRequest` reads actual persisted device-code status and owner;
  return the owner's user ID as `reviewerUserId` and `null` before claiming.
  Preserve the approved row until the test polls it.
- `pollHostBootstrap` polls the existing device-token endpoint as a host-side
  client, respecting its interval/expiry, and returns `{ credential }` containing
  the real bootstrap access token. Never inject this credential into the browser.
- `dispose()` removes synthetic fixture data even after failed assertions.
  This module is a test adapter, not a new production route or authority API.

Once the supervisor is ready and the serialized native/build slot is free, run
from the repository root (the Node CLI does not load ambient dotenv files):

```sh
env -i PATH="$PATH" HOME="$HOME" \
  LOMI_AUTH_FRONTEND_INTEGRATION=1 \
  LOMI_AUTH_FRONTEND_FIXTURE_MODULE=/absolute/path/to/synthetic-fixture.mjs \
  node node_modules/@playwright/test/cli.js test --config playwright.integration.config.ts
```

Add `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` explicitly if a local browser binary is
needed. Without a fixture, the same Node command reports three skipped tests.
Do not infer integration success from `--list` or a skipped run. No fixtures,
cookie values, device credentials, or bootstrap credentials belong in the repo.
Tracing, screenshots, and video are disabled to avoid saving browser sessions.
Assertions retain network bodies in memory only to check that host-side secrets
never appeared in browser requests/responses, cookies, DOM/history, local/session
storage, or IndexedDB. They do not prove absence from browser process memory.

The tests cover explicit claim versus approval, real request marker/cookie and
same-origin headers, account replacement before claim, real sign-out invalidation,
server-provided host purpose, and forged URL purpose on a desktop request. The
adapter must return a real host bootstrap; a placeholder cannot prove isolation.

API reference: [client](https://better-auth.com/docs/concepts/client) and
[device authorization](https://better-auth.com/docs/plugins/device-authorization).
Version evidence is the installed 1.7.6 package and
`dist/plugins/device-authorization/client.mjs` (`GET /device`, `POST
/device/approve`) plus `dist/client/config.mjs` (frontend fetch options override
defaults). Current online docs alone are not evidence of the pinned version.
