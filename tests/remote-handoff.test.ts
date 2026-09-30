import { describe, expect, test } from "bun:test";
import {
  readRemoteRequest,
  validateRemoteCallback,
  validateRemoteOrigin,
} from "../src/lib/remote-handoff";
import { resolveReturnDestination } from "../src/lib/return-destination";
const id = "A".repeat(43);
const origin = "https://remote.lomi.dev";
const callback = `${origin}/auth/callback?code=${id}&state=${id}`;
describe("Remote consent handoff", () => {
  test("accepts canonical request and exact registered callbacks", () => {
    expect(
      readRemoteRequest(
        `?request=${id}`,
        `https://auth.lomi.dev/remote?request=${id}`,
      ),
    ).toBe(id);
    expect(validateRemoteOrigin(origin)).toBe(origin);
    expect(validateRemoteCallback(callback, origin, "approve")).toBe(callback);
    expect(
      validateRemoteCallback(`${origin}/?auth=cancelled`, origin, "deny"),
    ).toBe(`${origin}/?auth=cancelled`);
    expect(
      resolveReturnDestination(
        `?returnTo=${encodeURIComponent(`/remote?request=${id}`)}`,
        "https://auth.lomi.dev",
      ),
    ).toBe(`/remote?request=${id}`);
  });
  test("rejects duplicates, fragments and open redirects", () => {
    for (const query of [
      `?request=${id}&request=${id}`,
      `?request=${id}&next=evil`,
      `?request=${id.slice(1)}`,
    ])
      expect(
        readRemoteRequest(query, "https://auth.lomi.dev/remote"),
      ).toBeNull();
    expect(
      readRemoteRequest(`?request=${id}`, "https://auth.lomi.dev/remote#"),
    ).toBeNull();
    for (const value of [
      callback + "#",
      callback + "&next=evil",
      callback.replace("remote.lomi.dev", "remote.lomi.dev.evil"),
      callback.replace("/auth/callback", "//auth/callback"),
    ])
      expect(validateRemoteCallback(value, origin, "approve")).toBeNull();
    expect(
      validateRemoteCallback(callback, "https://evil.example", "approve"),
    ).toBeNull();
    expect(
      resolveReturnDestination(
        `?returnTo=${encodeURIComponent(`/remote?request=${id}&next=evil`)}`,
        "https://auth.lomi.dev",
      ),
    ).toBe("/account");
  });
});
