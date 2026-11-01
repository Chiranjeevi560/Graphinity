// Which topic someone reads after which, within this tab only. Steps go to the server with no person attached, and it
// keeps them only with consent. Nothing is kept here past the tab, and signing out forgets it at once.
type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export interface Step {
  from: string;
  to: string;
  previous?: string;
}

const KEY = 'graphinity.journey';

export function journeyStore(storage: () => TabStorage) {
  const read = (): string[] => {
    try {
      const value: unknown = JSON.parse(storage().getItem(KEY) ?? '[]');
      return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string').slice(0, 2) : [];
    } catch {
      return [];
    }
  };
  return {
    /** Records reading `field`, and returns the step it completes, if any. */
    note(field: string): Step | null {
      const [last, before] = read();
      if (last === field) return null;
      try {
        storage().setItem(KEY, JSON.stringify(last ? [field, last] : [field]));
      } catch {
        return null;
      }
      return last ? { from: last, to: field, ...(before && before !== field ? { previous: before } : {}) } : null;
    },
    forget(): void {
      try {
        storage().removeItem(KEY);
      } catch {
        // Storage is blocked, so there's nothing to forget.
      }
    },
  };
}

export const journey = journeyStore(() => sessionStorage);
