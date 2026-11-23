import { useApp } from '../ctx.jsx';
import { api } from '../api.js';
import { AccSelect, Tag } from '../ui.jsx';

export default function AgentAccess() {
  const { data, group, state, refresh, notify } = useApp();
  const envs = Object.keys(data.envs);
  const set = (key, env, level) => api(`/groups/${group}/vars/${key}/access`, { method: 'PUT', body: { env, level } }).then(refresh).catch((e) => notify(e.message));
  return (
    <>
      <div className="kv" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <Tag kind="bad">none · invisible to the agent</Tag>
        <Tag kind="ok">use · available as $VAR in agent commands, output redacted</Tag>
        <Tag kind="warn">write · agent may also set or rotate it</Tag>
      </div>
      <div className="tablewrap">
        <table>
          <thead>
            <tr>
              <th>Variable</th>
              {envs.map((e) => (
                <th key={e}>{e}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.vars.map((v) => (
              <tr key={v.key}>
                <td className="mono">{v.key}</td>
                {envs.map((e) => (
                  <td key={e}>
                    <AccSelect value={v.access[e]} dead={state?.killed} label={`Agent access for ${v.key} in ${e}`} onChange={(l) => set(v.key, e, l)} />
                  </td>
                ))}
              </tr>
            ))}
            {!data.vars.length && (
              <tr>
                <td colSpan={envs.length + 1} className="empty">
                  No variables in this group yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
