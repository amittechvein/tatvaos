// The one place the app talks to the TatvaOS school backend (TechveinERP, /api/mobile/v1 and the
// web calls listed in its backend/docs/api/mobile-v1.md).
//
// Every call after choosing a school goes to that school's own host, so the backend picks the
// school from the address and a token never works at another school (NF-09). The school search
// and code lookup are the only calls without a school; they go to DIRECTORY_HOST.

import { Platform } from "react-native";
import Constants from "expo-constants";

export const DIRECTORY_HOST = "tatvaos.org";
export const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";
export const PLATFORM = Platform.OS === "ios" ? "ios" : "android";

const TIMEOUT_MS = 20000;

// Development only: EXPO_PUBLIC_DEV_API (e.g. http://localhost:5055) sends every call to a
// backend running on the developer's PC, which picks the school from the X-Tenant-Slug header
// (its development mode) instead of the address. Store builds never have __DEV__, so they
// always use the school's own https address.
const DEV_API = __DEV__ ? process.env.EXPO_PUBLIC_DEV_API : undefined;
export const usingDevApi = !!DEV_API;

/** A refused or failed call. `code` is the backend's code (LOCKED, FEATURE_OFF, …) when it sent one. */
export class ApiError extends Error {
  status: number;
  code?: string;
  triesLeft?: number;
  retryAfter?: number;
  constructor(message: string, status: number, extra: { code?: string; triesLeft?: number; retryAfter?: number } = {}) {
    super(message);
    this.status = status;
    this.code = extra.code;
    this.triesLeft = extra.triesLeft;
    this.retryAfter = extra.retryAfter;
  }
  /** The token is missing, expired, ended or for another school: sign in again. */
  get signedOut() {
    return this.status === 401 && this.triesLeft === undefined;
  }
  get offline() {
    return this.status === 0;
  }
}

type Options = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  token?: string;
  query?: Record<string, string | number | undefined | null>;
};

export async function call<T = any>(host: string, path: string, opts: Options = {}): Promise<T> {
  const qs = opts.query
    ? Object.entries(opts.query)
        .filter(([, v]) => v !== undefined && v !== null && v !== "")
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
        .join("&")
    : "";
  const url = `${DEV_API ?? `https://${host}`}${path}${qs ? `?${qs}` : ""}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    "X-App-Version": APP_VERSION,
    "X-App-Platform": PLATFORM,
  };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (DEV_API && host !== DIRECTORY_HOST) headers["X-Tenant-Slug"] = host.split(".")[0];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
  } catch {
    // No connection, DNS failure or timeout. Status 0 tells the screens to show the offline copy.
    throw new ApiError("No internet connection. Please check and try again.", 0);
  } finally {
    clearTimeout(timer);
  }

  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // Not JSON: a proxy error page, or a host that is not a TatvaOS school.
  }
  if (!res.ok || !json || json.success === false) {
    const message =
      (json && typeof json.error === "string" && json.error) ||
      (res.status >= 500 ? "The school server is not answering. Please try again." : "Something went wrong. Please try again.");
    throw new ApiError(message, res.status || 500, {
      code: json?.code,
      triesLeft: typeof json?.triesLeft === "number" ? json.triesLeft : undefined,
      retryAfter: typeof json?.retryAfter === "number" ? json.retryAfter : undefined,
    });
  }
  return json as T;
}

// ---- Shapes, as the backend sends them (mobile-v1.md) ----

export type School = { code: string; name: string; city: string | null; logoUrl: string | null; host: string };

export type LoginAnswer = {
  token: string;
  expiresInDays: number;
  mustChangePassword: boolean;
  user: { id: number; name: string; username: string; role: "STUDENT" | "EMPLOYEE" | "ADMIN" };
  school: { slug: string; name: string };
};

export type Bootstrap = {
  user: { id: number; name: string; username: string; role: string; mustChangePassword: boolean };
  school: { slug: string; name: string; logoUrl: string | null; color: string | null; city: string | null; contact: { mobile: string | null; email: string | null } };
  // Not sent by every backend version yet; the screens work without it.
  student?: { id: number; name: string; className: string | null; section: string | null; admissionNo: string | null; photoUrl: string | null } | null;
  permissions: { slug: string; name: string; submodules: { slug: string; name: string; features: string[] }[] }[];
  app: { enabled: boolean; minVersion: string; updateRequired: boolean; pushEnabled: boolean; features: Record<string, boolean>; askAshu: boolean };
};

export type AttendanceMonth = {
  month: string;
  summary: {
    total_days: number;
    present_days: number;
    late_days: number;
    absent_days: number;
    approved_leave_days: number;
    excused_leave_days: number;
    attendance_percentage: number | string | null;
    adjusted_attendance_percentage: number | string | null;
  };
  days: { date: string; status: "PRESENT" | "ABSENT" | "LATE"; onLeave: boolean; leaveType: string | null }[];
};

export type Leave = { id: number; from: string; to: string; days: number; leaveType: string | null; reason: string | null; status: string; reviewRemark: string | null; appliedAt: string };

export type FeeItem = { id: number; name: string; group: string | null; dueDate: string | null; amount: number; discount: number; paid: number; fine: number; due: number; status: "paid" | "overdue" | "due_today" | "upcoming"; active: boolean };
export type Fees = { totals: { amount: number; discount: number; paid: number; fine: number; due: number }; dueNow: number; nextDueDate: string | null; items: FeeItem[] };
export type Receipt = { id: number; receiptNo: string; paidOn: string; amount: number; mode: string | null; online: boolean; reverted: boolean };
export type Page<T> = { items: T[]; next: string | null };

// ---- Calls ----

export const api = {
  searchSchools: (q: string) => call<{ data: School[] }>(DIRECTORY_HOST, "/api/mobile/v1/schools", { query: { q } }).then((r) => r.data),
  schoolByCode: (code: string) => call<{ data: School }>(DIRECTORY_HOST, "/api/mobile/v1/schools/by-code", { query: { code } }).then((r) => r.data),

  login: (host: string, username: string, password: string, deviceName: string) =>
    call<LoginAnswer>(host, "/api/mobile/v1/auth/login", {
      method: "POST",
      body: { username, password, device: { platform: PLATFORM, appVersion: APP_VERSION, name: deviceName } },
    }),
  logout: (host: string, token: string) => call(host, "/api/mobile/v1/auth/logout", { method: "POST", token }),

  bootstrap: (host: string, token: string) => call<{ data: Bootstrap }>(host, "/api/mobile/v1/bootstrap", { token }).then((r) => r.data),
  attendance: (host: string, token: string, month: string) =>
    call<{ data: AttendanceMonth }>(host, "/api/mobile/v1/me/attendance", { token, query: { month } }).then((r) => r.data),
  leaves: (host: string, token: string) => call<{ data: Page<Leave> }>(host, "/api/mobile/v1/me/leaves", { token, query: { limit: 5 } }).then((r) => r.data),
  homework: (host: string, token: string) =>
    call<{ data: Page<{ id: number; date: string; subject: string | null; noHomework: boolean }> }>(host, "/api/mobile/v1/me/homework", { token, query: { limit: 20 } }).then((r) => r.data),
  fees: (host: string, token: string) => call<{ data: Fees }>(host, "/api/mobile/v1/me/fees", { token }).then((r) => r.data),
  receipts: (host: string, token: string, cursor?: string) =>
    call<{ data: Page<Receipt> }>(host, "/api/mobile/v1/me/receipts", { token, query: { limit: 20, cursor } }).then((r) => r.data),
  unreadCount: (host: string, token: string) =>
    call<{ data: { unread_count: number } }>(host, "/api/notifications/unread-count", { token }).then((r) => r.data?.unread_count ?? 0),
};

/** Feature keys behind each student screen, as the backend checks them (studentScope.js PERM). */
export const FEATURES = {
  attendance: ["students.attendance.attendance_reports"],
  leave: ["students.attendance.leave_tracking"],
  homework: ["academics.assignments.homework"],
  assignments: ["academics.assignments.assignments"],
  notices: ["communication.collaboration.news_and_announcements"],
  calendar: ["communication.collaboration.view_calendar", "communication.collaboration.calendar_and_events"],
  // student defaults in TechveinERP school/constants/defaultPermissions.js
  timetable: ["academics.timetable.view_timetable"],
  results: ["academics.examination_hub.my_report_cards"],
  library: ["academics.library.search_books"],
} as const;

/** True when the login holds any of these feature keys (the web's permission check, for menus only). */
export function hasFeature(boot: Bootstrap | undefined, ...keys: string[]) {
  if (!boot) return false;
  for (const m of boot.permissions) for (const s of m.submodules) for (const f of s.features) if (keys.includes(f)) return true;
  return false;
}
