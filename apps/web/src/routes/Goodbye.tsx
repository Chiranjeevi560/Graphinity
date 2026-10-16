import { Link } from '../lib/router.ts';

export default function Goodbye() {
  return (
    <main className="page stack-message">
      <h1 className="text-title2">Your account is deleted</h1>
      <p className="text-body secondary">Your profile and everything you shared have been removed. You’re signed out.</p>
      <p className="text-body"><Link to="/">Go to the home page</Link></p>
    </main>
  );
}
