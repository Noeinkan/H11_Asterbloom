/**
 * In-memory `Storage` for pref / save specs.
 *
 * Vitest runs with no DOM environment (see `vite.config.ts`), so
 * `globalThis.localStorage` does not exist. Anything testing persistence
 * installs one of these for the duration of the assertion block.
 *
 * Not named `*.test.ts` on purpose: Vitest's `include` would collect it as an
 * empty suite and fail.
 */

export interface FakeStorage {
  storage: Storage;
  memory: Map<string, string>;
}

export function createFakeStorage(): FakeStorage {
  const memory = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return memory.size;
    },
    clear() {
      memory.clear();
    },
    getItem(key: string) {
      return memory.has(key) ? memory.get(key)! : null;
    },
    key(index: number) {
      return [...memory.keys()][index] ?? null;
    },
    removeItem(key: string) {
      memory.delete(key);
    },
    setItem(key: string, value: string) {
      memory.set(key, String(value));
    },
  };
  return { storage, memory };
}

/**
 * Install a fake `localStorage`, run `body`, and always put the previous value
 * back — a throwing assertion must not leak the fake into the next spec.
 */
export function withFakeStorage<T>(body: (fake: FakeStorage) => T): T {
  const fake = createFakeStorage();
  const prev = globalThis.localStorage;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: fake.storage,
  });
  try {
    return body(fake);
  } finally {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: prev,
    });
  }
}

/** A `Storage` whose `setItem` always throws, standing in for a full quota. */
export function createFullStorage(): Storage {
  const { storage } = createFakeStorage();
  return {
    ...storage,
    get length() {
      return 0;
    },
    setItem() {
      throw new DOMException('quota', 'QuotaExceededError');
    },
  };
}
