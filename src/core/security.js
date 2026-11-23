import fs from 'node:fs';
import { file, bumpVersion } from './paths.js';
import * as lockbox from './lockbox.js';
import * as keyagent from './keyagent.js';
import { loadStoredKey, deleteStoredKey, hasStoredKey } from './keystore.js';
import { vaultExists } from './vault.js';
import * as st from './state.js';
import { audit } from './audit.js';

/** Orchestrates master-password protection. All functions here take or return keys and passwords; none log them. */

const DEFAULT_IDLE_MIN = 30;

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(file('config.json'), 'utf8'));
  } catch {
    return {};
  }
}

export const getIdleMin = () => {
  const v = readConfig().idleLockMin;
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_IDLE_MIN;
};

export async function setIdleMin(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0 || m > 24 * 60) throw Object.assign(new Error('Idle time must be between 0 (never) and 1440 minutes'), { status: 400 });
  const f = file('config.json');
  const cfg = { ...readConfig(), idleLockMin: m };
  fs.writeFileSync(`${f}.tmp`, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  fs.renameSync(`${f}.tmp`, f);
  await keyagent.setIdle(m);
  audit({ actor: 'you', action: 'set_idle_lock', result: m ? `${m} min` : 'never' });
  return m;
}

export async function securityStatus() {
  const protectedVault = lockbox.isProtected();
  const a = protectedVault ? await keyagent.agentStatus() : null;
  return {
    vault: vaultExists(),
    protected: protectedVault,
    unlocked: protectedVault ? Boolean(a?.unlocked) : true,
    idleMin: getIdleMin(),
    lockInSec: a?.lockInSec ?? null,
    // A plain key left behind (crash between steps) would defeat the password, so say so.
    leftoverKey: protectedVault && hasStoredKey(),
  };
}

/** Turn on master-password protection for an existing vault. The vault stays unlocked (the key agent holds the key). */
export async function enableProtection(password) {
  if (!vaultExists()) throw Object.assign(new Error('Create the vault first (secretmgr init)'), { status: 400 });
  if (lockbox.isProtected()) throw Object.assign(new Error('The vault already has a master password'), { status: 409 });
  const key = loadStoredKey();
  await lockbox.protect(password, key);
  deleteStoredKey(); // from here on the password is the only way in
  await keyagent.putKey(key, getIdleMin());
  st.clearUnlockRequest();
  audit({ actor: 'you', action: 'enable_master_password', result: 'ok' });
  bumpVersion();
}

/** Verify the password, start the key agent and give it the key. */
export async function unlock(password) {
  if (!lockbox.isProtected()) return;
  const key = await lockbox.unwrap(password);
  await keyagent.putKey(key, getIdleMin());
  if (hasStoredKey()) deleteStoredKey(); // finish an interrupted enable
  st.clearUnlockRequest();
  audit({ actor: 'you', action: 'unlock', result: 'ok' });
  bumpVersion(); // terminals reload their variables on the next prompt
}

export async function lock() {
  await keyagent.lockAgent();
}

export async function changePassword(current, next) {
  await lockbox.changePassword(current, next);
  audit({ actor: 'you', action: 'change_master_password', result: 'ok' });
}
