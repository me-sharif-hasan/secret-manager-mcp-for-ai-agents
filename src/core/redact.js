import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

const SENSITIVE_NAME = /(PASS|PWD|SECRET|TOKEN|KEY|CRED|AUTH|DSN|URL|URI)/i;

/** Values this short would shred ordinary output (ports, "true", "dev"), unless the name looks secret. */
function worthRedacting(key, value) {
  if (!value || value.length < 4) return false;
  if (value.length < 8 && !SENSITIVE_NAME.test(key)) return false;
  return true;
}

function variants(value) {
  const b64 = Buffer.from(value, 'utf8').toString('base64');
  const set = new Set([
    value,
    b64,
    b64.replace(/=+$/, ''),
    b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]);
  return [...set].filter((s) => s.length >= 4);
}

/**
 * secrets: [{ key, value }]. Matches raw, base64, base64url, URL-encoded and JSON-escaped forms.
 * redactString() is for whole strings; stream() is a Transform that is safe across chunk boundaries.
 */
export function createRedactor(secrets) {
  const seen = new Set();
  const patterns = [];
  for (const { key, value } of secrets) {
    if (!worthRedacting(key, value)) continue;
    for (const text of variants(value)) {
      if (seen.has(text)) continue;
      seen.add(text);
      patterns.push({ key, text });
    }
  }
  patterns.sort((a, b) => b.text.length - a.text.length);
  const maxLen = patterns.reduce((n, p) => Math.max(n, p.text.length), 0);
  const stats = { count: 0 };

  function redactString(input) {
    let s = input;
    for (const p of patterns) {
      if (!s.includes(p.text)) continue;
      const parts = s.split(p.text);
      stats.count += parts.length - 1;
      s = parts.join(`[REDACTED:${p.key}]`);
    }
    return s;
  }

  function stream() {
    const decoder = new StringDecoder('utf8');
    const hold = Math.max(0, maxLen - 1);
    let tail = '';
    return new Transform({
      transform(chunk, _enc, cb) {
        tail = redactString(tail + decoder.write(chunk));
        if (tail.length > hold) {
          this.push(tail.slice(0, tail.length - hold));
          tail = tail.slice(tail.length - hold);
        }
        cb();
      },
      flush(cb) {
        this.push(redactString(tail + decoder.end()));
        cb();
      },
    });
  }

  return { redactString, stream, stats, patternCount: patterns.length };
}
