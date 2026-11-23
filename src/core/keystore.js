import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { file } from './paths.js';
import { randomKey } from './crypto.js';
import { isProtected, LockedError } from './lockbox.js';
import { fetchKey } from './keyagent.js';

const SERVICE = 'secretmgr';
const ACCOUNT = 'master-key';

function run(cmd, args, input) {
  return spawnSync(cmd, args, { input, encoding: 'utf8', timeout: 8000 });
}

/**
 * OS-backed key storage without native modules.
 *  - Linux:   libsecret via `secret-tool`
 *  - macOS:   Keychain via `security`
 *  - Windows: DPAPI via PowerShell (blob stored in master.dpapi, only decryptable by this user)
 * Only the Linux path is exercised by this project's tests.
 */
const backends = {
  linux: {
    name: 'libsecret',
    get() {
      const r = run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
      if (r.error) return { status: 'unavailable' };
      if (r.status === 0 && r.stdout.trim()) return { status: 'found', value: r.stdout.trim() };
      if (r.status === 1 && !r.stderr.trim()) return { status: 'missing' };
      return { status: 'unavailable' };
    },
    set(b64) {
      const r = run('secret-tool', ['store', '--label=secretmgr master key', 'service', SERVICE, 'account', ACCOUNT], b64);
      return !r.error && r.status === 0;
    },
    del() {
      const r = run('secret-tool', ['clear', 'service', SERVICE, 'account', ACCOUNT]);
      return !r.error;
    },
  },
  darwin: {
    name: 'macOS Keychain',
    get() {
      const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
      if (r.error) return { status: 'unavailable' };
      if (r.status === 0 && r.stdout.trim()) return { status: 'found', value: r.stdout.trim() };
      return { status: 'missing' };
    },
    set(b64) {
      // Note: `security -w` takes the secret as an argument, visible briefly to local `ps`.
      const r = run('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', b64]);
      return !r.error && r.status === 0;
    },
    del() {
      const r = run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
      return !r.error;
    },
  },
  win32: {
    name: 'Windows DPAPI',
    get() {
      const f = file('master.dpapi');
      if (!fs.existsSync(f)) return { status: 'missing' };
      const ps =
        "Add-Type -AssemblyName System.Security;" +
        "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
        "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
        "[Convert]::ToBase64String($p)";
      const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], fs.readFileSync(f, 'utf8'));
      if (r.error || r.status !== 0) return { status: 'unavailable' };
      return { status: 'found', value: r.stdout.trim() };
    },
    set(b64) {
      const ps =
        "Add-Type -AssemblyName System.Security;" +
        "$b=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim());" +
        "$p=[Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser');" +
        "[Convert]::ToBase64String($p)";
      const r = run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], b64);
      if (r.error || r.status !== 0) return false;
      fs.writeFileSync(file('master.dpapi'), r.stdout.trim() + '\n', { mode: 0o600 });
      return true;
    },
    del() {
      fs.rmSync(file('master.dpapi'), { force: true });
      return true;
    },
  },
};

function osBackend() {
  if (process.env.SECRETMGR_KEY_BACKEND === 'file') return null;
  return backends[process.platform] || null;
}

let cached = null;
let usedBackend = null;
let sessionKey = null; // the unwrapped key while a protected vault is unlocked, in this process only
let holders = 0;

export function keyBackendName() {
  return isProtected() ? 'master password' : usedBackend;
}

/**
 * The key kept in the OS keychain or master.key (unprotected vaults). Order: OS keychain, then
 * master.key in the data directory (mode 0600). Pass create=true only when initialising a new vault.
 */
export function loadStoredKey({ create = false } = {}) {
  if (cached) return cached;
  let b64 = null;

  const os = osBackend();
  if (os) {
    const r = os.get();
    if (r.status === 'found') {
      b64 = r.value;
      usedBackend = os.name;
    }
  }
  const keyFile = file('master.key');
  if (!b64 && fs.existsSync(keyFile)) {
    b64 = fs.readFileSync(keyFile, 'utf8').trim();
    usedBackend = 'file (0600)';
  }
  if (!b64) {
    if (!create) {
      throw new Error('Master key not found. If this is a new machine, run `secretmgr init`. A vault cannot be opened without its key.');
    }
    b64 = randomKey().toString('base64');
    if (os && os.set(b64)) {
      usedBackend = os.name;
    } else {
      fs.writeFileSync(keyFile, b64 + '\n', { mode: 0o600 });
      usedBackend = 'file (0600)';
    }
  }
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('Master key is corrupt (expected 32 bytes).');
  cached = key;
  return cached;
}

/** Remove the plain key from the keychain and master.key once a password wraps it. Best effort, reports what it did. */
export function deleteStoredKey() {
  const done = [];
  const os = osBackend();
  if (os?.del?.()) done.push(os.name);
  const keyFile = file('master.key');
  if (fs.existsSync(keyFile)) {
    try {
      fs.writeFileSync(keyFile, Buffer.alloc(fs.statSync(keyFile).size, 0)); // best effort; not guaranteed on SSDs
    } catch {
      /* unlink anyway */
    }
    fs.rmSync(keyFile, { force: true });
    done.push('master.key');
  }
  cached = null;
  usedBackend = null;
  return done;
}

export const hasStoredKey = () => {
  if (fs.existsSync(file('master.key'))) return true;
  const os = osBackend();
  return Boolean(os && os.get().status === 'found');
};

/**
 * The vault key. Synchronous so the vault code stays simple: a protected vault returns the key that
 * acquireKey()/preloadKey() fetched from the key agent, or throws LockedError.
 */
export function getMasterKey({ create = false } = {}) {
  if (isProtected()) {
    if (sessionKey) return sessionKey;
    throw new LockedError();
  }
  return loadStoredKey({ create });
}

/**
 * Long-lived processes (MCP server, dashboard) bracket every operation with acquireKey()/release so the
 * key is dropped from their memory as soon as nothing is using it, and re-fetched from the agent next time.
 * That is what makes "lock" effective in them. Throws LockedError when the vault is locked.
 */
export async function acquireKey({ touch = true } = {}) {
  if (isProtected() && !sessionKey) {
    const k = await fetchKey({ touch });
    if (!k) throw new LockedError();
    sessionKey = k;
  }
  holders++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders === 0 && sessionKey) {
      sessionKey.fill(0);
      sessionKey = null;
    }
  };
}

export async function withKey(fn) {
  const release = await acquireKey();
  try {
    return await fn();
  } finally {
    release();
  }
}

/** One-shot CLI processes: fetch the key if the vault is protected and unlocked; stay quiet if it is locked. */
export async function preloadKey() {
  if (!isProtected()) return;
  try {
    await acquireKey(); // held until the process exits
  } catch {
    /* locked: callers that need the key get LockedError from getMasterKey() */
  }
}

export function resetKeyCache() {
  cached = null;
  usedBackend = null;
  if (sessionKey) sessionKey.fill(0);
  sessionKey = null;
  holders = 0;
}
