export interface ApiErrorBody {
  error?: {
    code?: string;
    requestId?: string;
  };
  effect?: "none" | "unknown";
}

export interface ApiError extends Error {
  code: string;
  requestId: string | null;
  status: number | null;
  effect: "none" | "unknown" | null;
}

export interface CurrentUser {
  id: string;
  displayName: string;
  image?: string | null;
  email: string | null;
  githubLogin: string | null;
  status: "active" | "suspended" | "deleting" | string;
}

export interface CurrentSession {
  id: string;
  expiresAt: string;
}

export interface MeResponse {
  user: CurrentUser;
  session: CurrentSession;
  capabilities: string[];
}

export interface AccountSession {
  id: string;
  kind: "desktop" | "browser" | "unknown";
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface SessionListResponse {
  sessions: AccountSession[];
  nextCursor: string | null;
}

export type HostInventoryState = "enrollment-incomplete" | "revoked" | "expired" | "authorized";

export interface PendingHostEnrollment {
  enrollmentId: string;
  approvedAccountEpoch: string;
  fingerprint: string;
  expiresAt: string;
  currentHostEpoch: string | null;
}

export interface AccountHost {
  hostId: string;
  fingerprint: string;
  accessEpoch: string | null;
  finalized: boolean;
  authorization: {
    id: string;
    hostAccessEpoch: string;
    revoked: boolean;
    confirmed: boolean;
    expiresAt: string;
    current: boolean;
  } | null;
  pendingEnrollments: PendingHostEnrollment[];
  connectionStatus: "unknown";
  sharingStatus: "unknown";
  state: HostInventoryState;
  revocable: boolean;
}

export interface HostInventoryResponse {
  hosts: AccountHost[];
  nextCursor: string | null;
}

function makeApiError(code: string, status: number | null, requestId: string | null, effect: "none" | "unknown" | null = null): ApiError {
  const error = new Error(code) as ApiError;
  error.code = code;
  error.status = status;
  error.requestId = requestId;
  error.effect = effect;
  return error;
}

function parseErrorBody(value: unknown): ApiErrorBody {
  if (typeof value !== "object" || value === null) return {};
  const record = value as Record<string, unknown>;
  if ("error" in value) {
    const error = record.error;
    if (typeof error === "object" && error !== null) {
      const effect = record.effect === "none" || record.effect === "unknown" ? record.effect : undefined;
      return { error: error as ApiErrorBody["error"], ...(effect ? { effect } : {}) };
    }
  }
  if (typeof record.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(record.code)) {
    const effect = record.effect === "none" || record.effect === "unknown" ? record.effect : undefined;
    return { error: { code: record.code }, ...(effect ? { effect } : {}) };
  }
  return {};
}

export async function apiRequest<T>(
  path: string,
  options: { method?: "GET" | "POST" | "DELETE"; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (method !== "GET") {
    headers.set("X-Lomi-Request", "1");
  }
  if (method === "POST") {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers,
      body: method === "POST" ? JSON.stringify(options.body ?? {}) : undefined,
      signal: options.signal,
    });
  } catch {
    throw makeApiError("NETWORK_ERROR", null, null);
  }

  if (!response.ok) {
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? parseErrorBody(await response.json().catch(() => null))
      : {};
    throw makeApiError(body.error?.code ?? `HTTP_${response.status}`, response.status, body.error?.requestId ?? null, body.effect ?? null);
  }

  if (response.status === 204) return undefined as T;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return undefined as T;
  return (await response.json()) as T;
}

export function userFacingError(error: unknown): { message: string; requestId: string | null } {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return { message: "Something went wrong. Try again in a moment.", requestId: null };
  }
  const apiError = error as ApiError;
  const messages: Record<string, string> = {
    NETWORK_ERROR: "We couldn’t reach Lomi. Check your connection and try again.",
    SERVICE_UNAVAILABLE: "Lomi is temporarily unavailable. Try again shortly.",
    RATE_LIMITED: "Too many requests. Wait a moment, then try again.",
    RESOURCE_EXHAUSTED: "This host has too many pending setups to show at once. Withdraw individual setups and refresh the list.",
    SESSION_REQUIRED: "Your session has ended. Sign in to continue.",
    AUTH_REQUIRED: "Sign in again to manage Remote hosts.",
    ACCOUNT_SUSPENDED: "This Lomi account is currently unavailable.",
    FORBIDDEN: "You don’t have permission to do that.",
    SCOPE_DENIED: "You don’t have permission to do that.",
    INVALID_ARGUMENT: "The Remote host information changed. Refresh the list before continuing.",
    OUTCOME_UNKNOWN: "Lomi could not confirm the result. Check the current Remote host list before acting again.",
    STALE_STATE: "The pending setup changed before Lomi withdrew it. Refresh the host list before continuing.",
    NOT_FOUND: "That session could not be found. It may have already been removed.",
    VALIDATION_FAILED: "Check the information and try again.",
    REAUTH_REQUIRED: "Verify your GitHub account again to continue.",
    LOGIN_EXPIRED: "This sign-in request expired or was already used. Start sign-in again in Lomi.",
  };
  if (apiError.status !== null && apiError.status >= 500) {
    return { message: "Lomi is having trouble right now. Try again shortly.", requestId: apiError.requestId };
  }
  return {
    message: Object.prototype.hasOwnProperty.call(messages, apiError.code)
      ? messages[apiError.code]!
      : "We couldn’t complete that request. Try again in a moment.",
    requestId: apiError.requestId,
  };
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function initials(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "L";
  return parts.slice(0, 2).map((part) => Array.from(part)[0]?.toUpperCase() ?? "").join("");
}
