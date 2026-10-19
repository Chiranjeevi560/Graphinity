// The one privileged call to Supabase: deleting a person's sign-in.
import { describe, expect, it } from 'vitest';
import { AuthAdminError, createSupabaseAdmin } from '../src/auth-admin.ts';

const ID = '7b1c3f0e-1d2a-4c5b-9e8f-0a1b2c3d4e5f';

function fakeFetch(status: number, body: string, contentType = 'application/json') {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const f = ((url: URL, init: RequestInit) => {
    calls.push({ url: url.toString(), init });
    return Promise.resolve(new Response(body, { status, headers: { 'content-type': contentType } }));
  }) as unknown as typeof fetch;
  return { f, calls };
}

const admin = (f: typeof fetch, secretKey = 'sb_secret_abcdefghijklmnopqrstuvwxyz') =>
  createSupabaseAdmin({ supabaseUrl: 'https://proj.supabase.co', secretKey, fetch: f });

describe('createSupabaseAdmin().deleteUser', () => {
  it('sends a hard delete to the admin endpoint with the secret key in apikey only', async () => {
    const { f, calls } = fakeFetch(200, '{}');
    await admin(f).deleteUser(ID);
    const call = calls[0];
    expect(call?.url).toBe(`https://proj.supabase.co/auth/v1/admin/users/${ID}`);
    expect(call?.init.method).toBe('DELETE');
    expect(JSON.parse(call?.init.body as string)).toEqual({ should_soft_delete: false });
    const headers = call?.init.headers as Record<string, string>;
    expect(headers.apikey).toBe('sb_secret_abcdefghijklmnopqrstuvwxyz');
    // Supabase: new secret keys go on apikey, never Authorization.
    expect(headers.authorization).toBeUndefined();
    expect(call?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('also sends a legacy service_role key (a JWT) as a bearer token', async () => {
    const { f, calls } = fakeFetch(200, '{}');
    await admin(f, 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln').deleteUser(ID);
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.c2ln',
    );
  });

  it('treats Supabase\'s own "user not found" as already done (a retry after success)', async () => {
    const { f } = fakeFetch(404, '{"code":404,"error_code":"user_not_found","msg":"User not found"}');
    await expect(admin(f).deleteUser(ID)).resolves.toBeUndefined();
  });

  it('treats any other 404 as a failure, so the deletion is retried rather than wrongly reported done', async () => {
    for (const [body, type] of [
      ['<h1>Not Found</h1>', 'text/html'],
      ['{"message":"no Route matched with those values"}', 'application/json'],
      ['', 'text/plain'],
    ]) {
      const { f } = fakeFetch(404, body ?? '', type);
      await expect(admin(f).deleteUser(ID), body).rejects.toBeInstanceOf(AuthAdminError);
    }
  });

  it('treats server errors and refusals as failures', async () => {
    for (const status of [401, 403, 500, 503]) {
      const { f } = fakeFetch(status, '{}');
      await expect(admin(f).deleteUser(ID), String(status)).rejects.toBeInstanceOf(AuthAdminError);
    }
  });
});
