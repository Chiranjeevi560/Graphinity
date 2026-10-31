import { useEffect, useState } from 'react';
import { browserTopics, landingQuery } from '../lib/ad-signals.ts';
import { api } from '../session.tsx';
import './SponsoredSlot.css';

interface Ad {
  token: string;
  headline: string;
  body: string;
  domain: string;
}

/**
 * Ads, asked for on their own and kept apart from knowledge results (ADR 0022). Renders nothing
 * while advertising is off or there's no ad, so the page doesn't move. Only outside signals the
 * server may ignore are sent; it uses them only with the person's partner-sites permission.
 * Not on any page yet: adding it needs 0.6 kB more script budget, which is the owner's call (CONSTRAINTS.md).
 */
export function SponsoredSlot({
  placement,
  questionId,
  query,
}: {
  placement: 'search' | 'question';
  questionId?: string;
  query?: string;
}) {
  const [ads, setAds] = useState<Ad[]>([]);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const landing = landingQuery(location.search);
      const topics = await browserTopics();
      return api<{ ads: Ad[] }>('/ads/select', {
        method: 'POST',
        signedIn: 'if-possible',
        body: {
          placement,
          ...(questionId ? { questionId } : {}),
          ...(query ? { query: query.slice(0, 600) } : {}),
          ...(landing ? { landingQuery: landing } : {}),
          ...(topics.length ? { browserTopics: topics } : {}),
        },
      });
    };
    load().then(
      found => {
        if (live) setAds(found.ads);
      },
      () => {
        // An ad that fails to load is no ad: nobody needs to know.
        if (live) setAds([]);
      },
    );
    return () => {
      live = false;
    };
  }, [placement, questionId, query]);
  if (ads.length === 0) return null;
  const open = async (ad: Ad) => {
    const { destination } = await api<{ destination: string }>(`/ads/click/${ad.token}`, {
      method: 'POST',
      signedIn: 'if-possible',
    });
    window.open(destination, '_blank', 'noopener,noreferrer');
  };
  return (
    <aside aria-label="Sponsored">
      {ads.map(ad => (
        <button
          key={ad.token}
          type="button"
          className="sponsored-ad"
          onClick={() => {
            void open(ad);
          }}
        >
          <span className="text-footnote secondary">Sponsored · {ad.domain}</span>
          <span className="text-headline">{ad.headline}</span>
          <span className="text-subhead secondary">{ad.body}</span>
        </button>
      ))}
    </aside>
  );
}
