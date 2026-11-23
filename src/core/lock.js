import fs from 'node:fs';
import { file } from './paths.js';

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Cross-process lock around a synchronous critical section. */
export function withLock(name, fn, { timeoutMs = 10000, staleMs = 15000 } = {}) {
  const lockFile = file(`${name}.lock`);
  const start = Date.now();
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(lockFile, 'wx', 0o600);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockFile).mtimeMs > staleMs) fs.unlinkSync(lockFile);
      } catch {
        /* raced with another process */
      }
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${name} lock`);
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(lockFile);
    } catch {
      /* already gone */
    }
  }
}
