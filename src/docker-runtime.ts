import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, open, readdir, rm, chmod, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Duplex } from 'node:stream';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { BrowserAllocationError, ServiceError, type Actor, type BrowserAction, type BrowserEngine, type BrowserWorkspace } from './contracts.js';
import { ProfileStore, type ProfileLease } from './profiles.js';
import { runtimeMount, type RuntimeVolume } from './runtime-mounts.js';

const exec = promisify(execFile);
const docker = (args: string[]) => exec('docker', args, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
const recordSchema = z.object({ id: z.string().uuid(), name: z.string(), hostname: z.string(), ownerId: z.string().uuid().optional(), profileId: z.string().uuid().optional() }).strict();
type RuntimeRecord = z.infer<typeof recordSchema>;

export class DockerEngine implements BrowserEngine {
  readonly profiles: ProfileStore;
  private root: string;
  private initialized?: Promise<void>;
  private instance = '';
  private image = '';
  private platform: 'linux/amd64' | 'linux/arm64';
  private releaseLock?: () => Promise<void>;
  private workspaces = new Map<string, DockerWorkspace>();
  private stopping = false;
  private reaping?: Promise<void>;
  constructor(private options: { dataDirectory: string; image?: string; platform?: 'linux/amd64' | 'linux/arm64'; seccompPath?: string; network?: 'none' | 'public'; denyHosts?: string[]; volume?: RuntimeVolume }) {
    this.platform = options.platform ?? (process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64');
    this.root = resolve(options.dataDirectory, 'runtimes');
    this.profiles = new ProfileStore(options.dataDirectory);
  }
  async initialize() { return this.initialized ??= this.prepare(); }
  private async prepare() {
    await mkdir(this.root, { recursive: true, mode: 0o700 }); await chmod(this.root, 0o700);
    const lock = await open(join(this.root, 'controller.lock'), 'a', 0o600);
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', lock.fd] });
      child.once('error', reject); child.once('exit', resolve);
    });
    if (code !== 0) { await lock.close(); throw new Error('Another runtime controller owns this data directory'); }
    this.releaseLock = () => lock.close();
    try {
      if (this.options.volume) {
        const version = (await docker(['version', '--format', '{{.Server.APIVersion}}'])).stdout.trim().split('.').map(Number);
        if (version[0] !== 1 || !Number.isInteger(version[1]) || version[1] < 45) throw new Error('Volume isolation requires Docker Engine 26 or newer');
        await docker(['volume', 'inspect', this.options.volume.name, '--format', '{{.Name}}']);
        await runtimeMount(this.root, '/check', this.options.volume);
      }
      const path = join(this.root, 'instance-id');
      try { this.instance = z.string().uuid().parse((await readFile(path, 'utf8')).trim()); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        this.instance = randomUUID(); await writeFile(path, this.instance, { flag: 'wx', mode: 0o600 });
      }
      const nativePlatform = process.arch === 'arm64' ? 'linux/arm64' : 'linux/amd64';
      const inspectPlatform = this.platform === nativePlatform ? [] : ['--platform', this.platform];
      // Pin the top-level image ID first. With containerd, platform inspection
      // returns a child manifest digest that cannot be resolved as an image ID.
      this.image = (await docker(['image', 'inspect', this.options.image ?? 'agentic-browser:zkpass-prototype', '--format', '{{.Id}}'])).stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(this.image)) throw new Error('Runtime image is not available locally');
      if ((await docker(['image', 'inspect', ...inspectPlatform, this.image, '--format', '{{.Os}}/{{.Architecture}}'])).stdout.trim() !== this.platform)
        throw new Error('Chrome runtime platform does not match the configured platform');
      await this.reap();
    } catch (error) { await this.releaseLock(); this.releaseLock = undefined; throw error; }
  }
  private recordPath(id: string) { return join(this.root, `${z.string().uuid().parse(id)}.json`); }
  async create(options?: { profileId?: string; ownerId?: string }) {
    await this.initialize();
    if (this.stopping) throw new ServiceError(503, 'shutting_down', 'Runtime controller is closing');
    const lease = options?.profileId ? await this.profiles.acquire(options.profileId, options.ownerId) : undefined;
    if (lease) {
      const release = lease.release; let released = false;
      lease.release = async () => { if (!released) { await release(); released = true; } };
    }
    const id = randomUUID();
    const record: RuntimeRecord = { id, name: `agentic-runtime-${id}`, hostname: `ab-${id}`, ownerId: options?.ownerId, profileId: options?.profileId };
    const workspace = new DockerWorkspace(record, lease, () => this.cleanup(record, lease));
    this.workspaces.set(id, workspace);
    try {
      await writeFile(this.recordPath(id), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      const proxyDirectory = join(this.root, `${id}-proxy`);
      if (this.options.network === 'public') {
        await mkdir(proxyDirectory, { mode: 0o700 });
        await docker(['run', '--platform', this.platform, '-d', '--rm', '--init', '--name', `agentic-egress-${id}`,
          '--label', `dev.agentic-browser.instance=${this.instance}`, '--label', `dev.agentic-browser.runtime=${id}`,
          '--network', 'bridge', '--read-only', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
          '--tmpfs', '/tmp:rw,nosuid,nodev,size=16m', '--memory', '128m', '--cpus', '0.5', '--pids-limit', '64',
          '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
          '--env', `AGENTIC_DENY_HOSTS=${JSON.stringify(this.options.denyHosts ?? [])}`,
          '--mount', await runtimeMount(proxyDirectory, '/proxy', this.options.volume),
          this.image, 'node', '--import', 'tsx', 'src/egress-proxy.ts']);
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try { ready = (await stat(join(proxyDirectory, 'egress.sock'))).isSocket(); } catch {}
          if (ready) break; await delay(50);
        }
        if (!ready) throw new Error('Egress proxy did not start');
      }
      const args = ['run', '--platform', this.platform, '--rm', '--init', '-i', '--name', record.name, '--hostname', record.hostname,
        '--label', `dev.agentic-browser.instance=${this.instance}`, '--label', `dev.agentic-browser.runtime=${id}`,
        '--network', 'none', '--read-only', '--user', `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        '--tmpfs', '/tmp:rw,nosuid,nodev,size=768m', '--shm-size', '512m', '--memory', '2g', '--cpus', '2', '--pids-limit', '512',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--security-opt', `seccomp=${resolve(this.options.seccompPath ?? 'runtime/chrome-seccomp.json')}`];
      if (lease) args.push('--mount', await runtimeMount(lease.directory, '/profile', this.options.volume));
      if (this.options.network === 'public') args.push('--mount', await runtimeMount(proxyDirectory, '/egress', this.options.volume, true));
      args.push(this.image, 'node', '--import', 'tsx', 'src/runtime-worker.ts');
      await workspace.start(args, this.options.network === 'public');
      return workspace;
    } catch (error) {
      try { await workspace.close(); }
      catch { throw new BrowserAllocationError(workspace); }
      throw error;
    }
  }
  private async removeContainer(name: string, runtimeId: string) {
    // Never stop by an unverified name: inspect immutable instance/runtime labels.
    const { stdout } = await docker(['ps', '-aq', '--filter', `label=dev.agentic-browser.instance=${this.instance}`, '--filter', `label=dev.agentic-browser.runtime=${runtimeId}`]);
    const ids = stdout.trim().split('\n').filter(Boolean);
    for (const id of ids) {
      if (!/^[a-f0-9]{12,64}$/.test(id)) throw new Error('Invalid container identity');
      try { await docker(['stop', '--time', '6', id]); }
      catch (error) { if ((await docker(['ps', '-aq', '--filter', `id=${id}`])).stdout.trim()) throw error; }
      // Docker --rm is asynchronous: stop may return while removal is in
      // progress. Confirm disappearance instead of treating that race as a leak.
      const gone = async () => !(await docker(['ps', '-aq', '--filter', `id=${id}`])).stdout.trim();
      let removed = false;
      for (let attempt = 0; attempt < 10; attempt++) { if (await gone()) { removed = true; break; } await delay(100); }
      if (!removed) {
        let removalError: unknown;
        try { await docker(['rm', '-f', id]); } catch (error) { removalError = error; }
        for (let attempt = 0; attempt < 30; attempt++) { if (await gone()) { removed = true; break; } await delay(100); }
        if (!removed) throw removalError ?? new Error('Container cleanup not yet confirmed');
      }
    }
    if ((await docker(['ps', '-aq', '--filter', `name=^/${name}$`])).stdout.trim())
      throw new Error('Unrecognised container occupies runtime name; refusing cleanup');
  }
  private async cleanup(record: RuntimeRecord, lease?: ProfileLease) {
    await this.removeContainer(record.name, record.id);
    // Release only after the isolated processes are confirmed stopped.
    await lease?.release();
    if (record.profileId) await this.profiles.recoverRuntime(record.profileId, record.ownerId, record.hostname);
    await rm(join(this.root, `${record.id}-proxy`), { recursive: true, force: true });
    await rm(this.recordPath(record.id), { force: true });
    this.workspaces.delete(record.id);
  }
  async reap() {
    return this.reaping ??= this.reapOnce().finally(() => { this.reaping = undefined; });
  }
  private async reapOnce() {
    if (!this.instance) return;
    for (const file of await readdir(this.root)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue;
      const record = recordSchema.parse(JSON.parse(await readFile(join(this.root, file), 'utf8')));
      if (file !== `${record.id}.json` || record.name !== `agentic-runtime-${record.id}` || record.hostname !== `ab-${record.id}`) throw new Error('Invalid runtime ledger');
      const active = this.workspaces.get(record.id);
      if (active && !active.closed) continue;
      if (active) await active.close(); else await this.cleanup(record);
    }
  }
  async close() {
    this.stopping = true;
    await this.reaping?.catch(() => {});
    const results = await Promise.allSettled([...this.workspaces.values()].map(workspace => workspace.close()));
    await this.releaseLock?.(); this.releaseLock = undefined;
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

export class DockerWorkspace implements BrowserWorkspace {
  readonly transport = 'desktop' as const;
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private streams = new Map<string, Duplex>();
  private closing?: Promise<void>;
  closed = false;
  private runtimeState: NonNullable<BrowserWorkspace['runtime']>['state'] = 'allocating';
  constructor(readonly record: RuntimeRecord, private lease: ProfileLease | undefined, private cleanup: () => Promise<void>) {}
  get profile() { return this.lease?.info; }
  get runtime() { return { id: this.record.id, state: this.runtimeState }; }
  async start(args: string[], publicEgress = false) {
    this.child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.resume(); // Browser/daemon errors never leak private page data.
    this.child.stdin.on('error', () => this.fail());
    this.child.on('error', () => this.fail());
    this.child.on('exit', () => this.fail());
    createInterface({ input: this.child.stdout }).on('line', line => this.receive(line));
    await this.rpc('start', { profile: this.lease?.info, publicEgress });
    this.runtimeState = 'ready';
  }
  private fail() {
    this.closed = true;
    this.runtimeState = 'cleanup_pending';
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new ServiceError(503, 'runtime_stopped', '浏览器环境已停止。')); }
    this.pending.clear();
    for (const stream of this.streams.values()) stream.destroy();
  }
  private receive(line: string) {
    try {
      if (line.length > 8 * 1024 * 1024) throw new Error('Oversized runtime message');
      const value = JSON.parse(line);
      if (value.event === 'desktop-data') {
        const stream = this.streams.get(value.stream);
        if (!stream) return;
        if (stream.readableLength > 4 * 1024 * 1024) { stream.destroy(); return; }
        stream.push(Buffer.from(value.data, 'base64')); return;
      }
      if (value.event === 'desktop-close') { this.streams.get(value.stream)?.destroy(); return; }
      const request = this.pending.get(value.id); if (!request) return;
      this.pending.delete(value.id); clearTimeout(request.timer);
      if (value.error) request.reject(new ServiceError(value.error.status, value.error.code, value.error.message));
      else request.resolve(value.result);
    } catch { this.fail(); }
  }
  private send(value: unknown) {
    if (!this.child || this.child.stdin.destroyed) throw new ServiceError(503, 'runtime_stopped', '浏览器环境已停止。');
    if (this.child.stdin.writableLength > 4 * 1024 * 1024) throw new Error('Runtime input queue is full');
    this.child.stdin.write(JSON.stringify(value) + '\n');
  }
  private rpc(operation: string, payload: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ServiceError(504, 'runtime_timeout', '浏览器环境没有及时响应。')); }, 30000).unref();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, operation, ...payload }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async perform(action: BrowserAction) { return this.rpc('perform', { action }); }
  async screenshot(mask = true) { return Buffer.from(await this.rpc('screenshot', { mask }), 'base64'); }
  async setControl(actor: Actor) { this.revokeHumanInput(); await this.rpc('control', { actor }); }
  revokeHumanInput() {
    for (const stream of this.streams.values()) stream.destroy();
    try { this.send({ operation: 'revoke' }); } catch {}
  }
  openDesktop(): Duplex {
    if (this.closed || this.streams.size) throw new ServiceError(409, 'control_unavailable', '远程桌面不可用或已有输入连接。');
    const id = randomUUID();
    const stream = new Duplex({
      read() {},
      write: (chunk, _encoding, done) => {
        try { this.send({ operation: 'desktop-write', stream: id, data: Buffer.from(chunk).toString('base64') }); done(); }
        catch (error) { done(error as Error); }
      },
      destroy: (error, done) => {
        this.streams.delete(id);
        try { this.send({ operation: 'desktop-close', stream: id }); } catch {}
        done(error);
      },
    });
    stream.on('error', () => {}); this.streams.set(id, stream);
    void this.rpc('desktop-open', { stream: id }).catch(() => stream.destroy());
    return stream;
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true; this.runtimeState = 'closing'; this.revokeHumanInput();
      this.closing = (async () => {
        if (this.child && this.child.exitCode === null && !this.child.stdin.destroyed) {
          await this.rpc('close').catch(() => {}); this.child.stdin.end();
        }
        await this.cleanup();
        this.runtimeState = 'closed';
      })().catch(error => { this.runtimeState = 'cleanup_pending'; this.closing = undefined; throw error; });
    }
    return this.closing;
  }
}
