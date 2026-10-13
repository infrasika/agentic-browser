import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserSession } from './sessions.js';
import type { Actor } from './contracts.js';

// Waiting observes only lifecycle/control metadata. It never observes a page,
// extends a lease, retries an action, or changes control after cancellation.
export async function waitForSession(
  session: BrowserSession,
  options: { control: Actor; timeoutMs: number; afterRevision?: number; signal: AbortSignal },
  authorize: () => void,
) {
  const deadline = performance.now() + options.timeoutMs;
  for (;;) {
    options.signal.throwIfAborted(); authorize(); session.assertAlive();
    const current = session.info();
    if (current.control === options.control && (options.afterRevision === undefined || current.revision > options.afterRevision))
      return { status: 'ready' as const, session: current };
    const remaining = deadline - performance.now();
    if (remaining <= 0) return { status: 'timed_out' as const, session: current };
    await delay(Math.min(200, remaining), undefined, { signal: options.signal });
  }
}
