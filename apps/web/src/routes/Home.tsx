import { GoogleButton } from '../components/GoogleButton.tsx';
import { Link } from '../lib/router.ts';
import { useSession } from '../session.tsx';

export default function Home() {
  const { state } = useSession();
  return (
    <main className="page home">
      <h1 className="text-large">Ask once. Reach people who’ve done it.</h1>
      <p className="text-body secondary">
        Your question goes to people with real experience of it. You choose the answer that helped.
      </p>
      {state.status === 'signedOut' && (
        <div className="home-action">
          <GoogleButton />
          <p className="text-footnote secondary">
            Google only confirms who you are. You choose the name people see, and we never show your Google name or email.
          </p>
        </div>
      )}
      {state.status === 'ready' && (
        <div className="home-action">
          <p className="text-body">You’re signed in as <Link to="/me">@{state.profile.handle}</Link>.</p>
        </div>
      )}
      {state.status === 'unreachable' && (
        <div className="home-action"><p className="text-body secondary" role="alert">{state.message}</p></div>
      )}
    </main>
  );
}
