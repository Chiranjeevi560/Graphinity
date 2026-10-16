// First-time setup, one decision per screen: name, country, fields.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../components/Button.tsx';
import { Checkbox, ChipPicker, SelectField, TextField } from '../components/Form.tsx';
import { ApiError } from '../lib/api.ts';
import { navigate } from '../lib/router.ts';
import { api, useSession, type Profile } from '../session.tsx';
import { guessCountry, useHandleCheck, useMeta } from './profile-form.ts';

const MAX_FIELDS = 8;

export default function Welcome() {
  const { setProfile } = useSession();
  const { meta, error: metaError } = useMeta();
  const [step, setStep] = useState(1);
  const [handle, setHandle] = useState('');
  const [country, setCountry] = useState('');
  const [fields, setFields] = useState<Set<string>>(new Set());
  const [adult, setAdult] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const check = useHandleCheck(handle);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (meta && !country) setCountry(guessCountry(meta.countries.map(c => c.code)) || '');
  }, [meta, country]);

  // Move focus to each step's heading, so keyboard and screen reader users
  // know the screen changed.
  useEffect(() => { if (step > 1) heading.current?.focus(); }, [step]);

  if (metaError) return <main className="page stack-message"><p className="text-body" role="alert">{metaError}</p></main>;
  if (!meta) return <main className="page stack-message"><p className="text-body status" role="status">Loading…</p></main>;

  const toggle = (slug: string) => setFields(prev => {
    const next = new Set(prev);
    if (next.has(slug)) next.delete(slug); else if (next.size < MAX_FIELDS) next.add(slug);
    return next;
  });

  async function create(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { profile } = await api<{ profile: Profile }>('/me/profile', {
        method: 'POST', signedIn: true,
        body: { handle, country, fields: [...fields], adult: true },
      });
      setProfile(profile);
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'handle_taken' || err.code === 'invalid_handle')) {
        // Someone took the name meanwhile: back to the name step, with the reason.
        check.setStatus({ tone: 'bad', text: err.message });
        check.setAvailable(false);
        setStep(1);
      } else {
        setSubmitError(err instanceof ApiError ? err.message : 'Something went wrong. Try again in a minute.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="page onboarding">
      <div className="onboarding-top">
        {step > 1 ? <button type="button" className="btn btn-plain" onClick={() => setStep(step - 1)}>Back</button> : <span />}
        <p className="text-footnote secondary" aria-live="polite">Step {step} of 3</p>
      </div>

      {step === 1 && (
        <form className="onboarding-step" onSubmit={e => { e.preventDefault(); if (check.available) setStep(2); }}>
          <h1 className="text-title1" tabIndex={-1}>Choose your name</h1>
          <p className="text-body secondary">This is how people see you on Graphinity. It isn’t taken from your Google account.</p>
          <TextField
            label="Name"
            prefix="@"
            value={handle}
            onChange={setHandle}
            status={check.status}
            hint="Letters, numbers, dots and underscores."
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={24}
            autoFocus
          />
          <Button type="submit" className="btn-block" disabled={!check.available}>Continue</Button>
        </form>
      )}

      {step === 2 && (
        <form className="onboarding-step" onSubmit={e => { e.preventDefault(); if (country) setStep(3); }}>
          <h1 ref={heading} className="text-title1" tabIndex={-1}>Where do you live?</h1>
          <p className="text-body secondary">Questions about your country reach you first. Your country shows on your profile.</p>
          <SelectField
            label="Country"
            value={country}
            onChange={setCountry}
            options={[{ value: '', label: 'Choose a country' }, ...meta.countries.map(c => ({ value: c.code, label: c.name }))]}
          />
          <Button type="submit" className="btn-block" disabled={!country}>Continue</Button>
        </form>
      )}

      {step === 3 && (
        <form className="onboarding-step" onSubmit={create}>
          <h1 ref={heading} className="text-title1" tabIndex={-1}>What do you know about?</h1>
          <p className="text-body secondary">Pick areas where you have real experience. You’ll be asked questions about them. You can change these later.</p>
          <ChipPicker legend="Your fields" options={meta.fields} selected={fields} onToggle={toggle} max={MAX_FIELDS} />
          <Checkbox checked={adult} onChange={setAdult}>I’m 18 or older</Checkbox>
          {submitError && <p className="form-note tone-bad" role="alert">{submitError}</p>}
          <Button type="submit" className="btn-block" disabled={fields.size === 0 || !adult || submitting}>
            {submitting ? 'Creating…' : 'Create profile'}
          </Button>
        </form>
      )}
    </main>
  );
}
