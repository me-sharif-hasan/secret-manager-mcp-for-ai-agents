import * as vault from './vault.js';
import * as st from './state.js';
import { audit } from './audit.js';
import { guidanceText, violates, LEVEL_LABEL } from './guidance.js';

export function envSuffix(env) {
  return env.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function resolveGroup(requested) {
  if (requested) return requested;
  const s = st.getState();
  if (s.defaultGroup) return s.defaultGroup;
  const names = vault.groupNames();
  if (names.length === 1) return names[0];
  throw new vault.VaultError('No group selected. Pass a group name, or set a default group in the dashboard.');
}

/**
 * What the agent's commands get. Each active environment contributes KEY__ENV for every variable
 * the agent may use; the primary environment also contributes the plain KEY.
 */
export function agentEnvironment() {
  const s = st.getState();
  if (s.killed) return { killed: true, envs: [], vars: {} };
  const vars = {};
  const envs = [];
  for (const [env, a] of Object.entries(s.active)) {
    let resolved;
    let settings;
    try {
      resolved = vault.resolve(a.group, env, { agent: true });
      settings = vault.viewGroup(a.group).envs[env];
    } catch {
      continue; // environment or group was deleted after activation
    }
    const names = [];
    for (const [k, v] of Object.entries(resolved)) {
      vars[`${k}__${envSuffix(env)}`] = v;
      names.push(`${k}__${envSuffix(env)}`);
      if (a.primary) {
        vars[k] = v;
        names.push(k);
      }
    }
    envs.push({ env, group: a.group, primary: a.primary, expiresAt: a.expiresAt, guidance: settings.guidance, enforce: settings.enforce, names });
  }
  return { killed: false, envs, vars };
}

/**
 * Enforcement for environments with enforce=on: only commands that reference one of that
 * environment's variables are checked, against that environment's guidance level.
 * Returns a message for the agent, or null.
 */
export function checkGuidance(command, envs) {
  for (const e of envs) {
    if (!e.enforce || e.guidance === 'full' || !e.names.length) continue;
    const re = new RegExp(`\\$\\{?(?:${e.names.join('|')})\\b`);
    if (!re.test(command)) continue;
    const why = violates(command, e.guidance);
    if (why) return `Blocked by the owner's ${LEVEL_LABEL[e.guidance]} guidance for "${e.env}": ${why}. ${guidanceText(e.env, e.guidance, true)}`;
  }
  return null;
}

/** Every name the agent environment could ever define, so stale inherited values can be stripped. */
export function managedNames() {
  const d = vault.vaultExists() ? vault.load() : { groups: {} };
  const keys = new Set();
  const envs = new Set();
  for (const g of Object.values(d.groups)) {
    for (const e of Object.keys(g.envs)) envs.add(e);
    for (const k of Object.keys(g.vars)) keys.add(k);
  }
  const names = new Set(keys);
  for (const k of keys) for (const e of envs) names.add(`${k}__${envSuffix(e)}`);
  return names;
}

/** Agent-initiated activation. Never returns values, only names. */
export async function agentActivate({ env, group, primary = false }) {
  const s = st.getState();
  if (s.killed) {
    audit({ actor: 'agent', action: 'activate_env', env, result: 'denied: kill switch' });
    return { ok: false, reason: 'The kill switch is on. All agent access is cut.' };
  }
  const g = resolveGroup(group);
  const view = vault.viewGroup(g);
  const settings = view.envs[env];
  if (!settings) return { ok: false, reason: `Environment "${env}" does not exist in group "${g}".` };
  if (!settings.allow) {
    audit({ actor: 'agent', action: 'activate_env', group: g, env, result: 'denied: not allowed' });
    return { ok: false, reason: `The owner has not allowed agents to activate "${env}". They can enable it in the dashboard (Environments).` };
  }
  if (settings.approval) {
    const id = st.requestApproval(g, env);
    const decision = await st.waitForDecision(id);
    if (decision !== 'approved') {
      return { ok: false, reason: decision === 'timeout' ? 'No approval was given within 90 seconds.' : 'The owner declined this activation.' };
    }
    if (primary) st.setPrimary(env);
  } else {
    st.activate(g, env, { primary, expiryMin: settings.expiryMin, actor: 'agent' });
  }
  return {
    ok: true,
    group: g,
    expiresInMin: settings.expiryMin,
    guidance: { level: settings.guidance, text: guidanceText(env, settings.guidance, settings.enforce), enforced: settings.enforce },
    variables: vault.agentVisible(g, env).map((v) => ({ name: v.key, suffixed: `${v.key}__${envSuffix(env)}`, access: v.access })),
  };
}
