import { apiRequest, formatDate, initials, userFacingError, type AccountSession, type MeResponse, type SessionListResponse } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { buildLoginUrl, buildReauthReturn, readReauthIntent, type ReauthIntent } from "../lib/return-destination";

type SessionAction = { kind: "single"; sessionId: string; label: string } | { kind: "all" };

const pageStatus = document.querySelector<HTMLParagraphElement>("#account-status");
const content = document.querySelector<HTMLElement>("#account-content");
const profileAvatar = document.querySelector<HTMLElement>("#profile-avatar");
const profileName = document.querySelector<HTMLElement>("#profile-name");
const profileHandle = document.querySelector<HTMLElement>("#profile-handle");
const profileEmail = document.querySelector<HTMLElement>("#profile-email");
const profileStatus = document.querySelector<HTMLElement>("#profile-status");
const sessionsList = document.querySelector<HTMLUListElement>("#sessions-list");
const sessionListStatus = document.querySelector<HTMLParagraphElement>("#session-list-status");
const sessionsEmpty = document.querySelector<HTMLElement>("#sessions-empty");
const sessionCount = document.querySelector<HTMLElement>("#session-count");
const loadMoreButton = document.querySelector<HTMLButtonElement>("#load-more-sessions");
const revokeAllButton = document.querySelector<HTMLButtonElement>("#revoke-all-sessions");
const confirmDialog = document.querySelector<HTMLDialogElement>("#confirm-dialog");
const confirmTitle = document.querySelector<HTMLHeadingElement>("#confirm-title");
const confirmCopy = document.querySelector<HTMLParagraphElement>("#confirm-copy");
const confirmButton = document.querySelector<HTMLButtonElement>("#confirm-action");
const cancelButton = document.querySelector<HTMLButtonElement>("#confirm-cancel");
const reauthPanel = document.querySelector<HTMLElement>("#reauth-panel");
const reauthTitle = document.querySelector<HTMLElement>("#reauth-title");
const reauthDescription = document.querySelector<HTMLParagraphElement>("#reauth-description");
const reauthStartButton = document.querySelector<HTMLButtonElement>("#reauth-start");
const reauthContinueButton = document.querySelector<HTMLButtonElement>("#reauth-continue");

let nextCursor: string | null = null;
let totalShown = 0;
let pendingAction: SessionAction | null = null;
let reauthIntent: ReauthIntent | null = null;
const seenSessions = new Set<string>();

function setPageStatus(message: string, tone: "info" | "success" | "warning" | "danger" = "info", requestId: string | null = null) {
  if (!pageStatus) return;
  pageStatus.className = `notice notice-${tone} account-status`;
  pageStatus.replaceChildren(document.createTextNode(message));
  if (requestId) {
    const reference = document.createElement("code");
    reference.className = "request-id";
    reference.textContent = `Reference: ${requestId}`;
    pageStatus.append(reference);
  }
  pageStatus.hidden = false;
}

function hidePageStatus() {
  if (pageStatus) pageStatus.hidden = true;
}

function showSessionStatus(message: string, tone: "info" | "success" | "warning" | "danger" = "info", requestId: string | null = null) {
  if (!sessionListStatus) return;
  sessionListStatus.className = `loading-line ${tone === "danger" ? "session-error" : ""}`;
  sessionListStatus.replaceChildren(document.createTextNode(message));
  if (requestId) {
    const reference = document.createElement("code");
    reference.className = "request-id";
    reference.textContent = `Reference: ${requestId}`;
    sessionListStatus.append(reference);
  }
  sessionListStatus.hidden = false;
}

function apiErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) return String(error.code);
  return null;
}

function validSession(value: unknown): value is AccountSession {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Partial<AccountSession>;
  return typeof item.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(item.id) &&
    (item.kind === "desktop" || item.kind === "browser" || item.kind === "unknown") &&
    typeof item.createdAt === "string" && typeof item.updatedAt === "string" &&
    typeof item.expiresAt === "string" && typeof item.isCurrent === "boolean";
}

function sessionTitle(session: AccountSession): string {
  if (session.isCurrent) return "This browser";
  if (session.kind === "desktop") return "Lomi desktop";
  if (session.kind === "browser") return "Browser session";
  return "Other session";
}

function appendIcon(target: HTMLElement, kind: AccountSession["kind"]) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  const d = kind === "desktop"
    ? "M4 4.5h16A1.5 1.5 0 0 1 21.5 6v10A1.5 1.5 0 0 1 20 17.5h-6.8l.45 2h2.1v1.5h-7.5V19.5h2.1l.45-2H4A1.5 1.5 0 0 1 2.5 16V6A1.5 1.5 0 0 1 4 4.5Zm0 2v9h16v-9H4Z"
    : "M7 2.5h10A2.5 2.5 0 0 1 19.5 5v14a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 19V5A2.5 2.5 0 0 1 7 2.5Zm0 2A.5.5 0 0 0 6.5 5v14c0 .28.22.5.5.5h10a.5.5 0 0 0 .5-.5V5a.5.5 0 0 0-.5-.5H7Zm3 12.5h4v1.5h-4V17Z";
  path.setAttribute("d", d);
  svg.append(path);
  target.append(svg);
}

function createSessionItem(session: AccountSession): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "session-item";

  const icon = document.createElement("span");
  icon.className = "session-kind-icon";
  appendIcon(icon, session.kind);

  const info = document.createElement("span");
  info.className = "session-info";
  const titleRow = document.createElement("span");
  titleRow.className = "session-title-row";
  const title = document.createElement("strong");
  title.className = "session-title";
  title.textContent = sessionTitle(session);
  titleRow.append(title);

  if (session.isCurrent) {
    const current = document.createElement("span");
    current.className = "current-pill";
    current.textContent = "Current";
    titleRow.append(current);
  }

  const meta = document.createElement("span");
  meta.className = "session-meta";
  meta.textContent = `Added ${formatDate(session.createdAt)} · Active ${formatDate(session.updatedAt)} · Expires ${formatDate(session.expiresAt)}`;
  info.append(titleRow, meta);

  const revoke = document.createElement("button");
  revoke.type = "button";
  revoke.className = "button button-danger button-small session-revoke";
  revoke.textContent = "Revoke";
  revoke.setAttribute("aria-label", `Revoke ${sessionTitle(session)} session`);
  revoke.addEventListener("click", () => openConfirm({ kind: "single", sessionId: session.id, label: sessionTitle(session) }));

  item.append(icon, info, revoke);
  return item;
}

function setProfile(me: MeResponse) {
  const name = me.user.displayName || "Lomi account";
  if (profileAvatar) profileAvatar.textContent = initials(name);
  if (profileName) profileName.textContent = name;
  if (profileHandle) profileHandle.textContent = me.user.githubLogin ? `@${me.user.githubLogin}` : "GitHub account";
  if (profileEmail) profileEmail.textContent = me.user.email || "Not shared with Lomi";
  if (profileStatus) {
    const statusText = profileStatus.querySelector("span:last-child");
    if (statusText) statusText.textContent = me.user.status === "active" ? "Active" : "Unavailable";
    profileStatus.classList.toggle("status-pill-inactive", me.user.status !== "active");
  }
}

function setSessionCount(count: number) {
  if (sessionCount) sessionCount.textContent = String(count);
}

async function loadSessions(append = false) {
  if (!sessionsList) return;
  const query = new URLSearchParams();
  if (append && nextCursor) query.set("cursor", nextCursor);
  const path = `/v1/account/sessions${query.size ? `?${query.toString()}` : ""}`;
  if (loadMoreButton) {
    loadMoreButton.disabled = true;
    loadMoreButton.setAttribute("aria-busy", "true");
  }
  showSessionStatus(append ? "Loading more sessions…" : "Loading sessions…");

  try {
    const response = await apiRequest<SessionListResponse>(path);
    const sessions = Array.isArray(response.sessions) ? response.sessions.filter(validSession) : [];
    for (const session of sessions) {
      if (seenSessions.has(session.id)) continue;
      seenSessions.add(session.id);
      sessionsList.append(createSessionItem(session));
      totalShown += 1;
    }
    nextCursor = typeof response.nextCursor === "string" && response.nextCursor.length <= 256 ? response.nextCursor : null;
    if (loadMoreButton) loadMoreButton.hidden = !nextCursor;
    if (sessionsEmpty) sessionsEmpty.hidden = totalShown !== 0;
    setSessionCount(totalShown);
    showSessionStatus(totalShown ? `${totalShown} ${totalShown === 1 ? "session" : "sessions"} shown` : "No active sessions were returned.", "success");
  } catch (error) {
    const friendly = userFacingError(error);
    showSessionStatus(friendly.message, "danger", friendly.requestId);
    if (apiErrorCode(error) === "SESSION_REQUIRED") {
      const intent = readReauthIntent(window.location.search);
      window.location.replace(buildLoginUrl(intent ? buildReauthReturn(intent) : "/account"));
    }
  } finally {
    if (loadMoreButton) {
      loadMoreButton.disabled = false;
      loadMoreButton.removeAttribute("aria-busy");
    }
  }
}

function setReauthPanel(intent: ReauthIntent, afterLogin: boolean) {
  reauthIntent = intent;
  if (reauthPanel) reauthPanel.hidden = false;
  if (reauthTitle) reauthTitle.textContent = afterLogin ? "Continue your account security change" : "Verify with GitHub to continue";
  if (reauthDescription) {
    reauthDescription.textContent = afterLogin
      ? "Your GitHub sign-in is complete. Continue to apply the change you requested."
      : "A fresh sign-in is required before Lomi can make this account security change.";
  }
  if (reauthStartButton) reauthStartButton.hidden = afterLogin;
  if (reauthContinueButton) {
    reauthContinueButton.hidden = !afterLogin;
    reauthContinueButton.textContent = intent.kind === "all" ? "Continue revoking all sessions" : "Continue revoking session";
  }
}

function openConfirm(action: SessionAction) {
  pendingAction = action;
  if (!confirmDialog || !confirmTitle || !confirmCopy || !confirmButton) return;
  if (action.kind === "all") {
    confirmTitle.textContent = "Sign out everywhere?";
    confirmCopy.textContent = "This revokes every active Lomi session, including Lomi desktop and this browser. You’ll need to sign in again for online account services; local desktop work remains available.";
    confirmButton.textContent = "Revoke all sessions";
  } else {
    confirmTitle.textContent = `Revoke ${action.label.toLowerCase()}?`;
    confirmCopy.textContent = "That session will no longer be able to access Lomi. This action can’t be undone.";
    confirmButton.textContent = "Revoke session";
  }
  if (typeof confirmDialog.showModal === "function") confirmDialog.showModal();
  else if (window.confirm(confirmCopy.textContent)) void performAction(action);
}

async function performAction(action: SessionAction) {
  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.setAttribute("aria-busy", "true");
  }
  const intent: ReauthIntent = action.kind === "all" ? { kind: "all" } : { kind: "single", sessionId: action.sessionId };

  try {
    if (action.kind === "all") {
      await apiRequest<void>("/v1/account/sessions/revoke-all", { method: "POST", body: {} });
    } else {
      await apiRequest<void>(`/v1/account/sessions/${encodeURIComponent(action.sessionId)}`, { method: "DELETE" });
    }
    if (confirmDialog?.open) confirmDialog.close();
    hidePageStatus();
    setPageStatus(action.kind === "all" ? "All Lomi sessions were revoked." : `${action.label} session was revoked.`, "success");

    if (action.kind === "all" || action.label === "This browser") {
      window.setTimeout(() => window.location.replace("/login"), 900);
      return;
    }

    totalShown = 0;
    seenSessions.clear();
    if (sessionsList) sessionsList.replaceChildren();
    await loadSessions();
  } catch (error) {
    if (apiErrorCode(error) === "REAUTH_REQUIRED") {
      if (confirmDialog?.open) confirmDialog.close();
      setReauthPanel(intent, false);
      setPageStatus("A fresh sign-in is required to finish this change.", "warning");
      reauthStartButton?.focus();
      return;
    }
    const friendly = userFacingError(error);
    if (apiErrorCode(error) === "SESSION_REQUIRED") {
      window.location.replace(buildLoginUrl("/account"));
      return;
    }
    setPageStatus(friendly.message, "danger", friendly.requestId);
  } finally {
    if (confirmButton) {
      confirmButton.disabled = false;
      confirmButton.removeAttribute("aria-busy");
    }
  }
}

async function startGithubReauth() {
  if (!reauthIntent || !reauthStartButton) return;
  reauthStartButton.disabled = true;
  reauthStartButton.setAttribute("aria-busy", "true");
  reauthStartButton.textContent = "Connecting to GitHub…";
  try {
    const callbackURL = buildReauthReturn(reauthIntent);
    const errorCallbackURL = `/error?returnTo=${encodeURIComponent(callbackURL)}`;
    const result = await authClient.signIn.social({
      provider: "github",
      callbackURL,
      errorCallbackURL,
      disableRedirect: true,
    });
    if (result.error || !result.data?.url) throw new Error("REAUTH_START_FAILED");
    const providerUrl = new URL(result.data.url, window.location.origin);
    if (providerUrl.protocol !== "https:" || providerUrl.hostname !== "github.com") throw new Error("REAUTH_START_FAILED");
    window.location.assign(providerUrl.href);
  } catch {
    setPageStatus("We couldn’t start GitHub verification. Try again in a moment.", "danger");
    reauthStartButton.disabled = false;
    reauthStartButton.removeAttribute("aria-busy");
    reauthStartButton.textContent = "Verify with GitHub";
  }
}

async function continueReauthenticatedAction() {
  if (!reauthIntent) return;
  reauthContinueButton?.setAttribute("aria-busy", "true");
  if (reauthContinueButton) reauthContinueButton.disabled = true;
  const action: SessionAction = reauthIntent.kind === "all"
    ? { kind: "all" }
    : { kind: "single", sessionId: reauthIntent.sessionId, label: "Selected" };
  await performAction(action);
  if (reauthContinueButton) {
    reauthContinueButton.disabled = false;
    reauthContinueButton.removeAttribute("aria-busy");
  }
}

async function loadAccount() {
  try {
    const me = await apiRequest<MeResponse>("/v1/me");
    if (!me.user || me.user.status !== "active") {
      setPageStatus("This Lomi account is currently unavailable.", "danger");
      return;
    }
    setProfile(me);
    if (content) content.hidden = false;
    hidePageStatus();

    const intent = readReauthIntent(window.location.search);
    if (intent) setReauthPanel(intent, true);
    void loadSessions();
  } catch (error) {
    if (apiErrorCode(error) === "SESSION_REQUIRED") {
      const intent = readReauthIntent(window.location.search);
      const returnTo = intent ? buildReauthReturn(intent) : "/account";
      window.location.replace(buildLoginUrl(returnTo));
      return;
    }
    const friendly = userFacingError(error);
    setPageStatus(friendly.message, "danger", friendly.requestId);
  }
}

loadMoreButton?.addEventListener("click", () => void loadSessions(true));
revokeAllButton?.addEventListener("click", () => openConfirm({ kind: "all" }));
confirmButton?.addEventListener("click", () => {
  if (pendingAction) void performAction(pendingAction);
});
cancelButton?.addEventListener("click", () => confirmDialog?.close());
confirmDialog?.addEventListener("close", () => { pendingAction = null; });
reauthStartButton?.addEventListener("click", () => void startGithubReauth());
reauthContinueButton?.addEventListener("click", () => void continueReauthenticatedAction());

void loadAccount();
