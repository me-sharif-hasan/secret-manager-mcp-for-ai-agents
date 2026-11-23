import fs from 'node:fs';
import { file, bumpVersion } from './paths.js';
import { encrypt, decrypt } from './crypto.js';
import { getMasterKey } from './keystore.js';
import { withLock } from './lock.js';
import { parseEnv, serializeEnv } from './envfile.js';
import { GUIDANCE_LEVELS } from './guidance.js';

export const LEVELS = ['none', 'use', 'write'];
export const GROUP_RE = /^[a-z0-9][a-z0-9-]{1,38}$/;
export const ENV_RE = /^[a-z][a-z0-9-]{0,19}$/;
export const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class VaultError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const defaultEnvs = () => ({
  dev: { allow: true, approval: false, expiryMin: null, defaultAccess: 'use', guidance: 'full', enforce: false },
  uat: { allow: true, approval: false, expiryMin: 30, defaultAccess: 'use', guidance: 'write', enforce: true },
  prod: { allow: false, approval: true, expiryMin: 15, defaultAccess: 'none', guidance: 'read_only', enforce: true },
});

const strictEnv = () => ({ allow: false, approval: true, expiryMin: 15, defaultAccess: 'none', guidance: 'read_only', enforce: true });

/** Older vaults may lack newer fields. Missing guidance defaults to the safest level. */
const normEnv = (s) => ({ guidance: 'read_only', enforce: true, ...s });

const vaultPath = () => file('vault.enc');
export const vaultExists = () => fs.existsSync(vaultPath());

function readRaw() {
  if (!vaultExists()) return { schema: 1, created: new Date().toISOString(), groups: {} };
  const blob = JSON.parse(fs.readFileSync(vaultPath(), 'utf8'));
  return JSON.parse(decrypt(getMasterKey(), blob));
}

function writeRaw(data) {
  const key = getMasterKey({ create: !vaultExists() });
  const tmp = `${vaultPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(encrypt(key, JSON.stringify(data))), { mode: 0o600 });
  fs.renameSync(tmp, vaultPath());
  bumpVersion();
}

/** Decrypted snapshot. Callers must never forward values to an agent. */
export function load() {
  return readRaw();
}

function mutate(fn) {
  return withLock('vault', () => {
    const data = readRaw();
    const result = fn(data);
    writeRaw(data);
    return result;
  });
}

function grp(data, name) {
  const g = data.groups[name];
  if (!g) throw new VaultError(`Group "${name}" does not exist`, 404);
  return g;
}

function checkEnv(g, env) {
  if (!g.envs[env]) throw new VaultError(`Environment "${env}" does not exist in this group`, 404);
}

function checkLevel(level) {
  if (!LEVELS.includes(level)) throw new VaultError(`Access must be one of: ${LEVELS.join(', ')}`);
}

/** First four characters for long values only; short values are fully masked. */
export function mask(value) {
  if (!value) return null;
  return value.length >= 12 ? value.slice(0, 4) + '••••••••' : '••••••••';
}

// ---------------------------------------------------------------- groups

export function listGroups() {
  const d = readRaw();
  return Object.entries(d.groups).map(([name, g]) => ({
    name,
    envs: Object.keys(g.envs),
    variableCount: Object.keys(g.vars).length,
  }));
}

export function createGroup(name, { envs } = {}) {
  if (!GROUP_RE.test(name)) throw new VaultError('Group name must be 2-39 chars: lowercase letters, numbers, hyphens');
  return mutate((d) => {
    if (d.groups[name]) throw new VaultError(`Group "${name}" already exists`, 409);
    const base = defaultEnvs();
    const chosen = envs?.length ? Object.fromEntries(envs.map((e) => [e, base[e] || strictEnv()])) : base;
    d.groups[name] = { created: new Date().toISOString(), envs: chosen, vars: {} };
    return { name, envs: Object.keys(chosen) };
  });
}

/** Dashboard view: masked values only. */
export function viewGroup(name) {
  const g = grp(readRaw(), name);
  return {
    name,
    envs: Object.fromEntries(Object.entries(g.envs).map(([k, v]) => [k, normEnv(v)])),
    vars: Object.entries(g.vars).map(([key, v]) => ({
      key,
      access: v.access,
      masked: Object.fromEntries(Object.keys(g.envs).map((e) => [e, mask(v.values[e])])),
      updated: v.updated,
    })),
  };
}

export function setEnvSettings(group, env, patch) {
  return mutate((d) => {
    const g = grp(d, group);
    checkEnv(g, env);
    const s = g.envs[env];
    if ('allow' in patch) s.allow = Boolean(patch.allow);
    if ('approval' in patch) s.approval = Boolean(patch.approval);
    if ('expiryMin' in patch) {
      if (patch.expiryMin !== null && !(Number.isInteger(patch.expiryMin) && patch.expiryMin > 0)) throw new VaultError('expiryMin must be null or a positive integer');
      s.expiryMin = patch.expiryMin;
    }
    if ('defaultAccess' in patch) {
      checkLevel(patch.defaultAccess);
      s.defaultAccess = patch.defaultAccess;
    }
    if ('guidance' in patch) {
      if (!GUIDANCE_LEVELS.includes(patch.guidance)) throw new VaultError(`guidance must be one of: ${GUIDANCE_LEVELS.join(', ')}`);
      s.guidance = patch.guidance;
    }
    if ('enforce' in patch) s.enforce = Boolean(patch.enforce);
    return normEnv(s);
  });
}

/** Clone keys and access rules (values are NOT copied) into a new environment. */
export function addEnv(group, env, { cloneFrom } = {}) {
  if (!ENV_RE.test(env)) throw new VaultError('Environment name must be lowercase letters, numbers, hyphens (max 20)');
  return mutate((d) => {
    const g = grp(d, group);
    if (g.envs[env]) throw new VaultError(`Environment "${env}" already exists`, 409);
    g.envs[env] = cloneFrom && g.envs[cloneFrom] ? { ...normEnv(g.envs[cloneFrom]), allow: false } : strictEnv();
    if (cloneFrom && g.envs[cloneFrom]) {
      for (const v of Object.values(g.vars)) v.access[env] = v.access[cloneFrom] ?? 'none';
    }
    return g.envs[env];
  });
}

// ------------------------------------------------------------- variables

export function setVar(group, key, { values = {}, access = {} } = {}) {
  if (!KEY_RE.test(key)) throw new VaultError('Variable name must match [A-Za-z_][A-Za-z0-9_]*');
  return mutate((d) => {
    const g = grp(d, group);
    const isNew = !g.vars[key];
    const v = (g.vars[key] ||= { values: {}, access: {}, updated: null });
    for (const [env, val] of Object.entries(values)) {
      checkEnv(g, env);
      if (val === null) delete v.values[env];
      else v.values[env] = String(val);
    }
    for (const [env, lvl] of Object.entries(access)) {
      checkEnv(g, env);
      checkLevel(lvl);
      v.access[env] = lvl;
    }
    for (const env of Object.keys(g.envs)) v.access[env] ??= isNew ? g.envs[env].defaultAccess : 'none';
    v.updated = new Date().toISOString();
    return { key, isNew };
  });
}

export function deleteVar(group, key) {
  return mutate((d) => {
    const g = grp(d, group);
    if (!g.vars[key]) throw new VaultError(`Variable "${key}" not found`, 404);
    delete g.vars[key];
  });
}

export function setAccess(group, key, env, level) {
  checkLevel(level);
  return mutate((d) => {
    const g = grp(d, group);
    checkEnv(g, env);
    if (!g.vars[key]) throw new VaultError(`Variable "${key}" not found`, 404);
    g.vars[key].access[env] = level;
    g.vars[key].updated = new Date().toISOString();
  });
}

export function reveal(group, key, env) {
  const g = grp(readRaw(), group);
  checkEnv(g, env);
  const v = g.vars[key]?.values[env];
  if (v === undefined) throw new VaultError(`"${key}" has no value in ${env}`, 404);
  return v;
}

// ---------------------------------------------------------------- .env

export function importEnv(group, env, text, { access = 'use', dryRun = false } = {}) {
  checkLevel(access);
  const { entries, errors } = parseEnv(text);
  const run = (d) => {
    const g = grp(d, group);
    checkEnv(g, env);
    const rows = [];
    for (const e of errors) rows.push({ line: e.line, key: null, status: 'invalid', reason: e.reason, text: e.text });
    for (const { key, value, line } of entries) {
      const existing = g.vars[key];
      const status = !existing || existing.values[env] === undefined ? 'new' : existing.values[env] === value ? 'unchanged' : 'changed';
      rows.push({ line, key, status });
      if (dryRun || status === 'unchanged') continue;
      const v = (g.vars[key] ||= { values: {}, access: {}, updated: null });
      const isNewVar = !existing;
      v.values[env] = value;
      for (const e2 of Object.keys(g.envs)) v.access[e2] ??= 'none';
      if (isNewVar || status === 'new') v.access[env] = access;
      v.updated = new Date().toISOString();
    }
    rows.sort((a, b) => a.line - b.line);
    return {
      rows,
      written: dryRun ? 0 : rows.filter((r) => r.status === 'new' || r.status === 'changed').length,
    };
  };
  return dryRun ? run(readRaw()) : mutate(run);
}

export function exportEnv(group, env) {
  const g = grp(readRaw(), group);
  checkEnv(g, env);
  const out = {};
  for (const [k, v] of Object.entries(g.vars)) if (v.values[env] !== undefined) out[k] = v.values[env];
  return serializeEnv(out);
}

// ----------------------------------------------------- resolution helpers

/** { KEY: value } for one environment. agent=true drops variables whose access is "none". */
export function resolve(group, env, { agent }) {
  const g = grp(readRaw(), group);
  checkEnv(g, env);
  const out = {};
  for (const [k, v] of Object.entries(g.vars)) {
    if (v.values[env] === undefined) continue;
    if (agent && (v.access[env] ?? 'none') === 'none') continue;
    out[k] = v.values[env];
  }
  return out;
}

/** Names visible to the agent in one environment (never values). */
export function agentVisible(group, env) {
  return Object.entries(grp(readRaw(), group).vars)
    .filter(([, v]) => v.values[env] !== undefined && (v.access[env] ?? 'none') !== 'none')
    .map(([key, v]) => ({ key, access: v.access[env] }));
}

export function agentAccessOf(group, key, env) {
  const g = grp(readRaw(), group);
  return g.vars[key]?.access[env] ?? null;
}

/** Every value in the vault, across groups and environments, for output redaction. */
export function allSecrets() {
  if (!vaultExists()) return [];
  const out = [];
  for (const g of Object.values(readRaw().groups)) {
    for (const [key, v] of Object.entries(g.vars)) for (const val of Object.values(v.values)) out.push({ key, value: val });
  }
  return out;
}

export function allKeys() {
  if (!vaultExists()) return new Set();
  const keys = new Set();
  for (const g of Object.values(readRaw().groups)) for (const k of Object.keys(g.vars)) keys.add(k);
  return keys;
}

export function groupNames() {
  return vaultExists() ? Object.keys(readRaw().groups) : [];
}
