import { createHash, randomBytes } from 'node:crypto';
import type { Principal } from './identity.js';
import { ServiceError } from './contracts.js';

type Grant = { sessionId: string; revision: number; ownerId: string; credentialHash: string; expires: number };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

// Connection tickets are in-memory, single-use, and bound to this exact human
// login and control revision. They never appear in URLs or Agent responses.
export class MirrorGrants {
  private grants = new Map<string, Grant>();
  constructor(private now = Date.now) {}
  issue(sessionId: string, revision: number, human: Principal) {
    for (const [id, grant] of this.grants) if (grant.expires <= this.now()) this.grants.delete(id);
    if (human.kind !== 'human') throw new ServiceError(403, 'human_required', '请由成员本人登录接管页面。');
    if (this.grants.size >= 512) throw new ServiceError(429, 'mirror_grant_limit', '连接请求繁忙，请稍后重试。');
    // A new reconnect attempt invalidates unused tickets of the same login.
    for (const [id, grant] of this.grants)
      if (grant.sessionId === sessionId && grant.credentialHash === human.credentialHash) this.grants.delete(id);
    const token = randomBytes(32).toString('base64url');
    const expires = this.now() + 15000;
    this.grants.set(hash(token), { sessionId, revision, ownerId: human.ownerId, credentialHash: human.credentialHash, expires });
    return { ticket: token, revision, expiresAt: new Date(expires).toISOString() };
  }
  consume(token: unknown, sessionId: string, revision: number, human: Principal) {
    if (typeof token !== 'string' || token.length !== 43) throw new Error('Invalid mirror ticket');
    const key = hash(token), grant = this.grants.get(key);
    this.grants.delete(key);
    if (!grant || grant.expires <= this.now() || human.kind !== 'human' || grant.sessionId !== sessionId || grant.revision !== revision || grant.ownerId !== human.ownerId || grant.credentialHash !== human.credentialHash)
      throw new Error('Invalid mirror ticket');
  }
}
