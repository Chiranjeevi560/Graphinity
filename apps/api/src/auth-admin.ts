// The one privileged call the server makes to Supabase Auth: deleting a
// person's sign-in when they delete their account. It uses the project's
// secret key, which can do anything in the project; it lives only in the
// server's environment and is never sent anywhere but Supabase.

export interface AuthAdmin {
  deleteUser(id: string): Promise<void>;
}

export class AuthAdminError extends Error {
  override name = 'AuthAdminError';
}

export function createSupabaseAdmin(options: {
  supabaseUrl: string;
  secretKey: string;
  fetch?: typeof fetch;
}): AuthAdmin {
  const doFetch = options.fetch ?? fetch;
  const headers: Record<string, string> = { apikey: options.secretKey, 'content-type': 'application/json' };
  // Legacy service_role keys are JWTs and also go in Authorization; new
  // sb_secret_ keys must not (Supabase: "send ... on the apikey header").
  if (options.secretKey.split('.').length === 3) headers.authorization = `Bearer ${options.secretKey}`;

  return {
    async deleteUser(id) {
      const url = new URL(`/auth/v1/admin/users/${encodeURIComponent(id)}`, options.supabaseUrl);
      const res = await doFetch(url, {
        method: 'DELETE',
        headers,
        body: JSON.stringify({ should_soft_delete: false }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      // Already gone (a retry after an earlier success) is also done, but only
      // when Supabase itself says so; any other 404 (wrong path, a proxy or
      // maintenance page) must not be mistaken for a finished deletion.
      if (res.status === 404) {
        const body = (await res.json().catch(() => null)) as { error_code?: unknown } | null;
        if (body?.error_code === 'user_not_found') return;
      }
      throw new AuthAdminError(`status ${res.status}`);
    },
  };
}
