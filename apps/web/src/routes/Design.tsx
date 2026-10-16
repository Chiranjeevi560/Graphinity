// Development-only gallery for reviewing the design system at every width
// and in both appearances. Excluded from production builds (see App.tsx).
import { Button } from '../components/Button.tsx';
import { SquircleLayers } from '../components/Squircle.tsx';

const styles = ['large', 'title1', 'title2', 'title3', 'headline', 'body', 'callout', 'subhead', 'footnote', 'caption'] as const;

export default function Design() {
  return (
    <main className="page design">
      <section>
        <h2 className="text-footnote secondary design-label">Text styles</h2>
        {styles.map(s => (
          <p key={s} className={`text-${s}`}>{s} — Customs duty on a watch</p>
        ))}
      </section>

      <section>
        <h2 className="text-footnote secondary design-label">Buttons</h2>
        <div className="design-row">
          <Button>Ask a question</Button>
          <Button variant="secondary">Cancel</Button>
          <Button disabled>Post</Button>
        </div>
      </section>

      <section>
        <h2 className="text-footnote secondary design-label">Card</h2>
        <div className="card sq-host">
          <SquircleLayers radius={1.25} edge />
          <p className="text-headline">How much duty did you pay importing a watch into India?</p>
          <p className="text-subhead secondary">Imports & Customs · India · 3 answers</p>
        </div>
      </section>

      <section>
        <h2 className="text-footnote secondary design-label">Input</h2>
        <input className="design-input" placeholder="Search questions" aria-label="Search questions" />
      </section>
    </main>
  );
}
