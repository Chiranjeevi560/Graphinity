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
}

interface Page {
  enabled: boolean;
  availability?: 'consent_required' | 'unavailable';
  algorithmVersion: string;
  recommendations: Recommendation[];
}

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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
