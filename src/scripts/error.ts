import { resolveReturnDestination } from "../lib/return-destination";

const params = new URLSearchParams(window.location.search);
const codes = params.getAll("error");
const requestIds = params.getAll("requestId");
const code = codes.length === 1 ? codes[0] : "";
const title = document.querySelector<HTMLHeadingElement>("#error-title");
const copy = document.querySelector<HTMLParagraphElement>("#error-copy");
const requestWrap = document.querySelector<HTMLElement>("#error-request");
const requestValue = document.querySelector<HTMLElement>("#error-request-id");
const retry = document.querySelector<HTMLAnchorElement>("#error-retry");
const back = document.querySelector<HTMLAnchorElement>("#error-back");
const returnTo = resolveReturnDestination(window.location.search, window.location.origin);
const isDesktopReturn = returnTo.startsWith("/desktop?request=");

const messages: Record<string, { title: string; copy: string }> = {
  access_denied: {
    title: "Sign-in was cancelled.",
    copy: "GitHub sign-in was cancelled before your Lomi session could start. You can try again whenever you’re ready.",
  },
  account_suspended: {
    title: "This account is unavailable.",
    copy: "This Lomi account cannot sign in right now. Contact Lomi support if you think this is a mistake.",
  },
  oauth_error: {
    title: "GitHub couldn’t complete sign-in.",
    copy: "There was a problem returning from GitHub. Your account was not changed. Try again in a moment.",
  },
  callback: {
    title: "We couldn’t verify the sign-in.",
    copy: "The sign-in response could not be verified. Start again from Lomi and complete the GitHub step in the same browser.",
  },
};

if (title && copy) {
  const mapped = Object.prototype.hasOwnProperty.call(messages, code) ? messages[code] : undefined;
  if (mapped) {
    title.textContent = mapped.title;
    copy.textContent = mapped.copy;
  }
  if (isDesktopReturn) {
    title.textContent = "Desktop sign-in didn’t finish.";
    copy.textContent = "Start sign-in again in Lomi.";
  }
}

if (requestWrap && requestValue && requestIds.length === 1 && /^[A-Za-z0-9._-]{1,80}$/.test(requestIds[0] ?? "")) {
  requestValue.textContent = requestIds[0] ?? "";
  requestWrap.hidden = false;
}

if (retry && !isDesktopReturn) {
  retry.href = returnTo === "/account" ? "/login" : `/login?returnTo=${encodeURIComponent(returnTo)}`;
  retry.hidden = false;
}

if (back && !isDesktopReturn) {
  back.hidden = false;
}
