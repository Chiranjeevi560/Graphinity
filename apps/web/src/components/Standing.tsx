import { useEffect, useState } from 'react';
import { api } from '../session.tsx';

export interface StandingData {
  points: Array<{ field: { slug: string; name: string }; points: number; medal: 'gold' | 'silver' | 'bronze' | null }>;
  trust: { correct: number; askers: number } | null;
}

const medalNames = { gold: 'Gold', silver: 'Silver', bronze: 'Bronze' } as const;

/** Points per field, medals and trust. Nothing at all until there is something to show. */
export function Standing({ standing }: { standing: StandingData }) {
  if (standing.points.length === 0 && !standing.trust) return null;
  return (
    <section className="profile-section" aria-labelledby="standing-heading">
      <h2 id="standing-heading" className="text-headline">Helped people with</h2>
      {standing.points.length > 0 && (
        <ul className="standing-list">
          {standing.points.map(p => (
            <li key={p.field.slug} className="standing-row">
              <span className="text-body">{p.field.name}</span>
              <span className="text-subhead secondary standing-score">
                {p.medal && <span className={`medal medal-${p.medal}`}>{medalNames[p.medal]}</span>}
                {p.points === 1 ? '1 point' : `${String(p.points)} points`}
              </span>
            </li>
          ))}
        </ul>
      )}
      {standing.trust && (
        <p className="text-subhead secondary">
          {standing.trust.correct} of {standing.trust.askers} people they helped say it turned out right.
        </p>
      )}
    </section>
  );
}

/** For your own profile: the session holds the profile, not its standing. */
export function useStanding(handle: string): StandingData | null {
  const [standing, setStanding] = useState<StandingData | null>(null);
  useEffect(() => {
    let live = true;
    api<{ standing: StandingData }>(`/profiles/${encodeURIComponent(handle)}`)
      .then(res => { if (live) setStanding(res.standing); })
      // Standing is extra: if it can't load, the profile still shows.
      .catch(() => {});
    return () => { live = false; };
  }, [handle]);
  return standing;
}
