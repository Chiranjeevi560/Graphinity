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
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
};

const mergeBase = git(['merge-base', base, 'HEAD'])?.trim();
if (!mergeBase) {
  console.error(`floor-guard: no merge base against ${base}`);
  process.exit(2);
}

const tracked = git(['diff', '--unified=0', mergeBase, '--']) ?? '';
const untracked = (git(['ls-files', '--others', '--exclude-standard']) ?? '')
  .split('\n')
  .filter(Boolean)
  .map(f => {
    try {
      execFileSync('git', ['diff', '--no-index', '--unified=0', '/dev/null', f], { encoding: 'utf8' });
      return '';
    } catch (e) {
      return e.stdout ?? '';
    }
  })
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
// A changed number is approved by naming its whole row, one trailer per row
// (row names contain commas), e.g. "Constraints-approved: Coverage, server".
const approvals = [
  ...(git(['log', `${mergeBase}..HEAD`, '--format=%B']) ?? '').matchAll(/^Constraints-approved:\s*(.+)$/gm),
].map(m => m[1]);
const approved = new Set(approvals.flatMap(a => a.split(/[,\s]+/).filter(Boolean)));
const rowApproved = row => approvals.some(a => a.trim() === row);
const findings = [];
const flag = (rule, f, text) => findings.push({ rule, file: f, text: text.trim().slice(0, 120) });

const SUPPRESSIONS =
  /@ts-ignore|@ts-nocheck|@ts-expect-error|eslint-disable|istanbul ignore|c8 ignore|v8 ignore|nosemgrep|gitleaks:allow/;
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
const assertionReasons = [
  ...(git(['log', `${mergeBase}..HEAD`, '--format=%B']) ?? '').matchAll(/^Assertions-changed:\s*(\S.{9,})$/gm),
];

// An assertion call removed from a test file, unless the same code was added
// back in that file (moved, reorganised, or re-wrapped by the formatter).
// Layout doesn't count: whitespace and the trailing commas a formatter adds
// are ignored, and the code may now span several lines. Any other change to
// the assertion (a value, a matcher) still counts as removed. Imports don't.
const code = s => s.replace(/\s+/g, '').replace(/,(?=[)\]}])/g, '');
// Joined before normalising, so a comma at the end of one line meets the bracket on the next.
const addedText = new Map();
for (const { file: f, text } of added) addedText.set(f, `${addedText.get(f) ?? ''}\n${text}`);
const addedCode = new Map([...addedText].map(([f, t]) => [f, code(t)]));
for (const { file: f, text } of removed) {
  if (!/\.(test|spec)\.ts$/.test(f) || /^\s*import\b/.test(text)) continue;
  if (!/\b(expect|assert)(\.\w+)*\(/.test(text)) continue;
  if (addedCode.get(f)?.includes(code(text))) continue;
  if (assertionReasons.length > 0) continue;
  flag('assertion-removed', f, text);
}

// ESLint silently honours a suppressions file: bringing one back hides findings.
for (const f of (git(['diff', '--name-only', '--diff-filter=A', mergeBase, '--']) ?? '').split('\n')) {
  if (/(^|\/)eslint-suppressions\.json$/.test(f)) flag('silenced-checker', f, '(lint suppressions file added)');
}

// A deleted test file is a test made easier.
for (const f of (git(['diff', '--name-only', '--diff-filter=D', mergeBase, '--']) ?? '').split('\n').filter(Boolean)) {
  if (/\.(test|spec)\.ts$/.test(f)) flag('test-deleted', f, '(file deleted)');
}

// Any changed number on a CONSTRAINTS.md row, up or down. Deliberately not
// direction-aware: a row can hold a maximum and a minimum side by side, and
// guessing which is which wrongly would let a loosening through silently.
// Tightening costs one "Constraints-approved:" trailer; loosening stays loud.
const nums = s => (s.match(/\d+(\.\d+)?/g) ?? []).map(Number);
const rowKey = s => s.split('|')[1]?.trim();
const before = removed.filter(l => /CONSTRAINTS\.md$/.test(l.file));
const after = added.filter(l => /CONSTRAINTS\.md$/.test(l.file));
for (const r of before) {
  const a = after.find(x => rowKey(x.text) && rowKey(x.text) === rowKey(r.text));
  if (!a) continue;
  const old = nums(r.text);
  if (rowApproved(rowKey(a.text))) continue;
  if (nums(a.text).some((n, i) => old[i] !== undefined && n !== old[i]))
    flag('threshold-changed', r.file, `${r.text.trim()}  ->  ${a.text.trim()}`);
}

if (findings.length === 0) {
  console.log('floor-guard: clean');
  process.exit(0);
}
console.error(`floor-guard: ${findings.length} floor violation(s):`);
for (const f of findings) console.error(`  [${f.rule}] ${f.file}: ${f.text}`);
console.error(
  '\nEach one lowers the bar. Fix the code, or record a tracked exception in CONSTRAINTS.md with an owner and an expiry.',
);
process.exit(1);
