import { normalizeDeviceCode } from "./device-code";

/** Only allow fixed local destinations that the portal itself understands. */
export function resolveReturnDestination(search: string, origin: string): string {
  const params = new URLSearchParams(search);
  const values = params.getAll("returnTo");
  if (values.length !== 1) return "/account";

  const candidate = values[0];
  if (candidate === "/account") return "/account";
  if (!candidate) return "/account";

  try {
    const destination = new URL(candidate, origin);
    if (destination.origin !== origin || destination.hash) {
      return "/account";
    }

    if (destination.pathname === "/account") {
      const query = new URLSearchParams(destination.search);
      const intent = readReauthIntent(destination.search);
      if (!intent || [...query.keys()].some((key) => key !== "reauth" && key !== "session")) return "/account";
      return buildReauthReturn(intent);
    }

    if (destination.pathname === "/desktop") {
      if (candidate.includes("#")) return "/account";
      const request = /^\?request=([A-Za-z0-9_-]{43})$/.exec(destination.search);
      if (!request) return "/account";
      return `/desktop?request=${request[1]}`;
    }

    if (destination.pathname !== "/device") return "/account";

    if (!destination.search) return "/device";

    const query = new URLSearchParams(destination.search);
    if ([...query.keys()].some((key) => key !== "user_code")) return "/account";
    const codeValues = query.getAll("user_code");
    if (codeValues.length !== 1) return "/account";

    const code = normalizeDeviceCode(codeValues[0] ?? "");
    if (!code) return "/account";
    return `/device?user_code=${encodeURIComponent(code)}`;
  } catch {
    return "/account";
  }
}

export function buildLoginUrl(returnTo: string): string {
  const params = new URLSearchParams({ returnTo });
  return `/login?${params.toString()}`;
}

export type ReauthIntent =
  | { kind: "single"; sessionId: string }
  | { kind: "all" };

export function readReauthIntent(search: string): ReauthIntent | null {
  const params = new URLSearchParams(search);
  const kinds = params.getAll("reauth");
  if (kinds.length !== 1) return null;

  if (kinds[0] === "all" && [...params.keys()].every((key) => key === "reauth")) {
    return { kind: "all" };
  }

  if (kinds[0] === "single") {
    const ids = params.getAll("session");
    if (
      ids.length === 1 &&
      [...params.keys()].every((key) => key === "reauth" || key === "session") &&
      /^[A-Za-z0-9_-]{1,128}$/.test(ids[0] ?? "")
    ) {
      return { kind: "single", sessionId: ids[0] ?? "" };
    }
  }

  return null;
}

export function buildReauthReturn(intent: ReauthIntent): string {
  if (intent.kind === "all") return "/account?reauth=all";
  const params = new URLSearchParams({ reauth: "single", session: intent.sessionId });
  return `/account?${params.toString()}`;
}
