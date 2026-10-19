// What someone has typed but not yet posted survives a reload, a crash,
// going offline and a failed post (spec §22.3 #12), so it is never lost.
// It lives in this tab only, like signing in: closing the tab forgets it,
// as the privacy page promises, so a half-written question about someone's
// health or visa never stays on a shared computer. Signing out or deleting
// the account forgets it at once.

type TabStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const PREFIX = 'graphinity.draft.';

export function draftStore(storage: TabStorage) {
  // When storage is blocked (some private modes), drafts last for the page only.
  const memory = new Map<string, string>();
  const attempt = <T>(run: () => T, fallback: () => T): T => {
    try {
      return run();
    } catch {
      return fallback();
    }
  };

  return {
    /** The saved draft under `key`, or null when there is none or it isn't the shape expected. */
    load<T>(key: string, valid: (value: unknown) => value is T): T | null {
      const raw = attempt(
        () => storage.getItem(PREFIX + key),
        () => memory.get(PREFIX + key) ?? null,
      );
      if (raw === null) return null;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        value = undefined;
      }
      if (valid(value)) return value;
      this.save(key, null);
      return null;
    },

    /** Saves the draft, or forgets it when null or when `empty` says there's nothing in it. */
    save<T>(key: string, value: T | null, empty: (value: T) => boolean = () => false): void {
      const k = PREFIX + key;
      if (value === null || empty(value)) {
        memory.delete(k);
        attempt(
          () => {
            storage.removeItem(k);
          },
          () => undefined,
        );
        return;
      }
      const raw = JSON.stringify(value);
      attempt(
        () => {
          storage.setItem(k, raw);
        },
        () => {
          memory.set(k, raw);
        },
      );
    },

    /** Forgets every draft in this tab. */
    clear(): void {
      memory.clear();
      attempt(
        () => {
          const ours: string[] = [];
          for (let i = 0; i < storage.length; i++) {
            const k = storage.key(i);
            if (k?.startsWith(PREFIX)) ours.push(k);
          }
          for (const k of ours) storage.removeItem(k);
        },
        () => undefined,
      );
    },
  };
}

function tabStorage(): TabStorage {
  try {
    return sessionStorage;
  } catch {
    // Reading sessionStorage itself can throw; the store then keeps drafts in memory.
    return {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new Error('unavailable');
      },
      removeItem: () => {
        throw new Error('unavailable');
      },
      key: () => null,
      length: 0,
    };
  }
}

export const drafts = draftStore(tabStorage());
