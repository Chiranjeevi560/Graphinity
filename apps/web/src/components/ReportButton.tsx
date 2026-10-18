import { useId, useState } from 'react';
import { ApiError } from '../lib/api.ts';
import { api } from '../session.tsx';
import { Button } from './Button.tsx';
import { Dialog } from './Dialog.tsx';
import { TextArea } from './Form.tsx';

const REASONS = [
  { value: 'spam', label: 'Spam or advertising' },
  { value: 'abuse', label: 'Abusive or hateful' },
  { value: 'private_info', label: 'Shares someone’s private information' },
  { value: 'misleading', label: 'Misleading or dangerous' },
  { value: 'other', label: 'Something else' },
] as const;

/** "Report…" for one question or answer. Reports are private; three from different people hide a post until it's reviewed. */
export function ReportButton({ kind, id }: { kind: 'question' | 'answer'; id: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const legendId = useId();

  if (sent) return <span className="text-footnote secondary report-sent">Reported. Thank you.</span>;

  async function send() {
    if (!reason) return;
    setSending(true);
    setError(null);
    try {
      await api(`/${kind}s/${id}/report`, { method: 'POST', signedIn: true, body: { reason, ...(note.trim() ? { note } : {}) } });
      setOpen(false);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The report didn’t send. Try again in a minute.');
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-plain report-button" onClick={() => { setOpen(true); }}>Report…</button>
      <Dialog
        open={open}
        onClose={() => { if (!sending) setOpen(false); }}
        title={kind === 'question' ? 'Report this question' : 'Report this answer'}
        actions={
          <>
            <Button variant="secondary" disabled={sending} onClick={() => { setOpen(false); }}>Cancel</Button>
            <Button disabled={sending || reason === null} onClick={() => { void send(); }}>{sending ? 'Sending…' : 'Send report'}</Button>
          </>
        }
      >
        <p>Only moderators see reports, never who sent them.</p>
        <fieldset className="reasons" aria-labelledby={legendId}>
          <legend id={legendId} className="visually-hidden">What’s wrong?</legend>
          {REASONS.map(r => (
            <label key={r.value} className="reason">
              <input type="radio" name={`report-${kind}-${id}`} value={r.value} checked={reason === r.value} onChange={() => { setReason(r.value); }} />
              <span>{r.label}</span>
            </label>
          ))}
        </fieldset>
        <TextArea label="Anything to add? (optional)" value={note} onChange={setNote} rows={3} maxLength={500} />
        {error && <p className="form-note tone-bad" role="alert">{error}</p>}
      </Dialog>
    </>
  );
}
