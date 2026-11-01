import { describe, expect, it } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.ts';
import { connectionSettings, isLocal, targetHost, tlsProblem } from '../src/db-target.ts';

const remote = 'postgres://u:hunter2xyz@aws-0.pooler.supabase.com:5432/postgres';

describe('where a connection goes', () => {
  it('names the host and never the password', () => {
    expect(targetHost(remote)).toBe('aws-0.pooler.supabase.com');
    expect(targetHost(remote)).not.toContain('hunter2xyz');
    expect(targetHost('not a url')).toBe('unknown');
  });
  it('knows this computer, by name or socket', () => {
    for (const u of [
      'postgres://localhost/x',
      'postgres://127.0.0.1:5432/x',
      'postgres:///x?host=/tmp/sock',
      'postgres://[::1]/x',
    ])
      expect(isLocal(u), u).toBe(true);
    expect(isLocal(remote)).toBe(false);
    // A socket-looking value elsewhere isn't a socket.
    expect(isLocal('postgres://db.example/x?host=db.example')).toBe(false);
  });
});

describe('encryption', () => {
  it('is required for anything remote, and modes that skip it or checking are refused', () => {
    expect(tlsProblem('postgres://localhost/x')).toBeNull();
    expect(tlsProblem(remote)).toMatch(/encrypted/);
    for (const mode of ['disable', 'prefer', 'allow', 'no-verify'])
      expect(tlsProblem(`${remote}?sslmode=${mode}`), mode).toMatch(/encrypted/);
    for (const mode of ['require', 'verify-ca', 'verify-full'])
      expect(tlsProblem(`${remote}?sslmode=${mode}`), mode).toBeNull();
  });
  it('a CA keeps verification on, and the string can’t override it', () => {
    expect(connectionSettings(`${remote}?sslmode=require`)).toEqual({ connectionString: `${remote}?sslmode=require` });
    const s = connectionSettings(`${remote}?sslmode=require`, 'PEM');
    expect(s).toEqual({ connectionString: remote, ssl: { ca: 'PEM', rejectUnauthorized: true } });
  });
  it('a production server refuses to start without it', () => {
    const env = {
      NODE_ENV: 'production',
      APP_ENV: 'production',
      DATABASE_URL: remote,
    };
    let message = '';
    try {
      loadConfig(env);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      message = String(err);
    }
    expect(message).toMatch(/sslmode=require/);
    expect(message).not.toContain('hunter2xyz');
  });
});
