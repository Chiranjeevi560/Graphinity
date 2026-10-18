import { canGoBack, navigate } from '../lib/router.ts';

/**
 * Back to where the person came from inside Graphinity, or to the home page
 * if they arrived from elsewhere. Installed on an iPhone's Home Screen the
 * site has no browser back button, so screens reached from a list need one.
 */
export function BackButton() {
  return (
    <button type="button" className="btn btn-plain back-button" onClick={() => { if (canGoBack()) history.back(); else navigate('/'); }}>
      <svg viewBox="0 0 8 14" aria-hidden="true" focusable="false"><path d="M7 1L1 7l6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      Back
    </button>
  );
}
