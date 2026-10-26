import { useEffect, useId, useState } from 'react';
import { Button } from './Button.tsx';
import { Dialog } from './Dialog.tsx';
import { ApiError } from '../lib/api.ts';
import { api } from '../session.tsx';
import './consent-welcome.css';

interface Category {
  name: string;
  purpose: string;
}

/** Plain words for a purpose's name: "ads_measurement" → "Ads measurement", "ai_…" → "AI …". */
const label = (name: string) =>
  (name.charAt(0).toUpperCase() + name.slice(1).replaceAll('_', ' ')).replace(/^Ai\b/, 'AI');

/**
 * The welcome consent screen (ADR 0023): asks once about every optional use of
 * a person's data they have never answered, including any added later. Three
 * answers of equal weight, side by side, each one tap: "Essential only",
 * "Choose", "Accept all". Nothing is ticked in advance; "Accept all" turns on
 * only what the law where they live allows (the server decides what's asked).
 * Escape counts as "Essential only", the answer that shares nothing. Every
 * answer is recorded, so it doesn't come back until a new purpose does.
 */
export function ConsentWelcome() {
  const [asked, setAsked] = useState<Category[]>([]);
  const [open, setOpen] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();

  useEffect(() => {
    let cancelled = false;
    api<{ unanswered: string[]; categories: Category[] }>('/me/consents', { signedIn: true }).then(
      res => {
        if (cancelled || !res.unanswered.length) return;
        setAsked(res.categories.filter(c => res.unanswered.includes(c.name)));
        setOpen(true);
      },
      // Not knowing is no reason to interrupt: it is asked on a later visit.
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, []);

  const answer = async (allowed: (name: string) => boolean) => {
    setSaving(true);
    setError(null);
    try {
      await api('/me/consents', {
        method: 'PUT',
        signedIn: true,
        body: { source: 'onboarding', choices: asked.map(c => ({ category: c.name, enabled: allowed(c.name) })) },
      });
      setOpen(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Your choice couldn’t be saved. Try again.');
    } finally {
      setSaving(false);
    }
  };
  const essentialOnly = () => void answer(() => false);
  const acceptAll = () => void answer(() => true);

  return (
    <Dialog
      open={open}
      onClose={() => {
        setOpen(false);
      }}
      onCancel={() => {
        if (!saving) essentialOnly();
      }}
      title="Your data, your choice"
      actions={
        <div className="consent-actions">
          <Button variant="secondary" onClick={essentialOnly} disabled={saving}>
            Essential only
          </Button>
          {choosing ? (
            <Button variant="secondary" onClick={() => void answer(name => chosen.has(name))} disabled={saving}>
              Save choices
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                setChoosing(true);
              }}
              disabled={saving}
              aria-expanded={false}
              aria-controls={listId}
            >
              Choose
            </Button>
          )}
          <Button variant="secondary" onClick={acceptAll} disabled={saving}>
            Accept all
          </Button>
        </div>
      }
    >
      <p>
        Graphinity needs only your account to work. Every other use of your data is up to you, and stays off until you
        allow it.
      </p>
      {choosing ? (
        <fieldset id={listId} className="consent-list">
          <legend className="text-subhead secondary">Allow only what you tick.</legend>
          {asked.map(c => (
            <label key={c.name} className="consent-choice">
              <input
                type="checkbox"
                checked={chosen.has(c.name)}
                disabled={saving}
                onChange={e => {
                  const on = e.currentTarget.checked;
                  setChosen(current => {
                    const next = new Set(current);
                    if (on) next.add(c.name);
                    else next.delete(c.name);
                    return next;
                  });
                }}
              />
              <strong>{label(c.name)}</strong>
              <span className="text-subhead secondary consent-purpose">{c.purpose}</span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="secondary">
          “Accept all” allows the {asked.length} uses listed under “Choose”. Change any of them later in Privacy
          settings.
        </p>
      )}
      {error && (
        <p className="form-note tone-bad" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
