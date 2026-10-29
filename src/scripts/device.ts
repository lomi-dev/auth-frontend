import { apiRequest, initials, type MeResponse } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { formatDeviceCode, normalizeDeviceCode, readDeviceCodeFromLocation } from "../lib/device-code";
import { buildLoginUrl } from "../lib/return-destination";

interface DeviceVerification {
  user_code?: string;
  status?: string;
  client_id?: string;
  scope?: string;
  purpose?: "host_enrollment";
  reviewerUserId?: string;
  expiresAt?: string;
}

const heading = document.querySelector<HTMLHeadingElement>("#device-title");
const safetyCopy = document.querySelector<HTMLElement>("#device-safety-note .notice-row > span:last-child");
const hostConsent = document.querySelector<HTMLElement>("#host-consent");
const statusBox = document.querySelector<HTMLParagraphElement>("#device-status");
const noSession = document.querySelector<HTMLElement>("#device-no-session");
const sessionPanel = document.querySelector<HTMLElement>("#device-session");
const loginLink = document.querySelector<HTMLAnchorElement>("#device-login-link");
const avatar = document.querySelector<HTMLElement>("#device-avatar");
const accountName = document.querySelector<HTMLElement>("#device-name");
const accountEmail = document.querySelector<HTMLElement>("#device-email");
const switchAccount = document.querySelector<HTMLButtonElement>("#device-switch-account");
const codeForm = document.querySelector<HTMLFormElement>("#device-code-form");
const codeInput = document.querySelector<HTMLInputElement>("#device-code");
const codeError = document.querySelector<HTMLParagraphElement>("#device-code-error");
const review = document.querySelector<HTMLElement>("#device-review");
const reviewCode = document.querySelector<HTMLElement>("#review-code");
const reviewClient = document.querySelector<HTMLElement>("#review-client");
const reviewExpiry = document.querySelector<HTMLElement>("#review-expiry");
const approve = document.querySelector<HTMLButtonElement>("#approve-device");
const deny = document.querySelector<HTMLButtonElement>("#deny-device");
const retryWrap = document.querySelector<HTMLElement>("#device-retry");
const retrySessionCheck = document.querySelector<HTMLButtonElement>("#retry-session-check");

let currentCode: string | null = null;
let reviewedCode: string | null = null;
let reviewedUserId: string | null = null;
let currentPurpose: "host_enrollment" | null = null;
let reviewGeneration = 0;

function resetReview() {
  reviewGeneration += 1;
  reviewedCode = null;
  reviewedUserId = null;
  currentPurpose = null;
  if (review) review.hidden = true;
  if (reviewClient) reviewClient.textContent = "Lomi desktop";
  if (hostConsent) hostConsent.hidden = true;
  if (heading) heading.textContent = "Connect to Lomi";
  if (approve) {
    approve.textContent = "Approve this device";
    approve.disabled = false;
    approve.removeAttribute("aria-busy");
  }
  if (deny) {
    deny.disabled = false;
    deny.removeAttribute("aria-busy");
  }
  if (codeForm) {
    codeForm.hidden = false;
    const submit = codeForm.querySelector<HTMLButtonElement>("button[type=submit]");
    if (submit) {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
      submit.textContent = "Check code";
    }
  }
  if (codeInput) codeInput.disabled = false;
}

let currentUser: MeResponse | null = null;

function setStatus(message: string, tone: "info" | "success" | "warning" | "danger" = "info") {
  if (!statusBox) return;
  statusBox.className = `notice notice-${tone} status-message`;
  statusBox.textContent = message;
  statusBox.hidden = false;
}

function setCodeError(message: string) {
  if (!codeInput || !codeError) return;
  codeInput.setAttribute("aria-invalid", "true");
  codeError.textContent = message;
  codeError.hidden = false;
  codeInput.focus();
}

function clearCodeError() {
  if (!codeInput || !codeError) return;
  codeInput.setAttribute("aria-invalid", "false");
  codeError.textContent = "";
  codeError.hidden = true;
}

function showSession(user: MeResponse) {
  currentUser = user;
  if (retryWrap) retryWrap.hidden = true;
  if (avatar) avatar.textContent = initials(user.user.displayName || user.user.githubLogin || "Lomi");
  if (accountName) accountName.textContent = user.user.displayName || "Lomi account";
  if (accountEmail) accountEmail.textContent = user.user.email || "No email shared with Lomi";
  if (sessionPanel) sessionPanel.hidden = false;
  if (noSession) noSession.hidden = true;
}

function showNoSession() {
  currentUser = null;
  resetReview();
  if (retryWrap) retryWrap.hidden = true;
  if (sessionPanel) sessionPanel.hidden = true;
  if (noSession) noSession.hidden = false;
  const returnTo = currentCode ? `/device?user_code=${encodeURIComponent(currentCode)}` : "/device";
  if (loginLink) loginLink.href = buildLoginUrl(returnTo);
  setStatus("Sign in with GitHub before reviewing a device request.", "info");
}

function explainDeviceError(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String(error.code);
    if (code === "SESSION_REQUIRED" || code === "UNAUTHORIZED") return "Your session has ended. Sign in again before reviewing this request.";
    if (code === "FORBIDDEN" || code === "access_denied") return "This code is already connected to a different Lomi account. Sign in to that account or start a new request in Lomi.";
    if (code === "NETWORK_ERROR") return "We couldn’t reach Lomi. Check your connection and try again.";
    if (code === "SERVICE_UNAVAILABLE") return "Lomi is temporarily unavailable. Try again shortly.";
  }
  return "This code is invalid, expired, or already handled. Start a new request in Lomi for a new code.";
}

function formatExpiry(value: string): string | null {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) return null;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function showExpiry(value: string | undefined) {
  if (!reviewExpiry) return;
  const copy = reviewExpiry.querySelector<HTMLElement>(".notice-row > span:last-child");
  if (!copy) return;
  while (copy.firstChild) copy.removeChild(copy.firstChild);

  const strong = document.createElement("strong");
  strong.textContent = "Keep your code private.";
  copy.append(strong, document.createTextNode(" "));

  const expiryDate = value ? new Date(value) : null;
  const expiry = value ? formatExpiry(value) : null;
  if (!expiry) {
    copy.append(document.createTextNode("This code can expire at any time. Start a new request in Lomi if it expires."));
    return;
  }

  copy.append(document.createTextNode("This request expires at "));
  const time = document.createElement("time");
  time.dateTime = expiryDate?.toISOString() ?? "";
  time.textContent = expiry;
  copy.append(time, document.createTextNode(". Return to Lomi after making your decision."));
}

async function verifyCode(value: string) {
  if (!codeInput || !codeForm || !review || !reviewCode || !approve || !deny) return;
  if (!currentUser) {
    showNoSession();
    return;
  }

  resetReview();
  const generation = reviewGeneration;
  currentCode = value;
  clearCodeError();
  codeInput.value = formatDeviceCode(value);
  codeInput.disabled = true;
  const submit = codeForm.querySelector<HTMLButtonElement>("button[type=submit]");
  if (submit) {
    submit.disabled = true;
    submit.setAttribute("aria-busy", "true");
    submit.textContent = "Checking…";
  }
  review.hidden = true;
  setStatus("Checking that code with Lomi…", "info");

  try {
    // Device-code verification is state changing on the server. It must only run after this explicit submit.
    const result = await authClient.device({ query: { user_code: value } });
    if (generation !== reviewGeneration || !currentUser) return;
    if (result.error) throw Object.assign(new Error("DEVICE_VERIFY_FAILED"), { code: result.error.error });

    const data = result.data as DeviceVerification | null;
    if (data && data.purpose !== undefined && data.purpose !== "host_enrollment") throw new Error("UNKNOWN_PURPOSE");
    if (!data || data.status !== "pending") {
      window.location.assign(`/device/result?status=${encodeURIComponent(data?.purpose === "host_enrollment" ? "expired" : data?.status === "denied" ? "denied" : data?.status === "approved" ? "approved" : "expired")}`);
      return;
    }
    if (normalizeDeviceCode(data.user_code ?? "") !== value) {
      throw new Error("DEVICE_CODE_MISMATCH");
    }
    const host = data.purpose === "host_enrollment";
    if (typeof data.client_id !== "string" || !data.client_id.trim() || data.client_id.length > 256
      || (!host && !/^lomi-desktop(?:-[a-z0-9]+(?:-[a-z0-9]+)*)?$/i.test(data.client_id))) {
      throw new Error("UNKNOWN_CLIENT");
    }

    if (data.expiresAt && !formatExpiry(data.expiresAt)) throw new Error("DEVICE_EXPIRED");
    if (host) {
      if (typeof data.reviewerUserId !== "string" || !data.reviewerUserId.trim()) {
        throw new Error("MISSING_REVIEWER");
      }
      if (data.reviewerUserId !== currentUser.user.id) {
        // A different tab may have changed the cookie since the displayed account was loaded.
        // Refresh only the account display; claiming the code again requires another explicit submit.
        await checkSession(true);
        return;
      }
    }
    currentPurpose = host ? "host_enrollment" : null;
    reviewedCode = value;
    reviewedUserId = currentUser.user.id;
    if (reviewClient) reviewClient.textContent = host ? "Lomi Remote host" : "Lomi desktop";
    if (heading && host) heading.textContent = "Authorize this host";
    approve.textContent = host ? "Authorize this host" : "Approve this device";
    if (hostConsent) hostConsent.hidden = !host;
    if (safetyCopy) safetyCopy.textContent = host
      ? "Only authorize a host you just started. Check that the code above exactly matches the code on your host. This authorizes the host for the selected Lomi account."
      : "Only approve a request you just started. Check that the code above exactly matches Lomi desktop. This connects the app to your Lomi account; it does not grant access to private GitHub repositories.";
    reviewCode.textContent = formatDeviceCode(value);
    showExpiry(data.expiresAt);
    codeForm.hidden = true;
    review.hidden = false;
    setStatus("The code is valid. Review the request before approving it.", "success");
    approve.focus();
  } catch (error) {
    if (generation !== reviewGeneration) return;
    resetReview();
    const message = error instanceof Error && ["UNKNOWN_CLIENT", "UNKNOWN_PURPOSE"].includes(error.message)
      ? "This request came from an unrecognized app. Close this page and start a new request in Lomi."
      : error instanceof Error && error.message === "MISSING_REVIEWER"
        ? "We couldn’t confirm the account for this host. Check the code again."
        : explainDeviceError(error);
    codeInput.disabled = false;
    if (submit) {
      submit.disabled = false;
      submit.removeAttribute("aria-busy");
      submit.textContent = "Check code";
    }
    setStatus(message, "danger");
    if (message.includes("session has ended")) showNoSession();
    else codeInput.focus();
  }
}

async function finishDeviceAction(action: "approve" | "deny") {
  if (!currentUser || !currentCode || reviewedCode !== currentCode || !approve || !deny) return;
  if (currentPurpose === "host_enrollment" && reviewedUserId !== currentUser.user.id) {
    void checkSession(true);
    return;
  }
  const purpose = currentPurpose;
  const generation = reviewGeneration;
  approve.disabled = true;
  deny.disabled = true;
  approve.setAttribute("aria-busy", "true");
  deny.setAttribute("aria-busy", "true");
  setStatus(action === "approve" ? "Sending your approval…" : "Sending your decision…", "info");

  try {
    const result = action === "approve"
      ? await authClient.device.approve({ userCode: currentCode })
      : await authClient.device.deny({ userCode: currentCode });
    if (generation !== reviewGeneration || !currentUser) return;
    if (result.error) throw Object.assign(new Error("DEVICE_ACTION_FAILED"), { code: result.error.error });
    resetReview();
    window.location.assign(`/device/result?status=${action === "approve" ? "approved" : "denied"}${purpose === "host_enrollment" ? "&purpose=host_enrollment" : ""}`);
  } catch (error) {
    if (generation !== reviewGeneration) return;
    resetReview();
    const message = explainDeviceError(error);
    approve.disabled = false;
    deny.disabled = false;
    approve.removeAttribute("aria-busy");
    deny.removeAttribute("aria-busy");
    setStatus(message, "danger");
    if (message.includes("session has ended")) showNoSession();
  }
}

async function start() {
  const initialSearch = window.location.search;
  const params = new URLSearchParams(initialSearch);
  const hadCode = params.has("user_code");
  const initialCode = readDeviceCodeFromLocation(initialSearch);
  // Keep the short-lived code in memory only; remove it from browser history before any request.
  window.history.replaceState(null, "", window.location.pathname);

  if (initialCode) {
    currentCode = initialCode;
    if (codeInput) codeInput.value = formatDeviceCode(initialCode);
  }

  if (hadCode && !initialCode) {
    setCodeError("Enter a complete 8-character code from Lomi.");
  }

  if (codeForm && codeInput) {
    codeInput.addEventListener("input", () => {
      resetReview();
      clearCodeError();
      const normalized = normalizeDeviceCode(codeInput.value);
      if (normalized) {
        currentCode = normalized;
        if (loginLink) loginLink.href = buildLoginUrl(`/device?user_code=${encodeURIComponent(normalized)}`);
      }
    });

    codeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const normalized = normalizeDeviceCode(codeInput.value);
      if (!normalized) {
        setCodeError("Enter all 8 characters from the code shown in Lomi.");
        return;
      }
      void verifyCode(normalized);
    });
  }

  approve?.addEventListener("click", () => void finishDeviceAction("approve"));
  deny?.addEventListener("click", () => void finishDeviceAction("deny"));

  switchAccount?.addEventListener("click", async () => {
    const normalized = codeInput ? normalizeDeviceCode(codeInput.value) : currentCode;
    currentCode = normalized ?? currentCode;
    if (currentCode && loginLink) loginLink.href = buildLoginUrl(`/device?user_code=${encodeURIComponent(currentCode)}`);
    resetReview();
    switchAccount.disabled = true;
    setStatus("Signing out of this browser…", "info");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error("SIGN_OUT_FAILED");
    } catch {
      switchAccount.disabled = false;
      setStatus("We couldn’t switch accounts. Try again in a moment.", "danger");
      return;
    }
    showNoSession();
    if (codeForm) codeForm.hidden = false;
    if (codeInput) codeInput.disabled = false;
    if (review) review.hidden = true;
    loginLink?.focus();
  });

  retrySessionCheck?.addEventListener("click", () => void checkSession());
  await checkSession();
}

async function checkSession(accountChanged = false) {
  resetReview();
  const generation = reviewGeneration;
  currentUser = null;
  if (retrySessionCheck) {
    retrySessionCheck.disabled = true;
    retrySessionCheck.setAttribute("aria-busy", "true");
    retrySessionCheck.textContent = "Checking…";
  }
  if (retryWrap) retryWrap.hidden = true;
  if (noSession) noSession.hidden = true;
  if (sessionPanel) sessionPanel.hidden = true;
  setStatus("Checking your Lomi session…", "info");

  try {
    const user = await apiRequest<MeResponse>("/v1/me");
    if (generation !== reviewGeneration) return;
    if (!user.user || user.user.status !== "active") {
      currentUser = null;
      setStatus("This account cannot review a device sign-in right now.", "danger");
      return;
    }
    showSession(user);
    setStatus(accountChanged
      ? "The signed-in account changed. Review the account above, then check the code again."
      : "Check that the code came from the Lomi request you just started.", "info");
    if (codeInput) codeInput.disabled = false;
  } catch (error) {
    if (generation !== reviewGeneration) return;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "SESSION_REQUIRED") {
      showNoSession();
      return;
    }
    setStatus("We couldn’t check your Lomi session. Check your connection and try again.", "danger");
    if (retryWrap) retryWrap.hidden = false;
  } finally {
    if (generation !== reviewGeneration) return;
    if (retrySessionCheck) {
      retrySessionCheck.disabled = false;
      retrySessionCheck.removeAttribute("aria-busy");
      retrySessionCheck.textContent = "Check again";
    }
  }
}

void start();
