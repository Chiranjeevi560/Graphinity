import { LinkButton } from '../components/Button.tsx';
import { GoogleButton } from '../components/GoogleButton.tsx';
import { QuestionList } from '../components/QuestionList.tsx';
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
          <LinkButton to="/ask">Ask a question</LinkButton>
        </div>
      )}
      {state.status === 'unreachable' && (
        <div className="home-action"><p className="text-body secondary" role="alert">{state.message}</p></div>
      )}
      <section className="home-questions" aria-labelledby="recent-heading">
        <h2 id="recent-heading" className="text-title3">Recent questions</h2>
        <QuestionList />
      </section>
    </main>
  );
}
