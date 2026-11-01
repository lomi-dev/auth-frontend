import { expect, test } from "bun:test";
import { explainDeviceError } from "./device-errors";

test("generic forbidden responses do not claim another account owns the code", () => {
  for (const code of ["FORBIDDEN", "access_denied"]) {
    const message = explainDeviceError({ code });
    expect(message).toContain("current browser session");
    expect(message).toContain("intended account");
    expect(message).not.toContain("already connected to a different");
  }
});

test("known session and transport errors keep actionable messages", () => {
  expect(explainDeviceError({ code: "SESSION_REQUIRED" })).toContain("Sign in again");
  expect(explainDeviceError({ code: "NETWORK_ERROR" })).toContain("Check your connection");
});
