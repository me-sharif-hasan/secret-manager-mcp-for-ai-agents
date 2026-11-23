/**
 * .env parser and serializer.
 * Supports: `export` prefix, comments, blank lines, unquoted values with inline " #" comments,
 * single-quoted (literal) values, double-quoted values with \n \r \t \" \\ escapes,
 * and quoted values spanning several lines.
 * Does not expand ${VAR} references (values are stored literally).
 */

function findClose(buf, quote) {
  for (let i = 0; i < buf.length; i++) {
    if (quote === '"' && buf[i] === '\\') {
      i++;
      continue;
    }
    if (buf[i] === quote) return i;
  }
  return -1;
}

function unescapeDouble(s) {
  return s.replace(/\\(.)/gs, (_, c) => ({ n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' }[c] ?? `\\${c}`));
}

export function parseEnv(text) {
  const entries = [];
  const errors = [];
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.replace(/^export\s+/, '').match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) {
      errors.push({ line: i + 1, text: trimmed, reason: 'not a KEY=VALUE line' });
      continue;
    }
    const key = m[1];
    const rest = m[2];
    const startLine = i + 1;
    const q = rest[0];
    let value;
    if (q === '"' || q === "'") {
      let buf = rest.slice(1);
      let close = findClose(buf, q);
      while (close < 0 && i + 1 < lines.length) {
        i++;
        buf += '\n' + lines[i];
        close = findClose(buf, q);
      }
      if (close < 0) {
        errors.push({ line: startLine, text: trimmed, reason: 'unterminated quote' });
        continue;
      }
      const inner = buf.slice(0, close);
      value = q === '"' ? unescapeDouble(inner) : inner;
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    entries.push({ key, value, line: startLine });
  }
  return { entries, errors };
}

export function serializeEnv(vars) {
  return (
    Object.entries(vars)
      .map(([k, v]) => {
        const needsQuote = /[\s#"'$`\\]/.test(v) || v === '';
        const out = needsQuote
          ? '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'
          : v;
        return `${k}=${out}`;
      })
      .join('\n') + '\n'
  );
}
