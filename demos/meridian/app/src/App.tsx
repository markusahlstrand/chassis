import { useEffect, useState } from 'react';
import { api, getPrincipal, setPrincipal, type CastMember } from './api';
import { useAppData, useManagerData, useAdminData } from './data';
import { icons } from './ui';
import { Expenses, Home, Me, TimeOff, TimesheetScreen, type FlowKind } from './screens';
import { LogTime, Onboarding, RequestLeave, SubmitExpense } from './flows';
import { Inbox, OnboardingView, Team, TeamCalendar, Timesheets } from './manage';
import { ADMIN_TABS, AdminLeaveTypes, AdminPayroll, AdminPeople, AdminProjects, AdminSetup, type AdminTab } from './admin';
import { SignIn } from './auth';

type WorkTab = 'home' | 'timeoff' | 'timesheet' | 'expenses' | 'me';
type ManageTab = 'inbox' | 'calendar' | 'timesheets' | 'onboarding' | 'team';
type Section = 'work' | 'manage' | 'admin';
type Theme = 'system' | 'light' | 'dark';

const WORK_TABS: { key: WorkTab; label: string; icon: keyof typeof icons }[] = [
  { key: 'home', label: 'Home', icon: 'home' },
  { key: 'timeoff', label: 'Time off', icon: 'timeoff' },
  { key: 'timesheet', label: 'Timesheet', icon: 'timesheet' },
  { key: 'expenses', label: 'Expenses', icon: 'expenses' },
  { key: 'me', label: 'Me', icon: 'me' },
];
const MANAGE_TABS: { key: ManageTab; label: string; icon: keyof typeof icons }[] = [
  { key: 'inbox', label: 'Inbox', icon: 'inbox' },
  { key: 'calendar', label: 'Team calendar', icon: 'timeoff' },
  { key: 'timesheets', label: 'Timesheets', icon: 'timesheet' },
  { key: 'onboarding', label: 'Onboarding', icon: 'me' },
  { key: 'team', label: 'Team', icon: 'people' },
];

function useIsDesktop(): boolean {
  const [d, setD] = useState(() => typeof window !== 'undefined' && window.matchMedia('(min-width: 900px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 900px)');
    const on = () => setD(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return d;
}

export default function App() {
  const [personaKey, setPersonaKey] = useState(getPrincipal());
  const [cast, setCast] = useState<CastMember[]>([]);
  const [theme, setTheme] = useState<Theme>((localStorage.getItem('meridian.theme') as Theme) ?? 'system');
  const [toast, setToast] = useState<string | null>(null);

  const { data: empData, loading, error, unauthorized, needsSetup, reload: reloadEmp } = useAppData(personaKey);
  const me = empData?.me ?? null;
  const hasMyWork = !!me?.employeeId;
  const canManage = me?.role === 'manager' || me?.role === 'hr-admin';
  const isAdmin = me?.role === 'hr-admin';
  const { data: mgrData, reload: reloadMgr } = useManagerData(personaKey, canManage);
  const { data: adminData, loading: adminLoading, error: adminError, reload: reloadAdmin } = useAdminData(personaKey, isAdmin);
  const isDesktop = useIsDesktop();

  const [section, setSection] = useState<Section>('work');
  const [workTab, setWorkTab] = useState<WorkTab>('home');
  const [manageTab, setManageTab] = useState<ManageTab>('inbox');
  const [adminTab, setAdminTab] = useState<AdminTab>('setup');
  const [flow, setFlow] = useState<FlowKind | null>(null);

  // Land on the section this persona actually has. An HR admin (no own work) opens on
  // Admin — their setup home — rather than Manage; everyone else lands on their work.
  useEffect(() => {
    if (me) setSection(hasMyWork ? 'work' : isAdmin ? 'admin' : 'manage');
  }, [me?.key, hasMyWork, isAdmin]);

  useEffect(() => {
    api.cast().then(setCast).catch(() => setCast([]));
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    localStorage.setItem('meridian.theme', theme);
  }, [theme]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(t);
  }, [toast]);

  const reloadAll = () => {
    reloadEmp();
    reloadMgr();
    reloadAdmin();
  };
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') reloadAll();
    };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onVisible);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reloadEmp, reloadMgr]);

  function switchPersona(key: string) {
    setPrincipal(key);
    setPersonaKey(key);
    setFlow(null);
    setWorkTab('home');
    setManageTab('inbox');
    setAdminTab('setup');
  }
  function done(msg: string) {
    setFlow(null);
    setToast(msg);
    reloadAll();
  }
  const mgrActions = {
    onDecideLeave: async (id: string, decision: 'approve' | 'reject', note?: string) => {
      await api.decideLeave(id, decision, note);
      setToast(decision === 'approve' ? 'Approved' : 'Declined');
      reloadAll();
    },
    onDecideExpense: async (id: string, decision: 'approve' | 'reject') => {
      await api.decideExpense(id, decision);
      setToast(decision === 'approve' ? 'Approved' : 'Declined');
      reloadAll();
    },
  };

  const pendingCount = mgrData
    ? mgrData.requests.filter((r) => r.status === 'requested').length + mgrData.expenses.filter((e) => e.status === 'submitted').length
    : 0;

  // -- view rendering ---------------------------------------------------------

  function workView() {
    if (!empData) return <Centered>Loading…</Centered>;
    switch (workTab) {
      case 'home': return <Home d={empData} openFlow={setFlow} />;
      case 'timeoff': return <TimeOff d={empData} openFlow={setFlow} />;
      case 'timesheet': return <TimesheetScreen d={empData} openFlow={setFlow} />;
      case 'expenses': return <Expenses d={empData} openFlow={setFlow} />;
      case 'me': return <Me d={empData} theme={theme} onTheme={setTheme} onSwitch={() => switchPersona(nextEmployee(cast, personaKey))} />;
    }
  }
  function manageView() {
    if (!mgrData) return <Centered>Loading team…</Centered>;
    switch (manageTab) {
      case 'inbox': return <Inbox d={mgrData} {...mgrActions} />;
      case 'calendar': return <TeamCalendar d={mgrData} {...mgrActions} />;
      case 'timesheets': return <Timesheets d={mgrData} {...mgrActions} />;
      case 'onboarding': return <OnboardingView d={mgrData} {...mgrActions} />;
      case 'team': return <Team d={mgrData} {...mgrActions} />;
    }
  }
  function adminView() {
    if (adminError && !adminData) return <Centered>{adminError}</Centered>;
    if (!adminData) return <Centered>{adminLoading ? 'Loading…' : 'No access'}</Centered>;
    const props = {
      d: adminData,
      reload: reloadAll,
      toast: setToast,
      go: (t: AdminTab) => { setSection('admin'); setAdminTab(t); },
    };
    switch (adminTab) {
      case 'setup': return <AdminSetup {...props} />;
      case 'leavetypes': return <AdminLeaveTypes {...props} />;
      case 'people': return <AdminPeople {...props} />;
      case 'projects': return <AdminProjects {...props} />;
      case 'payroll': return <AdminPayroll {...props} />;
    }
  }
  const view = section === 'work' ? workView() : section === 'manage' ? manageView() : adminView();

  const flowEl =
    flow === 'request' ? <RequestLeave d={empData!} onClose={() => setFlow(null)} onDone={done} />
    : flow === 'log' ? <LogTime d={empData!} onClose={() => setFlow(null)} onDone={done} />
    : flow === 'expense' ? <SubmitExpense d={empData!} onClose={() => setFlow(null)} onDone={done} />
    : flow === 'onboarding' && empData?.onboarding ? <Onboarding d={empData} onClose={() => setFlow(null)} onDone={done} />
    : null;

  // Freshly-provisioned instance with no admin yet → first-run setup (create the admin
  // account, which claims the owner seat → hr-admin). Distinct from a plain sign-in.
  if (needsSetup) return <SignIn firstRun onDone={() => window.location.reload()} />;
  // No session (hosted instance, not signed in) → the sign-in/sign-up screen. On success
  // it reloads and /api/me resolves (the first sign-in claims the owner seat → hr-admin).
  if (unauthorized) return <SignIn onDone={() => window.location.reload()} />;
  if (loading && !empData) return <div className="phone"><Centered>Loading…</Centered></div>;
  if (error && !empData) return <div className="phone"><Centered>{error}</Centered></div>;
  if (me && !hasMyWork && !canManage) {
    return (
      <div className="phone">
        {cast.length > 0 && (
          <div className="persona-bar">
            <span>Signed in as</span>
            <select value={personaKey} onChange={(e) => switchPersona(e.target.value)}>
              {cast.map((c) => (<option key={c.key} value={c.key}>{c.display} · {c.role}</option>))}
            </select>
          </div>
        )}
        <Centered>
          <b>{me.display}</b> has no access here.
          {cast.length > 0 && <><br />Pick an employee (Elin), a team lead (Mats) or HR (Hedda).</>}
        </Centered>
      </div>
    );
  }

  // -- desktop: sidebar shell -------------------------------------------------

  if (isDesktop) {
    return (
      <div className="web">
        <aside className="sidebar">
          <div className="brand"><div className="brand-mark" /><div className="brand-name">Meridian</div></div>

          {hasMyWork && (
            <>
              <div className="nav-section">My work</div>
              {WORK_TABS.map((t) => (
                <button key={t.key} className={`nav-item${section === 'work' && workTab === t.key ? ' active' : ''}`} onClick={() => { setSection('work'); setWorkTab(t.key); }}>
                  {icons[t.icon]}<span>{t.label}</span>
                </button>
              ))}
            </>
          )}
          {canManage && (
            <>
              <div className="nav-section">Manage · {mgrData?.dept ?? ''}</div>
              {MANAGE_TABS.map((t) => (
                <button key={t.key} className={`nav-item${section === 'manage' && manageTab === t.key ? ' active' : ''}`} onClick={() => { setSection('manage'); setManageTab(t.key); }}>
                  {icons[t.icon]}<span>{t.label}</span>
                  {t.key === 'inbox' && pendingCount > 0 && <span className="nav-badge">{pendingCount}</span>}
                </button>
              ))}
            </>
          )}
          {isAdmin && (
            <>
              <div className="nav-section">Admin</div>
              {ADMIN_TABS.map((t) => (
                <button key={t.key} className={`nav-item${section === 'admin' && adminTab === t.key ? ' active' : ''}`} onClick={() => { setSection('admin'); setAdminTab(t.key); }}>
                  {icons[t.icon]}<span>{t.label}</span>
                </button>
              ))}
            </>
          )}

          <div className="nav-user">
            <button className="btn sm tint" onClick={reloadAll} style={{ height: 30 }}>↻ Refresh</button>
            {cast.length > 0 && (
              <select value={personaKey} onChange={(e) => switchPersona(e.target.value)}>
                {cast.map((c) => (<option key={c.key} value={c.key}>{c.display}</option>))}
              </select>
            )}
            <select value={theme} onChange={(e) => setTheme(e.target.value as Theme)}>
              <option value="system">Theme: system</option>
              <option value="light">Theme: light</option>
              <option value="dark">Theme: dark</option>
            </select>
          </div>
        </aside>

        <main className="content">
          <div className="scroll-inner">{view}</div>
        </main>

        {flowEl && (
          <div className="dialog-backdrop" onClick={() => setFlow(null)}>
            <div style={{ width: 440, maxWidth: '92vw', maxHeight: '88vh', background: 'var(--bg)', borderRadius: 20, overflow: 'hidden', display: 'flex', flexDirection: 'column' }} onClick={(e) => e.stopPropagation()}>
              {flowEl}
            </div>
          </div>
        )}
        {toast && <div className="toast">{toast}</div>}
      </div>
    );
  }

  // -- mobile: bottom tabs ----------------------------------------------------

  // The sections this persona actually has — the mobile segment switches between them.
  const sections: { key: Section; label: string }[] = [
    ...(hasMyWork ? [{ key: 'work' as const, label: 'My work' }] : []),
    ...(canManage ? [{ key: 'manage' as const, label: `Manage${pendingCount > 0 ? ` · ${pendingCount}` : ''}` }] : []),
    ...(isAdmin ? [{ key: 'admin' as const, label: 'Admin' }] : []),
  ];
  const tabs = section === 'work' ? WORK_TABS : section === 'manage' ? MANAGE_TABS : ADMIN_TABS;
  const activeKey = section === 'work' ? workTab : section === 'manage' ? manageTab : adminTab;
  const setTab = (k: string) =>
    section === 'work' ? setWorkTab(k as WorkTab) : section === 'manage' ? setManageTab(k as ManageTab) : setAdminTab(k as AdminTab);

  return (
    <div className="phone">
      {cast.length > 0 && (
        <div className="persona-bar">
          <span>Signed in as</span>
          <select value={personaKey} onChange={(e) => switchPersona(e.target.value)}>
            {cast.map((c) => (<option key={c.key} value={c.key}>{c.display} · {c.role}</option>))}
          </select>
        </div>
      )}

      {flowEl ? (
        flowEl
      ) : (
        <>
          {sections.length > 1 && (
            <div style={{ padding: '4px 18px 0' }}>
              <div className="segment">
                {sections.map((s) => (
                  <button key={s.key} className={section === s.key ? 'active' : ''} onClick={() => setSection(s.key)}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="scroll">{view}</div>
          <nav className="tabbar">
            {tabs.map((t) => (
              <button key={t.key} className={activeKey === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
                {icons[t.icon]}
                <span className="tab-lbl">{t.label}</span>
              </button>
            ))}
          </nav>
        </>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ flex: 1, display: 'grid', placeItems: 'center', textAlign: 'center', padding: 24, color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
      <div>{children}</div>
    </div>
  );
}

function nextEmployee(cast: CastMember[], current: string): string {
  const employees = cast.filter((c) => c.employeeId).map((c) => c.key);
  if (employees.length === 0) return current;
  const i = employees.indexOf(current);
  return employees[(i + 1) % employees.length] ?? current;
}
