import { useEffect, useState } from 'react';
import { GoogleButton } from '../components/GoogleButton.tsx';
import { SignInError, signInMessages } from '../lib/auth.ts';
import { navigate } from '../lib/router.ts';
import { auth, useSession } from '../session.tsx';

// The one-time code is read and wiped from the address bar the moment this
// module first runs for a callback, before any network request, so it never
// lingers in history, bookmarks or a shared screenshot.
let finishing: Promise<{ returnTo: string }> | null = null;
function finishOnce(): Promise<{ returnTo: string }> {
  if (!finishing) {
    const params = new URLSearchParams(location.search);
    history.replaceState(null, '', '/auth/callback');
    finishing = auth.completeSignIn(params).finally(() => {
      // Let a later, separate sign-in start fresh.
      setTimeout(() => { finishing = null; }, 0);
    });
  }
  return finishing;
}

export default function AuthCallback() {
  const { reload } = useSession();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    finishOnce()
      .then(async ({ returnTo }) => {
        await reload();
        if (alive) navigate(returnTo, { replace: true });
      })
      .catch((err: unknown) => {
        if (alive) setError(err instanceof SignInError ? signInMessages[err.reason] : signInMessages.rejected);
      });
    return () => { alive = false; };
  }, [reload]);

  if (!error) {
    return (
      <main className="page stack-message">
        <p className="text-body status" role="status">Signing you in…</p>
      </main>
    );
  }
  return (
    <main className="page stack-message">
      <h1 className="text-title2">Sign-in didn’t finish</h1>
      <p className="text-body secondary">{error}</p>
      <GoogleButton />
    </main>
  );
}
