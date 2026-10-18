// What the asker can do with each answer: pick it, mark it helpful, and
// later say whether the pick turned out right. Everyone sees the labels.
import { useId, useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { CHANGE_REASONS, type Answer, type ChangeReason, type Selection } from '../lib/questions.ts';
import { api } from '../session.tsx';
import { Button } from './Button.tsx';
import { Dialog } from './Dialog.tsx';

const check = <svg viewBox="0 0 14 11" aria-hidden="true" focusable="false"><path d="M1.5 5.5l3.5 3.5 7.5-7.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>;

export function AnswerLabels({ answer, picked, correct }: { answer: Answer; picked: boolean; correct: boolean | null }) {
  if (!picked && !answer.helpful) return null;
  return (
    <p className="answer-labels text-footnote">
      {picked && (
        <span className="label-picked">
          {check}
          {correct === true ? 'Helped the asker · turned out right' : correct === false ? 'Helped the asker · turned out wrong' : 'Helped the asker'}
        </span>
      )}
      {!picked && answer.helpful && <span className="secondary">Useful to the asker</span>}
    </p>
  );
}

interface Props {
  questionId: string;
  answer: Answer;
  selection: Selection | null;
  onChanged: () => Promise<void>;
}

export function AnswerActions({ questionId, answer, selection, onChanged }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosingReason, setChoosingReason] = useState(false);
  const [reason, setReason] = useState<ChangeReason | null>(null);
  const reasonsId = useId();

  const picked = selection?.answerId === answer.id;
  // A pick to change: one exists, it's another answer, and changes remain.
  const isChange = selection !== null && selection.answerId !== null && !picked;
  const canPick = !picked && (!isChange || selection.changesLeft > 0);

  /** True when it saved; on failure the reason is shown where the person is looking. */
  async function run(work: () => Promise<unknown>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await work();
      await onChanged();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That didn’t save. Try again in a minute.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const pick = (why?: ChangeReason) => run(() => api(`/questions/${questionId}/selection`, {
    method: 'PUT', signedIn: true, body: { answerId: answer.id, ...(why ? { reason: why } : {}) },
  }));
  const verdict = (correct: boolean) => run(() => api(`/answers/${answer.id}/verdict`, { method: 'PUT', signedIn: true, body: { correct } }));

  return (
    <div className="answer-actions">
      {canPick && (
        <Button variant="secondary" className="btn-compact" disabled={busy} onClick={() => { if (isChange) setChoosingReason(true); else void pick(); }}>
          {isChange ? 'This helped more' : 'This helped me'}
        </Button>
      )}
      {!answer.helpful && !picked && (
        <button type="button" className="btn btn-plain" disabled={busy} onClick={() => { void run(() => api(`/answers/${answer.id}/helpful`, { method: 'POST', signedIn: true })); }}>
          Also useful
        </button>
      )}
      {picked && (
        <div className="verdict">
          <span className="text-subhead" id={`verdict-${answer.id}`}>Did it turn out right?</span>
          <div className="segmented" role="group" aria-labelledby={`verdict-${answer.id}`}>
            <button type="button" aria-pressed={selection.correct === true} disabled={busy} onClick={() => { void verdict(true); }}>Yes</button>
            <button type="button" aria-pressed={selection.correct === false} disabled={busy} onClick={() => { void verdict(false); }}>No</button>
          </div>
        </div>
      )}
      {picked && selection.changesLeft < 2 && (
        <p className="text-footnote secondary">
          {selection.changesLeft === 0 ? 'You can’t change this pick again.' : 'You can change your pick 1 more time.'}
        </p>
      )}
      {error && !choosingReason && <p className="form-note tone-bad" role="alert">{error}</p>}

      <Dialog
        open={choosingReason}
        onClose={() => { if (!busy) { setChoosingReason(false); setReason(null); } }}
        title="Why are you changing your pick?"
        actions={
          <>
            <button type="button" className="btn btn-plain" disabled={busy} onClick={() => { setChoosingReason(false); setReason(null); }}>Cancel</button>
            <Button disabled={busy || reason === null} onClick={() => {
              if (!reason) return;
              void pick(reason).then(ok => { if (ok) { setChoosingReason(false); setReason(null); } });
            }}>Change pick</Button>
          </>
        }
      >
        <p>The points move to this answer. {selection?.changesLeft === 1 ? 'This is your last change for this question.' : 'You can change your pick 2 more times for this question.'}</p>
        <fieldset className="reasons" aria-describedby={reasonsId}>
          <legend id={reasonsId} className="visually-hidden">Reason</legend>
          {CHANGE_REASONS.map(r => (
            <label key={r.value} className="reason">
              <input type="radio" name={`reason-${answer.id}`} value={r.value} checked={reason === r.value} onChange={() => { setReason(r.value); }} />
              <span>{r.label}</span>
            </label>
          ))}
        </fieldset>
        {error && <p className="form-note tone-bad" role="alert">{error}</p>}
      </Dialog>
    </div>
  );
}
