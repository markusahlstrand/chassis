// Typed client over the PeopleCo dev server. The dev persona is carried in the
// `x-principal` header (localStorage-backed); in production this becomes a real
// session. Every call goes through /api/invoke — the kernel checks permissions
// inside each operation, so the generic transport is exactly as safe.

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const PRINCIPAL_KEY = 'peopleco.principal';
export const getPrincipal = (): string => localStorage.getItem(PRINCIPAL_KEY) ?? 'elin';
export const setPrincipal = (key: string): void => localStorage.setItem(PRINCIPAL_KEY, key);

function headers(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-principal': getPrincipal() };
}

async function invoke<T>(op: string, input?: unknown): Promise<T> {
  const res = await fetch('/api/invoke', {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ op, input }),
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `${res.status}`, res.status);
  return body;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers() });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new ApiError((body as { error?: string }).error ?? `${res.status}`, res.status);
  return body;
}

// -- shapes (subset the app renders) ----------------------------------------

export interface Me {
  key: string;
  display: string;
  role: string;
  country: 'SE' | 'ES';
  employeeId: string | null;
}
export interface CastMember {
  key: string;
  display: string;
  role: string;
  country: 'SE' | 'ES';
  employeeId: string | null;
}
export interface LeaveType {
  key: string;
  label: string;
  kind: string;
  annual_days: string | null;
}
export interface Balance {
  employeeId: string;
  balances: { leaveTypeKey: string; balance: string }[];
}
export interface LeaveRequest {
  id: string;
  employee_id: string;
  leave_type_key: string;
  start_date: string;
  end_date: string;
  days: string;
  status: 'requested' | 'approved' | 'rejected' | 'cancelled';
  created_at: string;
}
export interface TimeEntry {
  id: string;
  project_id: string | null;
  work_date: string;
  hours: string;
  note: string | null;
}
export interface Timesheet {
  employeeId: string;
  entries: TimeEntry[];
  totalHours: string;
}
export interface Expense {
  id: string;
  employee_id: string;
  description: string;
  amount: string;
  currency: string;
  category: string;
  status: 'submitted' | 'approved' | 'rejected' | 'exported';
  created_at: string;
}
export interface Project {
  id: string;
  code: string;
  name: string;
}
export interface OnboardingItem {
  key: string;
  label: string;
  type: string;
}
export interface OnboardingInstance {
  id: string;
  status: 'open' | 'signed' | 'voided';
  answered: number;
  total: number;
  items: { key: string; label: string; done: boolean }[];
}
export interface RosterMember {
  id: string;
  number: string;
  name: string;
  email: string | null;
  started_at: string | null;
}
export interface OnboardingSummary {
  instance: { id: string; status: 'open' | 'signed' | 'voided' };
  title: string;
  answered: number;
  total: number;
}

export const api = {
  me: () => get<Me>('/api/me'),
  cast: () => get<CastMember[]>('/api/cast'),

  leaveTypes: (employeeId?: string) => invoke<LeaveType[]>('hr/list-leave-types', employeeId ? { employeeId } : undefined),
  balance: (employeeId: string) => invoke<Balance>('hr/balance', { employeeId }),
  myRequests: (employeeId: string) => invoke<LeaveRequest[]>('hr/my-requests', { employeeId }),
  requestLeave: (input: {
    employeeId: string;
    leaveTypeKey: string;
    startDate: string;
    endDate: string;
    days: string;
    note?: string;
  }) => invoke<LeaveRequest>('hr/request-leave', input),

  projects: (employeeId: string) => invoke<Project[]>('hr/list-projects', { employeeId }),
  timesheet: (employeeId: string) => invoke<Timesheet>('hr/timesheet', { employeeId }),
  logTime: (input: { employeeId: string; projectId?: string; workDate: string; hours: string; note?: string }) =>
    invoke<TimeEntry>('hr/log-time', input),

  myExpenses: (employeeId: string) => invoke<Expense[]>('hr/my-expenses', { employeeId }),
  submitExpense: (input: {
    employeeId: string;
    description: string;
    amount: string;
    currency: string;
    category: string;
    projectId?: string;
  }) => invoke<Expense>('hr/submit-expense', input),

  // Onboarding is the protocol engine, reached through the employee's own-record
  // grant. The employee fills and e-signs their own.
  onboardingFor: (employeeId: string) =>
    invoke<
      { instance: { id: string; status: 'open' | 'signed' | 'voided' }; title: string; answered: number; total: number }[]
    >('protocol/list-for-entity', { entityType: 'employee', entityId: employeeId }),
  onboardingDetail: (instanceId: string) =>
    invoke<{
      instance: { id: string; status: string };
      template: { title: string; content: { sections: { title: string; items: OnboardingItem[] }[] } };
      latest: Record<string, unknown>;
    }>('protocol/get', { instanceId }),
  fillOnboarding: (instanceId: string, itemKey: string, value: boolean) =>
    invoke<unknown>('protocol/fill', { instanceId, itemKey, value }),
  signOnboarding: (instanceId: string) => invoke<unknown>('protocol/sign', { instanceId }),

  // -- manager / HR (the Manage section) --
  roster: () => invoke<RosterMember[]>('hr/roster'),
  requests: (status?: string) => invoke<LeaveRequest[]>('hr/list-requests', status ? { status } : undefined),
  allExpenses: (status?: string) => invoke<Expense[]>('hr/list-expenses', status ? { status } : undefined),
  onboardingSummaryFor: (employeeId: string) =>
    invoke<OnboardingSummary[]>('protocol/list-for-entity', { entityType: 'employee', entityId: employeeId }),
  decideLeave: (requestId: string, decision: 'approve' | 'reject', note?: string) =>
    invoke<unknown>('hr/decide-leave', { requestId, decision, ...(note ? { note } : {}) }),
  decideExpense: (expenseId: string, decision: 'approve' | 'reject') =>
    invoke<unknown>('hr/decide-expense', { expenseId, decision }),
};

/** Money/decimal formatting per country. */
export const fmtDays = (d: string): string =>
  Number(d).toLocaleString('en', { maximumFractionDigits: 2 });
export const fmtMoney = (amount: string, currency: string): string =>
  `${Number(amount).toLocaleString('en', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency}`;
