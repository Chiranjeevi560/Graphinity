import type { Auth } from './auth.ts';

export class ApiError extends Error {
  override name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const OFFLINE = 'You seem to be offline. Check your connection and try again.';
const UNKNOWN = 'Something went wrong. Try again in a minute.';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send the access token. Required routes fail early when signed out. */
  signedIn?: boolean;
}

export function createApi(deps: { origin: string; auth: Auth; fetch: typeof fetch }) {
  async function send(path: string, options: RequestOptions, token: string | null) {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return deps.fetch(`${deps.origin}${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  }

  return async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    let token: string | null = null;
    if (options.signedIn) {
      token = await deps.auth.getAccessToken();
      // No token but the session is still there: the refresh couldn't reach
      // Supabase (offline). Say so, instead of telling the person they're out.
      if (!token && deps.auth.hasSession()) throw new ApiError(0, 'offline', OFFLINE);
      if (!token) throw new ApiError(401, 'signed_out', 'You’re signed out. Sign in again to continue.');
    }
    let res: Response;
    try {
      res = await send(path, options, token);
      // The token may have been revoked or expired early: refresh once, retry once.
      if (res.status === 401 && options.signedIn) {
        token = await deps.auth.getAccessToken({ forceRefresh: true });
        if (!token) throw new ApiError(401, 'signed_out', 'You’re signed out. Sign in again to continue.');
        res = await send(path, options, token);
        if (res.status === 401) deps.auth.clear();
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw new ApiError(0, 'offline', OFFLINE);
    }
    if (res.status === 204) return undefined as T;
    const data = await res.json().catch(() => null) as Record<string, unknown> | null;
    if (!res.ok) {
      const { error, message, ...details } = data ?? {};
      throw new ApiError(res.status, typeof error === 'string' ? error : 'unknown',
        typeof message === 'string' ? message : UNKNOWN, details);
    }
    return data as T;
  };
}

export type Api = ReturnType<typeof createApi>;
