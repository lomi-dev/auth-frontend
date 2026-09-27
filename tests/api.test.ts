import { afterEach, describe, expect, test } from "bun:test";
import { apiRequest, userFacingError } from "../src/lib/api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("same-origin API requests", () => {
  test("marks POST and DELETE mutations without adding the marker to reads", async () => {
    const observed: RequestInit[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      observed.push(init ?? {});
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    await apiRequest("/v1/me");
    await apiRequest("/v1/account/sessions/revoke-all", { method: "POST", body: {} });
    await apiRequest("/v1/account/sessions/session_01", { method: "DELETE" });

    const [read, post, deletion] = observed;
    expect(new Headers(read?.headers).get("X-Lomi-Request")).toBeNull();
    expect(new Headers(post?.headers).get("X-Lomi-Request")).toBe("1");
    expect(new Headers(post?.headers).get("Content-Type")).toBe("application/json");
    expect(post?.body).toBe("{}");
    expect(new Headers(deletion?.headers).get("X-Lomi-Request")).toBe("1");
    for (const request of observed) {
      expect(request.credentials).toBe("same-origin");
      expect(request.cache).toBe("no-store");
    }
  });

  test("maps machine errors and keeps request IDs available for support", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { code: "REAUTH_REQUIRED", requestId: "req-123" } }), {
      status: 403,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await apiRequest("/v1/account/sessions/revoke-all", { method: "POST", body: {} });
    } catch (error) {
      caught = error;
    }

    expect(userFacingError(caught)).toEqual({
      message: "Verify your GitHub account again to continue.",
      requestId: "req-123",
    });
  });

  test("does not treat inherited object properties as known API error codes", () => {
    const error = Object.assign(new Error("__proto__"), {
      code: "__proto__",
      status: 400,
      requestId: null,
    });
    expect(userFacingError(error).message).toBe("We couldn’t complete that request. Try again in a moment.");
  });

  test("shows a safe restart message for an expired desktop login request", () => {
    const error = Object.assign(new Error("LOGIN_EXPIRED"), {
      code: "LOGIN_EXPIRED",
      status: 410,
      requestId: null,
    });
    expect(userFacingError(error).message).toBe("This sign-in request expired or was already used. Start sign-in again in Lomi.");
  });
});
