import { createHash, randomBytes } from 'node:crypto';
import { ServiceError } from '../contracts.js';
import type { Principal } from '../scheduling/store.js';

export type ViewerGrant = Principal & { leaseId: string; revision: number; role: 'observe' | 'input'; expiresAt: number };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class ViewerGrants {
  private grants = new Map<string, ViewerGrant>();
  constructor(private now = Date.now, private ttlMs = 30000, private maxGrants = 1000) {}
  issue(value: Omit<ViewerGrant, 'expiresAt'>) {
    for (const [key, grant] of this.grants) if (grant.expiresAt <= this.now()) this.grants.delete(key);
    if (this.grants.size >= this.maxGrants) throw new ServiceError(429, 'viewer_limit', 'Too many browser connection requests');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.ttlMs;
    this.grants.set(hash(token), { ...value, expiresAt });
    return { grant: token, expiresAt, path: `/browser/v1/${value.role}` };
  }
  consume(token: string, role: 'observe' | 'input') {
    const key = hash(token); const grant = this.grants.get(key);
    this.grants.delete(key);
    if (!grant || grant.expiresAt <= this.now() || grant.role !== role) throw new ServiceError(403, 'invalid_grant', 'Browser authorization expired');
    return grant;
  }
  revokeUser(userId: string) { for (const [key, grant] of this.grants) if (grant.userId === userId) this.grants.delete(key); }
}
