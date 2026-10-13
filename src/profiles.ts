import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, open, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { ServiceError } from "./contracts.js";

export const profileName = z.string().trim().min(1).max(80);
const metadata = z.object({ id: z.string().uuid(), name: profileName, createdAt: z.string().datetime(), ownerId: z.string().uuid().optional() }).strict();
export type ProfileInfo = z.infer<typeof metadata>;
export interface ProfileLease {
  info: ProfileInfo;
  directory: string;
  release(): Promise<void>;
}

// Linux flock locks the shared open-file description. Keeping the parent fd open
// retains the lock after the small flock process exits, including across stores.
export class ProfileStore {
  private root: string;
  constructor(directory: string) { this.root = resolve(directory); }

  private async initialize() {
    for (const path of [this.root, join(this.root, "profiles"), join(this.root, "locks")]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700);
    }
  }

  private path(id: string) {
    return join(this.root, "profiles", z.string().uuid().parse(id));
  }

  private busy(): never {
    throw new ServiceError(409, "profile_in_use", "此登录配置正在使用，请先结束对应会话。");
  }

  private async lock(id: string, checkBrowser = true) {
    this.path(id);
    await this.initialize();
    // Lock files stay outside the removable directory; never replace their inode.
    const handle = await open(join(this.root, "locks", `${id}.lock`), "a", 0o600);
    try {
      const status = await new Promise<number | null>((yes, no) => {
        const child = spawn("flock", ["--exclusive", "--nonblock", "3"], {
          stdio: ["ignore", "ignore", "ignore", handle.fd],
        });
        child.once("error", no);
        child.once("exit", yes);
      });
      if (status === 1) this.busy();
      if (status !== 0) throw new Error("Unable to lock browser profile");
      // Chrome can outlive an abruptly killed service. Its own process lock is
      // an additional guard: never delete or reuse a still-running browser.
      let singleton: string | undefined;
      try { singleton = await readlink(join(this.path(id), "chrome", "SingletonLock")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (checkBrowser && singleton) {
        const match = /^(.*)-(\d+)$/.exec(singleton);
        if (!match || match[1] !== hostname()) this.busy();
        try { process.kill(Number(match![2]), 0); this.busy(); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      return () => handle.close();
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  private async read(id: string) {
    try {
      const info = metadata.parse(JSON.parse(await readFile(join(this.path(id), "profile.json"), "utf8")));
      if (info.id !== id) throw new Error("Invalid profile metadata");
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new ServiceError(404, "profile_not_found", "登录配置不存在，请刷新列表。");
      throw error;
    }
  }

  async create(name: string, ownerId?: string): Promise<ProfileInfo> {
    const info = { ...(ownerId ? { ownerId: z.string().uuid().parse(ownerId) } : {}), id: randomUUID(), name: profileName.parse(name), createdAt: new Date().toISOString() };
    const release = await this.lock(info.id);
    try {
      await mkdir(this.path(info.id), { mode: 0o700 });
      await writeFile(join(this.path(info.id), "profile.json"), JSON.stringify(info), { mode: 0o600, flag: "wx" });
      return info;
    } finally { await release(); }
  }

  async list(ownerId?: string): Promise<ProfileInfo[]> {
    await this.initialize();
    const results: ProfileInfo[] = [];
    for (const id of await readdir(join(this.root, "profiles"))) {
      if (!z.string().uuid().safeParse(id).success) continue;
      try { const info = await this.read(id); if (info.ownerId === ownerId) results.push(info); }
      catch (error) { if (!(error instanceof ServiceError && error.status === 404)) throw error; }
    }
    return results.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async get(id: string, ownerId?: string) {
    const info = await this.read(id);
    if (info.ownerId !== ownerId) throw new ServiceError(404, "profile_not_found", "登录配置不存在，请刷新列表。");
    return info;
  }

  // Local administrator CLI only. No HTTP route can claim an ownerless profile
  // or transfer an existing member's profile to another member.
  async assignOwner(id: string, ownerId: string) {
    z.string().uuid().parse(ownerId);
    const release = await this.lock(id);
    try {
      const info = await this.get(id);
      const temporary = join(this.path(id), `metadata-${randomUUID()}.tmp`);
      await writeFile(temporary, JSON.stringify({ ...info, ownerId }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(this.path(id), 'profile.json'));
    } finally { await release(); }
  }

  // Controller-only recovery after the matching labelled container is proven
  // stopped/removed. Never remove another namespace's or a host Chrome's lock.
  async recoverRuntime(id: string, ownerId: string | undefined, runtimeHostname: string) {
    if (!/^ab-[a-f0-9-]{36}$/.test(runtimeHostname)) throw new Error('Invalid runtime hostname');
    const release = await this.lock(id, false);
    try {
      await this.get(id, ownerId);
      const directory = join(this.path(id), 'chrome');
      let singleton: string;
      try { singleton = await readlink(join(directory, 'SingletonLock')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (!singleton.startsWith(runtimeHostname + '-')) throw new Error('Profile belongs to another runtime');
      for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) await rm(join(directory, name), { force: true });
    } finally { await release(); }
  }

  async acquire(id: string, ownerId?: string): Promise<ProfileLease> {
    await this.get(id, ownerId);
    const release = await this.lock(id);
    try {
      const info = await this.get(id, ownerId);
      const directory = join(this.path(id), "chrome");
      await mkdir(directory, { recursive: true, mode: 0o700 });
      return { info, directory, release };
    } catch (error) { await release(); throw error; }
  }

  async remove(id: string, ownerId?: string) {
    await this.get(id, ownerId);
    const release = await this.lock(id);
    try {
      await this.get(id, ownerId);
      await rm(this.path(id), { recursive: true, force: true });
    } finally { await release(); }
  }
}
