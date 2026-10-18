import { useEffect, useState } from 'react';
import { onLive, type LiveEvent } from '../lib/live.ts';
import { Link } from '../lib/router.ts';

const text = { routed: 'A new question for you', answered: 'New answer to your question' } as const;

/** A quiet note at the bottom of the screen when something happens, gone after a few seconds. */
export function LiveBanner() {
  const [event, setEvent] = useState<LiveEvent | null>(null);
  useEffect(() => onLive(e => {
    // Already looking at that question: it updates in place, no note needed.
    if (location.pathname.startsWith(`/q/${e.questionId}/`) || location.pathname === `/q/${e.questionId}`) return;
    setEvent(e);
  }), []);
  useEffect(() => {
    if (!event) return;
    const timer = setTimeout(() => { setEvent(null); }, 8000);
    return () => { clearTimeout(timer); };
  }, [event]);
  return (
    <div className="live-banner-region" role="status" aria-live="polite">
      {event && (
        <Link to={`/q/${event.questionId}`} className="live-banner" onClick={() => { setEvent(null); }}>
          {text[event.type]}
        </Link>
      )}
    </div>
  );
}
