import { canRetry, type ApiError } from '../lib/api.ts';
import { Button, LinkButton } from './Button.tsx';

/**
 * A screen with nothing else to show (not found, deleted, gone): what
 * happened, one line on why, and the way forward. Centred, one action.
 */
export function MessageScreen({ title, detail }: { title: string; detail?: string }) {
  return (
    <main className="page message-screen">
      <h1 className="text-title2">{title}</h1>
      {detail && <p className="text-body secondary">{detail}</p>}
      <LinkButton to="/" className="message-action">
        Go to home
      </LinkButton>
    </main>
  );
}

/** "It’s gone. It may have been deleted." → a title without its full stop, and the rest as detail. */
export function splitMessage(message: string): { title: string; detail?: string } {
  const parts = /^(.+?)\.\s+(.+)$/.exec(message);
  return parts?.[1] && parts[2] ? { title: parts[1], detail: parts[2] } : { title: message.replace(/\.$/, '') };
}

/**
 * Something couldn't load: what happened, and "Try again" when trying again
 * can help. As a whole screen, or in place inside one (a list on a page).
 */
export function LoadFailed({
  error,
  onRetry,
  inline = false,
}: {
  error: ApiError;
  onRetry: () => void;
  inline?: boolean;
}) {
  const { title, detail } = splitMessage(error.message);
  const retry = canRetry(error) && (
    <Button
      variant={inline ? 'secondary' : 'primary'}
      className={inline ? undefined : 'message-action'}
      onClick={onRetry}
    >
      Try again
    </Button>
  );
  if (inline) {
    return (
      <div className="load-failed" role="alert">
        <div>
          <p className="text-headline">{title}</p>
          {detail && <p className="text-subhead secondary">{detail}</p>}
        </div>
        {retry}
      </div>
    );
  }
  return (
    <main className="page message-screen" role="alert">
      <h1 className="text-title2">{title}</h1>
      {detail && <p className="text-body secondary">{detail}</p>}
      {retry || (
        <LinkButton to="/" className="message-action">
          Go to home
        </LinkButton>
      )}
    </main>
  );
}
