const requestPattern = /^\?request=([A-Za-z0-9_-]{43})$/;
const remoteOrigins = new Set([
  "https://remote.lomi.dev",
  "https://remote-staging.lomi.dev",
]);
export type RemoteConsentKind = "account" | "workspace";

/** Accept only the two scope sets issued by the Remote login flow. */
export function validateRemoteScope(value: unknown): RemoteConsentKind | null {
  if (!Array.isArray(value)) return null;
  if (value.length === 1 && value[0] === "remote:account:read") return "account";
  if (
    value.length === 2 &&
    value[0] === "remote:account:read" &&
    value[1] === "remote:v3:consumer"
  )
    return "workspace";
  return null;
}

export function readRemoteRequest(search: string, href: string): string | null {
  if (href.includes("#")) return null;
  return requestPattern.exec(search)?.[1] ?? null;
}
export function validateRemoteOrigin(value: unknown, identityOrigin?: string): string | null {
  if (typeof value !== "string") return null;
  // The local OAuth app has one exact loopback pair. Production pages never
  // accept local callbacks, even if an API response supplies one.
  const local = identityOrigin === "http://localhost:4321" && value === "http://localhost:4322";
  return remoteOrigins.has(value) || local ? value : null;
}
/** Server-issued, exact registered origins only; never accept a browser-supplied callback. */
export function validateRemoteCallback(
  value: unknown,
  origin: string,
  action: "approve" | "deny",
  identityOrigin?: string,
): string | null {
  if (typeof value !== "string" || !validateRemoteOrigin(origin, identityOrigin)) return null;
  if (action === "deny")
    return value === `${origin}/?auth=cancelled` ? value : null;
  const escapedOrigin = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^${escapedOrigin}/auth/callback\\?code=[A-Za-z0-9_-]{43}&state=[A-Za-z0-9_-]{43}$`,
  ).test(value)
    ? value
    : null;
}
