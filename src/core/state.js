import fs from 'node:fs';
import crypto from 'node:crypto';
import { file, bumpVersion } from './paths.js';
import { withLock } from './lock.js';
import { audit } from './audit.js';

/**
 * Non-secret runtime state: kill switch, which environments the agent has active,
 * pending approvals, default environment for new terminals.
 * active[env] = { group, primary, activatedAt, expiresAt|null }
 */
const fresh = () => ({ killed: false, defaultGroup: null, terminalDefaultEnv: 'dev', active: {}, pending: {} });

export function readState() {
  try {
    return { ...fresh(), ...JSON.parse(fs.readFileSync(file('state.json'), 'utf8')) };
  } catch {
    return fresh();
  }
}

export function mutateState(fn) {
  return withLock('state', () => {
    const s = readState();
    const result = fn(s);
    const f = file('state.json');
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, f);
    fs.writeFileSync(file('default-env'), (s.terminalDefaultEnv || '') + '\n', { mode: 0o600 });
    bumpVersion();
    return result;
  });
}

function fixPrimary(s) {
  const envs = Object.keys(s.active);
  if (!envs.length) return;
  if (!envs.some((e) => s.active[e].primary)) s.active[envs[0]].primary = true;
}

/** State with expired activations and stale approval requests removed. */
export function getState() {
  const s = readState();
  const now = Date.now();
  const expired = Object.entries(s.active).filter(([, a]) => a.expiresAt && a.expiresAt <= now);
  const stale = Object.values(s.pending).filter((p) => now - p.ts > 10 * 60_000);
  if (!expired.length && !stale.length) return s;
  return mutateState((st) => {
    for (const [env, a] of Object.entries(st.active)) {
      if (a.expiresAt && a.expiresAt <= now) {
        delete st.active[env];
        audit({ actor: 'system', action: 'expire', env, group: a.group, result: 'deactivated' });
      }
    }
    for (const [id, p] of Object.entries(st.pending)) if (now - p.ts > 10 * 60_000) delete st.pending[id];
    fixPrimary(st);
    return st;
  }) ?? readState();
}

export function setKilled(on, actor = 'you') {
  return mutateState((s) => {
    s.killed = Boolean(on);
    if (s.killed) {
      s.active = {};
      for (const p of Object.values(s.pending)) if (p.status === 'waiting') p.status = 'denied';
    }
    audit({ actor, action: on ? 'kill-on' : 'kill-off', result: 'ok' });
    return s.killed;
  });
}

export function activate(group, env, { primary = false, expiryMin = null, actor = 'you' } = {}) {
  return mutateState((s) => {
    if (s.killed) throw new Error('Kill switch is on');
    const now = Date.now();
    if (primary || !Object.values(s.active).some((a) => a.primary)) for (const a of Object.values(s.active)) a.primary = false;
    s.active[env] = {
      group,
      primary: primary || !Object.values(s.active).some((a) => a.primary),
      activatedAt: now,
      expiresAt: expiryMin ? now + expiryMin * 60_000 : null,
    };
    fixPrimary(s);
    audit({ actor, action: 'activate_env', group, env, result: 'ok', detail: expiryMin ? `expires in ${expiryMin} min` : undefined });
    return s.active[env];
  });
}

export function deactivate(env, actor = 'you') {
  return mutateState((s) => {
    const had = Boolean(s.active[env]);
    delete s.active[env];
    fixPrimary(s);
    if (had) audit({ actor, action: 'deactivate_env', env, result: 'ok' });
    return had;
  });
}

export function setPrimary(env) {
  return mutateState((s) => {
    if (!s.active[env]) throw new Error(`${env} is not active`);
    for (const a of Object.values(s.active)) a.primary = false;
    s.active[env].primary = true;
  });
}

export function setTerminalDefaultEnv(env) {
  return mutateState((s) => {
    s.terminalDefaultEnv = env;
  });
}

export function setDefaultGroup(group) {
  return mutateState((s) => {
    s.defaultGroup = group;
  });
}

// ------------------------------------------------------------ approvals

export function requestApproval(group, env) {
  return mutateState((s) => {
    const id = crypto.randomBytes(6).toString('hex');
    s.pending[id] = { id, group, env, ts: Date.now(), status: 'waiting' };
    audit({ actor: 'agent', action: 'activate_env', group, env, result: 'waiting for approval' });
    return id;
  });
}

export function pendingApprovals() {
  return Object.values(getState().pending).filter((p) => p.status === 'waiting');
}

export function decideApproval(id, approve, { expiryMin = null } = {}) {
  return mutateState((s) => {
    const p = s.pending[id];
    if (!p || p.status !== 'waiting') throw new Error('No such pending request');
    p.status = approve && !s.killed ? 'approved' : 'denied';
    if (p.status === 'approved') {
      const now = Date.now();
      const hasPrimary = Object.values(s.active).some((a) => a.primary);
      s.active[p.env] = { group: p.group, primary: !hasPrimary, activatedAt: now, expiresAt: expiryMin ? now + expiryMin * 60_000 : null };
      fixPrimary(s);
    }
    audit({ actor: 'you', action: 'approval', group: p.group, env: p.env, result: p.status });
    return p.status;
  });
}

export async function waitForDecision(id, timeoutMs = 90_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const p = readState().pending[id];
    if (!p) return 'denied';
    if (p.status !== 'waiting') return p.status;
    await new Promise((r) => setTimeout(r, 750));
  }
  mutateState((s) => {
    if (s.pending[id]?.status === 'waiting') s.pending[id].status = 'timeout';
  });
  return 'timeout';
}

/** Drop anything that still points at a deleted environment. */
export function afterEnvDeleted(group, env, fallbackEnv) {
  return mutateState((s) => {
    if (s.active[env]?.group === group) {
      delete s.active[env];
      fixPrimary(s);
    }
    for (const p of Object.values(s.pending)) if (p.group === group && p.env === env && p.status === 'waiting') p.status = 'denied';
    if (s.terminalDefaultEnv === env && fallbackEnv) s.terminalDefaultEnv = fallbackEnv;
  });
}
