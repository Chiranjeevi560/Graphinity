import { Link } from '../lib/router.ts';
import { searchFor } from '../lib/search.ts';
import { useLoad } from '../use-load.ts';

interface Next {
  next: Array<{ field: string; name: string }>;
}

/** A few topics near this one, chosen from everyone's journeys with no person in them. A short list that ends. */
export function NextTopics({ field }: { field: string }) {
  const { data } = useLoad<Next>(`/knowledge-graph/next?current=${encodeURIComponent(field)}`);
  const topics = data?.next.slice(0, 3) ?? [];
  if (!topics.length) return null;
  return (
    <section className="next-topics" aria-labelledby="next-topics-heading">
      <h2 id="next-topics-heading" className="text-headline">
        People often look at next
      </h2>
      <ul>
        {topics.map(t => (
          <li key={t.field}>
            <Link
              to="/search"
              onClick={() => {
                searchFor(t.name);
              }}
            >
              {t.name}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
