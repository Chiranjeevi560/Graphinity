import { Link } from '../lib/router.ts';
import { questionPath } from '../lib/questions.ts';
import { useLoad } from '../use-load.ts';

interface Recommendation {
  id: string;
  title: string;
  field: string;
  fieldName: string;
  answerCount: number;
  score: number;
  reason: string;
  trace: {
    signals: readonly string[];
    consent: string | null;
    commercialInputs: number;
  };
}

interface Page {
  enabled: boolean;
  availability?: 'consent_required' | 'unavailable';
  algorithmVersion: string;
  recommendations: Recommendation[];
}

const words = (name: string) => name.replaceAll('_', ' ');

/** A short, consent-gated list of useful questions; no infinite scroll or engagement ranking. */
export function RecommendedQuestions() {
  const { data, error } = useLoad<Page>('/me/recommendations', true);
  if (error || !data) return null;

  return (
    <section className="recommended" aria-labelledby="recommended-heading">
      <h2 id="recommended-heading" className="text-title3">
        For you
      </h2>
      {!data.enabled && data.availability === 'unavailable' ? (
        <p className="text-body secondary">Personalized suggestions are temporarily unavailable.</p>
      ) : !data.enabled ? (
        <p className="text-body secondary">
          Choose whether Graphinity may personalize question suggestions in{' '}
          <Link to="/me/privacy">Your data choices</Link>.
        </p>
      ) : data.recommendations.length === 0 ? (
        <p className="text-body secondary">There aren’t any question suggestions yet.</p>
      ) : (
        <ul className="question-list">
          {data.recommendations.map(item => (
            <li key={item.id} className="question-row">
              <Link to={questionPath(item)} className="question-link">
                <span className="text-headline question-title">{item.title}</span>
                <span className="text-footnote secondary question-meta">
                  <span>{item.fieldName}</span>
                  <span>{item.answerCount === 1 ? '1 answer' : `${String(item.answerCount)} answers`}</span>
                  <span>{item.reason}</span>
                </span>
              </Link>
              <details className="why-this text-footnote secondary">
                <summary>Why this?</summary>
                <p>
                  {item.reason}.{' '}
                  {item.trace.signals.length > 0
                    ? `Based on: ${item.trace.signals.map(words).join(', ')}.`
                    : 'Nothing about you was used.'}{' '}
                  {item.trace.consent ? `Allowed by your choice: ${words(item.trace.consent)}.` : ''} Nothing commercial
                  affects this list. <Link to="/me/privacy">Change this</Link>
                </p>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
