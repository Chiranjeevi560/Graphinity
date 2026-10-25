import { useEffect, useState } from 'react';
import { Button } from './Button.tsx';
import { Dialog } from './Dialog.tsx';
import { ApiError } from '../lib/api.ts';
import { api } from '../session.tsx';

/**
 * The one-time privacy update (ADR 0015, migration 0019): says once what
 * changed about matching by meaning, and asks once about improving search for
 * everyone. Any answer, "Allow" or "Not now" (Escape counts as not now), is
 * recorded, so it never appears again; it can be changed in Privacy settings.
 */
export function PrivacyUpdate() {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ awaitingAnswer: string[] }>('/me/consents', { signedIn: true }).then(
      res => {
        if (!cancelled && res.awaitingAnswer.includes('search_improvement')) setOpen(true);
      },
      // Not knowing is no reason to interrupt: it is asked on a later visit.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const answer = async (enabled: boolean) => {
    setSaving(true);
    setError(null);
    try {
      await api('/me/consents', {
        method: 'PUT',
        signedIn: true,
        body: { choices: [{ category: 'search_improvement', enabled }] },
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your choice couldn’t be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      // Closing after an answer is not another answer; only Escape means "Not now".
      onClose={() => {
        setOpen(false);
      }}
      onCancel={() => {
        if (!saving) void answer(false);
      }}
      title="Two privacy updates"
      actions={
        <>
          <Button variant="secondary" onClick={() => void answer(false)} disabled={saving}>
            Not now
          </Button>
          <Button onClick={() => void answer(true)} disabled={saving}>
            {saving ? 'Saving…' : 'Allow'}
          </Button>
        </>
      }
    >
      <p>
        <strong>Matching by meaning stays on Graphinity.</strong> Finding questions asked in other words now runs on
        Graphinity’s own servers, for everyone. Nothing is sent to an outside AI.
      </p>
      <p>
        <strong>Help improve search for everyone?</strong> If you allow it, your searches, the results you’re shown and
        open, and the time you spend on them help Graphinity rank results better. Deleted the moment you turn it off;
        kept a year at most.
      </p>
      <p className="secondary">You can change this any time in Privacy settings.</p>
      {error && (
        <p className="form-note tone-bad" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
