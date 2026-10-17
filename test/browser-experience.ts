import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { Page } from 'playwright';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

type Fixture = {
  page: Page; humanUrl: string; sessionId: string; client: Client;
  report: Record<string, any>; record: (name: string) => Promise<void>;
  // Host-side observer scoped to the disposable runtime, never an Agent tool.
  observe: (source: string) => Promise<string>;
  login: () => Promise<void>; logout: () => Promise<void>;
};

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  const content = response.content as { type: string; text: string }[];
  if (response.isError) {
    let code = 'unclassified', status: number | undefined;
    try { const error = JSON.parse(content[0].text); code = error.error; status = error.status; } catch {}
    assert.fail(`Experience tool failed: ${name}, code=${code}, status=${status}`);
  }
  assert.equal(content[0].type, 'text'); return JSON.parse(content[0].text);
}

export const desktopConnected = (page: Page) => page.waitForFunction(() =>
  document.getElementById('connection')?.textContent === 'Connected' && !!document.querySelector('#desktop canvas'), null, { timeout: 20000 });

async function colorVisible(page: Page, rgb: number[], minimum = 8) {
  await page.waitForFunction(({ rgb, minimum }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('#desktop canvas');
    const context = canvas?.getContext('2d');
    if (!canvas || !context || !canvas.width || !canvas.height) return false;
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let matches = 0;
    for (let y = 100; y < canvas.height; y += 60) for (let x = 60; x < canvas.width; x += 60) {
      const offset = (y * canvas.width + x) * 4;
      if (rgb.every((value, index) => Math.abs(pixels[offset + index] - value) <= 8)) matches++;
    }
    return matches >= minimum;
  }, { rgb, minimum }, { timeout: 12000, polling: 100 });
}

export async function verifyDesktopExperience(fixture: Fixture, minutes: number) {
  const { page, client, sessionId, report, observe, record } = fixture;
  const started = Date.now();
  const stream = report.stream = { requestedMinutes: minutes, verifiedStreamingMs: 0, checkpoints: 0,
    connections: [] as { openedMs: number; closedMs?: number; frames: number; bytes: number; lastFrameAt: number; maxFrameGapMs: number }[],
    recoveries: [] as { kind: string; elapsedMs: number }[], duplicateViewerRejected: false,
    revocationDisconnectMs: 0, elapsedMs: 0, passed: false };
  page.on('websocket', socket => {
    if (!new URL(socket.url()).pathname.endsWith(`/api/human/${sessionId}/desktop`)) return;
    const connection = { openedMs: Date.now() - started, frames: 0, bytes: 0, lastFrameAt: 0, maxFrameGapMs: 0, closedMs: undefined as number | undefined };
    stream.connections.push(connection);
    socket.on('framereceived', ({ payload }) => {
      if (!Buffer.isBuffer(payload)) return;
      const now = Date.now();
      if (connection.lastFrameAt) connection.maxFrameGapMs = Math.max(connection.maxFrameGapMs, now - connection.lastFrameAt);
      connection.lastFrameAt = now; connection.frames++; connection.bytes += payload.length;
    });
    socket.on('close', () => { connection.closedMs = Date.now() - started; });
  });

  report.stage = 'install synthetic stream probe';
  // A changing patch proves delivery of fresh pixels. The rest of the page
  // acknowledges keyboard input with a unique color, independently of its timer.
  await observe(`const page=context.pages().find(p=>p.url()==='http://127.0.0.1:8080/demo');
    await page.evaluate(()=>{
      document.body.innerHTML='<main style="padding:260px 60px 40px;color:#fff"><h1>Desktop stream acceptance</h1><p>Local synthetic fixture only.</p><input id="stream-input" aria-label="Synthetic input"/><p id="stream-ack"></p></main><div id="stream-pulse" style="position:fixed;left:80px;top:60px;width:240px;height:160px"></div>';
      document.body.style.cssText='margin:0;min-height:100vh;background:rgb(40,140,60)';
      let tick=0; const pulse=document.getElementById('stream-pulse');
      setInterval(()=>{pulse.style.background=tick++%2?'rgb(32,80,192)':'rgb(192,80,32)';},1000);
      const input=document.getElementById('stream-input');
      input.addEventListener('keydown',event=>{if(event.key!=='Enter')return;
        const match=/^stream-(\\d+)$/.exec(input.value);if(!match)return;
        const n=Number(match[1]);document.body.style.background='rgb('+(40+n*47%160)+','+(150+n*31%80)+','+(40+n*67%160)+')';
        document.getElementById('stream-ack').textContent='Received: '+input.value;
      }); input.focus();
    });await browser.close();`);
  await page.goto(fixture.humanUrl); await desktopConnected(page);

  async function checkpoint() {
    await desktopConnected(page);
    const connection = stream.connections.at(-1); assert.ok(connection && connection.closedMs === undefined);
    await colorVisible(page, [32, 80, 192], 2); await colorVisible(page, [192, 80, 32], 2);
    const n = stream.checkpoints + 1;
    await page.locator('#desktop canvas').focus();
    await page.keyboard.press('Control+a'); await page.keyboard.type(`stream-${n}`); await page.keyboard.press('Enter');
    await colorVisible(page, [40 + n * 47 % 160, 150 + n * 31 % 80, 40 + n * 67 % 160]);
    assert.equal((await call(client, 'browser_status', { sessionId })).control, 'human');
    const blocked = await client.callTool({ name: 'browser_action', arguments: { sessionId, action: { type: 'snapshot' } } });
    assert.equal(blocked.isError, true);
    assert.equal(JSON.parse((blocked.content as { text: string }[])[0].text).status, 409);
    assert.ok(Date.now() - connection.lastFrameAt < 5000, 'The desktop must be delivering fresh frames');
    stream.checkpoints++;
  }
  await checkpoint();
  report.stage = 'duplicate viewer exclusion';
  const other = await page.context().newPage(); let otherFrames = 0;
  other.on('websocket', socket => socket.on('framereceived', ({ payload }) => { if (Buffer.isBuffer(payload)) otherFrames++; }));
  try {
    await other.goto(fixture.humanUrl);
    await other.waitForFunction(() => document.getElementById('message')?.textContent?.includes('another window'));
    assert.equal(otherFrames, 0); stream.duplicateViewerRejected = true;
  } finally { await other.close(); }

  async function recover(kind: string, interrupt: () => Promise<void>, restore: () => Promise<void>) {
    report.stage = kind;
    await interrupt(); const begin = Date.now(); const prior = stream.connections.length;
    await restore(); await desktopConnected(page); await checkpoint();
    assert.ok(stream.connections.length > prior, 'Recovery must establish a fresh desktop connection');
    const elapsedMs = Date.now() - begin; assert.ok(elapsedMs < 30000, 'Desktop recovery exceeded 30 seconds');
    stream.recoveries.push({ kind, elapsedMs }); await record(`desktop ${kind} passed`);
  }
  await page.locator('#text').fill('unsent-input-must-not-replay');
  await recover('network interruption', async () => {
    await page.context().setOffline(true);
    await page.waitForFunction(() => !document.querySelector('#desktop canvas') && (document.getElementById('text') as HTMLInputElement).disabled);
    assert.equal((await call(client, 'browser_status', { sessionId })).control, 'human');
  }, async () => { await page.context().setOffline(false); });
  assert.equal(await page.locator('#text').inputValue(), '');
  // Reload closes the first connection before restoring the viewer.
  const beforeReload = stream.connections.length, reloadedAt = Date.now();
  await page.reload(); await desktopConnected(page); await checkpoint();
  assert.ok(stream.connections.length > beforeReload);
  stream.recoveries.push({ kind: 'viewer reload', elapsedMs: Date.now() - reloadedAt });
  await recover('logout and reauthentication', async () => {
    const revokedAt = Date.now(); await fixture.logout();
    await page.waitForFunction(() => !document.querySelector('#desktop canvas'));
    stream.revocationDisconnectMs = Date.now() - revokedAt;
  }, async () => { await fixture.login(); await page.goto(fixture.humanUrl); });

  report.stage = 'sustained native desktop stream';
  while (stream.verifiedStreamingMs < minutes * 60000) {
    const connection = stream.connections.at(-1)!;
    const frameCount = connection.frames, begin = Date.now();
    await delay(Math.min(30000, minutes * 60000 - stream.verifiedStreamingMs));
    await checkpoint();
    assert.equal(stream.connections.at(-1), connection, 'Unexpected disconnect during the sustained interval');
    assert.ok(connection.frames > frameCount, 'A connected but frozen framebuffer must fail');
    assert.ok(connection.maxFrameGapMs < 10000, 'The animated fixture must not stop delivering frames for 10 seconds');
    stream.verifiedStreamingMs += Date.now() - begin;
    await record(`desktop stream verified for ${Math.floor(stream.verifiedStreamingMs / 1000)} seconds`);
  }
  // Return to the ordinary synthetic login used by the installation verifier.
  await observe(`const page=context.pages().find(p=>p.url()==='http://127.0.0.1:8080/demo');await page.reload();await page.locator('#username').focus();await browser.close();`);
  stream.elapsedMs = Date.now() - started; stream.passed = true;
  await record('sustained native pixels, keyboard acknowledgements, reconnect and revocation passed');
}

export async function verifyExternalExperience(client: Client, sessionId: string, report: Record<string, any>, record: (name: string) => Promise<void>) {
  const results = report.externalSites = [] as Record<string, unknown>[];
  const action = (value: object) => call(client, 'browser_action', { sessionId, action: value });
  async function waitSnapshot(expected: (snapshot: { url: string; title: string; text: string }) => boolean) {
    const deadline = Date.now() + 20000;
    do {
      const snapshot = (await action({ type: 'snapshot' })).result;
      if (expected(snapshot)) return snapshot;
      await delay(500);
    } while (Date.now() < deadline);
    assert.fail(`Expected public page state was not observed: ${report.stage}`);
  }
  async function check(name: string, url: string, text: RegExp, exercise: () => Promise<void>) {
    report.stage = `external ${name}`; const begin = Date.now();
    await action({ type: 'navigate', url });
    const snapshot = await waitSnapshot(s => new URL(s.url).hostname === new URL(url).hostname && text.test(s.text));
    await exercise();
    results.push({ name, url, title: snapshot.title, elapsedMs: Date.now() - begin, passed: true });
    await record(`external ${name} passed`);
  }
  // This sample explicitly supports testing. Todo mutations affect only this
  // disposable browser's local storage, not an external account or backend.
  await check('Playwright TodoMVC', 'https://demo.playwright.dev/todomvc/#/', /todos/, async () => {
    const task = 'Agentic Browser temporary task';
    await action({ type: 'fill', selector: 'input[placeholder="What needs to be done?"]', text: task });
    await action({ type: 'press', key: 'Enter' });
    await waitSnapshot(s => s.text.includes(task) && /1\s+item left/.test(s.text));
    await action({ type: 'click', selector: 'input[aria-label="Toggle Todo"]' });
    await waitSnapshot(s => /0\s+items left/.test(s.text));
    await action({ type: 'click', selector: 'a[href="#/active"]' });
    await waitSnapshot(s => new URL(s.url).hash === '#/active' && !s.text.includes(task));
    await action({ type: 'click', selector: 'a[href="#/completed"]' });
    await waitSnapshot(s => new URL(s.url).hash === '#/completed' && s.text.includes(task));
    await action({ type: 'reload' });
    await waitSnapshot(s => s.text.includes(task) && /0\s+items left/.test(s.text));
    await action({ type: 'click', selector: 'button:has-text("Clear completed")' });
    await waitSnapshot(s => /todos/.test(s.text) && !s.text.includes(task));
  });
  await check('Playwright documentation', 'https://playwright.dev/docs/intro', /Installation/, async () => {
    await action({ type: 'click', selector: 'a[href="/docs/writing-tests"] >> nth=0' });
    await waitSnapshot(s => new URL(s.url).pathname === '/docs/writing-tests' && /Writing tests/.test(s.text));
    await action({ type: 'back' });
    await waitSnapshot(s => new URL(s.url).pathname === '/docs/intro' && /Installation/.test(s.text));
    await action({ type: 'forward' }); await action({ type: 'reload' }); await action({ type: 'scroll', x: 0, y: 500 });
    await waitSnapshot(s => new URL(s.url).pathname === '/docs/writing-tests' && /Writing tests/.test(s.text));
  });
  await check('GitHub public repository', 'https://github.com/microsoft/playwright', /README/, async () => {
    // GitHub renders hidden and visible copies of the same file link.
    await action({ type: 'click', selector: 'a[href="/microsoft/playwright/blob/main/README.md"]:visible' });
    await waitSnapshot(s => new URL(s.url).pathname === '/microsoft/playwright/blob/main/README.md' && /Playwright/.test(s.text));
  });
  report.externalPassed = true;
  await record('external HTTPS sample form, local state, navigation, history, reload and repository file passed');
}
