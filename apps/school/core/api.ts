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
  /** A refused attendance save (409 CHANGED): who saved the newer version, and when. */
  changed?: { byId: number | null; by: string | null; at: string | null };
  constructor(message: string, status: number, extra: { code?: string; triesLeft?: number; retryAfter?: number; changed?: ApiError["changed"] } = {}) {
    super(message);
    this.status = status;
    this.code = extra.code;
    this.triesLeft = extra.triesLeft;
    this.retryAfter = extra.retryAfter;
    this.changed = extra.changed;
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
      changed: json?.code === "CHANGED" ? { byId: json.changedById ?? null, by: json.changedBy ?? null, at: json.changedAt ?? null } : undefined,
    });
  }
  return json as T;
}

/** A multipart form (files + fields) to the school; the same errors as call(). */
export async function callForm<T = any>(host: string, path: string, token: string, form: FormData): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `Bearer ${token}`, "X-App-Version": APP_VERSION, "X-App-Platform": PLATFORM };
  if (DEV_API) headers["X-Tenant-Slug"] = host.split(".")[0];
  let res: Response;
  // uploads get longer than other calls, but never hang for ever on a weak connection
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    // no Content-Type: fetch sets the multipart boundary itself
    res = await fetch(`${DEV_API ?? `https://${host}`}${path}`, { method: "POST", headers, body: form, signal: ctrl.signal });
  } catch {
    throw new ApiError("No internet connection. Please check and try again.", 0);
  } finally {
    clearTimeout(timer);
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json || json.success === false) {
    throw new ApiError((json && json.error) || "Something went wrong. Please try again.", res.status || 500, { code: json?.code });
  }
  return json as T;
}

// ---- Shapes, as the backend sends them (mobile-v1.md) ----

export type School = { code: string; name: string; city: string | null; logoUrl: string | null; host: string };

// Teachers: student attendance (Phase 2, FR-T02). Statuses are the website's: PRESENT, ABSENT, LATE;
// approved leave is ABSENT with the leave filled in.
export type AttendanceMark = "PRESENT" | "ABSENT" | "LATE";
export type StaffSection = {
  id: number;
  className: string;
  section: string;
  students: number;
  today: { present: number; absent: number; late: number; savedAt: string } | null;
};
export type RosterRow = {
  student_profile_id: number;
  first_name: string;
  last_name: string | null;
  admission_no: string | null;
  roll_number: string | number | null;
  status: AttendanceMark;
  remark: string | null;
  leave_application_id: number | null;
  leave_type_name: string | null;
};
export type Roster = {
  date: string;
  day_status: { status: "WORKING" | "HOLIDAY" | "CLOSED" | "OUT_OF_ACADEMIC_YEAR" | string; title?: string; remark?: string };
  session: { updated_at: string; marker_name: string | null } | null;
  lock_status: { is_locked: boolean; can_edit: boolean; lock_reason: string };
  roster: RosterRow[];
};
export type AttendanceSave = {
  section_id: number;
  attendance_date: string;
  based_on: string | null;
  records: { student_profile_id: number; status: AttendanceMark; remark?: string | null; leave_application_id?: number | null }[];
};

// Teachers: student leave requests (Phase 2, FR-T04), as the website lists and reviews them.
export type LeaveStatus = "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
export type StaffLeave = {
  id: number;
  status: LeaveStatus;
  first_name: string;
  last_name: string | null;
  admission_no: string | null;
  roll_number: string | number | null;
  class_name: string | null;
  section_name: string | null;
  leave_type_name: string | null;
  start_date: string;
  end_date: string;
  total_days: number | string;
  reason: string | null;
  applied_at: string | null;
  applied_by_name: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_remark: string | null;
  exceeds_quota: boolean | null;
  current_available_quota: number | string | null;
};
export type StaffLeaveDetail = StaffLeave & { documents: { id: number; file_name: string; mime_type: string | null; download_url: string | null }[] };

export type OtpLoginChoice = { id: number; name: string; role: "STUDENT" | "EMPLOYEE" | "ADMIN"; detail: string };
export type OtpLoginAnswer = { choose: true; token: string; accounts: OtpLoginChoice[] };

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

export type HomeworkRow = { id: number; date: string; subject: string | null; teacher: string | null; noHomework: boolean; preview: string; attachments: number };
export type Attachment = { id?: number; name?: string; file_name?: string; original_name?: string; mime_type?: string; url?: string | null; storage_key?: string };
export type HomeworkDetail = { id: number; for_date: string; subject_name: string | null; is_no_homework: boolean; content_html: string | null; attachments: Attachment[] };
export type NoticeRow = { id: number; title: string; priority: string; pinned: boolean; publishedAt: string; preview: string; attachments: number };
export type NoticeDetail = { id: number; title: string; content_html: string | null; priority: string; publish_at: string; creator_name: string | null; attachments: Attachment[] };
export type CalendarEvent = { id: number; title: string; type: string; color: string | null; start: string; end: string; startTime: string | null; endTime: string | null; preview: string; attachments: number };
export type InboxRow = { id: number; type: string; title: string; body: string | null; link: string | null; is_read: boolean; created_at: string };
export type Period = { slot_number: number; type: string; label: string | null; start_time: string | null; end_time: string | null; subject: string | null; teacher: string | null; is_swapped: boolean };
export type TimetableDay = { date: string; weekday: string; is_school_open: boolean; periods: Period[] };
export type ReportCard = { id: number; exam: string; code: string | null; version: number; publishedAt: string | null; seen: boolean; held: boolean };
export type LibraryMe = { member: { name: string } | null; rule: { max_books: number; loan_days: number } | null; counts: { open: number; overdue: number; pending_fine: number }; reservations: { open: number; ready: number } };
export type Loan = { id: number; title: string | null; authors: string | null; issued_on: string | null; due_on: string | null; status: string; is_overdue: boolean };
export type MyHostel = {
  has_allocation: boolean;
  allocation?: { hostel_name: string; hostel_address: string | null; block_name: string | null; room_number: string | null; floor: string | number | null; bed_label: string | null; is_ac: boolean | number | null };
  wardens?: { id: number; role: string | null; warden_name: string | null; mobile: string | null; block_name: string | null }[];
  roommates?: { bed_label: string | null; roommate_name: string | null; class_name: string | null; section_name: string | null }[];
};
export type AssignmentRow = { id: number; title: string; type: string; subject: string | null; dueDate: string | null; publishedAt: string | null; status: string; submission: { status: string; submittedAt: string | null } | null };
export type AssignmentDetail = {
  assignment: { id: number; title: string; content_html: string | null; subject_name: string | null; due_date_enabled: boolean; due_date: string | null; allow_late_submission: boolean; status: string; attachments: Attachment[]; max_marks: number | null };
  submission: { id: number; status: string; answer_title: string | null; answer_html: string | null; submitted_at: string | null; marks_obtained?: number | null; grade?: string | null; teacher_remark?: string | null; attachments?: Attachment[] } | null;
};
export type LeaveType = { id: number; name: string; code?: string; is_active?: number | boolean; requires_document?: boolean; min_days_for_document?: number | null };

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
  // Sign in with mobile OTP: a code to the number, then either a login or a list to choose from
  loginOtpRequest: (host: string, mobile: string) =>
    call<{ sentTo: string; expiresInMinutes: number }>(host, "/api/mobile/v1/auth/login-otp/request", { method: "POST", body: { mobile } }),
  loginOtpVerify: (host: string, mobile: string, otp: string, deviceName: string) =>
    call<LoginAnswer | OtpLoginAnswer>(host, "/api/mobile/v1/auth/login-otp/verify", {
      method: "POST",
      body: { mobile, otp, device: { platform: PLATFORM, appVersion: APP_VERSION, name: deviceName } },
    }),
  loginOtpChoose: (host: string, token: string, userId: number, deviceName: string) =>
    call<LoginAnswer>(host, "/api/mobile/v1/auth/login-otp/choose", {
      method: "POST",
      body: { token, userId, device: { platform: PLATFORM, appVersion: APP_VERSION, name: deviceName } },
    }),

  staffSections: (host: string, token: string) =>
    call<{ data: { date: string; sections: StaffSection[] } }>(host, "/api/mobile/v1/staff/attendance/sections", { token }).then((r) => r.data),
  staffRoster: (host: string, token: string, sectionId: number, date: string) =>
    call<{ data: Roster }>(host, "/api/mobile/v1/staff/attendance/roster", { token, query: { section_id: sectionId, date } }).then((r) => r.data),
  saveAttendance: (host: string, token: string, body: AttendanceSave) =>
    call(host, "/api/mobile/v1/staff/attendance", { method: "POST", token, body: { ...body, device_name: "TatvaOS School app" } }),

  staffLeaves: (host: string, token: string, status: LeaveStatus, page = 1) =>
    call<{ data: StaffLeave[]; pagination: { total: number; page: number; totalPages: number } }>(host, "/api/mobile/v1/staff/leave-applications", {
      token,
      query: { status, page, limit: 25 },
    }),
  staffLeave: (host: string, token: string, id: number) =>
    call<{ data: StaffLeaveDetail }>(host, `/api/mobile/v1/staff/leave-applications/${id}`, { token }).then((r) => r.data),
  reviewLeave: (host: string, token: string, id: number, status: "APPROVED" | "REJECTED", remark: string) =>
    call(host, `/api/mobile/v1/staff/leave-applications/${id}/review`, { method: "PATCH", token, body: { status, review_remark: remark.trim() || null } }),

  bootstrap: (host: string, token: string) => call<{ data: Bootstrap }>(host, "/api/mobile/v1/bootstrap", { token }).then((r) => r.data),
  attendance: (host: string, token: string, month: string) =>
    call<{ data: AttendanceMonth }>(host, "/api/mobile/v1/me/attendance", { token, query: { month } }).then((r) => r.data),
  leaves: (host: string, token: string) => call<{ data: Page<Leave> }>(host, "/api/mobile/v1/me/leaves", { token, query: { limit: 5 } }).then((r) => r.data),
  homework: (host: string, token: string) =>
    call<{ data: Page<{ id: number; date: string; subject: string | null; noHomework: boolean }> }>(host, "/api/mobile/v1/me/homework", { token, query: { limit: 20 } }).then((r) => r.data),
  fees: (host: string, token: string) => call<{ data: Fees }>(host, "/api/mobile/v1/me/fees", { token }).then((r) => r.data),
  receipts: (host: string, token: string, cursor?: string) =>
    call<{ data: Page<Receipt> }>(host, "/api/mobile/v1/me/receipts", { token, query: { limit: 20, cursor } }).then((r) => r.data),
  homeworkPage: (host: string, token: string, cursor?: string) =>
    call<{ data: Page<HomeworkRow> }>(host, "/api/mobile/v1/me/homework", { token, query: { limit: 20, cursor } }).then((r) => r.data),
  homeworkDetail: (host: string, token: string, id: number) =>
    call<{ data: HomeworkDetail }>(host, `/api/student/homework/${id}`, { token }).then((r) => r.data),
  noticesPage: (host: string, token: string, cursor?: string) =>
    call<{ data: Page<NoticeRow> }>(host, "/api/mobile/v1/me/notices", { token, query: { limit: 20, cursor } }).then((r) => r.data),
  noticeDetail: (host: string, token: string, id: number) =>
    call<{ data: NoticeDetail }>(host, `/api/my/announcements/${id}`, { token }).then((r) => r.data),
  calendar: (host: string, token: string, from: string, to: string) =>
    call<{ data: { items: CalendarEvent[] } | CalendarEvent[] }>(host, "/api/mobile/v1/me/calendar", { token, query: { from, to } }).then((r) =>
      Array.isArray(r.data) ? r.data : r.data.items,
    ),
  // before= (empty) asks for the first page in the app's paging mode
  inboxPage: (host: string, token: string, before?: number | null) =>
    call<{ data: InboxRow[]; next_before: number | null; unread_count: number }>(host, `/api/notifications?limit=20&before=${before ?? ""}`, { token }),
  markRead: (host: string, token: string, id: number) => call(host, `/api/notifications/${id}/read`, { method: "PATCH", token }),
  markAllRead: (host: string, token: string) => call(host, "/api/notifications/read-all", { method: "PATCH", token }),
  changePassword: (host: string, token: string, currentPassword: string, newPassword: string) =>
    call(host, "/api/auth/change-password", { method: "POST", token, body: { currentPassword, newPassword, confirmPassword: newPassword } }),
  otpRequest: (host: string, username: string) =>
    call<{ channel: "sms" | "email"; sentTo: string; expiresInMinutes: number }>(host, "/api/mobile/v1/auth/otp/request", { method: "POST", body: { username } }),
  otpVerify: (host: string, username: string, otp: string) =>
    call<{ resetToken: string }>(host, "/api/mobile/v1/auth/otp/verify", { method: "POST", body: { username, otp } }),
  otpReset: (host: string, resetToken: string, newPassword: string) =>
    call(host, "/api/mobile/v1/auth/otp/reset", { method: "POST", body: { resetToken, newPassword, confirmPassword: newPassword } }),
  leaveTypes: (host: string, token: string) =>
    call<{ data: LeaveType[] }>(host, "/api/attendance/leave-types", { token }).then((r) => r.data),
  applyLeave: (host: string, token: string, body: { leave_type_id: number; start_date: string; end_date: string; reason: string }, files: { uri: string; name: string; type: string }[] = []) => {
    if (!files.length) return call(host, "/api/attendance/leave-applications", { method: "POST", token, body });
    // with a note: JPG, PNG or PDF, 5 MB each, at most 5 (the website's leave rule)
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) form.append(k, String(v));
    for (const f of files) form.append("attachments", f as unknown as Blob);
    return callForm(host, "/api/attendance/leave-applications", token, form);
  },
  timetableDay: (host: string, token: string, date: string) =>
    call<{ data: TimetableDay }>(host, "/api/timetable/views/daily", { token, query: { date } }).then((r) => r.data),
  reportCards: (host: string, token: string) => call<{ data: ReportCard[] }>(host, "/api/exam-hub/my-report-cards", { token }).then((r) => r.data),
  reportCardUrl: (host: string, token: string, id: number) =>
    call<{ data: { url: string } }>(host, `/api/exam-hub/my-report-cards/${id}/file`, { token }).then((r) => r.data.url),
  libraryMe: (host: string, token: string) => call<{ data: LibraryMe }>(host, "/api/school/library/me", { token }).then((r) => r.data),
  libraryLoans: (host: string, token: string) =>
    call<{ data: { loans: Loan[] } }>(host, "/api/school/library/me/loans", { token, query: { limit: 50 } }).then((r) => r.data.loans),
  // Paying fees (B-08). The student and the date are the server's for a student login; fines are
  // the server's too. The receipt is shown only when the status call says "paid" (FR-S07).
  createOrder: (host: string, token: string, items: { student_fee_item_id: number; amount: number }[]) =>
    call<{ data: { order_id: string; amount: number; currency: string; key: string; student: { name: string; email: string | null; mobile_no: string | null } } }>(
      host, "/api/finance/payments/order", { method: "POST", token, body: { items } },
    ).then((r) => r.data),
  verifyPayment: (host: string, token: string, body: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
    call(host, "/api/finance/payments/verify", { method: "POST", token, body }),
  paymentStatus: (host: string, token: string, orderId: string) =>
    call<{ data: { status: "pending" | "confirming" | "paid" | "failed" | "refunded"; receipt: { id: number; receipt_no: string; total_amount: number } | null } }>(
      host, `/api/finance/payments/${encodeURIComponent(orderId)}/status`, { token },
    ).then((r) => r.data),
  assignmentsPage: (host: string, token: string, cursor?: string) =>
    call<{ data: Page<AssignmentRow> }>(host, "/api/mobile/v1/me/assignments", { token, query: { limit: 20, cursor } }).then((r) => r.data),
  assignmentDetail: (host: string, token: string, id: number) =>
    call<{ data: AssignmentDetail }>(host, `/api/student/assignments/${id}`, { token }).then((r) => r.data),
  submitAssignment: (host: string, token: string, id: number, answer: string, title: string, files: { uri: string; name: string; type: string }[]) => {
    const form = new FormData();
    form.append("answer_title", title);
    form.append("answer_html", answer);
    // React Native sends { uri, name, type } parts as files
    for (const f of files) form.append("files", f as unknown as Blob);
    return callForm(host, `/api/student/assignments/${id}/submit`, token, form);
  },
  myHostel: (host: string, token: string) => call<{ data: MyHostel }>(host, "/api/school/hostel/my-hostel", { token }).then((r) => r.data),
  registerDevice: (host: string, token: string, body: { expoPushToken: string; platform: string; appVersion: string; deviceName: string; language: string }) =>
    call(host, "/api/mobile/v1/devices", { method: "POST", token, body }),
  unreadCount: (host: string, token: string) =>
    call<{ data: { unread_count: number } }>(host, "/api/notifications/unread-count", { token }).then((r) => r.data?.unread_count ?? 0),
};

/** The address and headers to download a file that needs the sign-in token (receipt PDF). */
export function fileRequest(host: string, path: string, token: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "X-App-Version": APP_VERSION, "X-App-Platform": PLATFORM };
  if (DEV_API) headers["X-Tenant-Slug"] = host.split(".")[0];
  return { url: `${DEV_API ?? `https://${host}`}${path}`, headers };
}

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
  hostel: ["assets.hostel.view_hostel"],
} as const;

/** True when the login holds any of these feature keys (the web's permission check, for menus only). */
export function hasFeature(boot: Bootstrap | undefined, ...keys: string[]) {
  if (!boot) return false;
  for (const m of boot.permissions) for (const s of m.submodules) for (const f of s.features) if (keys.includes(f)) return true;
  return false;
}
