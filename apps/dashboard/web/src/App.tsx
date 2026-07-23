import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toast } from '@substrat-run/ui';
import { api, signOut, type AppRow, type CatalogEntry, type Me } from './lib/api';
import { DEV_MOCK, MOCK_APPS, MOCK_CATALOG, MOCK_ME } from './lib/mock';
import { verticalMeta } from './lib/demo';
import { DashShell, type Crumb, type NavKey } from './components/DashShell';
import { CommandPalette } from './components/CommandPalette';
import { NotificationsPopover } from './components/NotificationsPopover';
import { SignIn, Interstitial } from './views/SignIn';
import { Apps } from './views/Apps';
import { CreateApp } from './views/CreateApp';
import { AppDetail } from './views/AppDetail';
import { Team } from './views/Team';
import { Domains } from './views/Domains';
import { Integrations } from './views/Integrations';
import { Billing } from './views/Billing';
import { Analytics } from './views/Analytics';
import { Settings } from './views/Settings';

/** The hash route, parsed. `section` maps to the sidebar; `app`/`tab` drive detail. */
interface Route {
  section: NavKey | 'new';
  app?: string;
  tab?: string;
}

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '');
  const parts = h.split('/').filter(Boolean);
  if (parts[0] === 'apps' && parts[1] === 'new') return { section: 'new' };
  if (parts[0] === 'apps' && parts[1]) return { section: 'apps', app: parts[1], tab: parts[2] ?? 'overview' };
  const known: NavKey[] = ['overview', 'apps', 'domains', 'team', 'integrations', 'analytics', 'billing', 'settings'];
  const section = (known.includes(parts[0] as NavKey) ? parts[0] : 'overview') as NavKey;
  return { section };
}

function go(hash: string) {
  window.location.hash = hash;
}

/** Org label from the signed-in email domain (acme.com → "Acme"), else "Workspace". */
function orgFrom(email?: string | null): string {
  const domain = email?.split('@')[1]?.split('.')[0];
  return domain ? domain.charAt(0).toUpperCase() + domain.slice(1) : 'Workspace';
}

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const [apps, setApps] = useState<AppRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [route, setRoute] = useState<Route>(parseHash);
  const [dark, setDark] = useState(() => {
    // `?theme=dark|light` wins on load (handy for demos + screenshots); otherwise
    // the per-user preference persisted in localStorage.
    const forced = new URLSearchParams(window.location.search).get('theme');
    if (forced === 'dark' || forced === 'light') return forced === 'dark';
    return localStorage.getItem('substrat.dash.theme') === 'dark';
  });
  const [palette, setPalette] = useState(false);
  const [notifs, setNotifs] = useState(false);
  const [unread, setUnread] = useState(true);
  const [toast, setToast] = useState<{ status: 'success' | 'danger'; title: string; detail?: string }>();

  // Theme → data-theme on the root (every token flips; no per-theme overrides).
  useEffect(() => {
    document.documentElement.dataset['theme'] = dark ? 'dark' : 'light';
    localStorage.setItem('substrat.dash.theme', dark ? 'dark' : 'light');
  }, [dark]);

  // Hash routing.
  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // ⌘K opens the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const reloadApps = useCallback(async () => {
    if (DEV_MOCK) return;
    setApps(await api.listApps());
  }, []);

  // Session check → on sign-in, load apps + catalog. Dev-preview mode short-
  // circuits to the demo tenant so the UI renders without the OIDC round-trip.
  useEffect(() => {
    if (DEV_MOCK) {
      setMe(MOCK_ME);
      setApps(MOCK_APPS);
      setCatalog(MOCK_CATALOG);
      return;
    }
    let live = true;
    void api.me().then(async (m) => {
      if (!live) return;
      setMe(m);
      if (m) {
        const [a, c] = await Promise.all([api.listApps(), api.catalog()]);
        if (!live) return;
        setApps(a);
        setCatalog(c);
      }
    });
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(undefined), 4500);
    return () => clearTimeout(t);
  }, [toast]);

  const createApp = useCallback(
    async (input: { verticalSlug: string; name: string }) => {
      let name = input.name;
      if (DEV_MOCK) {
        const row: AppRow = { id: String(Date.now()), app_scope_id: `01J${Date.now()}`, vertical_slug: input.verticalSlug, name, status: 'provisioning', hostname: null, created_by: MOCK_ME.email!, created_at: new Date().toISOString() };
        setApps((a) => [row, ...a]);
      } else {
        const row = await api.createApp(input);
        name = row.name;
        await reloadApps();
      }
      go('#/apps');
      setToast({ status: 'success', title: `${name} is provisioning`, detail: 'It will appear in your grid as it comes up.' });
    },
    [reloadApps],
  );

  const deleteApp = useCallback(
    async (app: AppRow) => {
      try {
        if (DEV_MOCK) setApps((a) => a.filter((x) => x.id !== app.id));
        else {
          await api.deleteApp(app.id);
          await reloadApps();
        }
        go('#/apps');
        setToast({ status: 'success', title: `${app.name} deleted`, detail: 'Its hostname is offline; audit history is retained.' });
      } catch (e) {
        setToast({ status: 'danger', title: 'Delete failed', detail: e instanceof Error ? e.message : String(e) });
      }
    },
    [reloadApps],
  );

  const openApp = useMemo(() => (route.app ? apps.find((a) => a.app_scope_id === route.app) : undefined), [apps, route.app]);

  // Session mode: checking → interstitial; signed out → sign-in.
  if (me === undefined) return <Interstitial />;
  if (me === null) {
    const failed = new URLSearchParams(window.location.search).get('error') === 'auth';
    return <SignIn error={failed} />;
  }

  const org = orgFrom(me.email);
  const activeNav: NavKey = route.section === 'new' ? 'apps' : route.section;

  const crumbs: Crumb[] = [{ label: org, onClick: () => go('#/overview') }];
  if (route.section === 'apps' || route.section === 'new') crumbs.push({ label: 'Apps', onClick: () => go('#/apps') });
  if (route.section === 'new') crumbs.push({ label: 'New app' });
  if (route.section === 'apps' && openApp) crumbs.push({ label: openApp.name });
  if (['domains', 'team', 'integrations', 'analytics', 'billing', 'settings'].includes(route.section)) {
    crumbs.push({ label: route.section.charAt(0).toUpperCase() + route.section.slice(1) });
  }

  return (
    <DashShell
      active={activeNav}
      onNav={(k) => go(`#/${k}`)}
      org={org}
      userEmail={me.email ?? 'you@substrat.run'}
      userName={me.name ?? me.email?.split('@')[0] ?? 'Account'}
      crumbs={crumbs}
      unread={unread}
      onToggleTheme={() => setDark((d) => !d)}
      onOpenPalette={() => setPalette(true)}
      onOpenNotifications={() => { setNotifs(true); setUnread(false); }}
      onSignOut={signOut}
    >
      {route.section === 'new' ? (
        <CreateApp catalog={catalog} onCancel={() => go('#/apps')} onCreate={createApp} />
      ) : route.section === 'apps' && openApp ? (
        <AppDetail
          app={openApp}
          tab={route.tab ?? 'overview'}
          onTab={(t) => go(`#/apps/${openApp.app_scope_id}/${t}`)}
          onDeleted={() => void deleteApp(openApp)}
        />
      ) : route.section === 'apps' && route.app ? (
        <NotFound label="That app could not be found." onBack={() => go('#/apps')} />
      ) : route.section === 'overview' || route.section === 'apps' ? (
        <Apps apps={apps} onCreate={() => go('#/apps/new')} onOpen={(s) => go(`#/apps/${s}/overview`)} onRetry={(s) => setToast({ status: 'danger', title: 'Retry not wired yet', detail: s })} />
      ) : route.section === 'team' ? (
        <Team />
      ) : route.section === 'domains' ? (
        <Domains />
      ) : route.section === 'integrations' ? (
        <Integrations />
      ) : route.section === 'billing' ? (
        <Billing />
      ) : route.section === 'analytics' ? (
        <Analytics />
      ) : route.section === 'settings' ? (
        <Settings org={org} />
      ) : null}

      {palette && (
        <CommandPalette
          apps={apps.map((a) => {
            const m = verticalMeta(a.vertical_slug);
            return { name: a.name, accent: m.accent, status: a.status, host: a.hostname, onOpen: () => go(`#/apps/${a.app_scope_id}/overview`) };
          })}
          onClose={() => setPalette(false)}
          onAction={(label) => {
            if (label === 'Create app') go('#/apps/new');
            else if (label === 'Invite member') go('#/team');
            else if (label === 'Add domain') go('#/domains');
          }}
        />
      )}
      {notifs && <NotificationsPopover onClose={() => setNotifs(false)} onMarkRead={() => { setUnread(false); setNotifs(false); }} />}

      {toast && (
        <div style={{ position: 'fixed', right: 24, top: 72, zIndex: 60 }}>
          <Toast status={toast.status} title={toast.title} detail={toast.detail} />
        </div>
      )}
    </DashShell>
  );
}

function NotFound({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div style={{ padding: 48, textAlign: 'center', color: 'var(--text-tertiary)' }}>
      {label} <a href="#" onClick={(e) => { e.preventDefault(); onBack(); }}>Back to apps</a>
    </div>
  );
}
