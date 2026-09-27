import { describe, expect, test } from "bun:test";
import { readDesktopRequest, validateDesktopCallback } from "../src/lib/desktop-handoff";

const requestId = "A".repeat(43);
const code = "C".repeat(43);
const state = "S".repeat(43);

describe("desktop browser handoff validation", () => {
  test("accepts one canonical desktop request and rejects other query or fragment shapes", () => {
    expect(readDesktopRequest(`?request=${requestId}`, `https://auth.lomi.dev/desktop?request=${requestId}`)).toBe(requestId);
    expect(readDesktopRequest(`?request=${requestId}&request=${requestId}`, `https://auth.lomi.dev/desktop?request=${requestId}&request=${requestId}`)).toBeNull();
    expect(readDesktopRequest(`?request=${requestId}&next=/account`, `https://auth.lomi.dev/desktop?request=${requestId}&next=/account`)).toBeNull();
    expect(readDesktopRequest(`?request=${"A".repeat(42)}`, `https://auth.lomi.dev/desktop?request=${"A".repeat(42)}`)).toBeNull();
    expect(readDesktopRequest(`?request=${requestId}`, `https://auth.lomi.dev/desktop?request=${requestId}#`)).toBeNull();
  });

  test("accepts only a complete fixed loopback callback", () => {
    expect(validateDesktopCallback(`http://127.0.0.1:14321/auth/callback?code=${code}&state=${state}`))
      .toBe(`http://127.0.0.1:14321/auth/callback?code=${code}&state=${state}`);
  });

  test("rejects redirects that are external, malformed, duplicated, or outside the port range", () => {
    const valid = `http://127.0.0.1:14321/auth/callback?code=${code}&state=${state}`;
    const rejected = [
      "https://127.0.0.1:14321/auth/callback?code=" + code + "&state=" + state,
      `http://localhost:14321/auth/callback?code=${code}&state=${state}`,
      `http://127.0.0.2:14321/auth/callback?code=${code}&state=${state}`,
      `http://127.1:14321/auth/callback?code=${code}&state=${state}`,
      `http://2130706433:14321/auth/callback?code=${code}&state=${state}`,
      `http://0x7f000001:14321/auth/callback?code=${code}&state=${state}`,
      ` http://127.0.0.1:14321/auth/callback?code=${code}&state=${state}`,
      `http://127.0.0.1:014321/auth/callback?code=${code}&state=${state}`,
      `http://127.0.0.1:14321/other/../auth/callback?code=${code}&state=${state}`,
      `http://127.0.0.1:80/auth/callback?code=${code}&state=${state}`,
      `http://127.0.0.1:65536/auth/callback?code=${code}&state=${state}`,
      `http://user@127.0.0.1:14321/auth/callback?code=${code}&state=${state}`,
      `http://127.0.0.1:14321/other?code=${code}&state=${state}`,
      `http://127.0.0.1:14321/auth/callback?code=${code}&code=${code}&state=${state}`,
      `http://127.0.0.1:14321/auth/callback?code=${code}&state=${state}&extra=value`,
      `http://127.0.0.1:14321/auth/callback?code=${code}&state=${"!".repeat(43)}`,
      `${valid}#fragment`,
      `${valid}#`,
    ];
    for (const candidate of rejected) expect(validateDesktopCallback(candidate)).toBeNull();
    expect(validateDesktopCallback(null)).toBeNull();
  });
});
