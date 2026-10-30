import type { BrowserWorkspace } from "../src/contracts.js";
export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export function fakeWorkspace(): BrowserWorkspace & { closed: boolean } {
  return {
    closed: false,
    async perform(action) {
      return { type: action.type };
    },
    async screenshot() {
      return Buffer.from("jpeg");
    },
    async close() {
      this.closed = true;
    },
  };
}
