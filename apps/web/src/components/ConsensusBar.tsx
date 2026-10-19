import { agreementWords, formatRange, type Consensus } from '../lib/questions.ts';

/**
 * What the answers report, at a glance (spec §7.2 Screen 4, §11.4): one
 * bar split by how much weight each group of amounts carries, the largest
 * first, and the same in words below. Smaller groups stay visible: an edge
 * case is information, not noise. Shares are weighted by each author's
 * standing in the field, so a crowd of new accounts can't outvote experience.
 */
export function ConsensusBar({ consensus }: { consensus: Consensus }) {
  const total = consensus.clusters.reduce((n, c) => n + c.answers, 0);
  return (
    <section className="consensus" aria-labelledby="consensus-heading">
      <h2 id="consensus-heading" className="text-headline">{agreementWords(consensus.confidence)}</h2>
      <div className="consensus-bar" aria-hidden="true">
        {consensus.clusters.map((c, i) => (
          <span key={`${c.currency}-${String(c.lowMinor)}`} className={`consensus-part ${tone(i, c.answers)}`} style={{ flexGrow: Math.max(c.share, 0.02) }} />
        ))}
      </div>
      <ul className="consensus-legend text-subhead">
        {consensus.clusters.map((c, i) => (
          <li key={`${c.currency}-${String(c.lowMinor)}`}>
            <span className={`consensus-key ${tone(i, c.answers)}`} aria-hidden="true" />
            <span className="consensus-amount">{formatRange(c.lowMinor, c.highMinor, c.currency)}</span>
            <span className="secondary">
              {' '}· {Math.round(c.share * 100)}% · {c.answers === 1 ? '1 answer' : `${String(c.answers)} answers`}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-footnote secondary">From {total === 1 ? '1 answer' : `${String(total)} answers`} that give an amount, weighed by each person’s record in this field.</p>
    </section>
  );
}

/** The largest group agrees; others are a second view; a lone report is an edge case. */
function tone(index: number, answers: number): string {
  if (index === 0) return 'is-consensus';
  return answers === 1 ? 'is-variance' : 'is-second';
}
