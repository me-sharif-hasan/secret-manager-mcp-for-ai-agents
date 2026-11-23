import { useEffect, useRef, useState } from 'react';
import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { Icon } from '../icons.jsx';
import { OutSelect, Seg, Tag, LEVELS } from '../ui.jsx';

const SAMPLE = ['# checkout-api local', 'export DATABASE_URL="postgres://app:x7Qp@db.dev.internal/app"', 'STRIPE_KEY=sk_test_51Hq0aEXAMPLE', 'REDIS_URL=redis://localhost:6379 # local cache', "FEATURE_FLAGS='a,b,c'"].join('\n');
const KIND = { new: 'ok', changed: 'warn', unchanged: '', invalid: 'bad' };

export default function ImportEnv() {
  const { data, group, refresh, notify, setScreen, setEnv } = useApp();
  const envs = Object.keys(data.envs);
  const [target, setTarget] = useState(envs.includes('dev') ? 'dev' : envs[0]);
  const [text, setText] = useState('');
  const [access, setAccess] = useState('use');
  const [rows, setRows] = useState([]);
  const timer = useRef();

  useEffect(() => {
    clearTimeout(timer.current);
    if (!text.trim()) return setRows([]);
    timer.current = setTimeout(() => {
      api(`/groups/${group}/import`, { method: 'POST', body: { env: target, text, access, dryRun: true } })
        .then((r) => setRows(r.rows))
        .catch((e) => notify(e.message));
    }, 250);
    return () => clearTimeout(timer.current);
  }, [text, target, access, group, notify]);

  const pending = rows.filter((r) => r.status === 'new' || r.status === 'changed').length;

  const run = async () => {
    try {
      const r = await api(`/groups/${group}/import`, { method: 'POST', body: { env: target, text, access } });
      notify(`Imported ${r.written} variables into ${target}`);
      setText('');
      setEnv(target);
      await refresh();
      setScreen('variables');
    } catch (e) {
      notify(e.message);
    }
  };

  const exportEnv = async () => {
    try {
      const res = await api(`/groups/${group}/export?env=${target}`, { raw: true });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = `.env.${target}`;
      a.click();
      URL.revokeObjectURL(a.href);
      notify(`Exported .env for ${target}. Delete the file when you are done.`);
    } catch (e) {
      notify(e.message);
    }
  };

  return (
    <>
      <div className="kv">
        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="muted">Target</span>
          <Seg items={envs} value={target} onChange={setTarget} dots />
        </div>
        <button className="btn outlined icon" onClick={exportEnv}>
          <Icon name="download" />
          Export .env for {target}
        </button>
      </div>

      <div className="tf">
        <label htmlFor="envtext">Paste .env contents</label>
        <textarea id="envtext" rows={9} spellCheck={false} placeholder={SAMPLE} value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      <div className="kv" style={{ justifyContent: 'flex-start', gap: 12 }}>
        <span className="muted">Agent access for new variables</span>
        <OutSelect value={access} options={LEVELS} label="Agent access for new variables" onChange={setAccess} />
      </div>

      {rows.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>Line</th>
                <th>Key</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.line}>
                  <td className="mono num">{r.line}</td>
                  <td className="mono">{r.key ?? r.text}</td>
                  <td>
                    <Tag kind={KIND[r.status]}>{r.status === 'invalid' ? `invalid: ${r.reason}` : r.status}</Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="kv">
        <span className="muted">
          {pending} to write into {target}. Comments and blank lines are skipped. {'${VAR}'} references are kept literally.
        </span>
        <button className="btn filled" disabled={!pending} onClick={run}>
          Import {pending} variables
        </button>
      </div>
    </>
  );
}
