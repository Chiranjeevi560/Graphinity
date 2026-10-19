import { useEffect, useState } from 'react';
import { onLive, type LiveEvent } from '../lib/live.ts';
import { Link } from '../lib/router.ts';

const text = {
  routed: 'A new question for you',
  answered: 'New answer to your question',
  sent: 'Your question went out to more people',
} as const;

/** A quiet note at the bottom of the screen when something happens, gone after a few seconds. */
export function LiveBanner() {
  const [event, setEvent] = useState<LiveEvent | null>(null);
  // Pointed at or focused: someone is reading it, so it stays (WCAG 2.2.1).
  const [held, setHeld] = useState(false);
  useEffect(
    () =>
      onLive(e => {
        // Already looking at that question: it updates in place, no note needed.
        if (location.pathname.startsWith(`/q/${e.questionId}/`) || location.pathname === `/q/${e.questionId}`) return;
        setEvent(e);
      }),
    [],
  );
  useEffect(() => {
    if (!event || held) return;
    const timer = setTimeout(() => {
      setEvent(null);
    }, 8000);
    return () => {
      clearTimeout(timer);
    };
  }, [event, held]);
  return (
    <div className="live-banner-region" role="status" aria-live="polite">
      {event && (
        <Link
          to={`/q/${event.questionId}`}
          className="live-banner"
          onClick={() => {
            setEvent(null);
            setHeld(false);
          }}
          onMouseEnter={() => {
            setHeld(true);
          }}
          onMouseLeave={() => {
            setHeld(false);
          }}
          onFocus={() => {
            setHeld(true);
          }}
          onBlur={() => {
            setHeld(false);
          }}
        >
          {text[event.type]}
        </Link>
      )}
    </div>
  );
}
