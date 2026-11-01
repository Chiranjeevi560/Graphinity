// `SELECT seq::text … ORDER BY seq` sorts by the text output column: "9" after "10". That took the audit log down at
// its eleventh entry, so no query may order by a bare name its select list has turned into text.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sources(path);
    return e.name.endsWith('.ts') ? [path] : [];
  });

export function textOrdered(source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(/ORDER BY\s+([^`;\n)']+)/g)) {
    const start = source.lastIndexOf('SELECT', m.index);
    if (start < 0 || m.index - start > 1500) continue;
    const head = source.slice(start, m.index);
    const from = /\bFROM\b/.exec(head);
    const list = from ? head.slice(0, from.index) : head;
    for (const term of (m[1] ?? '').split(',')) {
      const name = term.trim().split(/\s+/)[0] ?? '';
      if (!/^[a-z_]+$/.test(name)) continue;
      const bare = new RegExp(`\\b${name}::(?:text|varchar)\\b(?!\\s+AS\\b)`);
      const named = new RegExp(`::(?:text|varchar)\\s+AS\\s+${name}\\b`);
      if (bare.test(list) || named.test(list)) found.push(name);
    }
  }
  return found;
}

describe('ordering in SQL', () => {
  it('recognises the mistake, and a qualified column as safe', () => {
    expect(textOrdered('SELECT seq::text, hash FROM app.audit_log ORDER BY seq DESC')).toEqual(['seq']);
    expect(textOrdered('SELECT id::text AS at FROM t ORDER BY at')).toEqual(['at']);
    expect(textOrdered('SELECT l.seq::text FROM app.audit_log l ORDER BY l.seq DESC')).toEqual([]);
  });

  it('never sorts by a number turned into text', () => {
    const offenders = sources('src').flatMap(file =>
      textOrdered(readFileSync(file, 'utf8')).map(name => `${file}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });
});
