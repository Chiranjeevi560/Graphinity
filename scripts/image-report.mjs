#!/usr/bin/env node
// Summarises osv-scanner's scan of the API image (JSON) for the run and its
// pull request. The image's npm packages are already held to "nothing high
// or above" by `npm run check:deps` on the lockfile, which fails the build.
// The rest is the Debian base: those findings are reported here, high and
// critical as warnings, without failing the build (CONSTRAINTS.md, measured
// not enforced), because a fixed Debian package arrives only with a newer
// base digest, which Dependabot proposes.
//
//   node scripts/image-report.mjs image-vulns.json
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/image-report.mjs <osv-scanner json>');
const report = JSON.parse(readFileSync(file, 'utf8'));

const rows = [];
for (const result of report.results ?? [])
  for (const p of result.packages ?? [])
    for (const g of p.groups ?? []) {
      // An empty rating is unrated, not zero.
      const severity = g.max_severity === undefined || g.max_severity === '' ? NaN : Number(g.max_severity);
      rows.push({
        name: p.package?.name ?? '?',
        version: p.package?.version ?? '?',
        ecosystem: p.package?.ecosystem ?? '?',
        ids: (g.ids ?? []).slice(0, 3).join(', '),
        severity: Number.isFinite(severity) ? severity : null,
      });
    }

const band = s => (s === null ? 'unrated' : s >= 9 ? 'critical' : s >= 7 ? 'high' : s >= 4 ? 'medium' : 'low');
const counts = {};
for (const r of rows) counts[band(r.severity)] = (counts[band(r.severity)] ?? 0) + 1;
const summary =
  rows.length === 0
    ? 'no known vulnerabilities'
    : Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ');
console.log(`API image: ${summary}`);

const serious = rows.filter(r => r.severity !== null && r.severity >= 7);
for (const r of serious) console.log(`  ${band(r.severity)} ${r.ecosystem} ${r.name} ${r.version}: ${r.ids}`);
if (process.env.GITHUB_ACTIONS) {
  console.log(`::notice title=API image vulnerabilities::${summary}`);
  for (const r of serious.slice(0, 10))
    console.log(`::warning title=API image (${band(r.severity)})::${r.ecosystem} ${r.name} ${r.version}: ${r.ids}`);
}
