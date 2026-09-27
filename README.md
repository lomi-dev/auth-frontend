# Lomi account portal

The portal is a static Astro site. Browser requests use the same origin for the auth API and `/v1` account API.

## Visual language

The login screen contains one centered card and a GitHub button. It uses the
local Geist font from `lomi-web`, along with the consolidated Lomi design system's
Soft Chalk/Ink/Electric Lime palette, flat bordered cards and compact controls.
System dark mode uses the design system's graphite palette. Loading, errors and
no-JavaScript guidance appear only when needed. New desktop sign-ins open a quiet
handoff page that resumes after the explicit GitHub sign-in and returns directly
to the local desktop callback without showing a device code.

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
