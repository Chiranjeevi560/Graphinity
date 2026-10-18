// What happened that someone should hear about, inside this one server.
// ponytail: in-process only; with more than one instance, move to Postgres
// LISTEN/NOTIFY (one free instance today).

export type PersonEvent =
  | { type: 'routed'; questionId: string }
  | { type: 'answered'; questionId: string };

export interface Events {
  /** A new question: the routing job should run now instead of waiting. */
  asked(questionId: string): void;
  onAsked(listener: (questionId: string) => void): void;
  /** Something for one person (their live stream, later a push). */
  publish(userId: string, event: PersonEvent): void;
  subscribe(userId: string, listener: (event: PersonEvent) => void): () => void;
}

export function createEvents(): Events {
  const askedListeners: Array<(questionId: string) => void> = [];
  const people = new Map<string, Set<(event: PersonEvent) => void>>();
  return {
    asked: questionId => { for (const l of askedListeners) l(questionId); },
    onAsked: listener => { askedListeners.push(listener); },
    publish(userId, event) {
      for (const l of people.get(userId) ?? []) l(event);
    },
    subscribe(userId, listener) {
      const set = people.get(userId) ?? new Set();
      set.add(listener);
      people.set(userId, set);
      return () => {
        set.delete(listener);
        if (set.size === 0) people.delete(userId);
      };
    },
  };
}
