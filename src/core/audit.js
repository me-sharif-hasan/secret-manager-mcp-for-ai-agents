import fs from 'node:fs';
import { file } from './paths.js';

/** Append-only JSONL. Names and outcomes only; values are never written here. */
export function audit(entry) {
  try {
    fs.appendFileSync(file('audit.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch {
    /* auditing must never break the caller */
  }
}

export function readAudit({ limit = 200, actor } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(file('audit.jsonl'), 'utf8');
  } catch {
    return [];
  }
  const rows = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const filtered = actor === 'agent' ? rows.filter((r) => r.actor === 'agent') : actor === 'you' ? rows.filter((r) => r.actor !== 'agent') : rows;
  return filtered.slice(-limit).reverse();
}
