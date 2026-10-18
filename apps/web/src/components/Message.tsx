import { LinkButton } from './Button.tsx';

/**
 * A screen with nothing else to show (not found, deleted, gone): what
 * happened, one line on why, and the way forward. Centred, one action.
 */
export function MessageScreen({ title, detail }: { title: string; detail?: string }) {
  return (
    <main className="page message-screen">
      <h1 className="text-title2">{title}</h1>
      {detail && <p className="text-body secondary">{detail}</p>}
      <LinkButton to="/" className="message-action">Go to home</LinkButton>
    </main>
  );
}

/** "It’s gone. It may have been deleted." → a title without its full stop, and the rest as detail. */
export function splitMessage(message: string): { title: string; detail?: string } {
  const parts = /^(.+?)\.\s+(.+)$/.exec(message);
  return parts?.[1] && parts[2] ? { title: parts[1], detail: parts[2] } : { title: message.replace(/\.$/, '') };
}
