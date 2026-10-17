#!/usr/bin/env node
// Floor guard: blocks the cheap ways to turn a red check green without fixing
// anything. Looks only at what changed since the base (default origin/main),
// including new untracked files.
//
// Adapted from the constraint-driven-development skill's reference
// implementation. Exit 0 clean, 1 violation, 2 could not run (never read a 2
// as a pass).
//
//   node scripts/floor-guard.mjs [--base <ref>]
import { execFileSync } from 'node:child_process';

const base = (() => {
  const i = process.argv.indexOf('--base');
  return i > -1 ? process.argv[i + 1] : 'origin/main';
})();

const git = args => {
  try { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch { return null; }
};

const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
if (!mergeBase) { console.error(`floor-guard: no merge base against ${base}`); process.exit(2); }

const tracked = git(['diff', '--unified=0', mergeBase, '--']) ?? '';
const untracked = (git(['ls-files', '--others', '--exclude-standard']) ?? '')
  .split('\n').filter(Boolean)
  .map(f => { try { execFileSync('git', ['diff', '--no-index', '--unified=0', '/dev/null', f], { encoding: 'utf8' }); return ''; } catch (e) { return e.stdout ?? ''; } })
  .join('\n');

const added = [];
const removed = [];
let file = '';
for (const line of `${tracked}\n${untracked}`.split('\n')) {
  if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
  else if (line.startsWith('+') && !line.startsWith('+++')) added.push({ file, text: line.slice(1) });
  else if (line.startsWith('-') && !line.startsWith('---')) removed.push({ file, text: line.slice(1) });
}

// The guard's own patterns would match themselves, and documentation may
// describe the rules in words; only code is checked for the code patterns.
const SELF = /^scripts\/floor-guard\.mjs$/;
const CODE = /\.(ts|tsx|js|mjs|cjs|sql|sh|css|ya?ml)$/;

// The owner approves a new exception or changed number by adding a trailer
// to a commit message in the range, e.g. "Constraints-approved: E1, E2".
const approved = new Set(
  [...(git(['log', `${mergeBase}..HEAD`, '--format=%B']) ?? '').matchAll(/^Constraints-approved:\s*(.+)$/gm)]
    .flatMap(m => m[1].split(/[,\s]+/).filter(Boolean)),
);
const findings = [];
const flag = (rule, f, text) => findings.push({ rule, file: f, text: text.trim().slice(0, 120) });

const SUPPRESSIONS = /@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|istanbul ignore|c8 ignore|v8 ignore|nosemgrep|gitleaks:allow/;
const STUBS = /throw new Error\(.*[Nn]ot implemented|catch\s*(\(\w*\))?\s*\{\s*\}|\bTODO\b|\bFIXME\b/;
const SKIPS = /\b(it|test|describe)\.(skip|todo|only)\b|\bxit\(|\bxdescribe\(|\.fixme\(/;

for (const { file: f, text } of added) {
  if (SELF.test(f)) continue;
  if (CODE.test(f)) {
    if (SUPPRESSIONS.test(text)) flag('silenced-checker', f, text);
    if (STUBS.test(text)) flag('unfinished-work', f, text);
    if (SKIPS.test(text)) flag('test-made-easier', f, text);
  }
  const exception = /CONSTRAINTS\.md$/.test(f) && text.match(/^\| *(E\d+) *\|/);
  if (exception && !approved.has(exception[1])) flag('new-exception', f, text);
}

// Assertions replaced on purpose (the behaviour they checked changed) are
// allowed when a commit in the range says why: "Assertions-changed: <reason>".
const assertionReasons = [...(git(['log', `${mergeBase}..HEAD`, '--format=%B']) ?? '').matchAll(/^Assertions-changed:\s*(\S.{9,})$/gm)];

// An assertion call removed from a test file, unless the same line was added
// back in that file (moved, or the test was reorganised). Imports don't count.
const addedIn = new Map();
for (const { file: f, text } of added) {
  if (!addedIn.has(f)) addedIn.set(f, new Set());
  addedIn.get(f).add(text.trim());
}
for (const { file: f, text } of removed) {
  if (!/\.(test|spec)\.ts$/.test(f) || /^\s*import\b/.test(text)) continue;
  if (!/\b(expect|assert)(\.\w+)*\(/.test(text)) continue;
  if (addedIn.get(f)?.has(text.trim())) continue;
  if (assertionReasons.length > 0) continue;
  flag('assertion-removed', f, text);
}

// A deleted test file is a test made easier.
for (const f of (git(['diff', '--name-only', '--diff-filter=D', mergeBase, '--']) ?? '').split('\n').filter(Boolean)) {
  if (/\.(test|spec)\.ts$/.test(f)) flag('test-deleted', f, '(file deleted)');
}

// A number in CONSTRAINTS.md that went down on the same row.
const nums = s => (s.match(/\d+(\.\d+)?/g) ?? []).map(Number);
const rowKey = s => s.split('|')[1]?.trim();
const before = removed.filter(l => /CONSTRAINTS\.md$/.test(l.file));
const after = added.filter(l => /CONSTRAINTS\.md$/.test(l.file));
for (const r of before) {
  const a = after.find(x => rowKey(x.text) && rowKey(x.text) === rowKey(r.text));
  if (!a) continue;
  const old = nums(r.text);
  // Budgets that are maxima (bytes, ms, CLS) may only go down; minima only up.
  // Either way, a change to a number on a constraint row needs a human: flag it.
  if (nums(a.text).some((n, i) => old[i] !== undefined && n !== old[i])) flag('threshold-changed', r.file, `${r.text.trim()}  ->  ${a.text.trim()}`);
}

if (findings.length === 0) { console.log('floor-guard: clean'); process.exit(0); }
console.error(`floor-guard: ${findings.length} floor violation(s):`);
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
console.error('\nEach one lowers the bar. Fix the code, or record a tracked exception in CONSTRAINTS.md with an owner and an expiry.');
process.exit(1);
