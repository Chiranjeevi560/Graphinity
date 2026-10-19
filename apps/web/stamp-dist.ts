// node stamp-dist.ts <build> <out> [--local]
// Writes one environment's settings into a copy of the build (stamp.ts).
// Deployed, the values come from VITE_* variables and must all be set;
// --local uses this computer's servers and the sign-in stand-in.
import { settingsFromEnv, settingsProblems } from './src/lib/settings.ts';
import { stampDist } from './stamp.ts';

const [dist, out] = process.argv.slice(2).filter(a => !a.startsWith('--'));
const local = process.argv.includes('--local');
if (!dist || !out || dist === out) {
  console.error(
    'usage: node stamp-dist.ts <build> <out> [--local]  (out must differ from build: the build stays as it was)',
  );
  process.exit(2);
}
const settings = settingsFromEnv(process.env, local);
const problems = settingsProblems(settings, !local);
if (problems.length) {
  console.error(`Can't stamp the site:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
stampDist(dist, out, settings, { localHttp: local });
