import { authClient } from "../lib/auth-client";
import { resolveReturnDestination } from "../lib/return-destination";

const form = document.querySelector<HTMLFormElement>("#login-form");
const button = document.querySelector<HTMLButtonElement>("#github-sign-in");
const buttonLabel = document.querySelector<HTMLElement>("[data-button-label]");
const status = document.querySelector<HTMLParagraphElement>("#login-status");

if (form && button && buttonLabel && status) {
  button.disabled = false;
  const returnTo = resolveReturnDestination(window.location.search, window.location.origin);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
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
