import { execFileSync } from 'node:child_process';

// The API needs the local database; start it (idempotent) before any server.
// CI prepares its own Postgres service and .local/api.env instead.
export default function globalSetup() {
  if (process.env.CI) return;
  execFileSync('sh', ['scripts/db.sh', 'start'], { stdio: 'inherit' });
}
