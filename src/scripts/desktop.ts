import { apiRequest, userFacingError, type ApiError, type MeResponse } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { readDesktopRequest, validateDesktopCallback } from "../lib/desktop-handoff";

const title = document.querySelector<HTMLHeadingElement>("#desktop-title");
const status = document.querySelector<HTMLParagraphElement>("#desktop-status");
const errorBox = document.querySelector<HTMLParagraphElement>("#desktop-error");
const OAUTH_ATTEMPT_PREFIX = "lomi:desktop-oauth-attempt:";
let handoffStarted = false;

function showError(heading: string, message: string) {
  if (title) title.textContent = heading;
  if (status) status.hidden = true;
  if (!errorBox) return;
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function isUnauthorized(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as ApiError).status === 401;
}

function providerUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value, window.location.origin);
    if (
      url.origin !== "https://github.com" ||
      url.username ||
      url.password ||
      url.hash
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

async function startGithubSignIn(requestId: string, returnTo: string): Promise<void> {
  const storageKey = `${OAUTH_ATTEMPT_PREFIX}${requestId}`;
  try {
    if (window.sessionStorage.getItem(storageKey) !== null) {
      showError(
        "GitHub sign-in could not be confirmed.",
        "Close this page and start sign-in again in Lomi.",
      );
      return;
    }
    window.sessionStorage.setItem(storageKey, "started");
  } catch {
    showError(
      "GitHub sign-in could not start.",
      "Allow browser storage, then start sign-in again in Lomi.",
    );
    return;
  }

  if (status) status.textContent = "You will automatically be redirected.";
  try {
    const result = await authClient.signIn.social({
      provider: "github",
      callbackURL: returnTo,
      errorCallbackURL: `/error?returnTo=${encodeURIComponent(returnTo)}`,
      disableRedirect: true,
    });
    const destination = providerUrl(result.data?.url);
    if (result.error || !destination) throw new Error("SOCIAL_SIGN_IN_FAILED");
    window.location.assign(destination);
  } catch {
    showError(
      "GitHub sign-in could not start.",
      "Close this page and start sign-in again in Lomi.",
    );
  }
}

async function resumeDesktopSignIn() {
  if (handoffStarted) return;
  handoffStarted = true;

  const requestId = readDesktopRequest(window.location.search, window.location.href);
  if (!requestId) {
    showError("This sign-in link is invalid.", "Start sign-in again in Lomi.");
    return;
  }

  const returnTo = `/desktop?request=${requestId}`;
  try {
    await apiRequest<MeResponse>("/v1/me");
  } catch (error) {
    if (isUnauthorized(error)) {
      await startGithubSignIn(requestId, returnTo);
      return;
    }
    showError("Could not check your Lomi session.", userFacingError(error).message);
    return;
  }

  if (title) title.textContent = "Returning to Lomi";
  if (status) status.textContent = "Lomi desktop will confirm when your session is saved.";
  try {
    const result = await apiRequest<{ redirectUrl?: unknown }>("/v1/desktop/complete", {
      method: "POST",
      body: { requestId },
    });
    const callback = validateDesktopCallback(result?.redirectUrl);
    if (!callback) {
      showError("This sign-in link is invalid.", "Start sign-in again in Lomi.");
      return;
    }
    window.location.replace(callback);
  } catch (error) {
    if (isUnauthorized(error)) {
      showError(
        "Your session could not be confirmed.",
        "Close this page and start sign-in again in Lomi.",
      );
      return;
    }
    showError("Could not return to Lomi.", userFacingError(error).message);
  }
}

void resumeDesktopSignIn();
