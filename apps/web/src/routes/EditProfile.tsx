import { useState, type FormEvent } from 'react';
import { Button } from '../components/Button.tsx';
import { ChipPicker, SelectField, TextField } from '../components/Form.tsx';
import { ApiError } from '../lib/api.ts';
import { Link, navigate } from '../lib/router.ts';
import { api, useSession, type Profile } from '../session.tsx';
import { useHandleCheck, useMeta } from './profile-form.ts';

const dateFormat = new Intl.DateTimeFormat('en', { day: 'numeric', month: 'long' });

export default function EditProfile({ profile }: { profile: Profile }) {
  const { setProfile } = useSession();
  const { meta, error: metaError } = useMeta();
  const [handle, setHandle] = useState(profile.handle);
  const [country, setCountry] = useState(profile.country.code);
  const [fields, setFields] = useState<Set<string>>(new Set(profile.fields.map(f => f.slug)));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useHandleCheck(handle, profile.handle);

  const nextChange = profile.handleChangeAvailableAt ? new Date(profile.handleChangeAvailableAt) : null;
  const nameLocked = nextChange !== null && nextChange.getTime() > Date.now();

  if (metaError) return <main className="page stack-message"><p className="text-body" role="alert">{metaError}</p></main>;
  if (!meta) return <main className="page stack-message"><p className="text-body status" role="status">Loading…</p></main>;

  const toggle = (slug: string) => setFields(prev => {
    const next = new Set(prev);
    if (next.has(slug)) next.delete(slug); else if (next.size < 8) next.add(slug);
    return next;
  });

  const normalized = handle.trim().toLowerCase();
  const changes: Record<string, unknown> = {};
  if (normalized !== profile.handle) changes.handle = normalized;
  if (country !== profile.country.code) changes.country = country;
  const before = profile.fields.map(f => f.slug).sort().join();
  if ([...fields].sort().join() !== before) changes.fields = [...fields];
  const canSave = Object.keys(changes).length > 0 && fields.size > 0 && (changes.handle === undefined || check.available) && !saving;

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api<{ profile: Profile }>('/me/profile', { method: 'PATCH', signedIn: true, body: changes });
      setProfile(res.profile);
      navigate('/me', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again in a minute.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page">
      <form className="edit-form" onSubmit={save}>
        <div className="onboarding-top">
          <Link to="/me" className="btn btn-plain">Cancel</Link>
        </div>
        <h1 className="text-title1">Edit profile</h1>
        <TextField
          label="Name"
          prefix="@"
          value={handle}
          onChange={setHandle}
          status={nameLocked ? null : check.status}
          hint={nameLocked ? `You can change your name again on ${dateFormat.format(nextChange!)}.` : 'You can change your name once a week.'}
          disabled={nameLocked}
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={24}
        />
        <SelectField
          label="Country"
          value={country}
          onChange={setCountry}
          options={meta.countries.map(c => ({ value: c.code, label: c.name }))}
        />
        <ChipPicker legend="Your fields" options={meta.fields} selected={fields} onToggle={toggle} max={8} />
        {error && <p className="form-note tone-bad" role="alert">{error}</p>}
        <Button type="submit" className="btn-block" disabled={!canSave}>{saving ? 'Saving…' : 'Save'}</Button>
      </form>
    </main>
  );
}
