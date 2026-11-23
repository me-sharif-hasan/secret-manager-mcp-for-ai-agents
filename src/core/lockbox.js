import fs from 'node:fs';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { file } from './paths.js';
import { encrypt, decrypt } from './crypto.js';
import { checkStrength } from './strength.js';

const scrypt = promisify(crypto.scrypt);

/**
 * Master-password protection. The vault key (a random 32 bytes) is wrapped with a key derived from
 * the password using scrypt and stored in lock.json. Once protected, the plain key is removed from the
 * OS keychain and master.key, so the vault, lock.json and the keychain together are still useless
 * without the password. Nothing here can be recovered: a forgotten password means a lost vault.
 */

export class LockedError extends Error {
  constructor(message = 'The vault is locked. Unlock it with `secretmgr unlock` or in the dashboard.') {
    super(message);
    this.name = 'LockedError';
    this.status = 423;
    this.code = 'LOCKED';
  }
}

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password');
    this.name = 'WrongPasswordError';
    this.status = 401;
  }
}

// SECRETMGR_KDF_FAST exists only so the test suite is quick. It lowers the work factor for NEW wraps and
// the floor accepted when reading, so a real install never accepts weaker parameters than 2^17.
const fast = () => process.env.SECRETMGR_KDF_FAST === '1';
const KDF = () => ({ alg: 'scrypt', N: fast() ? 2 ** 12 : 2 ** 17, r: 8, p: 1 });
const MIN_N = () => (fast() ? 2 ** 12 : 2 ** 17);
const MAXMEM = 512 * 1024 * 1024;

const lockPath = () => file('lock.json');
export const isProtected = () => fs.existsSync(lockPath());

/**
 * A master password is required before agents can use secrets. True for a vault that has none yet
 * (new installs and upgrades alike). SECRETMGR_ALLOW_UNPROTECTED is for the automated test suite only
 * and is deliberately undocumented; the Bash guard refuses commands that mention SECRETMGR_ variables.
 */
export const requiresSetup = () => !isProtected() && fs.existsSync(file('vault.enc')) && process.env.SECRETMGR_ALLOW_UNPROTECTED !== '1';

function readLock() {
  const lock = JSON.parse(fs.readFileSync(lockPath(), 'utf8'));
  const k = lock.kdf;
  if (lock.v !== 1 || !k || k.alg !== 'scrypt' || !lock.wrapped) throw new Error('lock.json is not in a supported format');
  if (!(k.N >= MIN_N()) || (k.N & (k.N - 1)) !== 0 || k.r < 8 || k.p < 1) throw new Error('lock.json uses key-derivation settings that are too weak; refusing to use it');
  return lock;
}

const normalize = (pw) => Buffer.from(String(pw).normalize('NFKC'), 'utf8');

async function derive(password, kdf, salt) {
  return scrypt(normalize(password), salt, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: MAXMEM });
}

async function wrap(password, masterKey) {
  const kdf = KDF();
  const salt = crypto.randomBytes(32);
  const wrapKey = await derive(password, kdf, salt);
  const blob = encrypt(wrapKey, masterKey.toString('base64'));
  wrapKey.fill(0);
  return { v: 1, kdf: { ...kdf, salt: salt.toString('base64') }, wrapped: blob, updated: new Date().toISOString() };
}

function writeLock(lock) {
  const tmp = `${lockPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(lock, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, lockPath());
}

/** Returns the vault key, or throws WrongPasswordError. The AES-GCM tag is the password check. */
export async function unwrap(password) {
  const lock = readLock();
  const wrapKey = await derive(password, lock.kdf, Buffer.from(lock.kdf.salt, 'base64'));
  try {
    const key = Buffer.from(decrypt(wrapKey, lock.wrapped), 'base64');
    if (key.length !== 32) throw new Error('bad key length');
    return key;
  } catch {
    throw new WrongPasswordError();
  } finally {
    wrapKey.fill(0);
  }
}

/** Wrap an existing vault key under a new password and write lock.json. */
export async function protect(password, masterKey) {
  const strength = checkStrength(password);
  if (!strength.ok) throw Object.assign(new Error(strength.reason), { status: 400 });
  const lock = await wrap(password, masterKey);
  // Prove the wrap round-trips before anything else changes.
  const probe = await derive(password, lock.kdf, Buffer.from(lock.kdf.salt, 'base64'));
  const back = Buffer.from(decrypt(probe, lock.wrapped), 'base64');
  probe.fill(0);
  if (!back.equals(masterKey)) throw new Error('internal error: key wrap did not round-trip');
  writeLock(lock);
}

/** Needs the current password. The vault data is not re-encrypted; only the key wrapper changes. */
export async function changePassword(current, next) {
  const key = await unwrap(current);
  const strength = checkStrength(next);
  if (!strength.ok) throw Object.assign(new Error(strength.reason), { status: 400 });
  if (current === next) throw Object.assign(new Error('The new password is the same as the current one'), { status: 400 });
  writeLock(await wrap(next, key));
  key.fill(0);
}

export { checkStrength };
