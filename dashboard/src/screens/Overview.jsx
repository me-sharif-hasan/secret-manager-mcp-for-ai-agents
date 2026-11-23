import { useEffect, useState } from 'react';
import { useApp } from '../ctx.jsx';
import { api, ago } from '../api.js';
import { Icon } from '../icons.jsx';
import { Tag, guidanceLabel } from '../ui.jsx';

function Stat({ icon, value, label }) {
  return (
    <div className="stat">
      <Icon name={icon} />
      <b>{value}</b>
      <span className="l">{label}</span>
    </div>
  );
}

export default function Overview() {
  const { data, state, setScreen, setEnv, guard } = useApp();
  const [log, setLog] = useState([]);
  useEffect(() => {
    api('/audit').then((r) => setLog(r.slice(0, 5))).catch(guard);
  }, [state, guard]);

  const envs = Object.keys(data.envs);
  const split = Object.fromEntries(envs.map((e) => [e, { none: 0, use: 0, write: 0 }]));
  data.vars.forEach((v) => envs.forEach((e) => split[e][v.access[e] ?? 'none']++));
  const usable = envs.reduce((n, e) => n + split[e].use + split[e].write, 0);
  const hidden = envs.reduce((n, e) => n + split[e].none, 0);

  return (
    <>
      <div className="stats">
        <Stat icon="key" value={data.vars.length} label="Variables" />
        <Stat icon="layers" value={envs.length} label="Environments" />
        <Stat icon="smart_toy" value={usable} label="Agent can use or write" />
        <Stat icon="shield" value={hidden} label="Hidden from agent" />
      </div>

      <div className="grid3">
        {envs.map((e) => {
          const s = split[e];
          const cfg = data.envs[e];
          return (
            <div className="card" key={e}>
              <div className="kv">
                <h3>{e}</h3>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <Tag>{guidanceLabel[cfg.guidance]}</Tag>
                  {!cfg.allow ? <Tag kind="bad">agent off</Tag> : cfg.approval ? <Tag kind="warn" icon="verified_user">approval</Tag> : <Tag kind="ok">auto</Tag>}
                </div>
              </div>
              <div className="bar" aria-label="Access split">
                {['none', 'use', 'write'].map((k) => (s[k] ? <i key={k} className={k} style={{ flex: s[k] }} /> : null))}
              </div>
              <span className="muted">
                {s.none} none · {s.use} use · {s.write} write
              </span>
              <button
                className="btn tonal"
                onClick={() => {
                  setEnv(e);
                  setScreen('variables');
                }}
              >
                Open variables
              </button>
            </div>
          );
        })}
      </div>

      <div className="card">
        <h3>Recent activity</h3>
        {log.length === 0 ? (
          <p className="muted">Nothing yet. Agent calls and your own changes show up here.</p>
        ) : (
          <div className="list">
            {log.map((r, i) => {
              const bad = String(r.result).startsWith('blocked') || String(r.result).startsWith('denied');
              return (
                <div className="li" key={i}>
                  <span className={bad ? 'lead bad' : 'lead'}>
                    <Icon name={bad ? 'block' : r.actor === 'agent' ? 'smart_toy' : 'person'} />
                  </span>
                  <div className="body">
                    <b>
                      {r.actor} · {r.action}
                    </b>
                    <span className="muted mono">{[r.key, r.env, r.result].filter(Boolean).join(' · ')}</span>
                  </div>
                  <span className="muted">{ago(r.ts)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
