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

// A request that got no answer: either this device has no internet, or it
// does and Graphinity didn't answer. Saying "check your connection" when the
// connection is fine sends people to fix the wrong thing.
const OFFLINE = 'You’re offline. Connect to the internet and try again.';
const UNREACHABLE = 'Graphinity isn’t responding. Try again in a moment.';
const UNKNOWN = 'Something went wrong. Try again in a minute.';

/** Worth trying again unchanged: no answer, a server fault, or too many requests. */
export function canRetry(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true;
  return err.code === 'offline' || err.code === 'unreachable' || err.status >= 500 || err.status === 429;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** Send the access token. Required routes fail early when signed out. */
  /**
   * true: must be signed in. 'if-possible': send the sign-in when there is
   * one (an author sees their own hidden post), else read as a visitor.
   */
  signedIn?: boolean | 'if-possible';
}

export function createApi(deps: {
  origin: string;
  auth: Auth;
  fetch: typeof fetch;
  /** Whether the device has a network at all (navigator.onLine). */
  online: () => boolean;
}) {
  const noAnswer = () =>
    deps.online() ? new ApiError(0, 'unreachable', UNREACHABLE) : new ApiError(0, 'offline', OFFLINE);

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
    if (options.signedIn === 'if-possible') {
      token = deps.auth.hasSession() ? await deps.auth.getAccessToken() : null;
    } else if (options.signedIn) {
      token = await deps.auth.getAccessToken();
      // No token but the session is still there: the refresh couldn't reach
      // Supabase. Say so, instead of telling the person they're signed out.
      if (!token && deps.auth.hasSession()) throw noAnswer();
      if (!token) throw new ApiError(401, 'signed_out', 'You’re signed out. Sign in again to continue.');
    }
    let res: Response;
    try {
      res = await send(path, options, token);
      // The token may have been revoked or expired early: refresh once, retry once.
      if (res.status === 401 && options.signedIn === true) {
        token = await deps.auth.getAccessToken({ forceRefresh: true });
        if (!token) throw new ApiError(401, 'signed_out', 'You’re signed out. Sign in again to continue.');
        res = await send(path, options, token);
        if (res.status === 401) deps.auth.clear();
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw noAnswer();
    }
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) {
      const { error, message, ...details } = data ?? {};
      throw new ApiError(
        res.status,
        typeof error === 'string' ? error : 'unknown',
        typeof message === 'string' ? message : UNKNOWN,
        details,
      );
    }
    return data as T;
  };
}

export type Api = ReturnType<typeof createApi>;
