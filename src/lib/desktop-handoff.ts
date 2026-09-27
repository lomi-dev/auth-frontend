const BASE64URL_43_SOURCE = "[A-Za-z0-9_-]{43}";
const BASE64URL_43 = new RegExp(`^${BASE64URL_43_SOURCE}$`);
const CALLBACK_URL = new RegExp(
  `^http://127\\.0\\.0\\.1:([1-9]\\d{0,4})/auth/callback\\?(?:code=${BASE64URL_43_SOURCE}&state=${BASE64URL_43_SOURCE}|state=${BASE64URL_43_SOURCE}&code=${BASE64URL_43_SOURCE})$`,
);

/** Read the desktop request only from its single, canonical query parameter. */
export function readDesktopRequest(search: string, href: string): string | null {
  if (href.includes("#")) return null;
  const match = /^\?request=([A-Za-z0-9_-]{43})$/.exec(search);
  return match?.[1] ?? null;
}

/** Accept only the exact loopback callback shape created by the desktop listener. */
export function validateDesktopCallback(value: unknown): string | null {
  if (typeof value !== "string" || value.includes("#")) return null;
  const match = CALLBACK_URL.exec(value);
  if (!match) return null;

  const port = Number(match[1]);
  if (port < 1024 || port > 65535) return null;

  try {
    const callback = new URL(value);
    if (
      callback.href !== value ||
      callback.protocol !== "http:" ||
      callback.hostname !== "127.0.0.1" ||
      callback.username ||
      callback.password ||
      callback.hash ||
      callback.pathname !== "/auth/callback" ||
      Number(callback.port) !== port
    ) {
      return null;
    }

    const query = callback.searchParams;
    const keys = [...query.keys()];
    if (
      keys.length !== 2 ||
      query.getAll("code").length !== 1 ||
      query.getAll("state").length !== 1 ||
      keys.some((key) => key !== "code" && key !== "state")
    ) {
      return null;
    }

    const code = query.get("code") ?? "";
    const state = query.get("state") ?? "";
    if (!BASE64URL_43.test(code) || !BASE64URL_43.test(state)) return null;

    return value;
  } catch {
    return null;
  }
}
