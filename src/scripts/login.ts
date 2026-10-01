import { apiRequest, type ApiError, type MeResponse } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { resolveReturnDestination } from "../lib/return-destination";

const form = document.querySelector<HTMLFormElement>("#login-form");
const button = document.querySelector<HTMLButtonElement>("#github-sign-in");
const buttonLabel = document.querySelector<HTMLElement>("[data-button-label]");
const status = document.querySelector<HTMLParagraphElement>("#login-status");

const retry = document.querySelector<HTMLDivElement>("#login-retry");
const checkSession = document.querySelector<HTMLButtonElement>("#login-check-session");

if (form && button && buttonLabel && status && retry && checkSession) {
  const returnTo = resolveReturnDestination(window.location.search, window.location.origin);

  const remoteLogin = /^\/remote\?request=[A-Za-z0-9_-]{43}$/.test(returnTo);
  let canSignIn = !remoteLogin;
  let checkingSession = false;

  async function checkRemoteSession() {
    if (checkingSession) return;
    checkingSession = true;
    canSignIn = false;
    form!.hidden = true;
    retry!.hidden = true;
    status!.classList.remove("notice-danger");
    status!.textContent = "Checking your Lomi session…";
    status!.hidden = false;
    try {
      const me = await apiRequest<MeResponse>("/v1/me");
      if (me?.user?.status !== "active") throw new Error("ACCOUNT_UNAVAILABLE");
      location.replace(returnTo);
    } catch (error) {
      if ((error as ApiError | null)?.status === 401) {
        canSignIn = true;
        form!.hidden = false;
        button!.disabled = false;
        status!.hidden = true;
      } else {
        status!.classList.add("notice-danger");
        status!.textContent = "We couldn’t confirm your Lomi session. Check your connection and try again.";
        retry!.hidden = false;
      }
    } finally {
      checkingSession = false;
    }
  }

  if (remoteLogin) {
    checkSession.addEventListener("click", () => void checkRemoteSession());
    void checkRemoteSession();
  } else {
    form.hidden = false;
    button.disabled = false;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!canSignIn) return;
    status.classList.add("notice-danger");
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    buttonLabel.textContent = "Connecting to GitHub…";
    status.hidden = true;

    try {
      const errorReturn = `/error?returnTo=${encodeURIComponent(returnTo)}`;
      const result = await authClient.signIn.social({
        provider: "github",
        callbackURL: returnTo,
        errorCallbackURL: errorReturn,
        disableRedirect: true,
      });

      if (result.error) throw new Error("SOCIAL_SIGN_IN_FAILED");
      if (!result.data?.url) throw new Error("SOCIAL_SIGN_IN_FAILED");

      const providerUrl = new URL(result.data.url, window.location.origin);
      if (providerUrl.protocol !== "https:" || providerUrl.hostname !== "github.com") {
        throw new Error("SOCIAL_SIGN_IN_FAILED");
      }

      window.location.assign(providerUrl.href);
    } catch {
      status.textContent = "We couldn’t start GitHub sign-in. Check your connection and try again.";
      status.hidden = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      buttonLabel.textContent = "Continue with GitHub";
    }
  });
}
