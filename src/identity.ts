import { EventEmitter } from 'node:events';
import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { IncomingMessage } from 'node:http';
import { z } from 'zod';
import { ServiceError } from './contracts.js';

export const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9._-]{2,63}$/);
export const passwordSchema = z.string().min(12).max(256);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const denied = () => new ServiceError(401, 'unauthorized', 'Sign in or use a valid personal Agent credential.');
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key));
});
type MemberRow = { id: string; username: string; password: string; salt: string; active: number; guest_expires: number };
export type Principal = { ownerId: string; kind: 'human' | 'agent'; credentialHash: string; profileIds?: string[]; guest?: boolean };

// Only digests of browser cookies and Agent keys are stored. This database never
// contains browser profile data, page contents or plaintext member passwords.
export class IdentityStore extends EventEmitter {
  private db: DatabaseSync;
  private attempts = new Map<string, { count: number; resetAt: number }>();
  private verifying = 0;
  constructor(directory: string, private now = Date.now) {
    super();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const path = join(directory, 'identity.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, salt TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS credentials (hash TEXT PRIMARY KEY, id TEXT NOT NULL UNIQUE, owner TEXT NOT NULL REFERENCES members(id), kind TEXT NOT NULL, name TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS credentials_owner ON credentials(owner);
      PRAGMA user_version=1;`);
    if (!this.db.prepare('PRAGMA table_info(credentials)').all().some(column => column.name === 'profile_ids'))
      this.db.exec("ALTER TABLE credentials ADD COLUMN profile_ids TEXT NOT NULL DEFAULT '[]'");
    if (!this.db.prepare('PRAGMA table_info(members)').all().some(column => column.name === 'guest_expires'))
      this.db.exec('ALTER TABLE members ADD COLUMN guest_expires INTEGER NOT NULL DEFAULT 0');
  }
  close() { this.db.close(); }
  listMembers() { return this.db.prepare('SELECT id, username, active FROM members ORDER BY username').all(); }
  async createMember(username: string, password: string) {
    username = usernameSchema.parse(username); passwordSchema.parse(password);
    const id = randomUUID(), salt = secret();
    const hash = (await derive(password, salt)).toString('hex');
    try { this.db.prepare('INSERT INTO members(id,username,password,salt) VALUES(?,?,?,?)').run(id, username, hash, salt); }
    catch { throw new ServiceError(409, 'member_exists', 'The member name already exists, or the member record could not be saved.'); }
    return { id, username };
  }
  private member(username: string) {
    const row = this.db.prepare('SELECT * FROM members WHERE username=?').get(usernameSchema.parse(username)) as MemberRow | undefined;
    if (!row) throw new ServiceError(404, 'member_not_found', 'Member not found.');
    return row;
  }
  setActive(username: string, active: boolean) {
    const member = this.member(username);
    this.db.prepare('UPDATE members SET active=? WHERE id=?').run(Number(active), member.id);
    if (!active) this.db.prepare('DELETE FROM credentials WHERE owner=?').run(member.id);
    this.emit("revoked");
    return { id: member.id, active };
  }
  async setPassword(username: string, password: string) {
    const member = this.member(username), salt = secret(); passwordSchema.parse(password);
    const hash = (await derive(password, salt)).toString('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE members SET password=?,salt=? WHERE id=?').run(hash, salt, member.id);
      this.db.prepare('DELETE FROM credentials WHERE owner=?').run(member.id);
      this.db.exec('COMMIT');
      this.emit('revoked');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  isActive(owner: string) { return !!this.db.prepare('SELECT id FROM members WHERE id=? AND active=1 AND (guest_expires=0 OR guest_expires>?)').get(owner, this.now()); }
  createGuest(remoteAddress: string) {
    this.rateLimit(`guest:${remoteAddress}`, 6);
    this.reap();
    if (Number(this.db.prepare('SELECT count(*) AS total FROM members WHERE guest_expires>0').get()!.total) >= 128)
      throw new ServiceError(429, 'demo_busy', 'The demo is busy. Please try again later.');
    const id = randomUUID(), username = `guest-${id.slice(0, 12)}`;
    this.db.prepare('INSERT INTO members(id,username,password,salt,guest_expires) VALUES(?,?,?,?,?)').run(id, username, secret(), secret(), this.now() + 600000);
    return { ownerId: id, ...this.issue(id, 'human', 'Temporary demo visitor', 600000) };
  }
  deleteGuest(owner: string) {
    if (!this.db.prepare('SELECT id FROM members WHERE id=? AND guest_expires>0').get(owner)) return;
    this.db.prepare('DELETE FROM credentials WHERE owner=?').run(owner);
    this.db.prepare('DELETE FROM members WHERE id=?').run(owner);
    this.emit('revoked');
  }
  private issue(owner: string, kind: Principal['kind'], name: string, ttlMs: number, profileIds: string[] = []) {
    if (!this.isActive(owner)) throw denied();
    const token = `${kind === 'agent' ? 'ab_agent_' : 'ab_human_'}${secret()}`;
    const id = randomUUID(), expires = this.now() + ttlMs;
    this.db.prepare('INSERT INTO credentials(hash,id,owner,kind,name,expires,created,profile_ids) VALUES(?,?,?,?,?,?,?,?)').run(digest(token), id, owner, kind, name, expires, this.now(), JSON.stringify(profileIds));
    return { id, token, expiresAt: new Date(expires).toISOString() };
  }
  private rateLimit(key: string, maximum: number) {
    const now = this.now();
    for (const [id, value] of this.attempts) if (value.resetAt <= now) this.attempts.delete(id);
    if (this.attempts.size >= 4096 && !this.attempts.has(key)) throw new ServiceError(429, 'login_rate_limit', 'Too many sign-in attempts. Please try again later.');
    const state = this.attempts.get(key) ?? { count: 0, resetAt: now + 60000 };
    this.attempts.set(key, state);
    if (++state.count > maximum) throw new ServiceError(429, 'login_rate_limit', 'Too many sign-in attempts. Please try again later.');
  }
  async login(username: string, password: string, remoteAddress: string) {
    username = usernameSchema.parse(username); passwordSchema.parse(password);
    this.rateLimit(`ip:${remoteAddress}`, 30); this.rateLimit(`user:${username}`, 10);
    if (this.verifying >= 4) throw new ServiceError(429, 'login_busy', 'Sign-in is busy. Please try again later.');
    const row = this.db.prepare('SELECT * FROM members WHERE username=?').get(username) as MemberRow | undefined;
    this.verifying++;
    let hash: Buffer;
    try { hash = await derive(password, row?.salt ?? 'unknown-member-comparison-salt'); }
    finally { this.verifying--; }
    if (!row || row.guest_expires || !timingSafeEqual(hash, Buffer.from(row.password, 'hex')) || !this.db.prepare('SELECT id FROM members WHERE id=? AND password=? AND active=1').get(row.id, row.password)) throw denied();
    return { ...this.issue(row.id, 'human', 'Browser login', 12 * 3600000), username: row.username };
  }
  authenticate(token: string, kind: Principal['kind']): Principal {
    if (token.length > 128 || !token.startsWith(kind === 'agent' ? 'ab_agent_' : 'ab_human_')) throw denied();
    const hash = digest(token);
    const row = this.db.prepare('SELECT c.owner,c.profile_ids,m.guest_expires FROM credentials c JOIN members m ON m.id=c.owner WHERE c.hash=? AND c.kind=? AND c.expires>? AND m.active=1 AND (m.guest_expires=0 OR m.guest_expires>?)').get(hash, kind, this.now(), this.now());
    if (!row) throw denied();
    return { ownerId: String(row.owner), kind, credentialHash: hash, profileIds: JSON.parse(String(row.profile_ids)), guest: Number(row.guest_expires) > 0 };
  }
  assertCurrent(principal: Principal) {
    if (!this.db.prepare('SELECT c.id FROM credentials c JOIN members m ON m.id=c.owner WHERE c.hash=? AND c.owner=? AND c.kind=? AND c.expires>? AND m.active=1 AND (m.guest_expires=0 OR m.guest_expires>?)').get(principal.credentialHash, principal.ownerId, principal.kind, this.now(), this.now())) throw denied();
  }
  request(request: IncomingMessage, humanOnly = false): Principal {
    // Never fall back to a cookie if an explicit, invalid Agent token is supplied.
    if (request.headers.authorization) {
      if (humanOnly) throw denied();
      const token = /^Bearer (\S+)$/.exec(request.headers.authorization)?.[1] ?? '';
      return this.authenticate(token, 'agent');
    }
    const cookies = (request.headers.cookie ?? '').split(';').map(value => value.trim());
    const matches = cookies.filter(value => value.startsWith('ab_login='));
    if (matches.length !== 1) throw denied();
    return this.authenticate(matches[0].slice('ab_login='.length), 'human');
  }
  memberInfo(principal: Principal) {
    this.assertCurrent(principal);
    return this.db.prepare('SELECT id,username FROM members WHERE id=?').get(principal.ownerId)!;
  }
  issueAgent(principal: Principal, name: string, profileIds: string[] = []) {
    this.requireHuman(principal);
    if (principal.guest) throw new ServiceError(403, 'demo_restricted', 'Demo guests cannot create Agent credentials.');
    name = z.string().trim().min(1).max(80).parse(name);
    if (this.listAgents(principal).length >= 20) throw new ServiceError(429, 'credential_limit', 'Revoke unused Agent credentials first.');
    return this.issue(principal.ownerId, 'agent', name, 90 * 24 * 3600000, z.array(z.string().uuid()).max(100).parse(profileIds));
  }
  private requireHuman(principal: Principal) {
    this.assertCurrent(principal);
    if (principal.kind !== 'human') throw denied();
  }
  listAgents(principal: Principal) {
    this.requireHuman(principal);
    return this.db.prepare("SELECT id,name,created,expires FROM credentials WHERE owner=? AND kind='agent' AND expires>? ORDER BY created").all(principal.ownerId, this.now());
  }
  agentHash(principal: Principal, id: string) {
    this.requireHuman(principal);
    const key = this.db.prepare("SELECT hash FROM credentials WHERE id=? AND owner=? AND kind='agent' AND expires>?").get(id, principal.ownerId, this.now());
    if (!key) throw new ServiceError(404, 'credential_not_found', 'The Agent credential does not exist or has expired.');
    return String(key.hash);
  }
  revokeAgent(principal: Principal, id: string) {
    this.requireHuman(principal);
    this.db.prepare("DELETE FROM credentials WHERE id=? AND owner=? AND kind='agent'").run(id, principal.ownerId);
    this.emit("revoked");
  }
  logout(principal: Principal) { this.db.prepare('DELETE FROM credentials WHERE hash=?').run(principal.credentialHash); this.emit('revoked'); }
  reap() {
    this.db.prepare('DELETE FROM credentials WHERE expires<=?').run(this.now());
    this.db.prepare('DELETE FROM credentials WHERE owner IN (SELECT id FROM members WHERE guest_expires>0 AND guest_expires<=?)').run(this.now());
    this.db.prepare('DELETE FROM members WHERE guest_expires>0 AND guest_expires<=?').run(this.now());
  }
}
