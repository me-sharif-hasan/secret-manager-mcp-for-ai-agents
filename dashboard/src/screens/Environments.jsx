import { useState } from 'react';
import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { Confirm, Dialog, Field, GUIDANCE, LEVELS, OutSelect, Row, Switch, Tag, guidanceLabel } from '../ui.jsx';

const EXPIRY = [['never', 'Never'], ['15', '15 min'], ['30', '30 min'], ['60', '60 min'], ['120', '2 hours']];
const HELP = {
  read_only: 'Told: only read, change nothing, ask first.',
  write: 'Told: may write, no destructive operations.',
  full: 'Told: may operate, ask before anything destructive.',
};

export default function Environments() {
  const { data, group, state, refresh, notify } = useApp();
  const [dlg, setDlg] = useState(null); // { type: 'new' | 'clone' | 'delete', env? }
  const envs = Object.keys(data.envs);

  const patch = (env, body) => api(`/groups/${group}/envs/${env}`, { method: 'PUT', body }).then(refresh).catch((e) => notify(e.message));
  const openShell = (env) =>
    api('/shell/open', { method: 'POST', body: { group, env } })
      .then((r) => notify(`Opened ${r.terminal} with ${env} loaded${env === 'prod' ? '. This open is logged.' : ''}`))
      .catch((e) => notify(e.message));

  return (
    <>
      <p className="muted">
        Group <b style={{ color: 'var(--on-surface)' }}>{group}</b>. Each environment keeps its own value for every key, and its own rules for what the agent may do.
      </p>
      <div className="grid3">
        {envs.map((e) => {
          const c = data.envs[e];
          const active = Boolean(state?.active?.[e]);
          const expiry = String(c.expiryMin ?? 'never');
          const expiryOptions = EXPIRY.some(([v]) => v === expiry) ? EXPIRY : [...EXPIRY, [expiry, `${expiry} min`]];
          return (
            <div className="card" key={e}>
              <div className="kv">
                <h3>{e}</h3>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {active && <Tag kind="ok">active for agent</Tag>}
                  <Tag>{data.vars.length} variables</Tag>
                </div>
              </div>

              <Row label="Default agent access" sub="For new variables">
                <OutSelect value={c.defaultAccess} options={LEVELS} label={`Default agent access in ${e}`} onChange={(v) => patch(e, { defaultAccess: v })} />
              </Row>
              <Row label="Agent may activate" sub={c.allow ? 'activate_env is allowed' : 'activate_env returns denied'}>
                <Switch checked={c.allow} label={`Allow agent to activate ${e}`} onChange={(v) => patch(e, { allow: v })} />
              </Row>
              <Row label="Approve each activation" sub="You click Approve each time" off={!c.allow}>
                <Switch checked={c.approval} disabled={!c.allow} label={`Approval required in ${e}`} onChange={(v) => patch(e, { approval: v })} />
              </Row>
              <Row label="Auto-expire" sub="Deactivates by itself" off={!c.allow}>
                <OutSelect value={expiry} options={expiryOptions} disabled={!c.allow} label={`Auto-expire in ${e}`} onChange={(v) => patch(e, { expiryMin: v === 'never' ? null : Number(v) })} />
              </Row>
              <Row label="Guidance for the agent" sub={HELP[c.guidance]}>
                <OutSelect value={c.guidance} options={GUIDANCE} label={`Guidance in ${e}`} onChange={(v) => patch(e, { guidance: v })} />
              </Row>
              <Row label="Enforce with command checks" sub={c.guidance === 'full' ? 'Full only advises' : c.enforce ? 'Mutating commands are blocked' : 'Advice only, nothing is blocked'} off={c.guidance === 'full'}>
                <Switch checked={c.enforce} disabled={c.guidance === 'full'} label={`Enforce guidance in ${e}`} onChange={(v) => patch(e, { enforce: v })} />
              </Row>
              <details className="told">
                <summary>Show what the agent is told ({guidanceLabel[c.guidance]})</summary>
                <p>{c.guidanceText}</p>
              </details>

              <div className="actions-row">
                <button className="btn filled icon" onClick={() => openShell(e)} disabled={state?.killed}>
                  <Icon name="terminal" />
                  Open shell
                </button>
                <button className="btn tonal icon" title="Clone to new environment" onClick={() => setDlg({ type: 'clone', env: e })}>
                  <Icon name="content_copy" />
                  Clone
                </button>
                <button className="btn text danger-text icon" disabled={envs.length <= 1} title={envs.length <= 1 ? 'A group needs at least one environment' : `Delete ${e}`} onClick={() => setDlg({ type: 'delete', env: e })}>
                  <Icon name="delete" />
                  Delete
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <button className="fab" onClick={() => setDlg({ type: 'new' })}>
        <Icon name="add" />
        New environment
      </button>

      {dlg && (dlg.type === 'new' || dlg.type === 'clone') && <NewEnvDialog cloneFrom={dlg.env || ''} envs={envs} onClose={() => setDlg(null)} />}
      {dlg?.type === 'delete' && (
        <Confirm
          danger
          icon="delete"
          title={`Delete environment ${dlg.env}?`}
          body={`This permanently removes every value stored for ${dlg.env} in group ${group}, and its access rules and settings. The other environments are not touched. It cannot be undone.`}
          confirmLabel="Delete environment"
          typeToConfirm={dlg.env}
          onCancel={() => setDlg(null)}
          onConfirm={() =>
            api(`/groups/${group}/envs/${dlg.env}`, { method: 'DELETE' })
              .then((r) => { notify(`Deleted ${dlg.env} (${r.removedValues} values removed)`); setDlg(null); refresh(); })
              .catch((err) => { notify(err.message); setDlg(null); })
          }
        />
      )}
    </>
  );
}

function NewEnvDialog({ cloneFrom, envs, onClose }) {
  const { group, refresh, notify } = useApp();
  const [name, setName] = useState('');
  const [from, setFrom] = useState(cloneFrom);
  const [err, setErr] = useState('');
  const go = async () => {
    const n = name.trim().toLowerCase();
    try {
      await api(`/groups/${group}/envs`, { method: 'POST', body: { name: n, cloneFrom: from || undefined } });
      notify(`Created ${n}. Agent activation is off until you enable it.`);
      onClose();
      refresh();
    } catch (e) {
      setErr(e.message);
    }
  };
  return (
    <Dialog
      title="New environment"
      onClose={onClose}
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Cancel
          </button>
          <button className="btn filled" onClick={go}>
            Create
          </button>
        </>
      }
    >
      <div onKeyDown={(e) => e.key === 'Enter' && go()}>
        <Field id="envname" label="Name" placeholder="staging" value={name} onChange={setName} autoFocus error={err} hint="Lowercase letters, numbers, hyphens" bg="var(--surface-low)" />
      </div>
      <div>
        <span className="sub" style={{ margin: '0 0 6px 4px' }}>
          Copy keys and access rules from (values are never copied)
        </span>
        <OutSelect wide value={from} label="Copy from" options={[['', 'Nothing (empty)'], ...envs]} onChange={setFrom} />
      </div>
    </Dialog>
  );
}
