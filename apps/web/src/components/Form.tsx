import { useId, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { SquircleLayers } from './Squircle.tsx';

export type FieldStatus = { tone: 'neutral' | 'good' | 'bad'; text: string } | null;

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'prefix'> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  prefix?: string;
  status?: FieldStatus;
  hint?: string;
}

export function TextField({ label, value, onChange, prefix, status, hint, ...rest }: TextFieldProps) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = status?.text ?? hint;
  return (
    <div className="form-row">
      <label className="form-label" htmlFor={id}>{label}</label>
      <div className="input-box sq-host">
        <SquircleLayers radius={0.75} focusRing />
        {prefix && <span className="input-prefix" aria-hidden="true">{prefix}</span>}
        <input
          id={id}
          className="input"
          value={value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => { onChange(e.target.value); }}
          aria-describedby={note ? noteId : undefined}
          aria-invalid={status?.tone === 'bad' || undefined}
          {...rest}
        />
      </div>
      {/* Announced as it changes, so screen reader users hear "Available". */}
      <p id={noteId} className={`form-note tone-${status?.tone ?? 'neutral'}`} aria-live="polite">{note}</p>
    </div>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  hint?: string;
}

export function SelectField({ label, value, onChange, options, hint }: SelectFieldProps) {
  const id = useId();
  return (
    <div className="form-row">
      <label className="form-label" htmlFor={id}>{label}</label>
      <div className="input-box sq-host">
        <SquircleLayers radius={0.75} focusRing />
        {/* The native picker: on iPhone it opens the system wheel, which people already know. */}
        <select id={id} className="input select" value={value} onChange={e => { onChange(e.target.value); }} aria-describedby={hint ? `${id}-note` : undefined}>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <svg className="select-chevron" viewBox="0 0 12 8" aria-hidden="true"><path d="M1 1.5l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </div>
      {hint && <p id={`${id}-note`} className="form-note">{hint}</p>}
    </div>
  );
}

interface ChipPickerProps {
  legend: string;
  options: Array<{ slug: string; name: string }>;
  selected: ReadonlySet<string>;
  onToggle: (slug: string) => void;
  max: number;
}

export function ChipPicker({ legend, options, selected, onToggle, max }: ChipPickerProps) {
  const full = selected.size >= max;
  return (
    <fieldset className="chips-fieldset">
      <legend className="form-label">{legend}</legend>
      <div className="chips">
        {options.map(o => {
          const on = selected.has(o.slug);
          return (
            <button
              key={o.slug}
              type="button"
              className={`chip sq-host${on ? ' is-on' : ''}`}
              aria-pressed={on}
              disabled={!on && full}
              onClick={() => { onToggle(o.slug); }}
            >
              <SquircleLayers radius={0.75} focusRing />
              <span className="chip-label">{o.name}</span>
            </button>
          );
        })}
      </div>
      <p className="form-note" aria-live="polite">
        {full ? `You’ve picked ${max}, the most you can. Tap one to swap it.` : `${selected.size} of ${max} picked`}
      </p>
    </fieldset>
  );
}

export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label className="checkbox">
      <input type="checkbox" checked={checked} onChange={e => { onChange(e.target.checked); }} />
      <span className="checkbox-box sq-host" aria-hidden="true">
        <SquircleLayers radius={0.375} />
        <svg viewBox="0 0 14 11"><path d="M1.5 5.5l3.5 3.5 7.5-7.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
      <span>{children}</span>
    </label>
  );
}
