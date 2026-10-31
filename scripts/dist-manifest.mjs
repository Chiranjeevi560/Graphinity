#!/usr/bin/env node
// A SHA-256 of every file a release ships (docs/RUNBOOK.md, SLSA provenance covers the image; this covers the website).
// Deterministic: sorted paths, no timestamps, so two builds of the same commit can be compared by eye or by diff.
//
//   node scripts/dist-manifest.mjs <folder> [output]
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function manifest(root) {
  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(e => e.isFile())
    .map(e => join(e.parentPath, e.name));
  return files
    .map(path => ({
      path: relative(root, path).split(sep).join('/'),
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

if (import.meta.url === `file://${process.argv[1] ?? ''}`) {
  const [root, output] = process.argv.slice(2);
  if (!root) throw new Error('usage: dist-manifest.mjs <folder> [output]');
  const text = `${JSON.stringify({ files: manifest(root) }, null, 2)}\n`;
  if (output) writeFileSync(output, text);
  else process.stdout.write(text);
}
