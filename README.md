# Lomi account portal

The portal is a static Astro site. Browser requests use the same origin for the auth API and `/v1` account API.

## Visual language

The login screen contains a centered heading and GitHub button over the same
cloud background and Soft Chalk overlay as `lomi-web`. Local Geist typography,
the Lomi wordmark, and the Soft Chalk/Ink/Electric Lime palette carry across the
portal. Loading, errors and no-JavaScript guidance appear only when needed.

Desktop Sign In opens a minimal progress page and starts GitHub automatically
when there is no browser session. A per-request session marker prevents repeated
OAuth redirects if the session cannot be confirmed. After authentication, the
portal returns to the validated local desktop callback without a device code.
The desktop app shows success only after verifying and activating its session.

## Local development

Use Bun 1.4.2. The development server binds only to `127.0.0.1:4321` and Vite proxies `/api/auth`, `/v1`, and `/health` to the API at `127.0.0.1:3001`. Port `4321` is fixed so GitHub callbacks stay on the configured development origin. If another local site (including the Lomi marketing site) is already using `4321`, stop that server before starting this portal; Astro will fail instead of quietly switching ports.

```sh
bun install --frozen-lockfile
bun run dev
bun run check
bun run test
bun run test:e2e
bun run build
```

The portal pins Better Auth 1.7.6 to match the API. TypeScript is pinned to 6.0.3 because `@astrojs/check` 0.9.10 supports TypeScript 5 and 6; it does not support TypeScript 7. No API secrets are needed by this static frontend.

The Playwright suite mocks auth and account API responses. It verifies browser behavior and request headers, not real GitHub OAuth or production API behavior.

## Release prerequisites

Before public release, add the approved Lomi privacy notice and its support contact and retention details, then link it from sign-in. No approved policy URL is currently available in this repository.

Production build and proxy details are in [DEPLOYMENT.md](./DEPLOYMENT.md).
