const requestPattern = /^\?request=([A-Za-z0-9_-]{43})$/;
const remoteOrigins = new Set([
  "https://remote.lomi.dev",
  "https://remote-staging.lomi.dev",
]);
export function readRemoteRequest(search: string, href: string): string | null {
  if (href.includes("#")) return null;
  return requestPattern.exec(search)?.[1] ?? null;
}
export function validateRemoteOrigin(value: unknown): string | null {
  return typeof value === "string" && remoteOrigins.has(value) ? value : null;
}
/** Server-issued, exact registered origins only; never accept a browser-supplied callback. */
export function validateRemoteCallback(
  value: unknown,
  origin: string,
  action: "approve" | "deny",
): string | null {
  if (typeof value !== "string" || !validateRemoteOrigin(origin)) return null;
  if (action === "deny")
    return value === `${origin}/?auth=cancelled` ? value : null;
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escapedOrigin}/auth/callback\\?code=[A-Za-z0-9_-]{43}&state=[A-Za-z0-9_-]{43}$`,
  ).test(value)
    ? value
    : null;
}
