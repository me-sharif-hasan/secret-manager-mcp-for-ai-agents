import { useEffect, useRef, useState } from 'react';
import { useApp } from '../ctx.jsx';
import { api, ago } from '../api.js';
import { Icon } from '../icons.jsx';
import { AccSelect, Confirm, Dialog, Field, OutSelect, Seg, Tag, LEVELS, levelKind } from '../ui.jsx';

export default function Variables() {
  const { data, group, env, setEnv, refresh, notify, setScreen, state, guard } = useApp();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(null);
  const [revealed, setRevealed] = useState({});
  const [edit, setEdit] = useState(null);
  const [del, setDel] = useState(null);
  const timers = useRef({});
  const envs = Object.keys(data.envs);
  const rows = data.vars.filter((v) => !q || v.key.includes(q.toUpperCase()));
  const selected = data.vars.find((v) => v.key === sel);

  useEffect(() => () => Object.values(timers.current).forEach(clearTimeout), []);

  const reveal = async (key, e) => {
    const id = `${key}|${e}`;
    if (revealed[id] !== undefined) {
      clearTimeout(timers.current[id]);
      return setRevealed((r) => ({ ...r, [id]: undefined }));
    }
    try {
      const { value } = await api(`/groups/${group}/vars/${key}/reveal`, { method: 'POST', body: { env: e } });
      setRevealed((r) => ({ ...r, [id]: value }));
      timers.current[id] = setTimeout(() => setRevealed((r) => ({ ...r, [id]: undefined })), 10000);
    } catch (err) {
      notify(err.message);
    }
  };
  const setAccess = (key, e, level) => api(`/groups/${group}/vars/${key}/access`, { method: 'PUT', body: { env: e, level } }).then(refresh).catch((err) => notify(err.message));

  return (
    <>
      <div className="kv">
        <Seg items={envs} value={env} onChange={setEnv} dots />
        <div className="toolbar">
          <label className="search">
            <Icon name="search" />
            <input type="search" placeholder="Search variables" aria-label="Search variables" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <button className="btn outlined icon" onClick={() => setScreen('import')}>
            <Icon name="upload_file" />
            Import .env
          </button>
        </div>
      </div>

      <div className={selected ? 'cols' : ''}>
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Key</th>
                <th>Value in {env}</th>
                <th>Agent access</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((v) => {
                const id = `${v.key}|${env}`;
                const shown = revealed[id];
                return (
                  <tr key={v.key} className={'row' + (sel === v.key ? ' sel' : '')} onClick={() => setSel(v.key)}>
                    <td className="mono">{v.key}</td>
                    <td>
                      <span className="val">
                        <span className="mono" style={{ wordBreak: 'break-all' }}>
                          {shown !== undefined ? shown : v.masked[env] ?? 'not set'}
                        </span>
                        {v.masked[env] && (
                          <button className="eye state" aria-label={shown !== undefined ? 'Hide value' : 'Reveal value'} onClick={(e) => { e.stopPropagation(); reveal(v.key, env); }}>
                            <Icon name={shown !== undefined ? 'visibility_off' : 'visibility'} />
                          </button>
                        )}
                      </span>
                    </td>
                    <td>
                      <AccSelect value={v.access[env]} dead={state?.killed} label={`Agent access for ${v.key} in ${env}`} onChange={(l) => setAccess(v.key, env, l)} />
                    </td>
                    <td className="muted">{ago(v.updated)}</td>
                  </tr>
                );
              })}
              {!rows.length && (
                <tr>
                  <td colSpan={4} className="empty">
                    {data.vars.length ? 'No variable matches your search.' : 'No variables yet. Add one, or import a .env file.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {selected && (
          <div className="card">
            <div className="kv">
              <h3 className="mono">{selected.key}</h3>
              <button className="iconbtn state" aria-label="Close" onClick={() => setSel(null)}>
                <Icon name="close" />
              </button>
            </div>
            {envs.map((e) => (
              <div key={e}>
                <div className="kv" style={{ minHeight: 32 }}>
                  <span className="muted" style={{ fontWeight: 500 }}>
                    {e}
                  </span>
                  <Tag kind={levelKind(selected.access[e] ?? 'none')}>{selected.access[e] ?? 'none'}</Tag>
                </div>
                <div className="mono" style={{ wordBreak: 'break-all' }}>
                  {selected.masked[e] ?? 'not set'}
                </div>
              </div>
            ))}
            <span className="muted">Updated {ago(selected.updated)}</span>
            <div className="actions-row">
              <button className="btn outlined icon" onClick={() => setEdit({ key: selected.key })}>
                <Icon name="edit" />
                Edit values
              </button>
              <button className="btn text danger-text icon" onClick={() => setDel(selected.key)}>
                <Icon name="delete" />
                Delete
              </button>
            </div>
          </div>
        )}
      </div>

      <button className="fab" onClick={() => setEdit({ key: null })}>
        <Icon name="add" />
        Add variable
      </button>

      {edit && <EditDialog existing={edit.key ? data.vars.find((v) => v.key === edit.key) : null} onClose={() => setEdit(null)} />}
      {del && (
        <Confirm
          danger
          title={`Delete ${del}?`}
          body="This removes the variable and all of its values in every environment. It cannot be undone."
          confirmLabel="Delete"
          onCancel={() => setDel(null)}
          onConfirm={() =>
            api(`/groups/${group}/vars/${del}`, { method: 'DELETE' })
              .then(() => { notify(`Deleted ${del}`); setSel(null); setDel(null); refresh(); })
              .catch((e) => { setDel(null); guard(e); })
          }
        />
      )}
    </>
  );
}

function EditDialog({ existing, onClose }) {
  const { data, group, refresh, notify } = useApp();
  const envs = Object.keys(data.envs);
  const [key, setKey] = useState(existing?.key || '');
  const [vals, setVals] = useState({});
  const [clear, setClear] = useState({});
  const [acc, setAcc] = useState(() => Object.fromEntries(envs.map((e) => [e, existing?.access[e] ?? data.envs[e].defaultAccess])));
  const [err, setErr] = useState('');

  const save = async () => {
    const values = {};
    envs.forEach((e) => {
      if (clear[e]) values[e] = null;
      else if (vals[e]) values[e] = vals[e];
    });
    try {
      await api(`/groups/${group}/vars` + (existing ? `/${existing.key}` : ''), { method: existing ? 'PUT' : 'POST', body: { key, values, access: existing ? undefined : acc } });
      notify(existing ? `Updated ${key}` : `Added ${key}`);
      onClose();
      refresh();
    } catch (e) {
      setErr(e.message);
    }
  };

  return (
    <Dialog
      title={existing ? `Edit ${existing.key}` : 'Add variable'}
      onClose={onClose}
      wide
      actions={
        <>
          <button className="btn text" onClick={onClose}>
            Cancel
          </button>
          <button className="btn filled" onClick={save}>
            Save
          </button>
        </>
      }
    >
      {!existing && <Field id="vkey" label="Name" placeholder="DATABASE_URL" value={key} onChange={setKey} mono autoFocus error={err} hint="Letters, numbers and underscores" bg="var(--surface-low)" />}
      {existing && err && <p style={{ color: 'var(--error)' }}>{err}</p>}
      {envs.map((e) => (
        <div key={e} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 12, alignItems: 'start' }}>
          <Field
            id={`v-${e}`}
            label={`Value in ${e}`}
            type="password"
            mono
            bg="var(--surface-low)"
            placeholder={existing ? (existing.masked[e] ? 'unchanged' : 'not set') : 'not set'}
            value={clear[e] ? '' : vals[e] || ''}
            onChange={(v) => setVals({ ...vals, [e]: v })}
          />
          <div style={{ minHeight: 48, display: 'flex', alignItems: 'center' }}>
            {existing ? (
              existing.masked[e] ? (
                <button className={'btn text' + (clear[e] ? '' : ' danger-text')} onClick={() => setClear({ ...clear, [e]: !clear[e] })}>
                  {clear[e] ? 'Keep' : 'Clear'}
                </button>
              ) : null
            ) : (
              <OutSelect value={acc[e]} options={LEVELS} label={`Agent access in ${e}`} onChange={(v) => setAcc({ ...acc, [e]: v })} />
            )}
          </div>
        </div>
      ))}
      {!existing && <p className="sub">The dropdown on the right is the agent's access in that environment. Leave a value empty to skip that environment.</p>}
    </Dialog>
  );
}
