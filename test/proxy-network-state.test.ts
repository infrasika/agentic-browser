import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { type AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { ProxyNetworkState } from '../src/proxy-network-state.js';

async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) { if (check()) return; await delay(5); }
  assert.fail('Network state event did not complete');
}

async function fixture(t: test.TestContext, options: {
  rejectSession?: string; detachFirst?: boolean; pausedSession?: string;
} = {}) {
  const { rejectSession, detachFirst, pausedSession } = options;
  const messages: { id: number; method: string; params: Record<string, unknown>; sessionId?: string }[] = [];
  let peer: WebSocket | undefined;
  let failures = 0;
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/browser` }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => {
    peer = socket;
    const deferred: number[] = [];
    socket.on('message', data => {
      const message = JSON.parse(data.toString()); messages.push(message);
      // Chrome's popup renderer can defer Page command responses until resume.
      if (message.sessionId === pausedSession && message.method.startsWith('Page.')) {
        deferred.push(message.id); return;
      }
      if (message.sessionId === pausedSession && message.method === 'Runtime.runIfWaitingForDebugger') {
        for (const id of deferred.splice(0)) socket.send(JSON.stringify({ id, result: {} }));
      }
      if (message.method === 'Target.setAutoAttach' && !message.sessionId)
        socket.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId: 'initial-page' } }));
      if (message.method === 'Page.addScriptToEvaluateOnNewDocument' && message.sessionId === rejectSession) {
        if (detachFirst) socket.send(JSON.stringify({ method: 'Target.detachedFromTarget', params: { sessionId: rejectSession } }));
        socket.send(JSON.stringify({ id: message.id, error: { code: -32000, message: 'Target closed' } }));
      } else socket.send(JSON.stringify({ id: message.id, result: {} }));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let state: ProxyNetworkState | undefined;
  t.after(async () => {
    state?.close(); for (const client of sockets.clients) client.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    messages, failures: () => failures,
    connect: async () => state = await ProxyNetworkState.connect(endpoint, () => { failures++; }),
    attach: (sessionId: string) => peer!.send(JSON.stringify({ method: 'Target.attachedToTarget', params: { sessionId } })),
    disconnect: () => peer!.terminate(),
  };
}

test('proxy network state configures existing/new targets before resuming without inspecting content or traffic', async t => {
  const f = await fixture(t);
  const state = await f.connect();
  f.attach('popup'); f.attach('cross-origin-frame');
  await until(() => f.messages.filter(m => m.method === 'Runtime.runIfWaitingForDebugger').length === 3);
  for (const id of ['initial-page', 'popup', 'cross-origin-frame']) {
    const commands = f.messages.filter(m => m.sessionId === id);
    assert.deepEqual(commands.map(m => m.method), ['Page.enable', 'Page.addScriptToEvaluateOnNewDocument', 'Target.setAutoAttach', 'Runtime.runIfWaitingForDebugger']);
    assert.equal(commands[1].params.runImmediately, true);
    assert.match(String(commands[1].params.source), /Object.defineProperty\(Navigator.prototype, 'onLine'/);
    assert.ok(!('worldName' in commands[1].params), 'Site scripts must see the setting in the main world');
    assert.equal(commands[2].params.waitForDebuggerOnStart, true);
  }
  assert.equal(f.failures(), 0);
  state.close(); state.close(); await delay(10);
  assert.equal(f.failures(), 0, 'Intentional shutdown does not signal failure');
});

test('proxy network state treats a disappearing target as a normal tab closure', async t => {
  const f = await fixture(t, { rejectSession: 'closed-popup', detachFirst: true }); await f.connect(); f.attach('closed-popup');
  await until(() => f.messages.some(m => m.sessionId === 'closed-popup'));
  f.attach('next-popup');
  await until(() => f.messages.some(m => m.sessionId === 'next-popup' && m.method === 'Runtime.runIfWaitingForDebugger'));
  assert.equal(f.failures(), 0);
});

test('proxy network state fails startup and notifies its owner if an attached page cannot be configured', async t => {
  const f = await fixture(t, { rejectSession: 'initial-page' });
  await assert.rejects(f.connect(), /initialization failed/);
  assert.equal(f.failures(), 1);
});

test('proxy network state releases paused popup renderers without waiting for Page responses', async t => {
  const f = await fixture(t, { pausedSession: 'initial-page' });
  const state = await f.connect();
  f.attach('next-tab');
  await until(() => f.messages.some(m => m.sessionId === 'next-tab' && m.method === 'Runtime.runIfWaitingForDebugger'));
  assert.equal(f.failures(), 0);
  state.close();
});

test('proxy network state notifies its owner once if its persistent transport disconnects', async t => {
  const f = await fixture(t); await f.connect(); f.disconnect();
  await until(() => f.failures() === 1);
  assert.equal(f.failures(), 1);
});
