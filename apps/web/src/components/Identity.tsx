import { SquircleLayers } from './Squircle.tsx';

export function Avatar({ handle, size = 'small' }: { handle: string; size?: 'small' | 'large' }) {
  return (
    <span className={`avatar avatar-${size} sq-host`} aria-hidden="true">
      <SquircleLayers radius={size === 'large' ? 1.25 : 0.5} />
      <span>{handle[0]}</span>
    </span>
  );
}

export function CountryBadge({ country }: { country: { code: string; name: string } }) {
  return (
    <span className="badge sq-host" title={country.name}>
      <SquircleLayers radius={0.5} />
      <span>{country.name}</span>
    </span>
  );
}

export function FieldTags({ fields }: { fields: Array<{ slug: string; name: string }> }) {
  return (
    <ul className="tags" aria-label="Knows about">
      {fields.map(f => (
        <li key={f.slug} className="tag sq-host">
          <SquircleLayers radius={0.5} />
          <span>{f.name}</span>
        </li>
      ))}
    </ul>
  );
}

const monthFormat = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "2026-10" → "October 2026" */
export function joinedLabel(joined: string): string {
  return `Joined ${monthFormat.format(new Date(`${joined}-01T00:00:00Z`))}`;
}

/** A name that wraps at its dots and underscores, never in the middle of a word or number. */
export function Handle({ handle }: { handle: string }) {
  const parts = handle.split(/(?<=[._])/);
  return (
    <>
      @
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && <wbr />}
          {p}
        </span>
      ))}
    </>
  );
}
