import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";

/**
 * Node's own global `localStorage` (present since Node 22) shadows jsdom's `window.localStorage`
 * with a non-functional stub -- not a real `Storage` instance, every method missing -- rather
 * than jsdom installing its own. Replacing it here, once, gives every jsdom test a working,
 * per-test-isolated `localStorage` the way a real browser would provide one. Real-browser specs
 * (`*.browser.test.tsx`, run via Playwright) are unaffected; they never load this file.
 */
function installLocalStorage(): void {
  const store = new Map<string, string>();
  const stub: Storage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => Array.from(store.keys())[index] ?? null,
    get length() {
      return store.size;
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: stub,
    configurable: true,
  });
}

beforeEach(() => {
  installLocalStorage();
});

afterEach(() => {
  cleanup();
});
