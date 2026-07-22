/**
 * The Dashboard SPA — a single, dependency-free page so the vertical is clickable
 * in a browser without a separate build. Sign-in is an OIDC redirect to the
 * platform's AuthHero instance (`/api/auth/login`); then `/api/catalog`,
 * `/api/apps`. Vanilla JS on purpose; a real build (Vite) is a later step.
 */
export const PAGE = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Substrat Dashboard</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#666; --line:#e3e3e3; --accent:#D97708; --bg:#fafafa; --card:#fff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#eee; --muted:#999; --line:#333; --bg:#141414; --card:#1c1c1c; } }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--fg); background:var(--bg); }
  header { display:flex; align-items:center; justify-content:space-between; padding:14px 24px; border-bottom:1px solid var(--line); }
  header b { font-weight:650; } header .who { color:var(--muted); font-size:13px; }
  main { max-width:760px; margin:0 auto; padding:28px 24px 60px; }
  h2 { font-size:15px; margin:28px 0 12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:18px; }
  label { display:block; font-size:12px; color:var(--muted); margin:10px 0 4px; }
  input, select, button { font:inherit; }
  input, select { width:100%; padding:9px 11px; border:1px solid var(--line); border-radius:8px; background:transparent; color:var(--fg); }
  button { padding:9px 16px; border:0; border-radius:8px; background:var(--accent); color:#fff; font-weight:600; cursor:pointer; }
  button.link { background:none; color:var(--accent); padding:0; font-weight:500; }
  .row { display:flex; gap:10px; align-items:end; } .row > div { flex:1; }
  .app { display:flex; align-items:center; justify-content:space-between; padding:12px 0; border-bottom:1px solid var(--line); }
  .app:last-child { border-bottom:0; } .app .name { font-weight:600; } .app .meta { color:var(--muted); font-size:12px; }
  .pill { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--muted); }
  .pill.active { color:#1a7f37; border-color:#1a7f3733; }
  .empty { color:var(--muted); padding:16px 0; }
  .err { color:#c0392b; font-size:13px; min-height:18px; margin-top:8px; }
</style>
</head>
<body>
<header>
  <b>◆ Substrat Dashboard</b>
  <span style="display:flex; gap:14px; align-items:center;">
    <span class="who" id="who"></span>
    <button class="link" id="signout" hidden>Sign out</button>
  </span>
</header>
<main>
  <section id="auth" hidden>
    <h2>Sign in</h2>
    <div class="card">
      <p style="margin:0 0 14px; color:var(--muted);">Sign in with your Substrat account to create and manage apps.</p>
      <button id="signin">Sign in</button>
      <div class="err" id="authErr"></div>
    </div>
  </section>

  <section id="dash" hidden>
    <h2>Create an app</h2>
    <div class="card">
      <div class="row">
        <div><label>Vertical</label><select id="vertical"></select></div>
        <div><label>Name</label><input id="appName" placeholder="Onboarding" /></div>
        <button id="create">Create app</button>
      </div>
      <div class="err" id="createErr"></div>
    </div>
    <h2>Your apps</h2>
    <div class="card" id="apps"><div class="empty">Loading…</div></div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const api = (path, opts) => fetch(path, { headers: { 'content-type':'application/json' }, ...opts });

function show(el, on){ el.hidden = !on; }
function renderApps(list){
  const box = $('apps');
  if(!list.length){ box.innerHTML = '<div class="empty">No apps yet — create one above.</div>'; return; }
  box.innerHTML = list.map(a => \`<div class="app"><div><div class="name">\${a.name}</div>
    <div class="meta">\${a.vertical_slug} · \${a.app_scope_id}</div></div>
    <span class="pill \${a.status}">\${a.status}</span></div>\`).join('');
}

async function refresh(){
  const me = await api('/api/me');
  if(me.status !== 200){ show($('auth'), true); show($('dash'), false); show($('signout'), false); $('who').textContent=''; return; }
  const acct = await me.json();
  $('who').textContent = 'tenant ' + acct.tenant.slice(0,10) + '…';
  show($('auth'), false); show($('dash'), true); show($('signout'), true);
  const cats = await (await api('/api/catalog')).json();
  $('vertical').innerHTML = cats.map(c => \`<option value="\${c.slug}">\${c.name}</option>\`).join('');
  renderApps(await (await api('/api/apps')).json());
}

// Auth is an OIDC redirect to the platform's AuthHero instance — no password here.
$('signin').onclick = () => { location.href = '/api/auth/login'; };
$('signout').onclick = () => { location.href = '/api/auth/logout'; };
if(new URLSearchParams(location.search).get('error') === 'auth'){
  $('authErr').textContent = 'Sign-in did not complete. Please try again.';
}
$('create').onclick = async () => {
  $('createErr').textContent = '';
  const r = await api('/api/apps', { method:'POST', body: JSON.stringify({ verticalSlug: $('vertical').value, name: $('appName').value || 'Untitled' }) });
  if(!r.ok){ const e = await r.json().catch(()=>({})); $('createErr').textContent = e.error || 'Could not create app.'; return; }
  $('appName').value = '';
  renderApps(await (await api('/api/apps')).json());
};
refresh();
</script>
</body>
</html>`;
