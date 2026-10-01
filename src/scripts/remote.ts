import { apiRequest, initials, type MeResponse } from "../lib/api";
import { validateAccountImage } from "../lib/account-image";
import { buildLoginUrl } from "../lib/return-destination";
import {
  readRemoteRequest,
  validateRemoteCallback,
  validateRemoteOrigin,
} from "../lib/remote-handoff";
interface Preview {
  clientId: string;
  application: string;
  origin: string;
  scope: string[];
  expiresAt: string;
}
const status = document.querySelector<HTMLElement>("#remote-status")!;
const errorBox = document.querySelector<HTMLElement>("#remote-error")!;
const review = document.querySelector<HTMLElement>("#remote-review")!;
const login = document.querySelector<HTMLAnchorElement>("#remote-login")!;
const approve = document.querySelector<HTMLButtonElement>("#remote-approve")!;
const deny = document.querySelector<HTMLButtonElement>("#remote-deny")!;
const account = document.querySelector<HTMLParagraphElement>("#remote-account")!;
const github = document.querySelector<HTMLParagraphElement>("#remote-github")!;
const avatar = document.querySelector<HTMLImageElement>("#remote-avatar")!;
const avatarInitials = document.querySelector<HTMLSpanElement>("#remote-initials")!;
const requestId = readRemoteRequest(location.search, location.href);
let destination: string | null = null;
let busy = false;
function showError(message: string) {
  errorBox.textContent = message;
  errorBox.hidden = false;
}
async function remoteRequest<T>(
  path: string,
  body?: { requestId: string },
): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: {
      Accept: "application/json",
      "X-Lomi-Request": "1",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok)
    throw Object.assign(new Error("REQUEST_FAILED"), {
      status: response.status,
    });
  if (typeof data !== "object" || data === null)
    throw new Error("INVALID_RESPONSE");
  return data as T;
}
async function start() {
  if (!requestId) {
    status.hidden = true;
    showError("This request is invalid. Start sign-in again on Lomi Remote.");
    return;
  }
  let checkingSession = true;
  try {
    const me = await apiRequest<MeResponse>("/v1/me");
    if (me.user.status !== "active") throw new Error("ACCOUNT_UNAVAILABLE");
    checkingSession = false;
    const preview = await remoteRequest<Preview>(
      `/v1/remote-login/request?request=${requestId}`,
    );
    destination = validateRemoteOrigin(preview.origin);
    if (
      !destination ||
      preview.application !== "Lomi Remote" ||
      !Array.isArray(preview.scope) ||
      preview.scope.length !== 1 ||
      preview.scope[0] !== "remote:account:read" ||
      Date.parse(preview.expiresAt) <= Date.now() ||
      !Number.isFinite(Date.parse(preview.expiresAt))
    )
      throw new Error("INVALID_REQUEST");
    const name = me.user.displayName || me.user.githubLogin || "Lomi account";
    account.textContent = name;
    avatarInitials.textContent = initials(name);
    if (me.user.githubLogin && me.user.githubLogin !== name) {
      github.textContent = `@${me.user.githubLogin}`;
      github.hidden = false;
    }
    const image = validateAccountImage(me.user.image);
    if (image) {
      avatar.addEventListener("load", () => { avatar.hidden = false; });
      avatar.addEventListener("error", () => { avatar.hidden = true; });
      avatar.src = image;
    }
    status.hidden = true;
    review.hidden = false;
  } catch (error) {
    if (
      checkingSession &&
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      error.status === 401
    ) {
      status.textContent = "Redirecting to GitHub sign-in…";
      login.href = buildLoginUrl(`/remote?request=${requestId}`);
      login.hidden = false;
      try { location.replace(login.href); } catch {
        status.textContent = "Continue with GitHub to sign in.";
      }
      return;
    }
    status.hidden = true;
    showError(
      "We couldn’t verify this request. It may have expired, already been handled, or the service may be unavailable. Start sign-in again on Lomi Remote.",
    );
  }
}
async function finish(action: "approve" | "deny") {
  if (!requestId || !destination || busy) return;
  busy = true;
  approve.disabled = true;
  deny.disabled = true;
  errorBox.hidden = true;
  status.hidden = false;
  approve.setAttribute("aria-busy", "true");
  status.textContent =
    action === "approve"
      ? "Continuing to Lomi Remote…"
      : "Cancelling this request…";
  try {
    const result = await remoteRequest<{ redirectUrl: unknown }>(
      `/v1/remote-login/${action === "approve" ? "complete" : "deny"}`,
      { requestId },
    );
    const redirect = validateRemoteCallback(
      result.redirectUrl,
      destination,
      action,
    );
    if (!redirect) throw new Error("INVALID_CALLBACK");
    location.replace(redirect);
  } catch {
    status.textContent = "The request could not be completed.";
    showError(
      "Try again. If this request expired or was already handled, start sign-in again on Lomi Remote.",
    );
    busy = false;
    approve.removeAttribute("aria-busy");
    approve.disabled = false;
    deny.disabled = false;
  }
}
approve.addEventListener("click", () => void finish("approve"));
deny.addEventListener("click", () => void finish("deny"));
void start();
