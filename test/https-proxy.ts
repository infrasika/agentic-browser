import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const exec = promisify(execFile);
export async function freePort() {
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

export class HttpsProxy {
  private child?: ChildProcess;
  private config = '';
  constructor(readonly root: string, readonly base: string, readonly upstream: string, readonly redirectPort: number,
    readonly report: Record<string, any>) {}

  async start() {
    const template = await readFile('deploy/nginx-public.conf', 'utf8');
    // Change deployment placeholders only. Keep the distributed proxy's headers,
    // buffering, timeouts, rate limits and WebSocket configuration under test.
    const server = template
      .replace('listen 80;', `listen 127.0.0.1:${this.redirectPort};`)
      .replace('listen 443 ssl;', `listen 127.0.0.1:${new URL(this.base).port} ssl;`)
      .replaceAll('server_name demo.example.com;', 'server_name 127.0.0.1;')
      .replace('https://demo.example.com$request_uri', `${this.base}$request_uri`)
      .replace('/etc/letsencrypt/live/demo.example.com/fullchain.pem', join(this.root, 'server.crt'))
      .replace('/etc/letsencrypt/live/demo.example.com/privkey.pem', join(this.root, 'server.key'))
      .replace('http://127.0.0.1:3334', this.upstream)
      .replace('proxy_set_header Host demo.example.com;', `proxy_set_header Host ${new URL(this.base).host};`);
    this.config = join(this.root, 'nginx.conf');
    await writeFile(this.config, `daemon off;\nworker_processes 1;\npid ${join(this.root, 'nginx.pid')};\nerror_log ${join(this.root, 'nginx-error.log')} crit;\nevents { worker_connections 256; }\nhttp {\naccess_log off;\nclient_body_temp_path ${join(this.root, 'body')};\nproxy_temp_path ${join(this.root, 'proxy')};\n${server}\n}\n`);
    await exec('nginx', ['-p', this.root, '-c', this.config, '-t']);
    this.report.nginxVersion = (await exec('nginx', ['-v'])).stderr.trim();
    this.report.templateSha256 = createHash('sha256').update(template).digest('hex');
    this.report.certificateVerification = 'Ephemeral CA trusted in Node and a disposable Chromium NSS store; no TLS bypass';
    await this.launch();
  }

  private async launch() {
    this.child = spawn('nginx', ['-p', this.root, '-c', this.config], { stdio: 'ignore' });
    await once(this.child, 'spawn');
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(this.child.exitCode, null, 'Disposable Nginx exited unexpectedly');
      try { if ((await fetch(this.base + '/health')).ok) return; } catch { /* Wait for the new listener. */ }
      await delay(100);
    }
    throw new Error('Disposable HTTPS proxy did not become healthy');
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    const closed = once(this.child, 'exit'); this.child.kill('SIGTERM');
    const timer = setTimeout(() => this.child?.kill('SIGKILL'), 5000);
    try { await closed; } finally { clearTimeout(timer); }
  }

  async restart() { await this.stop(); await this.launch(); }

  async verifyRateLimits() {
    const burst = async (path: string, count: number) => {
      const statuses: number[] = []; let next = 0;
      await Promise.all(Array.from({ length: 8 }, async () => {
        while (next++ < count) {
          const response = await fetch(this.base + path); await response.arrayBuffer(); statuses.push(response.status);
        }
      }));
      assert.equal(statuses.length, count); return statuses;
    };
    const modules = await burst('/vendor/novnc/core/crypto/md5.js', 60);
    assert.ok(modules.every(status => status === 200), 'Static viewer modules must not exhaust the API rate limit');
    const api = await burst('/api/auth/config', 80);
    assert.ok(api.includes(200) && api.includes(429), 'The API rate limit must remain active');
    assert.ok(api.every(status => status === 200 || status === 429));
    this.report.rateLimits = { moduleRequests: modules.length, modulesPassed: true,
      apiRequests: api.length, apiRejected: api.filter(status => status === 429).length };
    // Let the 40-request API burst drain before testing the normal login flow.
    await delay(5000);
  }

  async verifyTransport() {
    const redirect = await fetch(`http://127.0.0.1:${this.redirectPort}/self-host?probe=1`, { redirect: 'manual' });
    assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), this.base + '/self-host?probe=1');
    assert.equal((await fetch(this.base + '/health')).status, 200);
    // A separate Node process has no test CA. It must reject our certificate.
    const untrusted = { ...process.env }; delete untrusted.NODE_EXTRA_CA_CERTS;
    const source = `fetch(${JSON.stringify(this.base + '/health')}).then(()=>process.exit(1)).catch(e=>{
      if(!['UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN'].includes(e.cause?.code))process.exit(2);});`;
    await exec(process.execPath, ['-e', source], { env: untrusted, timeout: 15000 });
    // Trusting a CA must still reject a certificate for the wrong hostname.
    await exec(process.execPath, ['-e', `require('node:https').get(${JSON.stringify(this.base + '/health')},
      {servername:'wrong.acceptance.invalid'},()=>process.exit(1)).on('error',e=>{if(e.code!=='ERR_TLS_CERT_ALTNAME_INVALID')process.exit(2);});`], { timeout: 15000 });
    // Node fetch derives Host from its URL; use http.get for an actual bad Host.
    const direct = await new Promise<{ status: number | undefined; error: string }>((resolve, reject) => {
      const request = get(this.upstream + '/api/auth/me', { headers: { Host: 'wrong.acceptance.invalid' } }, response => {
        let body = ''; response.on('data', chunk => { body += chunk; });
        response.on('end', () => { try { resolve({ status: response.statusCode, error: JSON.parse(body).error }); } catch (error) { reject(error); } });
        response.on('error', reject);
      });
      request.on('error', reject); request.setTimeout(10000, () => request.destroy(new Error('Host check timed out')));
    });
    assert.equal(direct.status, 403); assert.equal(direct.error, 'host_rejected');
    this.report.transportPassed = true;
  }
}
