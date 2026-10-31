import { useState } from 'react';
import { Button } from '../components/Button.tsx';
import { ApiError } from '../lib/api.ts';
import { api } from '../session.tsx';

const KINDS = [
  ['general', 'Something else'],
  ['personal_data', 'My personal data'],
  ['impersonation', 'Someone is pretending to be me'],
  ['unlawful_content', 'Unlawful content'],
  ['copyright', 'Copyright'],
] as const;

interface Ticket {
  reference: string;
  acknowledgeBy: string;
  resolveBy: string;
}

/** A complaint, with a reference to quote and dates Graphinity must meet (ADR 0027). */
export default function Complaint() {
  const [kind, setKind] = useState<string>('general');
  const [body, setBody] = useState('');
  const [sworn, setSworn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<Ticket | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ grievance: Ticket }>('/grievances', {
        method: 'POST',
        signedIn: true,
        body: { kind, body, ...(kind === 'copyright' ? { sworn } : {}) },
      });
      setTicket(res.grievance);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That didn’t send. Try again.');
    } finally {
      setBusy(false);
    }
  }

  if (ticket)
    return (
      <main className="page legal">
        <h1 className="text-title1">We have your complaint</h1>
        <p className="text-body">
          Your reference is <strong>{ticket.reference}</strong>. Keep it to ask about this later.
        </p>
        <p className="text-body secondary">
          We’ll acknowledge it by {new Date(ticket.acknowledgeBy).toLocaleString()} and resolve it by{' '}
          {new Date(ticket.resolveBy).toLocaleString()}.
        </p>
      </main>
    );

  return (
    <main className="page legal">
      <h1 className="text-title1">Make a complaint</h1>
      <p className="text-body secondary">Tell us what’s wrong. A person reads every complaint.</p>
      <div className="field">
        <label htmlFor="complaint-kind" className="text-subhead">
          What is it about?
        </label>
        <select
          id="complaint-kind"
          className="input"
          value={kind}
          onChange={e => {
            setKind(e.target.value);
          }}
        >
          {KINDS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="complaint-body" className="text-subhead">
          What happened? Link the post if there is one.
        </label>
        <textarea
          id="complaint-body"
          className="input"
          rows={6}
          maxLength={4000}
          value={body}
          onChange={e => {
            setBody(e.target.value);
          }}
        />
      </div>
      {kind === 'copyright' && (
        <label className="text-body">
          <input
            type="checkbox"
            checked={sworn}
            onChange={e => {
              setSworn(e.target.checked);
            }}
          />{' '}
          I swear this notice is accurate and I own the rights or act for whoever does.
        </label>
      )}
      {error && (
        <p className="form-note tone-bad" role="alert">
          {error}
        </p>
      )}
      <Button
        disabled={busy || body.trim().length < 10 || (kind === 'copyright' && !sworn)}
        onClick={() => void send()}
      >
        {busy ? 'Sending…' : 'Send complaint'}
      </Button>
    </main>
  );
}
