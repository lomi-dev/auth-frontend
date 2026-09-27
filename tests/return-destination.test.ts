import { describe, expect, test } from "bun:test";
import { buildLoginUrl, buildReauthReturn, readReauthIntent, resolveReturnDestination } from "../src/lib/return-destination";

const origin = "https://auth.lomi.dev";
const returnParam = (value: string) => `?returnTo=${encodeURIComponent(value)}`;
const desktopRequest = "A".repeat(43);

describe("local callback allowlist", () => {
  test("allows account and valid device destinations only", () => {
    expect(resolveReturnDestination(returnParam("/account"), origin)).toBe("/account");
    expect(resolveReturnDestination(returnParam("/device"), origin)).toBe("/device");
    expect(resolveReturnDestination(returnParam("/device?user_code=ABCD2345"), origin)).toBe("/device?user_code=ABCD2345");
    expect(resolveReturnDestination(returnParam(`/desktop?request=${desktopRequest}`), origin)).toBe(`/desktop?request=${desktopRequest}`);
  });

  test("rejects external, protocol-relative, nested, duplicated, and unknown destinations", () => {
    expect(resolveReturnDestination(returnParam("https://evil.example/"), origin)).toBe("/account");
    expect(resolveReturnDestination(returnParam("//evil.example/path"), origin)).toBe("/account");
    expect(resolveReturnDestination(returnParam("/%252f%252fevil.example"), origin)).toBe("/account");
    expect(resolveReturnDestination("?returnTo=%2Faccount&returnTo=https%3A%2F%2Fevil.example", origin)).toBe("/account");
    expect(resolveReturnDestination(returnParam("/device?user_code=ABCD2345&next=https://evil.example"), origin)).toBe("/account");
    expect(resolveReturnDestination(returnParam("/device?user_code=BAD"), origin)).toBe("/account");
    expect(resolveReturnDestination(returnParam("/account?tab=private"), origin)).toBe("/account");
    expect(resolveReturnDestination(returnParam(`/desktop?request=${desktopRequest}&next=https://evil.example`), origin)).toBe("/account");
    expect(resolveReturnDestination(returnParam(`/desktop?request=${desktopRequest}&request=${desktopRequest}`), origin)).toBe("/account");
    expect(resolveReturnDestination(returnParam(`/desktop?request=${"A".repeat(42)}`), origin)).toBe("/account");
    expect(resolveReturnDestination(returnParam(`/desktop?request=${desktopRequest}#`), origin)).toBe("/account");
  });

  test("preserves only validated reauthentication intents", () => {
    expect(resolveReturnDestination(returnParam("/account?reauth=all"), origin)).toBe("/account?reauth=all");
    expect(resolveReturnDestination(returnParam("/account?reauth=single&session=desk_01"), origin)).toBe("/account?reauth=single&session=desk_01");
    expect(resolveReturnDestination(returnParam("/account?reauth=single&session=..%2Fsecret"), origin)).toBe("/account");
    expect(readReauthIntent("?reauth=single&session=desk_01")).toEqual({ kind: "single", sessionId: "desk_01" });
    expect(readReauthIntent("?reauth=all&session=desk_01")).toBeNull();
    expect(buildReauthReturn({ kind: "all" })).toBe("/account?reauth=all");
    expect(buildLoginUrl("/device?user_code=ABCD2345")).toBe("/login?returnTo=%2Fdevice%3Fuser_code%3DABCD2345");
  });
});
