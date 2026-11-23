import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, AuthError } from './api.js';
import { Ctx } from './ctx.jsx';
import { Icon } from './icons.jsx';
import { Confirm, Dialog, Field, OutSelect, cx } from './ui.jsx';
import Overview from './screens/Overview.jsx';
import Variables from './screens/Variables.jsx';
import ImportEnv from './screens/ImportEnv.jsx';
import Environments from './screens/Environments.jsx';
import AgentAccess from './screens/AgentAccess.jsx';
import ShellSync from './screens/ShellSync.jsx';
import Audit from './screens/Audit.jsx';

const SCREENS = [
  { id: 'overview', name: 'Overview', icon: 'dashboard', el: Overview },
  { id: 'variables', name: 'Variables', icon: 'key', el: Variables },
  { id: 'import', name: 'Import .env', icon: 'upload_file', el: ImportEnv },
  { id: 'envs', name: 'Environments', icon: 'layers', el: Environments },
  { id: 'access', name: 'Agent access', icon: 'smart_toy', el: AgentAccess },
  { id: 'shell', name: 'Shell sync', icon: 'terminal', el: ShellSync },
  { id: 'audit', name: 'Audit log', icon: 'history', el: Audit },
];

export default function App() {
  const [state, setState] = useState(null);
  const [locked, setLocked] = useState(false);
  const [fatal, setFatal] = useState(null);
  const [group, setGroupRaw] = useState(() => localStorage.getItem('sm-group'));
  const [data, setData] = useState(null);
  const [env, setEnv] = useState('dev');
  const [screen, setScreenRaw] = useState(() => {
    const saved = sessionStorage.getItem('sm-screen');
    return SCREENS.some((s) => s.id === saved) ? saved : 'overview';
  });
  const setScreen = useCallback((s) => {
    sessionStorage.setItem('sm-screen', s);
    setScreenRaw(s);
  }, []);
  const [snack, setSnack] = useState(null);
  const [killAsk, setKillAsk] = useState(false);
  const [groupDlg, setGroupDlg] = useState(false);

  const notify = useCallback((m) => {
    setSnack(m);
    clearTimeout(notify.t);
    notify.t = setTimeout(() => setSnack(null), 3500);
  }, []);
  const setGroup = (g) => {
    localStorage.setItem('sm-group', g);
    setGroupRaw(g);
  };
  const guard = useCallback((e) => (e instanceof AuthError ? setLocked(true) : setFatal(e.message)), []);

  const loadState = useCallback(async () => {
    try {
      const s = await api('/state');
      setState(s);
      setFatal(null);
      return s;
    } catch (e) {
      guard(e);
    }
  }, [guard]);

  const loadGroup = useCallback(
    async (name) => {
      if (!name) return setData(null);
      try {
        const d = await api(`/groups/${name}`);
        setData(d);
        setEnv((cur) => (d.envs[cur] ? cur : Object.keys(d.envs)[0]));
      } catch (e) {
        if (/does not exist/.test(e.message)) setGroupRaw(null);
        else guard(e);
      }
    },
    [guard],
  );

  const refresh = useCallback(async () => {
    const s = await loadState();
    const has = (n) => n && s?.groups.some((x) => x.name === n);
    const g = has(group) ? group : has(s?.defaultGroup) ? s.defaultGroup : s?.groups[0]?.name;
    if (g && g !== group) setGroup(g);
    await loadGroup(g);
    if (s && s.groups.length === 0) setGroupDlg(true);
  }, [group, loadState, loadGroup]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  const ctx = useMemo(() => ({ state, group, data, env, setEnv, refresh, notify, setScreen, guard }), [state, group, data, env, refresh, notify, guard, setScreen]);

  if (locked || !sessionStorage.getItem('secretmgr-token')) {
    return (
      <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 24 }}>
        <div className="card center" style={{ border: 0, background: 'transparent' }}>
          <div className="logo">
            <Icon name="lock" />
          </div>
          <h2>Dashboard locked</h2>
          <p className="muted">This page needs the one-time token from your terminal. Run the command below and open the link it prints.</p>
          <pre>secretmgr dashboard</pre>
        </div>
      </div>
    );
  }

  const killed = state?.killed;
  const current = SCREENS.find((s) => s.id === screen);
  const Screen = current.el;
  const activeEnvs = Object.keys(state?.active || {});

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <nav className="drawer" aria-label="Sections">
          <div className="brand">
            <span className="logo">
              <Icon name="shield" />
            </span>
            Secrets
          </div>
          <div className="field">
            <label htmlFor="grp">Group</label>
            <div className="row">
              <OutSelect id="grp" wide value={group && state?.groups.some((g) => g.name === group) ? group : ''} options={(state?.groups || []).map((g) => g.name)} onChange={setGroup} />
              <button className="iconbtn state" aria-label="New group" title="New group" onClick={() => setGroupDlg(true)}>
                <Icon name="add" />
              </button>
            </div>
          </div>
          {SCREENS.map((s) => (
            <button key={s.id} className="navitem state" aria-current={screen === s.id} onClick={() => setScreen(s.id)}>
              <Icon name={s.icon} />
              {s.name}
            </button>
          ))}
          <div className="grow" />
          <div className="agentcard">
            <b>
              <span className={cx('dot', killed && 'off')} />
              Agent {killed ? 'locked' : 'active'}
            </b>
            <span className="muted">{killed ? 'Kill switch is on' : activeEnvs.length ? `Active: ${activeEnvs.join(', ')}` : 'No environment active'}</span>
          </div>
          <span className="muted keys" style={{ fontSize: 12, padding: '4px 14px 0' }}>
            Keys in: {state?.keyBackend || '-'}
          </span>
        </nav>

        <div className="content">
          <header className="appbar">
            <h2>{current.name}</h2>
            {group && <span className="tag">{group}</span>}
            {killed ? (
              <button className="btn danger-filled icon" onClick={() => api('/kill', { method: 'POST', body: { on: false } }).then(() => { notify('Agent access restored'); refresh(); }).catch(guard)}>
                <Icon name="lock_open" />
                Restore access
              </button>
            ) : (
              <button className="btn danger icon" onClick={() => setKillAsk(true)}>
                <Icon name="power_settings_new" />
                Kill switch
              </button>
            )}
          </header>

          {killed && (
            <div className="banner">
              <Icon name="block" />
              <span className="t">
                <b>Kill switch is on.</b> Agent commands run with every variable unset and terminals clear theirs on the next prompt. The dashboard still works.
              </span>
            </div>
          )}
          {state?.approvals?.map((a) => (
            <div className="banner warn" key={a.id}>
              <Icon name="verified_user" />
              <span className="t">
                The agent is asking to activate <b>{a.env}</b> in group <b>{a.group}</b>.
              </span>
              <button className="btn text" onClick={() => api(`/approvals/${a.id}`, { method: 'POST', body: { approve: false } }).then(refresh).catch(guard)}>
                Deny
              </button>
              <button className="btn filled" onClick={() => api(`/approvals/${a.id}`, { method: 'POST', body: { approve: true } }).then(() => { notify(`Approved ${a.env}`); refresh(); }).catch(guard)}>
                Approve
              </button>
            </div>
          ))}
          {fatal && (
            <div className="banner">
              <span className="t">{fatal}</span>
              <button className="iconbtn" aria-label="Dismiss" onClick={() => setFatal(null)}>
                <Icon name="close" />
              </button>
            </div>
          )}

          <main className="screen">{data ? <Screen /> : <p className="empty">Create a group to get started.</p>}</main>
        </div>
      </div>

      {killAsk && (
        <Confirm
          danger
          icon="power_settings_new"
          title="Cut all agent access?"
          body="Every agent command will run with all secrets unset, active environments are cleared, and your terminals clear their variables on the next prompt. Your access policies stay as they are."
          confirmLabel="Kill switch"
          onCancel={() => setKillAsk(false)}
          onConfirm={() => {
            setKillAsk(false);
            api('/kill', { method: 'POST', body: { on: true } }).then(() => { notify('Kill switch on. Agent access cut.'); refresh(); }).catch(guard);
          }}
        />
      )}
      {groupDlg && (
        <NewGroupDialog
          first={state && state.groups.length === 0}
          onClose={() => setGroupDlg(false)}
          onCreated={(name) => {
            setGroup(name);
            setGroupDlg(false);
            notify(`Created group ${name} with dev, uat and prod`);
            refresh();
          }}
        />
      )}
      {snack && (
        <div className="snack" role="status">
          {snack}
        </div>
      )}
    </Ctx.Provider>
  );
}

function NewGroupDialog({ first, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const submit = async () => {
    const n = name.trim().toLowerCase().replace(/\s+/g, '-');
    try {
      await api('/groups', { method: 'POST', body: { name: n } });
      onCreated(n);
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <Dialog
      title={first ? 'Create your first group' : 'New group'}
      onClose={first ? undefined : onClose}
      actions={
        <>
          {!first && (
            <button className="btn text" onClick={onClose}>
              Cancel
            </button>
          )}
          <button className="btn filled" onClick={submit}>
            Create group
          </button>
        </>
      }
    >
      <p className="muted">A group is one project or stack. It starts with dev, uat and prod, each with its own values.</p>
      <div onKeyDown={(e) => e.key === 'Enter' && submit()}>
        <Field id="gname" label="Group name" placeholder="payments-service" value={name} onChange={setName} autoFocus error={err} hint="Lowercase letters, numbers and hyphens" bg="var(--surface-low)" />
      </div>
    </Dialog>
  );
}
