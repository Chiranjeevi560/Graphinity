import { useEffect, useId, useRef, type SubmitEvent } from 'react';
import { QUERY_MAX } from '../lib/search.ts';
import { SquircleLayers } from './Squircle.tsx';
import './search.css';

/**
 * The search field, on the home page and the Search screen. A search runs
 * when it is submitted, not on every keystroke: half-typed words are noise to
 * the results and to learning a better ranking.
 */
export function SearchField({
  value,
  onChange,
  onSubmit,
  focusFirst = false,
  busy = false,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (query: string) => void;
  focusFirst?: boolean;
  busy?: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  // On the Search screen the field is the point of the page; on the home page it waits to be chosen.
  useEffect(() => {
    if (focusFirst) input.current?.focus();
  }, [focusFirst]);
  return (
    <form
      role="search"
      className="search-form"
      onSubmit={(e: SubmitEvent<HTMLFormElement>) => {
        e.preventDefault();
        onSubmit(value.trim());
      }}
    >
      <label className="visually-hidden" htmlFor={id}>
        Search questions
      </label>
      <div className="input-box search-box sq-host">
        <SquircleLayers radius={0.75} focusRing />
        <svg className="search-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M11 11l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        <input
          id={id}
          className="input"
          type="search"
          value={value}
          onChange={e => {
            onChange(e.target.value);
          }}
          placeholder="Search questions"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={QUERY_MAX * 2}
          ref={input}
          aria-busy={busy || undefined}
        />
      </div>
    </form>
  );
}
