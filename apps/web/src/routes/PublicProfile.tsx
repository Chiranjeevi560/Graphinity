import { Avatar, CountryBadge, FieldTags, Handle, joinedLabel } from '../components/Identity.tsx';
import { LoadFailed, MessageScreen, splitMessage } from '../components/Message.tsx';
import { Standing, type StandingData } from '../components/Standing.tsx';
import type { Profile } from '../session.tsx';
import { useLoad } from '../use-load.ts';

export default function PublicProfile({ handle }: { handle: string }) {
  const { data, error, retry } = useLoad<{ profile: Profile; standing: StandingData }>(
    `/profiles/${encodeURIComponent(handle)}`,
  );

  // "Check the name" only when there's no one by that name; otherwise it's not the name's fault.
  if (error?.status === 404) {
    return (
      <MessageScreen
        title={splitMessage(error.message).title}
        detail="Check the name, or start again from the home page."
      />
    );
  }
  if (error) return <LoadFailed error={error} onRetry={retry} />;
  if (!data)
    return (
      <main className="page stack-message">
        <p className="text-body status" role="status">
          Loading…
        </p>
      </main>
    );
  const { profile, standing } = data;

  return (
    <main className="page profile">
      <header className="profile-head">
        <Avatar handle={profile.handle} size="large" />
        <div className="profile-names">
          <h1 className="text-title1">
            <Handle handle={profile.handle} />
          </h1>
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
      <Standing standing={standing} />
    </main>
  );
}
