import { apiRequest, formatDate, initials, userFacingError, type AccountHost, type AccountSession, type HostInventoryResponse, type MeResponse, type PendingHostEnrollment, type SessionListResponse } from "../lib/api";
import { authClient } from "../lib/auth-client";
import { validateAccountImage } from "../lib/account-image";
import { buildLoginUrl, buildReauthReturn, readReauthIntent, type ReauthIntent } from "../lib/return-destination";

type SessionAction = { kind: "single"; sessionId: string; label: string } | { kind: "all" } | { kind: "host"; host: AccountHost } | { kind: "host-enrollment"; host: AccountHost; enrollment: PendingHostEnrollment };
const MAX_DATABASE_EPOCH = 9223372036854775807n;

const pageStatus = document.querySelector<HTMLParagraphElement>("#account-status");
const content = document.querySelector<HTMLElement>("#account-content");
const profileImage = document.querySelector<HTMLImageElement>("#profile-image");
const profileInitials = document.querySelector<HTMLElement>("#profile-initials");
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
const hostsList = document.querySelector<HTMLUListElement>("#hosts-list");
const hostListStatus = document.querySelector<HTMLParagraphElement>("#host-list-status");
const hostsEmpty = document.querySelector<HTMLElement>("#hosts-empty");
const refreshHostsButton = document.querySelector<HTMLButtonElement>("#refresh-hosts");
const loadMoreHostsButton = document.querySelector<HTMLButtonElement>("#load-more-hosts");
const firstHostsPageButton = document.querySelector<HTMLButtonElement>("#first-hosts-page");

let nextCursor: string | null = null;
let totalShown = 0;
let pendingAction: SessionAction | null = null;
let reauthIntent: ReauthIntent | null = null;
let currentHostCursor: string | null = null;
let nextHostCursor: string | null = null;
let currentHosts: AccountHost[] = [];
let hostInventoryFresh = false;
const seenSessions = new Set<string>();
const unknownHostIds = new Set<string>();
const unknownEnrollmentIds = new Set<string>();

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

function showHostStatus(message: string, tone: "info" | "success" | "warning" | "danger" = "info") {
  if (!hostListStatus) return;
  hostListStatus.className = `loading-line ${tone === "danger" ? "session-error" : ""}`;
  hostListStatus.textContent = message;
  hostListStatus.hidden = false;
}

function validIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validHost(value: unknown): value is AccountHost {
  if (typeof value !== "object" || value === null) return false;
  const host = value as Partial<AccountHost>;
  if (Object.keys(value).sort().join(",") !== "accessEpoch,authorization,connectionStatus,finalized,fingerprint,hostId,pendingEnrollments,revocable,sharingStatus,state") return false;
  if (typeof host.hostId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(host.hostId) ||
    host.hostId === "00000000-0000-0000-0000-000000000000" ||
    typeof host.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(host.fingerprint) ||
    !(host.accessEpoch === null || (typeof host.accessEpoch === "string" && /^[1-9][0-9]{0,18}$/.test(host.accessEpoch))) ||
    typeof host.finalized !== "boolean" || !Array.isArray(host.pendingEnrollments) || host.pendingEnrollments.length > 50 ||
    host.connectionStatus !== "unknown" || host.sharingStatus !== "unknown" ||
    !["enrollment-incomplete", "revoked", "expired", "authorized"].includes(host.state ?? "") ||
    typeof host.revocable !== "boolean") return false;
  if (host.accessEpoch !== null && BigInt(host.accessEpoch) > MAX_DATABASE_EPOCH) return false;
  const enrollmentIds = new Set<string>();
  for (const enrollment of host.pendingEnrollments) {
    if (typeof enrollment !== "object" || enrollment === null ||
      Object.keys(enrollment).sort().join(",") !== "approvedAccountEpoch,currentHostEpoch,enrollmentId,expiresAt,fingerprint" ||
      typeof enrollment.enrollmentId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(enrollment.enrollmentId) ||
      enrollment.enrollmentId === "00000000-0000-0000-0000-000000000000" || enrollmentIds.has(enrollment.enrollmentId) ||
      typeof enrollment.approvedAccountEpoch !== "string" || !/^[1-9][0-9]{0,18}$/.test(enrollment.approvedAccountEpoch) ||
      BigInt(enrollment.approvedAccountEpoch) > MAX_DATABASE_EPOCH ||
      typeof enrollment.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(enrollment.fingerprint) ||
      !validIsoDate(enrollment.expiresAt) ||
      !(enrollment.currentHostEpoch === null || (typeof enrollment.currentHostEpoch === "string" &&
        /^[1-9][0-9]{0,18}$/.test(enrollment.currentHostEpoch) && BigInt(enrollment.currentHostEpoch) <= MAX_DATABASE_EPOCH))) return false;
    enrollmentIds.add(enrollment.enrollmentId);
  }

  if (host.authorization !== null) {
    const authorization = host.authorization;
    if (typeof authorization !== "object" || authorization === undefined ||
      Object.keys(authorization).sort().join(",") !== "confirmed,current,expiresAt,hostAccessEpoch,id,revoked" ||
      typeof authorization.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(authorization.id) ||
      typeof authorization.hostAccessEpoch !== "string" || !/^[1-9][0-9]{0,18}$/.test(authorization.hostAccessEpoch) ||
      typeof authorization.revoked !== "boolean" || typeof authorization.confirmed !== "boolean" ||
      !validIsoDate(authorization.expiresAt) || typeof authorization.current !== "boolean") return false;
    const current = host.accessEpoch !== null && authorization.hostAccessEpoch === host.accessEpoch;
    if (host.accessEpoch === null || BigInt(authorization.hostAccessEpoch) > MAX_DATABASE_EPOCH ||
      BigInt(authorization.hostAccessEpoch) > BigInt(host.accessEpoch) ||
      authorization.current !== current || host.revocable !== (current && !authorization.revoked &&
        BigInt(host.accessEpoch) < MAX_DATABASE_EPOCH)) return false;
  } else if (host.revocable) {
    return false;
  }
  return true;
}

function parseHostInventory(value: unknown): HostInventoryResponse {
  if (typeof value !== "object" || value === null || Object.keys(value).sort().join(",") !== "hosts,nextCursor" ||
    !Array.isArray((value as Partial<HostInventoryResponse>).hosts)) throw new Error("INVALID_HOST_INVENTORY");
  const response = value as Partial<HostInventoryResponse>;
  if (response.hosts!.length > 50 || !(response.nextCursor === null ||
    (typeof response.nextCursor === "string" && /^[A-Za-z0-9_-]{1,96}$/.test(response.nextCursor)))) throw new Error("INVALID_HOST_INVENTORY");
  const seen = new Set<string>();
  for (const host of response.hosts!) {
    if (!validHost(host) || seen.has(host.hostId)) throw new Error("INVALID_HOST_INVENTORY");
    seen.add(host.hostId);
  }
  return response as HostInventoryResponse;
}

function hostStateLabel(state: AccountHost["state"]): string {
  const labels: Record<AccountHost["state"], string> = {
    "enrollment-incomplete": "Enrollment incomplete",
    revoked: "Revoked",
    expired: "Expired",
    authorized: "Authorized",
  };
  return labels[state];
}

function validEnrollmentSnapshot(value: unknown): value is PendingHostEnrollment & { revoked: boolean; consumed: boolean } & { hostId: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return Object.keys(snapshot).sort().join(",") === "approvedAccountEpoch,consumed,currentHostEpoch,enrollmentId,expiresAt,fingerprint,hostId,revoked" &&
    typeof snapshot.enrollmentId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(snapshot.enrollmentId) &&
    typeof snapshot.hostId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(snapshot.hostId) &&
    typeof snapshot.approvedAccountEpoch === "string" && /^[1-9][0-9]{0,18}$/.test(snapshot.approvedAccountEpoch) &&
    BigInt(snapshot.approvedAccountEpoch) <= MAX_DATABASE_EPOCH &&
    typeof snapshot.fingerprint === "string" && /^[0-9a-f]{64}$/.test(snapshot.fingerprint) &&
    validIsoDate(snapshot.expiresAt) &&
    (snapshot.currentHostEpoch === null || (typeof snapshot.currentHostEpoch === "string" &&
      /^[1-9][0-9]{0,18}$/.test(snapshot.currentHostEpoch) && BigInt(snapshot.currentHostEpoch) <= MAX_DATABASE_EPOCH)) &&
    typeof snapshot.revoked === "boolean" && typeof snapshot.consumed === "boolean";
}

function createHostItem(host: AccountHost): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "host-item";
  const info = document.createElement("span");
  info.className = "host-info";
  const titleRow = document.createElement("span");
  titleRow.className = "host-title-row";
  const title = document.createElement("strong");
  title.textContent = `Host ${host.hostId}`;
  const state = document.createElement("span");
  state.className = `host-state host-state-${host.state}`;
  state.textContent = hostStateLabel(host.state);
  titleRow.append(title, state);

  const fingerprint = document.createElement("span");
  fingerprint.className = "host-meta";
  fingerprint.textContent = `Fingerprint ${host.fingerprint}`;
  const epoch = document.createElement("span");
  epoch.className = "host-meta";
  epoch.textContent = host.accessEpoch === null ? "Access epoch not issued" : `Access epoch ${host.accessEpoch}`;
  info.append(titleRow, fingerprint, epoch);

  if (host.authorization) {
    const authorization = document.createElement("span");
    authorization.className = "host-meta";
    const familyState = host.authorization.revoked || !host.authorization.current
      ? "revoked"
      : host.state === "expired"
        ? "expired"
        : host.state === "enrollment-incomplete"
          ? "setup incomplete"
          : "active";
    authorization.textContent = `Authorization ${host.authorization.id} · ${familyState} · Expires ${formatDate(host.authorization.expiresAt)}`;
    info.append(authorization);
  }
  for (const enrollment of host.pendingEnrollments) {
    const pending = document.createElement("span");
    pending.className = "host-meta host-enrollment-row";
    const details = document.createElement("span");
    details.textContent = `Approved setup ${enrollment.enrollmentId} · account epoch ${enrollment.approvedAccountEpoch} · ${enrollment.currentHostEpoch === null ? "Host identity not issued" : `host epoch ${enrollment.currentHostEpoch}`} · expires ${formatDate(enrollment.expiresAt)}`;
    pending.append(details);
    const withdraw = document.createElement("button");
    withdraw.type = "button";
    withdraw.className = "button button-danger button-small session-revoke";
    withdraw.textContent = "Withdraw setup";
    withdraw.setAttribute("aria-label", `Withdraw approved setup for host ${host.hostId}`);
    withdraw.disabled = !hostInventoryFresh || unknownEnrollmentIds.has(enrollment.enrollmentId);
    withdraw.addEventListener("click", () => openConfirm({ kind: "host-enrollment", host, enrollment }));
    pending.append(withdraw);
    info.append(pending);
  }

  item.append(info);
  if (host.revocable) {
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "button button-danger button-small session-revoke";
    revoke.textContent = "Revoke host";
    revoke.setAttribute("aria-label", `Revoke host authorization for ${host.hostId}`);
    revoke.disabled = !hostInventoryFresh || unknownHostIds.has(host.hostId);
    revoke.addEventListener("click", () => openConfirm({ kind: "host", host }));
    item.append(revoke);
  }
  return item;
}

function renderHosts() {
  if (!hostsList) return;
  hostsList.replaceChildren(...currentHosts.map(createHostItem));
  if (hostsEmpty) hostsEmpty.hidden = currentHosts.length !== 0;
}

function apiErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) return String(error.code);
  return null;
}

function apiErrorStatus(error: unknown): number | null {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") return error.status;
  return null;
}

function apiErrorEffect(error: unknown): "none" | "unknown" | null {
  if (typeof error !== "object" || error === null || !("effect" in error)) return null;
  return error.effect === "none" || error.effect === "unknown" ? error.effect : null;
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
  if (profileInitials) profileInitials.textContent = initials(name);
  const image = validateAccountImage(me.user.image);
  if (profileImage && image) {
    profileImage.onload = () => {
      profileImage.hidden = false;
      if (profileInitials) profileInitials.hidden = true;
    };
    profileImage.onerror = () => {
      profileImage.hidden = true;
      if (profileInitials) profileInitials.hidden = false;
    };
    profileImage.src = image;
  }
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

function redirectForHostAuthError(error: unknown): boolean {
  const code = apiErrorCode(error);
  if (code !== "SESSION_REQUIRED" && code !== "AUTH_REQUIRED") return false;
  window.location.replace(buildLoginUrl("/account"));
  return true;
}

async function loadHostPage(cursor: string | null = null, clearUnknown = false) {
  if (!hostsList) return;
  hostInventoryFresh = false;
  if (refreshHostsButton) refreshHostsButton.disabled = true;
  if (loadMoreHostsButton) loadMoreHostsButton.disabled = true;
  if (firstHostsPageButton) firstHostsPageButton.disabled = true;
  showHostStatus(cursor ? "Loading the next page of Remote hosts…" : "Loading Remote hosts…");

  try {
    const query = cursor ? `?${new URLSearchParams({ cursor }).toString()}` : "";
    const raw = await apiRequest<unknown>(`/v2/remote/hosts${query}`, { signal: AbortSignal.timeout(8000) });
    const result = parseHostInventory(raw);
    if (clearUnknown) {
      unknownHostIds.clear();
      unknownEnrollmentIds.clear();
    }
    currentHostCursor = cursor;
    nextHostCursor = result.nextCursor;
    currentHosts = result.hosts;
    hostInventoryFresh = true;
    renderHosts();
    if (loadMoreHostsButton) loadMoreHostsButton.hidden = nextHostCursor === null;
    if (firstHostsPageButton) firstHostsPageButton.hidden = currentHostCursor === null;
    if (currentHosts.length === 0 && currentHostCursor === null) {
      showHostStatus("No Remote hosts are associated with this account.", "success");
    } else {
      showHostStatus(`Showing ${currentHosts.length} Remote ${currentHosts.length === 1 ? "host" : "hosts"}${nextHostCursor ? " · more hosts are available" : ""}.`, "success");
    }
  } catch (error) {
    hostInventoryFresh = false;
    renderHosts();
    const friendly = userFacingError(error);
    showHostStatus(friendly.message, "danger");
    if (redirectForHostAuthError(error)) return;
  } finally {
    if (refreshHostsButton) refreshHostsButton.disabled = false;
    if (loadMoreHostsButton) loadMoreHostsButton.disabled = false;
    if (firstHostsPageButton) firstHostsPageButton.disabled = false;
  }
}

async function getHostSnapshot(hostId: string): Promise<AccountHost | null> {
  const raw = await apiRequest<unknown>(`/v2/remote/hosts?hostId=${encodeURIComponent(hostId)}`, { signal: AbortSignal.timeout(8000) });
  const inventory = parseHostInventory(raw);
  if (inventory.nextCursor !== null || inventory.hosts.length > 1 ||
    (inventory.hosts.length === 1 && inventory.hosts[0]!.hostId !== hostId)) throw new Error("INVALID_HOST_INVENTORY");
  return inventory.hosts[0] ?? null;
}

async function getHostEnrollmentSnapshot(enrollmentId: string): Promise<PendingHostEnrollment & { revoked: boolean; consumed: boolean; hostId: string } | null> {
  const raw = await apiRequest<unknown>(`/v2/remote/enrollments/${encodeURIComponent(enrollmentId)}`, { signal: AbortSignal.timeout(8000) });
  if (!validEnrollmentSnapshot(raw)) throw new Error("INVALID_HOST_ENROLLMENT_SNAPSHOT");
  return raw;
}

function matchesEnrollmentSnapshot(
  snapshot: PendingHostEnrollment & { revoked: boolean; consumed: boolean; hostId: string },
  host: AccountHost,
  enrollment: PendingHostEnrollment,
  requireCapturedHostEpoch: boolean,
): boolean {
  return snapshot.enrollmentId === enrollment.enrollmentId && snapshot.hostId === host.hostId &&
    snapshot.approvedAccountEpoch === enrollment.approvedAccountEpoch && snapshot.fingerprint === enrollment.fingerprint &&
    (!requireCapturedHostEpoch || snapshot.currentHostEpoch === enrollment.currentHostEpoch);
}

async function performHostEnrollmentRevoke(host: AccountHost, enrollment: PendingHostEnrollment) {
  const currentHost = currentHosts.find(item => item.hostId === host.hostId);
  const currentEnrollment = currentHost?.pendingEnrollments.find(item => item.enrollmentId === enrollment.enrollmentId);
  if (!hostInventoryFresh || !currentHost || !currentEnrollment ||
    currentEnrollment.approvedAccountEpoch !== enrollment.approvedAccountEpoch ||
    currentEnrollment.fingerprint !== enrollment.fingerprint ||
    currentEnrollment.currentHostEpoch !== enrollment.currentHostEpoch ||
    unknownEnrollmentIds.has(enrollment.enrollmentId)) {
    if (confirmDialog?.open) confirmDialog.close();
    showHostStatus("Refresh the Remote host list before withdrawing this setup.", "warning");
    return;
  }

  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.setAttribute("aria-busy", "true");
  }
  let revokeSent = false;
  showHostStatus("Preparing account authorization for this confirmed action…");
  try {
    const prepared = await apiRequest<unknown>("/v2/remote/consumer-authorizations", {
      method: "POST",
      body: {},
      signal: AbortSignal.timeout(10000),
    });
    if (!validManagementAuthority(prepared)) throw new Error("INVALID_MANAGEMENT_AUTHORITY");

    revokeSent = true;
    const result = await apiRequest<unknown>(`/v2/remote/enrollments/${encodeURIComponent(enrollment.enrollmentId)}/revoke`, {
      method: "POST",
      body: {
        hostId: host.hostId,
        approvedAccountEpoch: enrollment.approvedAccountEpoch,
        fingerprint: enrollment.fingerprint,
        expectedHostAccessEpoch: enrollment.currentHostEpoch,
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!validEnrollmentSnapshot(result) || !result.revoked || result.consumed ||
      !matchesEnrollmentSnapshot(result, host, enrollment, true)) throw new Error("INVALID_HOST_ENROLLMENT_REVOKE_RESPONSE");
    if (confirmDialog?.open) confirmDialog.close();
    await loadHostPage(currentHostCursor);
    showHostStatus(`Approved setup ${enrollment.enrollmentId} for host ${host.hostId} was withdrawn. Existing host access and local data were not changed.`, "success");
  } catch (error) {
    if (revokeSent) {
      if (apiErrorEffect(error) === "none" || [400, 401, 403, 404].includes(apiErrorStatus(error) ?? 0)) {
        if (confirmDialog?.open) confirmDialog.close();
        await loadHostPage(currentHostCursor);
        const friendly = userFacingError(error);
        showHostStatus(`The approved setup was not withdrawn. ${friendly.message}`, "danger");
        return;
      }
      let confirmed = false;
      try {
        const snapshot = await getHostEnrollmentSnapshot(enrollment.enrollmentId);
        confirmed = !!snapshot && matchesEnrollmentSnapshot(snapshot, host, enrollment, false) &&
          snapshot.revoked && !snapshot.consumed;
      } catch {
        confirmed = false;
      }
      if (confirmDialog?.open) confirmDialog.close();
      if (confirmed) {
        await loadHostPage(currentHostCursor);
        showHostStatus(`Approved setup ${enrollment.enrollmentId} was withdrawn and confirmed from its exact enrollment record.`, "success");
      } else {
        hostInventoryFresh = false;
        unknownEnrollmentIds.add(enrollment.enrollmentId);
        renderHosts();
        showHostStatus("The setup withdrawal result is unknown. No withdrawal was retried. Refresh the current host inventory before taking another action.", "warning");
      }
      return;
    }

    if (confirmDialog?.open) confirmDialog.close();
    if (redirectForHostAuthError(error)) return;
    const friendly = userFacingError(error);
    showHostStatus(`The approved setup was not withdrawn. ${friendly.message}`, "danger");
  } finally {
    if (confirmButton) {
      confirmButton.disabled = false;
      confirmButton.removeAttribute("aria-busy");
    }
  }
}

function validManagementAuthority(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return Object.keys(result).sort().join(",") === "accountId,accountSessionId,canManageAccount,class,consumerAuthorizationId,expiresAt" &&
    typeof result.accountId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result.accountId) &&
    typeof result.consumerAuthorizationId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(result.consumerAuthorizationId) &&
    typeof result.accountSessionId === "string" && result.accountSessionId.length > 0 && result.accountSessionId.length <= 128 &&
    result.class === "web" && result.canManageAccount === true && typeof result.expiresAt === "string" &&
    /^\d{10}$/.test(result.expiresAt) && Number(result.expiresAt) > Math.floor(Date.now() / 1000);
}

function validHostRevokeResult(value: unknown, host: AccountHost, expectedNextEpoch: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return Object.keys(result).sort().join(",") === "hostAccessEpoch,hostId" &&
    result.hostId === host.hostId && result.hostAccessEpoch === expectedNextEpoch;
}

function confirmsHostRevoke(before: AccountHost, after: AccountHost | null, expectedEpoch: bigint): boolean {
  if (!after || !before.authorization || !before.authorization.current || after.hostId !== before.hostId ||
    after.pendingEnrollments.length !== 0 || after.accessEpoch === null || !after.authorization ||
    after.authorization.id !== before.authorization.id || after.authorization.hostAccessEpoch !== before.authorization.hostAccessEpoch ||
    !after.authorization.revoked || after.authorization.current) return false;
  try {
    return BigInt(after.accessEpoch) > expectedEpoch;
  } catch {
    return false;
  }
}

async function performHostRevoke(host: AccountHost) {
  if (!host.revocable || !host.authorization || host.accessEpoch === null || !hostInventoryFresh) {
    if (confirmDialog?.open) confirmDialog.close();
    showHostStatus("Refresh the Remote host list before revoking this authorization.", "warning");
    return;
  }

  if (confirmButton) {
    confirmButton.disabled = true;
    confirmButton.setAttribute("aria-busy", "true");
  }
  let revokeSent = false;
  const expectedEpoch = BigInt(host.accessEpoch);
  const expectedNextEpoch = (expectedEpoch + 1n).toString();
  showHostStatus("Preparing account authorization for this confirmed action…");
  try {
    const prepared = await apiRequest<unknown>("/v2/remote/consumer-authorizations", {
      method: "POST",
      body: {},
      signal: AbortSignal.timeout(10000),
    });
    if (!validManagementAuthority(prepared)) throw new Error("INVALID_MANAGEMENT_AUTHORITY");

    revokeSent = true;
    const result = await apiRequest<unknown>(`/v2/remote/hosts/${encodeURIComponent(host.hostId)}/revoke`, {
      method: "POST",
      body: { expectedHostAccessEpoch: host.accessEpoch },
      signal: AbortSignal.timeout(10000),
    });
    if (!validHostRevokeResult(result, host, expectedNextEpoch)) throw new Error("INVALID_HOST_REVOKE_RESPONSE");
    if (confirmDialog?.open) confirmDialog.close();
    await loadHostPage(currentHostCursor);
    showHostStatus(`Remote authorization for host ${host.hostId} was revoked. Its projects and files were not deleted.`, "success");
  } catch (error) {
    if (revokeSent) {
      if ([400, 401, 403, 404].includes(apiErrorStatus(error) ?? 0)) {
        if (confirmDialog?.open) confirmDialog.close();
        await loadHostPage(currentHostCursor);
        const friendly = userFacingError(error);
        showHostStatus(`The host authorization was not revoked. ${friendly.message}`, "danger");
        return;
      }
      let confirmed = false;
      try {
        const current = await getHostSnapshot(host.hostId);
        confirmed = confirmsHostRevoke(host, current, expectedEpoch);
      } catch {
        confirmed = false;
      }
      if (confirmDialog?.open) confirmDialog.close();
      if (confirmed) {
        await loadHostPage(currentHostCursor);
        showHostStatus(`Remote authorization for host ${host.hostId} was revoked and confirmed from the current account inventory.`, "success");
      } else {
        hostInventoryFresh = false;
        unknownHostIds.add(host.hostId);
        renderHosts();
        showHostStatus("The revoke result is unknown. No revoke was retried. Refresh the current host inventory before taking another action.", "warning");
      }
      return;
    }

    if (confirmDialog?.open) confirmDialog.close();
    if (redirectForHostAuthError(error)) return;
    const friendly = userFacingError(error);
    showHostStatus(`The host authorization was not revoked. ${friendly.message}`, "danger");
  } finally {
    if (confirmButton) {
      confirmButton.disabled = false;
      confirmButton.removeAttribute("aria-busy");
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
  } else if (action.kind === "single") {
    confirmTitle.textContent = `Revoke ${action.label.toLowerCase()}?`;
    confirmCopy.textContent = "That session will no longer be able to access Lomi. This action can’t be undone.";
    confirmButton.textContent = "Revoke session";
  } else if (action.kind === "host") {
    confirmTitle.textContent = "Revoke this host authorization?";
    confirmCopy.textContent = `This blocks Remote access for host ${action.host.hostId}. It does not delete the host’s projects, files, or local data. Reconnecting this host may require a new enrollment.`;
    confirmButton.textContent = "Revoke host authorization";
  } else {
    confirmTitle.textContent = "Withdraw this approved setup?";
    confirmCopy.textContent = `This withdraws enrollment ${action.enrollment.enrollmentId} for host ${action.host.hostId}. It does not revoke any existing host authorization or delete projects, files, or local data.`;
    confirmButton.textContent = "Withdraw setup";
  }
  if (typeof confirmDialog.showModal === "function") confirmDialog.showModal();
  else if (window.confirm(confirmCopy.textContent)) void performAction(action);
}

async function performAction(action: SessionAction) {
  if (action.kind === "host") {
    await performHostRevoke(action.host);
    return;
  }
  if (action.kind === "host-enrollment") {
    await performHostEnrollmentRevoke(action.host, action.enrollment);
    return;
  }
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
    void loadHostPage();
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
refreshHostsButton?.addEventListener("click", () => void loadHostPage(null, true));
loadMoreHostsButton?.addEventListener("click", () => {
  if (nextHostCursor) void loadHostPage(nextHostCursor);
});
firstHostsPageButton?.addEventListener("click", () => void loadHostPage(null));
revokeAllButton?.addEventListener("click", () => openConfirm({ kind: "all" }));
confirmButton?.addEventListener("click", () => {
  if (pendingAction) void performAction(pendingAction);
});
cancelButton?.addEventListener("click", () => confirmDialog?.close());
confirmDialog?.addEventListener("close", () => { pendingAction = null; });
reauthStartButton?.addEventListener("click", () => void startGithubReauth());
reauthContinueButton?.addEventListener("click", () => void continueReauthenticatedAction());

void loadAccount();
