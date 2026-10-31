// Private container entry point. Only the controller's stdin/stdout pipe is used;
// CDP and VNC listen on container loopback and have no published host ports.
import { createInterface } from 'node:readline';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createConnection, createServer, type Socket, type Server, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { DesktopWorkspace } from './desktop.js';
import { actionSchema, ServiceError } from './contracts.js';

let workspace: DesktopWorkspace | undefined;
let stopping = false;
const streams = new Map<string, Socket>();
const proxySockets = new Set<Socket>();
let proxy: Server | undefined;
const send = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n');
async function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const stream of streams.values()) stream.destroy();
  await workspace?.close();
  for (const socket of proxySockets) socket.destroy();
  proxy?.close();
  process.exitCode = 0;
}
const input = createInterface({ input: process.stdin });
let tail = Promise.resolve();
input.on('line', line => {
  if (line.length > 131072) { void shutdown(); input.close(); return; }
  let message: any;
  try { message = JSON.parse(line); } catch { return; }
  if (message.operation === 'revoke') { workspace?.revokeHumanInput(); return; }
  if (message.operation === 'desktop-write') {
    const data = Buffer.from(String(message.data), 'base64');
    const stream = streams.get(message.stream);
    if (data.length > 65536 || (stream?.writableLength ?? 0) > 1024 * 1024) stream?.destroy();
    else stream?.write(data);
    return;
  }
  if (message.operation === 'desktop-close') { streams.get(message.stream)?.destroy(); return; }
  if (message.operation === 'close') {
    void shutdown().finally(() => { send({ id: message.id, result: null }); input.close(); }); return;
  }
  tail = tail.then(async () => {
    try {
      if (stopping) throw new Error('Runtime closing');
      let result: unknown = null;
      if (message.operation === 'start') {
        if (workspace) throw new Error('Already started');
        workspace = new DesktopWorkspace(await mkdtemp(join(tmpdir(), 'browser-')));
        const chromeArgs: string[] = [];
        if (message.publicEgress === true) {
          proxy = createServer(client => {
            const upstream = createConnection('/egress/egress.sock');
            const stop = () => { client.destroy(); upstream.destroy(); };
            for (const socket of [client, upstream]) {
              proxySockets.add(socket); socket.on('close', () => { proxySockets.delete(socket); stop(); }); socket.on('error', stop);
            }
            client.pipe(upstream); upstream.pipe(client);
          });
          proxy.maxConnections = 64;
          proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
          chromeArgs.push(`--proxy-server=http://127.0.0.1:${(proxy.address() as AddressInfo).port}`, '--proxy-bypass-list=<-loopback>');
        }
        await workspace.start('/usr/bin/google-chrome-stable', chromeArgs, message.publicEgress === true);
        const lock = JSON.parse(await readFile('/app/runtime/assets.lock.json', 'utf8'));
        await workspace.verifyExtensions(lock.extensions);
      } else {
        if (!workspace) throw new Error('Runtime not started');
        if (message.operation === 'perform') {
          const action = actionSchema.parse(message.action);
          result = await workspace.perform(action);
        }
        else if (message.operation === 'screenshot') result = (await workspace.screenshot(message.mask !== false)).toString('base64');
        else if (message.operation === 'control') await workspace.setControl(z.enum(['agent', 'human']).parse(message.actor));
        else if (message.operation === 'desktop-open') {
          const id = z.string().uuid().parse(message.stream);
          if (streams.size) throw new Error('An input stream already exists');
          const socket = workspace.openDesktop(); streams.set(id, socket);
          socket.on('data', data => {
            if (!send({ event: 'desktop-data', stream: id, data: data.toString('base64') })) {
              socket.pause(); process.stdout.once('drain', () => socket.resume());
            }
          });
          socket.on('close', () => { streams.delete(id); send({ event: 'desktop-close', stream: id }); });
        } else throw new Error('Unknown runtime operation');
      }
      send({ id: message.id, result });
    } catch (error) {
      send({ id: message.id, error: error instanceof ServiceError ? { status: error.status, code: error.code, message: error.message } : { status: 502, code: 'runtime_operation_failed', message: 'Browser operation failed. Check the session status.' } });
    }
  });
});
input.on('close', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown().finally(() => process.exit()); });
process.on('SIGINT', () => { void shutdown().finally(() => process.exit()); });
process.stdout.on('error', () => { void shutdown(); });
