// Which database a connection string points at, and how it must be reached. Pure, so the rules can be tested
// without one. Production data travels only over TLS; a CA can be supplied for hosts whose certificate chain
// Node doesn't trust by itself (Supabase's own CA), so verification stays on.
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '[::1]', '::1']);
const ENCRYPTED_MODES = new Set(['require', 'verify-ca', 'verify-full']);

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * Whether libraries could read this address differently: libpq and pg disagree on repeated parameters, and a comma
 * lists several hosts. Such an address counts as remote and unencrypted, the careful answer.
 */
function ambiguous(u: URL): boolean {
  const hosts = u.searchParams.getAll('host');
  return (
    hosts.length > 1 ||
    u.searchParams.getAll('sslmode').length > 1 ||
    hosts.some(h => h === '' || h.includes(',')) ||
    u.hostname.includes(',')
  );
}

/** The host a connection string reaches, never its password. A socket is `local`. */
export function targetHost(url: string): string {
  const u = parse(url);
  if (!u || ambiguous(u)) return 'unknown';
  // A `host` parameter wins over the address's own host, as it does for pg and libpq: `@localhost/db?host=prod` is prod.
  const host = u.searchParams.get('host') ?? u.hostname;
  return host.startsWith('/') || LOCAL_HOSTS.has(host) ? 'local' : host;
}

export const isLocal = (url: string) => targetHost(url) === 'local';

/** Whether a connection must be refused for not encrypting: remote, without an sslmode that encrypts. */
export function tlsProblem(url: string): string | null {
  if (isLocal(url)) return null;
  const u = parse(url);
  const mode = u?.searchParams.get('sslmode') ?? '';
  return u && !ambiguous(u) && ENCRYPTED_MODES.has(mode)
    ? null
    : 'must end with ?sslmode=require (or verify-full): the database is reached over the internet, so the connection has to be encrypted';
}

/**
 * Settings for the pg client. pg's parsed `sslmode` overrides an explicit `ssl`, so with a CA the
 * parameter comes out of the string, leaving a connection that encrypts and verifies against that CA.
 */
export function connectionSettings(url: string, caPem?: string | null) {
  if (!caPem) return { connectionString: url };
  const u = new URL(url);
  u.searchParams.delete('sslmode');
  return { connectionString: u.toString(), ssl: { ca: caPem, rejectUnauthorized: true } };
}
