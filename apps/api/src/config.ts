// Reads configuration from the environment once, at startup, and refuses to
// start if anything is missing or unsafe. A server that boots with a weak or
// absent secret is worse than one that doesn't boot.

export interface Config {
  production: boolean;
  host: string;
  port: number;
  databaseUrl: string;
  /** The one website origin allowed to call this API from a browser. */
  webOrigin: string;
  /**
   * How many reverse proxies sit in front of the server. Only that many
   * X-Forwarded-For entries are trusted; anything further left was written
   * by the client and could be forged to dodge rate limits. Measure it on
   * each host before setting it (docs/RUNBOOK.md).
   */
  trustProxyHops: number;
  /**
   * Key for one-way hashes: visitor addresses (rate limits) and deleted
   * account ids. Neither is ever stored in readable form.
   */
  ipHashKey: Buffer;
  /** Supabase project URL, e.g. https://abcd.supabase.co. Tokens must be issued by it. */
  supabaseUrl: string;
  /** Supabase secret key, used only to delete a person's sign-in. */
  supabaseSecretKey: string;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const production = env.NODE_ENV === 'production';

  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be a port number');

  const databaseUrl = env.DATABASE_URL ?? '';
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) problems.push('DATABASE_URL must be a postgres:// URL');

  const webOrigin = env.WEB_ORIGIN ?? (production ? '' : 'http://localhost:5173');
  if (!isOrigin(webOrigin)) problems.push('WEB_ORIGIN must be an origin like https://example.pages.dev (no path)');
  else if (production && !webOrigin.startsWith('https://')) problems.push('WEB_ORIGIN must use https in production');

  // In development there is no proxy. In production the value must be
  // measured and set deliberately, so there is no default.
  const hopsRaw = env.TRUST_PROXY_HOPS ?? (production ? undefined : '0');
  const trustProxyHops = Number(hopsRaw);
  if (hopsRaw === undefined || !Number.isInteger(trustProxyHops) || trustProxyHops < 0 || trustProxyHops > 5) {
    problems.push('TRUST_PROXY_HOPS must be set to the measured number of proxies (0-5)');
  }

  const keyHex = env.IP_HASH_KEY ?? '';
  if (!/^[0-9a-f]{64,}$/i.test(keyHex)) problems.push('IP_HASH_KEY must be at least 32 random bytes in hex (openssl rand -hex 32)');

  const supabaseUrl = env.SUPABASE_URL ?? (production ? '' : 'http://localhost:54321');
  if (!isOrigin(supabaseUrl)) problems.push('SUPABASE_URL must be an origin like https://abcd.supabase.co');
  else if (production && !supabaseUrl.startsWith('https://')) problems.push('SUPABASE_URL must use https in production');

  const supabaseSecretKey = env.SUPABASE_SECRET_KEY ?? '';
  if (supabaseSecretKey.length < 20) problems.push('SUPABASE_SECRET_KEY must be set (Supabase: Project Settings → API Keys → secret)');

  // Values are never echoed: they may be secrets.
  if (problems.length) throw new ConfigError(`Configuration problems:\n  - ${problems.join('\n  - ')}`);

  return {
    production,
    host: env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port,
    databaseUrl,
    webOrigin,
    trustProxyHops,
    ipHashKey: Buffer.from(keyHex, 'hex'),
    supabaseUrl,
    supabaseSecretKey,
  };
}

function isOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === value;
  } catch {
    return false;
  }
}
