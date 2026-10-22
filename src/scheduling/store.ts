import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServiceError } from '../contracts.js';

export type Principal = { userId: string; conversationId: string; taskId: string };
export type LeaseState = 'queued' | 'starting' | 'active' | 'closing' | 'cleanup_pending' | 'completed' | 'cancelled' | 'failed' | 'expired';
export type Lease = Principal & {
  id: string; acquisitionId: string; purpose: string; url: string; state: LeaseState;
  sessionId: string | null; createdAt: number; updatedAt: number; expiresAt: number | null;
  revision: number; control: 'agent' | 'human' | 'switching' | 'closed'; error: string | null;
};
export type BrowserEvent = Principal & { id: number; leaseId: string; type: string; revision: number; createdAt: number };
export const terminalStates: LeaseState[] = ['completed', 'cancelled', 'failed', 'expired'];
const occupied = "'starting','active','closing','cleanup_pending'";

export class SchedulerStore {
  private db: DatabaseSync;
  constructor(path: string, readonly maxSessions = 20, private now = Date.now) {
    if (!Number.isInteger(maxSessions) || maxSessions < 1 || maxSessions > 20) throw new Error('Invalid capacity');
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('Unsafe scheduler file');
    }
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS leases (
        id TEXT PRIMARY KEY, userId TEXT NOT NULL, conversationId TEXT NOT NULL, taskId TEXT NOT NULL,
        acquisitionId TEXT NOT NULL, purpose TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL,
        sessionId TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, expiresAt INTEGER,
        revision INTEGER NOT NULL DEFAULT 0, control TEXT NOT NULL DEFAULT 'agent', error TEXT,
        UNIQUE(userId, taskId, acquisitionId)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_lease_per_user ON leases(userId)
        WHERE state IN ('queued',${occupied});
      CREATE INDEX IF NOT EXISTS queue_order ON leases(state, createdAt);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, leaseId TEXT NOT NULL, userId TEXT NOT NULL,
        conversationId TEXT NOT NULL, taskId TEXT NOT NULL, type TEXT NOT NULL,
        revision INTEGER NOT NULL, createdAt INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumers (name TEXT PRIMARY KEY, cursor INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        leaseId TEXT NOT NULL, operationId TEXT NOT NULL, fingerprint TEXT NOT NULL,
        state TEXT NOT NULL, result TEXT, PRIMARY KEY(leaseId, operationId)
      );`);
  }

  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  get(id: string): Lease {
    const row = this.db.prepare('SELECT * FROM leases WHERE id = ?').get(id);
    if (!row) throw new ServiceError(404, 'lease_not_found', 'Browser task not found');
    return row as unknown as Lease;
  }

  owned(id: string, principal: Principal): Lease {
    const lease = this.get(id);
    if (lease.userId !== principal.userId || lease.conversationId !== principal.conversationId || lease.taskId !== principal.taskId) {
      throw new ServiceError(404, 'lease_not_found', 'Browser task not found');
    }
    return lease;
  }

  forTask(principal: Principal): Lease | null {
    const row = this.db.prepare('SELECT * FROM leases WHERE userId=? AND conversationId=? AND taskId=? ORDER BY rowid DESC LIMIT 1')
      .get(principal.userId, principal.conversationId, principal.taskId);
    return row ? row as unknown as Lease : null;
  }

  acquire(principal: Principal, input: { acquisitionId: string; purpose: string; url: string }): Lease {
    return this.transaction(() => {
      const previous = this.db.prepare('SELECT id FROM leases WHERE userId=? AND taskId=? AND acquisitionId=?')
        .get(principal.userId, principal.taskId, input.acquisitionId);
      if (previous) {
        const lease = this.owned(String(previous.id), principal);
        if (lease.url !== input.url || lease.purpose !== input.purpose) throw new ServiceError(409, 'idempotency_conflict', 'Request identity was reused with different input');
        return lease;
      }
      const active = this.db.prepare(`SELECT id FROM leases WHERE userId=? AND state IN ('queued',${occupied})`).get(principal.userId);
      if (active) {
        const lease = this.get(String(active.id));
        if (lease.taskId === principal.taskId && lease.conversationId === principal.conversationId) return lease;
        throw new ServiceError(409, 'user_busy', 'Another browser task is already active for this account');
      }
      const id = randomUUID(); const now = this.now();
      this.db.prepare(`INSERT INTO leases(id,userId,conversationId,taskId,acquisitionId,purpose,url,state,createdAt,updatedAt)
        VALUES(?,?,?,?,?,?,?,'queued',?,?)`).run(id, principal.userId, principal.conversationId, principal.taskId, input.acquisitionId, input.purpose, input.url, now, now);
      return this.get(id);
    });
  }

  capacity() {
    const row = this.db.prepare(`SELECT COUNT(*) AS total FROM leases WHERE state IN (${occupied})`).get()!;
    return { occupied: Number(row.total), maximum: this.maxSessions };
  }

  position(lease: Lease): number | null {
    if (lease.state !== 'queued') return null;
    const row = this.db.prepare("SELECT COUNT(*) AS total FROM leases WHERE state='queued' AND rowid <= (SELECT rowid FROM leases WHERE id=?)").get(lease.id)!;
    return Number(row.total);
  }

  reserve(): Lease | undefined {
    return this.transaction(() => {
      if (this.capacity().occupied >= this.maxSessions) return undefined;
      const row = this.db.prepare("SELECT id FROM leases WHERE state='queued' ORDER BY rowid LIMIT 1").get();
      if (!row) return undefined;
      this.db.prepare("UPDATE leases SET state='starting',updatedAt=? WHERE id=?").run(this.now(), row.id);
      return this.get(String(row.id));
    });
  }

  update(id: string, patch: Partial<Pick<Lease, 'state' | 'sessionId' | 'expiresAt' | 'revision' | 'control' | 'error'>>, event?: string): Lease {
    return this.transaction(() => {
      const fields = Object.entries(patch);
      const allowed = new Set(['state', 'sessionId', 'expiresAt', 'revision', 'control', 'error']);
      if (fields.some(([key]) => !allowed.has(key))) throw new Error('Invalid lease update');
      this.db.prepare(`UPDATE leases SET ${fields.map(([key]) => `${key}=?`).concat('updatedAt=?').join(',')} WHERE id=?`)
        .run(...fields.map(([, value]) => value ?? null), this.now(), id);
      const lease = this.get(id);
      if (event) this.addEvent(lease, event);
      return lease;
    });
  }

  private addEvent(lease: Lease, type: string) {
    this.db.prepare('INSERT INTO events(leaseId,userId,conversationId,taskId,type,revision,createdAt) VALUES(?,?,?,?,?,?,?)')
      .run(lease.id, lease.userId, lease.conversationId, lease.taskId, type, lease.revision, this.now());
  }

  live(): Lease[] {
    return this.db.prepare(`SELECT * FROM leases WHERE state IN ('queued',${occupied}) ORDER BY rowid`).all() as unknown as Lease[];
  }

  /** Call only after runtime reconciliation has confirmed old containers are gone. */
  recover() {
    for (const lease of this.live()) {
      if (lease.state !== 'queued') this.update(lease.id, { state: 'failed', control: 'closed', error: 'service_restarted' }, 'session_ended');
    }
    this.db.prepare("UPDATE operations SET state='unknown' WHERE state='running'").run();
  }

  events(after: number, limit = 100): BrowserEvent[] {
    return this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT ?').all(after, Math.min(100, limit)) as unknown as BrowserEvent[];
  }

  cursor() { return Number(this.db.prepare("SELECT cursor FROM consumers WHERE name='librechat'").get()?.cursor ?? 0); }
  ack(cursor: number) {
    const max = Math.max(this.cursor(), Number(this.db.prepare('SELECT MAX(id) AS id FROM events').get()?.id ?? 0));
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > max) throw new ServiceError(400, 'invalid_cursor', 'Invalid event cursor');
    this.db.prepare("INSERT INTO consumers(name,cursor) VALUES('librechat',?) ON CONFLICT(name) DO UPDATE SET cursor=MAX(cursor,excluded.cursor)").run(cursor);
  }

  beginOperation(leaseId: string, operationId: string, fingerprint: string): { fresh: boolean; result?: unknown } {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM operations WHERE leaseId=? AND operationId=?').get(leaseId, operationId);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new ServiceError(409, 'idempotency_conflict', 'Operation identity was reused with different input');
        if (existing.state !== 'done') throw new ServiceError(409, 'operation_uncertain', 'Previous operation has no confirmed result; inspect state before continuing');
        return { fresh: false, result: JSON.parse(String(existing.result)) };
      }
      this.db.prepare("INSERT INTO operations(leaseId,operationId,fingerprint,state) VALUES(?,?,?,'running')").run(leaseId, operationId, fingerprint);
      return { fresh: true };
    });
  }

  finishOperation(leaseId: string, operationId: string, result: unknown) {
    const json = JSON.stringify(result ?? null);
    if (Buffer.byteLength(json) > 1024 * 1024) throw new ServiceError(413, 'result_too_large', 'Browser result is too large');
    this.db.prepare("UPDATE operations SET state='done',result=? WHERE leaseId=? AND operationId=?").run(json, leaseId, operationId);
  }

  /** Retain ended leases beyond the LC checkpoint TTL; never prune unacknowledged events or live resources. */
  prune(retentionMs: number) {
    if (!Number.isFinite(retentionMs) || retentionMs < 86400000) throw new Error('Retention must be at least one day');
    return this.transaction(() => {
      const cutoff = this.now() - retentionMs;
      const cursor = this.cursor();
      const eligible = `SELECT id FROM leases WHERE state IN ('completed','cancelled','failed','expired') AND updatedAt < ?
        AND NOT EXISTS (SELECT 1 FROM events WHERE events.leaseId=leases.id AND events.id>?)`;
      this.db.prepare(`DELETE FROM operations WHERE leaseId IN (${eligible})`).run(cutoff, cursor);
      const deleted = this.db.prepare(`DELETE FROM leases WHERE id IN (${eligible})`).run(cutoff, cursor);
      this.db.prepare('DELETE FROM events WHERE id<=? AND createdAt<?').run(cursor, cutoff);
      return Number(deleted.changes);
    });
  }

  close() { this.db.close(); }
}
