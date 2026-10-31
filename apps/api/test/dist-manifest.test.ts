import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../scripts/dist-manifest.mjs', import.meta.url));
const run = (root: string) =>
  (
    JSON.parse(execFileSync(process.execPath, [script, root], { encoding: 'utf8' })) as {
      files: Array<{ path: string; sha256: string }>;
    }
  ).files;

describe('the release manifest', () => {
  it('lists every file, sorted, with its SHA-256, the same each time, and changes with any byte', () => {
    const root = mkdtempSync(join(tmpdir(), 'manifest-'));
    try {
      mkdirSync(join(root, 'assets'));
      writeFileSync(join(root, 'index.html'), 'a');
      writeFileSync(join(root, 'assets', 'x.js'), 'b');
      const first = run(root);
      expect(first.map(f => f.path)).toEqual(['assets/x.js', 'index.html']);
      // SHA-256 of "a", from shasum.
      expect(first[1]?.sha256).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
      expect(run(root)).toEqual(first);
      writeFileSync(join(root, 'index.html'), 'c');
      expect(run(root)).not.toEqual(first);
    } finally {
      rmSync(root, { recursive: true });
    }
  });
});
