import { useEffect, useState } from 'react';
import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { Tag } from '../ui.jsx';

export default function Audit() {
  const { state, guard } = useApp();
  const [actor, setActor] = useState('all');
  const [rows, setRows] = useState([]);
  useEffect(() => {
    api(`/audit${actor === 'all' ? '' : `?actor=${actor}`}`).then(setRows).catch(guard);
  }, [actor, state, guard]);

  return (
    <>
      <div className="kv" style={{ justifyContent: 'flex-start', gap: 8 }}>
        {['all', 'agent', 'you'].map((f) => (
          <button key={f} className="step state" aria-current={actor === f} onClick={() => setActor(f)}>
            {f}
          </button>
        ))}
        <span className="muted" style={{ marginLeft: 8 }}>
          Names and outcomes only. Values are never logged.
        </span>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Variable</th>
              <th>Env</th>
              <th>Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const result = String(r.result ?? '');
              const kind = result.startsWith('blocked') || result.startsWith('denied') ? 'bad' : result === 'ok' ? 'ok' : '';
              return (
                <tr key={i}>
                  <td className="mono num" style={{ whiteSpace: 'nowrap' }}>
                    {new Date(r.ts).toLocaleTimeString()}
                  </td>
                  <td>{r.actor}</td>
                  <td className="mono">{r.action}</td>
                  <td className="mono">{r.key || '-'}</td>
                  <td>{r.env || '-'}</td>
                  <td>
                    <Tag kind={kind}>{result + (r.redactions ? ` · ${r.redactions} redacted` : '')}</Tag>
                  </td>
                </tr>
              );
            })}
            {!rows.length && (
              <tr>
                <td colSpan={6} className="empty">
                  No activity yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
