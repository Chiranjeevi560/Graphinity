import { Link } from '../lib/router.ts';

// Written from what the code actually stores and sends (db/schema.sql,
// apps/api). Change this page in the same commit as any change to that.
export default function Privacy() {
  return (
    <main className="page legal">
      <p className="draft-note text-subhead" role="note">Draft: this page is being reviewed before Graphinity opens to everyone.</p>
      <h1 className="text-title1">Privacy</h1>
      <p className="text-body secondary">Last updated 19 October 2026</p>

      <h2 className="text-title3">The short version</h2>
      <ul className="text-body">
        <li>We keep what Graphinity needs to work, and nothing to sell or study you with.</li>
        <li>No ads, no analytics, no tracking scripts, and no cookies at all: signing in is kept in this browser tab only, and closing the tab signs you out.</li>
        <li>Your Google name and email are never shown, and Graphinity itself never reads them.</li>
        <li>Deleting your account deletes what you shared.</li>
      </ul>

      <h2 className="text-title3">What we keep</h2>
      <ul className="text-body">
        <li><strong>Signing in.</strong> Google confirms who you are. Our sign-in provider, Supabase, keeps your Google account’s email and an id for it, only so you can sign in again. Graphinity asks Google for your email and nothing else: not your name, not your photo.</li>
        <li><strong>Your profile.</strong> The name you choose, your country, the fields you know about, and when you confirmed you are 18 or older.</li>
        <li><strong>What you share.</strong> Your questions, answers, the answers you picked or marked helpful, whether a picked answer turned out right, and reports you send.</li>
        <li><strong>Points and trust,</strong> worked out from the above.</li>
        <li><strong>Which questions were put to you,</strong> and whether you opened them.</li>
        <li><strong>Notifications,</strong> if you turn them on: an address from your browser’s notification service for each device. Signing out or deleting your account turns them off for that device. Closing the tab doesn’t, since they are for when Graphinity is closed.</li>
        <li><strong>Network checks.</strong> To spot one person using several accounts, we keep a scrambled, one-way code made from the network you use whenever you ask, answer, pick, mark or report something (not the address itself), for 30 days. Only moderators see which accounts share one, and it never blocks anyone by itself.</li>
      </ul>

      <h2 className="text-title3">What others can see</h2>
      <p className="text-body">Anyone, signed in or not, can see your chosen name, country, fields, the month you joined, your points, medals and trust, and your questions and answers. Who was asked a question, who reported what, and who blocked whom are never shown.</p>

      <h2 className="text-title3">What we don’t do</h2>
      <ul className="text-body">
        <li>We don’t sell or share your information for advertising.</li>
        <li>Our server logs record only which kind of page was asked for, whether it worked, and how long it took: never your address, your name, or what you wrote.</li>
        <li>Limits that stop floods use the same kind of scrambled code, kept in memory only.</li>
        <li>The companies that host us (Cloudflare, Render, Supabase) keep their own short technical logs, which can include network addresses, under their own privacy policies.</li>
      </ul>

      <h2 className="text-title3">Where it is kept</h2>
      <p className="text-body">Our database and server run in Singapore (Supabase and Render). The website is delivered by Cloudflare from the location nearest you. Notifications travel through your browser’s own service (Google, Mozilla, Apple or Microsoft), encrypted so that only your device can read them.</p>

      <h2 className="text-title3">Deleting your account</h2>
      <p className="text-body">From your profile, choose Delete account. Your profile, questions, answers, reports and notification settings are deleted at once, and your sign-in is removed from Supabase. If Supabase is briefly unavailable, that last step finishes automatically within hours, and your account can’t be used meanwhile. Points that others earned from your picks stay with them, with no link back to you.</p>

      <h2 className="text-title3">Children</h2>
      <p className="text-body">Graphinity is for people 18 and older.</p>

      <h2 className="text-title3">Questions</h2>
      <p className="text-body">Contact details will be added here before launch. See also the <Link to="/terms">terms</Link>.</p>
    </main>
  );
}
