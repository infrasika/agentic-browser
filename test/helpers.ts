import { once } from "node:events";
import type { AddressInfo } from "node:net";
import type { BrowserEngine, BrowserWorkspace } from "../src/contracts.js";
import { createHttpServer } from "../src/http.js";
import { SessionRegistry } from "../src/sessions.js";

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

export async function startService(engine: BrowserEngine, ttlMs = 60000) {
  const token = "test-agent-token-with-at-least-32-characters";
  const registry = new SessionRegistry(engine, {
    ttlMs,
    maxSessions: 8,
  });
  const options = { token, publicUrl: "http://127.0.0.1" };
  const server = createHttpServer(registry, options);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  options.publicUrl = base;
  return {
    base,
    token,
    registry,
    request(path: string, method = "GET", body?: unknown, credential = token) {
      return fetch(`${base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${credential}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
    async close() {
      await registry.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
