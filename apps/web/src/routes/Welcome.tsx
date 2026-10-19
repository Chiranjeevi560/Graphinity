// First-time setup, one decision per screen: name, country, fields.
import { useEffect, useRef, useState, type SubmitEvent } from 'react';
import { Button } from '../components/Button.tsx';
import { Checkbox, ChipPicker, SelectField, TextField } from '../components/Form.tsx';
import { LoadFailed } from '../components/Message.tsx';
import { ApiError } from '../lib/api.ts';
import { safePath } from '../lib/auth.ts';
import { navigate } from '../lib/router.ts';
import { api, useSession, type Profile } from '../session.tsx';
import { guessCountry, useHandleCheck, useMeta } from './profile-form.ts';

const MAX_FIELDS = 8;

export default function Welcome() {
  const { setProfile } = useSession();
  const { meta, error: metaError, retry: retryMeta } = useMeta();
  const [step, setStep] = useState(1);
  const [handle, setHandle] = useState('');
  const [country, setCountry] = useState('');
  const [fields, setFields] = useState<Set<string>>(new Set());
  const [adult, setAdult] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const check = useHandleCheck(handle);
  const heading = useRef<HTMLHeadingElement>(null);

  // Pre-select a guess once, when the list arrives. Not again: choosing
  // "Choose a country" must not snap back to the guess.
  const guessed = useRef(false);
  useEffect(() => {
    if (!meta || guessed.current) return;
    guessed.current = true;
    setCountry(guessCountry(meta.countries.map(c => c.code)));
  }, [meta]);

  // Move focus to each step's heading, so keyboard and screen reader users
  // know the screen changed.
  useEffect(() => {
    if (step > 1) heading.current?.focus();
  }, [step]);

  if (metaError) return <LoadFailed error={metaError} onRetry={retryMeta} />;
  if (!meta)
    return (
      <main className="page stack-message">
        <p className="text-body status" role="status">
          Loading…
        </p>
      </main>
    );

  const toggle = (slug: string) => {
    setFields(prev => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else if (next.size < MAX_FIELDS) next.add(slug);
      return next;
    });
  };

  async function create(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { profile } = await api<{ profile: Profile }>('/me/profile', {
        method: 'POST',
        signedIn: true,
        body: { handle, country, fields: [...fields], adult: true },
      });
      setProfile(profile);
      // Back to where they were going (a question they wanted to answer), on this site only.
      navigate(safePath(new URLSearchParams(location.search).get('next') ?? '/'), { replace: true });
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'handle_taken' || err.code === 'invalid_handle')) {
        // Someone took the name meanwhile: back to the name step, with the reason.
        check.refuse(err.message);
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
        {step > 1 ? (
          <button
            type="button"
            className="btn btn-plain"
            onClick={() => {
              setStep(step - 1);
            }}
          >
            Back
          </button>
        ) : (
          <span />
        )}
        <p className="text-footnote secondary" aria-live="polite">
          Step {step} of 3
        </p>
      </div>

      {step === 1 && (
        <form
          className="onboarding-step"
          onSubmit={e => {
            e.preventDefault();
            if (check.available) setStep(2);
          }}
        >
          <h1 className="text-title1" tabIndex={-1}>
            Choose your name
          </h1>
          <p className="text-body secondary">
            This is how people see you on Graphinity. It isn’t taken from your Google account.
          </p>
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
          />
          <Button type="submit" className="btn-block" disabled={!check.available}>
            Continue
          </Button>
        </form>
      )}

      {step === 2 && (
        <form
          className="onboarding-step"
          onSubmit={e => {
            e.preventDefault();
            if (country) setStep(3);
          }}
        >
          <h1 ref={heading} className="text-title1" tabIndex={-1}>
            Where do you live?
          </h1>
          <p className="text-body secondary">
            Questions about your country reach you first. Your country shows on your profile.
          </p>
          <SelectField
            label="Country"
            value={country}
            onChange={setCountry}
            options={[
              { value: '', label: 'Choose a country' },
              ...meta.countries.map(c => ({ value: c.code, label: c.name })),
            ]}
          />
          <Button type="submit" className="btn-block" disabled={!country}>
            Continue
          </Button>
        </form>
      )}

      {step === 3 && (
        <form
          className="onboarding-step"
          onSubmit={e => {
            void create(e);
          }}
        >
          <h1 ref={heading} className="text-title1" tabIndex={-1}>
            What do you know about?
          </h1>
          <p className="text-body secondary">
            Pick areas where you have real experience. You’ll be asked questions about them. You can change these later.
          </p>
          <ChipPicker legend="Your fields" options={meta.fields} selected={fields} onToggle={toggle} max={MAX_FIELDS} />
          <Checkbox checked={adult} onChange={setAdult}>
            I’m 18 or older
          </Checkbox>
          {submitError && (
            <p className="form-note tone-bad" role="alert">
              {submitError}
            </p>
          )}
          <Button type="submit" className="btn-block" disabled={fields.size === 0 || !adult || submitting}>
            {submitting ? 'Creating…' : 'Create profile'}
          </Button>
        </form>
      )}
    </main>
  );
}
