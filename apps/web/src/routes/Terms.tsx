import { Link } from '../lib/router.ts';

export default function Terms() {
  return (
    <main className="page legal">
      <p className="draft-note text-subhead" role="note">
        Draft: these terms are being reviewed before Graphinity opens to everyone.
      </p>
      <h1 className="text-title1">Terms</h1>
      <p className="text-body secondary">Last updated 18 October 2026</p>

      <h2 className="text-title3">Using Graphinity</h2>
      <ul className="text-body">
        <li>You must be 18 or older.</li>
        <li>One account per person. Don’t use more accounts to give yourself points.</li>
        <li>Answer from your own experience, honestly. Say so when you’re not sure.</li>
        <li>Don’t post spam, abuse, hate, or anyone’s private information, and don’t break the law.</li>
      </ul>

      <h2 className="text-title3">Answers are people’s experience, not professional advice</h2>
      <p className="text-body">
        Answers come from people who have done something themselves. They are not medical, legal, financial or other
        professional advice. Check anything important with a qualified professional before you act on it.
      </p>

      <h2 className="text-title3">What you post</h2>
      <p className="text-body">
        You keep ownership of what you write. By posting it, you let Graphinity show it to everyone on the site and in
        search results for as long as it stays up. You can delete your account at any time, and your posts go with it.
      </p>

      <h2 className="text-title3">Moderation</h2>
      <p className="text-body">
        Anyone can report a post. A post reported by several people is hidden until a moderator looks at it. Moderators
        can remove posts and stop accounts from posting. If you think we got it wrong, contact us.
      </p>

      <h2 className="text-title3">The service</h2>
      <p className="text-body">
        Graphinity is free. We work to keep it running and safe, but we can’t promise it will always be available or
        free of mistakes. We may change these terms; if we make a change that matters, we’ll say so on the site first.
      </p>

      <p className="text-body">
        See also the <Link to="/privacy">privacy page</Link>.
      </p>
    </main>
  );
}
