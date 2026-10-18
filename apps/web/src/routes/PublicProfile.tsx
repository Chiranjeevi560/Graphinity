import { useEffect, useState } from 'react';
import { Avatar, CountryBadge, FieldTags, joinedLabel } from '../components/Identity.tsx';
import { ApiError } from '../lib/api.ts';
import { Link } from '../lib/router.ts';
import { api, type Profile } from '../session.tsx';

export default function PublicProfile({ handle }: { handle: string }) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);

  // App keys each screen by its path, so a new handle mounts a fresh screen;
  // only a late answer after leaving needs ignoring.
  useEffect(() => {
    let live = true;
    api<{ profile: Profile }>(`/profiles/${encodeURIComponent(handle)}`)
      .then(r => { if (live) setProfile(r.profile); })
      .catch((err: unknown) => { if (live) setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again in a minute.'); });
    return () => { live = false; };
  }, [handle]);

  if (error) {
    return (
      <main className="page stack-message">
        <h1 className="text-title2">{error}</h1>
        <p className="text-body secondary">Check the name, or go to the <Link to="/">home page</Link>.</p>
      </main>
    );
  }
  if (!profile) return <main className="page stack-message"><p className="text-body status" role="status">Loading…</p></main>;

  return (
    <main className="page profile">
      <header className="profile-head">
        <Avatar handle={profile.handle} size="large" />
        <div className="profile-names">
          <h1 className="text-title1">@{profile.handle}</h1>
          <div className="profile-meta">
            <CountryBadge country={profile.country} />
            <span className="text-subhead secondary">{joinedLabel(profile.joined)}</span>
          </div>
        </div>
      </header>
      <section className="profile-section">
        <h2 className="text-headline">Knows about</h2>
        <FieldTags fields={profile.fields} />
      </section>
    </main>
  );
}
