import { useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { api } from '../session.tsx';
import { useLoad } from '../use-load.ts';
import { Button } from './Button.tsx';

interface Statement {
  id: string;
  facts: string;
  termsGround: string | null;
  legalGround: string | null;
  redress: string;
  appealBy: string;
  appealStatus: 'none' | 'appealed' | 'upheld' | 'overturned';
}

const STATUS = {
  none: '',
  appealed: 'You appealed. Another moderator will decide.',
  upheld: 'Your appeal was decided: the removal stands.',
  overturned: 'Your appeal succeeded: the post is back.',
};

/** Decisions about this person's posts, why, and the appeal (ADR 0027). Nothing shows when there are none. */
export function Statements() {
  const { data } = useLoad<{ statements: Statement[] }>('/me/statements', true);
  const [why, setWhy] = useState<Record<string, string>>({});
  const [appealed, setAppealed] = useState<Record<string, true>>({});
  const [error, setError] = useState<string | null>(null);
  if (!data?.statements.length) return null;

  async function appeal(id: string) {
    setError(null);
    try {
      await api(`/me/statements/${id}/appeal`, { method: 'POST', signedIn: true, body: { why: why[id] ?? '' } });
      setAppealed(a => ({ ...a, [id]: true }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That didn’t send. Try again.');
    }
  }

  return (
    <section className="profile-section" aria-labelledby="statements-heading">
      <h2 id="statements-heading" className="text-headline">
        Decisions about your posts
      </h2>
      {data.statements.map(s => {
        const status = appealed[s.id] ? 'appealed' : s.appealStatus;
        const open = status === 'none' && new Date(s.appealBy) > new Date();
        return (
          <div key={s.id} className="review-item">
            <p className="text-body">{s.facts}</p>
            <p className="text-footnote secondary">Why: {s.legalGround ?? s.termsGround}</p>
            {status !== 'none' && <p className="text-subhead">{STATUS[status]}</p>}
            {open && (
              <>
                <label htmlFor={`appeal-${s.id}`} className="text-subhead">
                  Appeal by {new Date(s.appealBy).toLocaleDateString()}: why was this wrong?
                </label>
                <textarea
                  id={`appeal-${s.id}`}
                  className="input"
                  rows={3}
                  maxLength={2000}
                  value={why[s.id] ?? ''}
                  onChange={e => {
                    setWhy(w => ({ ...w, [s.id]: e.target.value }));
                  }}
                />
                <Button
                  variant="secondary"
                  disabled={(why[s.id] ?? '').trim().length < 10}
                  onClick={() => void appeal(s.id)}
                >
                  Send appeal
                </Button>
              </>
            )}
          </div>
        );
      })}
      {error && (
        <p className="form-note tone-bad" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
