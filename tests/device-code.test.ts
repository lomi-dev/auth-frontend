import { describe, expect, test } from "bun:test";
import { formatDeviceCode, normalizeDeviceCode, readDeviceCodeFromLocation } from "../src/lib/device-code";

describe("device code input", () => {
  test("normalizes spacing, dashes, and letter case like Better Auth", () => {
    expect(normalizeDeviceCode("abcd-2345")).toBe("ABCD2345");
    expect(normalizeDeviceCode(" abcd 2345 ")).toBe("ABCD2345");
    expect(formatDeviceCode("ABCD2345")).toBe("ABCD 2345");
  });

  test("rejects incomplete codes and characters omitted from the default alphabet", () => {
    expect(normalizeDeviceCode("ABC2345")).toBeNull();
    expect(normalizeDeviceCode("ABCD0123")).toBeNull();
    expect(normalizeDeviceCode("ABCDI234")).toBeNull();
    expect(normalizeDeviceCode("ABCDO234")).toBeNull();
  });

  test("reads one valid code from a device verification URL", () => {
    expect(readDeviceCodeFromLocation("?user_code=abcd-2345")).toBe("ABCD2345");
    expect(readDeviceCodeFromLocation("?user_code=ABCD2345&user_code=EFGH2345")).toBeNull();
    expect(readDeviceCodeFromLocation("?user_code=invalid")).toBeNull();
  });
});
