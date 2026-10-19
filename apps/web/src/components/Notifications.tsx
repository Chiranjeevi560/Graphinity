import { useEffect, useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { isPushOn, pushSupport, turnPushOff, turnPushOn } from '../lib/push.ts';
import { api } from '../session.tsx';

/** Notifications for this device, when the site is closed. Hidden if the server has push off. */
export function Notifications() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const support = pushSupport();

  useEffect(() => {
    let live = true;
    api<{ publicKey: string }>('/push/key')
      .then(async res => {
        // Can't check right now: show it off; turning it on again is harmless.
        const current = await isPushOn(api).catch(() => false);
        if (live) {
          setPublicKey(res.publicKey);
          setOn(current);
        }
      })
      .catch(() => {
        /* push is off on the server: show nothing */
      });
    return () => {
      live = false;
    };
  }, []);

  if (!publicKey || on === null) return null;

  async function toggle() {
    if (!publicKey) return;
    setBusy(true);
    setNote(null);
    try {
      if (on) {
        await turnPushOff(api);
        setOn(false);
      } else if ((await turnPushOn(api, publicKey)) === 'denied') {
        setNote(
          'Notifications are blocked for this site. You can allow them in your browser’s settings, then try again.',
        );
      } else {
        setOn(true);
      }
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'That didn’t work. Try again in a minute.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="profile-section" aria-labelledby="notifications-heading">
      <h2 id="notifications-heading" className="text-headline">
        Notifications
      </h2>
      <p className="text-subhead secondary">
        When a question is put to you, or someone answers yours, even with Graphinity closed.
      </p>
      {support === 'install-first' && (
        <p className="text-subhead">
          On iPhone and iPad, add Graphinity to your Home Screen first: tap Share, then “Add to Home Screen”, and open
          it from there.
        </p>
      )}
      {support === 'unsupported' && <p className="text-subhead secondary">This browser can’t show notifications.</p>}
      {support === 'ok' && (
        <button
          type="button"
          className="btn btn-plain notifications-toggle"
          disabled={busy}
          onClick={() => {
            void toggle();
          }}
        >
          {on ? 'Turn off on this device' : 'Turn on for this device'}
        </button>
      )}
      {note && (
        <p className="form-note tone-bad" role="alert">
          {note}
        </p>
      )}
    </section>
  );
}
