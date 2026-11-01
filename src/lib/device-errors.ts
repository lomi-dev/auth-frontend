export function explainDeviceError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (code === "SESSION_REQUIRED" || code === "UNAUTHORIZED") return "Your session has ended. Sign in again before reviewing this request.";
    if (code === "FORBIDDEN" || code === "access_denied") return "Lomi couldn’t verify this request with the current browser session. Check that this page is signed into the intended account, then try a fresh code from Lomi.";
    if (code === "NETWORK_ERROR") return "We couldn’t reach Lomi. Check your connection and try again.";
    if (code === "SERVICE_UNAVAILABLE") return "Lomi is temporarily unavailable. Try again shortly.";
  }
  return "This code is invalid, expired, or already handled. Start a new request in Lomi for a new code.";
}
