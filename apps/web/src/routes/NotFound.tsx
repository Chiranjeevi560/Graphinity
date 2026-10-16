import { Link } from '../lib/router.ts';

export default function NotFound() {
  return (
    <main className="page stack-message">
      <h1 className="text-title2">This page doesn’t exist</h1>
      <p className="text-body secondary">
        Check the address, or go to the <Link to="/">home page</Link>.
      </p>
    </main>
  );
}
