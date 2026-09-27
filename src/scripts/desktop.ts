import { apiRequest, userFacingError, type ApiError, type MeResponse } from "../lib/api";
import { readDesktopRequest, validateDesktopCallback } from "../lib/desktop-handoff";
import { buildLoginUrl } from "../lib/return-destination";

const status = document.querySelector<HTMLParagraphElement>("#desktop-status");
const errorBox = document.querySelector<HTMLParagraphElement>("#desktop-error");

function showError(message: string) {
  if (status) status.hidden = true;
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function isUnauthorized(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as ApiError).status === 401;
}

async function resumeDesktopSignIn() {
  const requestId = readDesktopRequest(window.location.search, window.location.href);
  if (!requestId) {
    showError("This sign-in link is invalid. Start sign-in again in Lomi.");
    return;
  }

  const returnTo = `/desktop?request=${requestId}`;
  try {
    await apiRequest<MeResponse>("/v1/me");
  } catch (error) {
    if (isUnauthorized(error)) {
      window.location.replace(buildLoginUrl(returnTo));
      return;
    }
    showError(userFacingError(error).message);
    return;
  }

  if (status) status.textContent = "Returning to Lomi…";
  try {
    const result = await apiRequest<{ redirectUrl?: unknown }>("/v1/desktop/complete", {
      method: "POST",
      body: { requestId },
    });
    const callback = validateDesktopCallback(result?.redirectUrl);
    if (!callback) {
      showError("This sign-in link is invalid. Start sign-in again in Lomi.");
      return;
    }
    window.location.replace(callback);
  } catch (error) {
    if (isUnauthorized(error)) {
      window.location.replace(buildLoginUrl(returnTo));
      return;
    }
    showError(userFacingError(error).message);
  }
}

void resumeDesktopSignIn();
