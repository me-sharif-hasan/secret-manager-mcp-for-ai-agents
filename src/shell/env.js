import { KEY_RE } from '../core/vault.js';
import * as vault from '../core/vault.js';
import { getState } from '../core/state.js';
import { resolveGroup, agentEnvironment, managedNames } from '../core/policy.js';
import { LEVEL_LABEL } from '../core/guidance.js';

export const SHELLS = ['bash', 'zsh', 'fish', 'pwsh', 'cmd'];
const KEYS_VAR = '__SECRETMGR_KEYS';

const quoteSh = (v) => `'${v.replace(/'/g, `'\\''`)}'`;
const quoteFish = (v) => `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const quotePs = (v) => `'${v.replace(/'/g, "''")}'`;
const quoteCmd = (v) => v.replace(/%/g, '%%');

/** Statements that set `set` and unset `unset` in the given shell. Names are validated before use. */
export function emit(shell, { set = {}, unset = [], track = true }) {
  for (const k of [...Object.keys(set), ...unset]) if (!KEY_RE.test(k)) throw new Error(`Refusing unsafe variable name: ${k}`);
  const lines = [];
  const setKeys = Object.keys(set);
  switch (shell) {
    case 'bash':
    case 'zsh':
    case 'sh':
      if (unset.length) lines.push(`unset ${unset.join(' ')}`);
      for (const [k, v] of Object.entries(set)) lines.push(`export ${k}=${quoteSh(v)}`);
      if (track) lines.push(setKeys.length ? `export ${KEYS_VAR}=${quoteSh(setKeys.join(' '))}` : `unset ${KEYS_VAR}`);
      break;
    case 'fish':
      for (const k of unset) lines.push(`set -e ${k}`);
      for (const [k, v] of Object.entries(set)) lines.push(`set -gx ${k} ${quoteFish(v)}`);
      if (track) lines.push(setKeys.length ? `set -gx ${KEYS_VAR} ${quoteFish(setKeys.join(' '))}` : `set -e ${KEYS_VAR}`);
      break;
    case 'pwsh':
      for (const k of unset) lines.push(`Remove-Item Env:${k} -ErrorAction SilentlyContinue`);
      for (const [k, v] of Object.entries(set)) lines.push(`$env:${k} = ${quotePs(v)}`);
      if (track) lines.push(setKeys.length ? `$env:${KEYS_VAR} = ${quotePs(setKeys.join(' '))}` : `Remove-Item Env:${KEYS_VAR} -ErrorAction SilentlyContinue`);
      break;
    case 'cmd':
      for (const k of unset) lines.push(`set "${k}="`);
      for (const [k, v] of Object.entries(set)) lines.push(`set "${k}=${quoteCmd(v)}"`);
      if (track) lines.push(`set "${KEYS_VAR}=${setKeys.join(' ')}"`);
      break;
    default:
      throw new Error(`Unsupported shell: ${shell}`);
  }
  return lines.join('\n') + '\n';
}

const prevKeys = () => (process.env[KEYS_VAR] || '').split(/\s+/).filter((k) => KEY_RE.test(k));

/**
 * For the user's own terminals: all values in the chosen environment (the user owns them),
 * regardless of agent access. Honors the kill switch by unsetting everything previously loaded.
 */
export function terminalScript(shell, { env, group, unload = false }) {
  const prev = prevKeys();
  const state = getState();
  if (unload || state.killed) {
    return { script: emit(shell, { unset: prev }), note: state.killed && !unload ? 'secretmgr: kill switch is on, variables cleared' : null };
  }
  const g = resolveGroup(group);
  const vars = vault.resolve(g, env, { agent: false });
  const unset = prev.filter((k) => !(k in vars));
  return { script: emit(shell, { set: vars, unset }), note: null };
}

/**
 * Prelude run inside the sandboxed subshell around every agent Bash command (bash syntax).
 * First strips every managed name inherited from wherever the agent was launched, then
 * exports only what the active environments allow, then prints a banner naming them.
 */
export function agentScript() {
  const strip = [...managedNames()].filter((k) => KEY_RE.test(k));
  const env = agentEnvironment();
  const lines = [];
  if (strip.length) lines.push(`unset ${strip.join(' ')}`);
  for (const [k, v] of Object.entries(env.vars)) lines.push(`export ${k}=${quoteSh(v)}`);
  if (env.killed) lines.push(`printf '%s\\n' '[secretmgr kill switch is on: no secrets loaded]'`);
  else if (env.envs.length) {
    const label = env.envs.map((e) => `${e.env}:${LEVEL_LABEL[e.guidance] || '?'}` + (e.primary && env.envs.length > 1 ? '*' : '')).join(',');
    lines.push(`printf '%s\\n' '[secretmgr env=${label}]'`);
  }
  return lines.join('\n') + '\n';
}
