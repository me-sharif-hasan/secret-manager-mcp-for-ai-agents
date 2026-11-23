import { useEffect, useState } from 'react';
import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { OutSelect, Seg, Tag } from '../ui.jsx';

const SHELLS = ['bash', 'zsh', 'fish', 'pwsh', 'cmd'];
const RC = { bash: '~/.bashrc', zsh: '~/.zshrc', fish: '~/.config/fish/config.fish', pwsh: '$PROFILE', cmd: 'registry AutoRun' };

export default function ShellSync() {
  const { data, group, state, refresh, notify, guard } = useApp();
  const [shell, setShell] = useState('bash');
  const [snippet, setSnippet] = useState('');
  const envs = Object.keys(data.envs);
  const active = state?.active || {};
  const activeEnvs = Object.keys(active);

  useEffect(() => {
    api(`/shell/snippet?shell=${shell}`).then((r) => setSnippet(r.line)).catch(guard);
  }, [shell, guard]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      notify('Copied');
    } catch {
      notify('Select the text and copy it');
    }
  };

  const toggle = async (e) => {
    try {
      if (active[e]) await api('/agent/deactivate', { method: 'POST', body: { env: e } });
      else await api('/agent/activate', { method: 'POST', body: { group, env: e } });
      notify(active[e] ? `deactivate_env("${e}")` : `activate_env("${e}")`);
      refresh();
    } catch (err) {
      notify(err.message);
    }
  };

  const names = [];
  Object.entries(active).forEach(([e, a]) => {
    if (a.group !== group) return;
    data.vars.forEach((v) => {
      if (v.masked[e] && (v.access[e] ?? 'none') !== 'none') names.push(`${v.key}__${e.toUpperCase().replace(/[^A-Z0-9]/g, '_')}` + (a.primary ? ` · $${v.key}` : ''));
    });
  });

  return (
    <>
      <div className="kv">
        <Tag kind="ok" icon="sync">
          Hooks check the version file on every prompt
        </Tag>
        <button className="btn filled icon" onClick={() => api('/shell/install', { method: 'POST', body: {} }).then((r) => notify(`Installed for ${r.installed.map((x) => x.shell).join(', ') || 'no shells found'}`)).catch((e) => notify(e.message))}>
          <Icon name="bolt" />
          Install automatically
        </button>
      </div>

      <Seg items={SHELLS} value={shell} onChange={setShell} />

      <div className="card">
        <div className="kv">
          <h3>Manual setup for {RC[shell]}</h3>
          <button className="iconbtn state" aria-label="Copy" onClick={copy}>
            <Icon name="content_copy" />
          </button>
        </div>
        <pre>{snippet}</pre>
        <span className="muted">
          Skip this with <span className="mono">secretmgr install</span>, or use <span className="mono">secretmgr shell --env dev</span> for a one-off subshell. Then <span className="mono">secretmgr use uat</span> switches environment in that terminal.
        </span>
      </div>

      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Session</th>
              <th>Following</th>
              <th>Mode</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Your new terminals</td>
              <td>
                <OutSelect
                  value={envs.includes(state?.terminalDefaultEnv) ? state.terminalDefaultEnv : envs[0]}
                  options={envs}
                  label="Environment new terminals start on"
                  onChange={(v) => api('/terminal-default', { method: 'PUT', body: { env: v } }).then(() => { notify(`New terminals start on ${v}`); refresh(); }).catch((e) => notify(e.message))}
                />
              </td>
              <td>
                <Tag>every prompt</Tag>
              </td>
            </tr>
            <tr>
              <td>Claude Code (agent)</td>
              <td>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                  {envs.map((e) => (
                    <button key={e} className="step state" aria-current={Boolean(active[e])} title="Same as the agent calling activate_env / deactivate_env" onClick={() => toggle(e)}>
                      {active[e] && <Icon name="check" />}
                      {e}
                      {active[e]?.primary && activeEnvs.length > 1 ? ' ★' : ''}
                    </button>
                  ))}
                  {activeEnvs.length > 1 && (
                    <>
                      <span className="muted">primary</span>
                      <OutSelect value={activeEnvs.find((e) => active[e].primary) || activeEnvs[0]} options={activeEnvs} label="Primary environment" onChange={(v) => api('/agent/primary', { method: 'PUT', body: { env: v } }).then(refresh).catch((e) => notify(e.message))} />
                    </>
                  )}
                </div>
              </td>
              <td>
                <Tag kind="ok" icon="shield">
                  scoped load
                </Tag>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="kv">
          <h3>Variables in the agent shell right now</h3>
          <span className="muted">Names only. Values never leave the vault.</span>
        </div>
        {state?.killed ? (
          <Tag kind="bad">Kill switch is on. Nothing is loaded.</Tag>
        ) : names.length ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {names.map((n) => (
              <span className="tag mono" key={n}>
                {n}
              </span>
            ))}
          </div>
        ) : (
          <span className="muted">No environment is active. The agent calls activate_env to load one, or tap a chip above.</span>
        )}
      </div>
    </>
  );
}
