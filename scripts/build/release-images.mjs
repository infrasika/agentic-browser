import path from 'node:path';
import { Failure, run, same } from '../../deploy/agent/lib/system.mjs';
export const ROOT = path.resolve(import.meta.dirname, '../..');
export const INFRA = {
  gateway: 'nginx@sha256:47928bf67eb62a1863cb08d9ecb52d3e704304ba614eaee17884204677702951',
  mongo: 'mongo:8.0.34@sha256:b9924c330a8bbc5800fe9c69f04a84e221eca7b28fd049a0354147d9908fa142',
  redis: 'redis:7.4-alpine@sha256:57e4255cc971b1c8d6f8a6ca283ac01bc3ecdd914273ef6bfaede87aaecd6541',
};
export const gitBytes = (repo, revision, file) => run(['git', 'show', revision + ':' + file], { cwd: repo, binary: true });
export function validateReport(report) {
  if (report.passed !== true || report.sourceMode !== 'committed') throw new Failure('a completed build from committed sources is required');
  if (Object.keys(report.images ?? {}).sort().join(',') !== 'agent,browser,runtime') throw new Failure('a complete three-image build is required');
  if (!['linux/amd64', 'linux/arm64'].includes(report.platform)) throw new Failure('explicit supported build platform required');
  if (!/^[a-f0-9]{40}$/.test(report.librechatTree)) throw new Failure('verified LibreChat source tree required');
  if (!report.sourceCommits?.browser || !report.sourceCommits?.librechat || Object.values(report.sourceCommits).some(v => !/^[a-f0-9]{40}$/.test(v))) throw new Failure('invalid source revision');
  if (Object.values(report.images).some(i => !/^sha256:[a-f0-9]{64}$/.test(i.id))) throw new Failure('invalid image identity');
}
export async function validateImageSources(sourceCommit, packageCommit) {
  const paths = ['LICENSE', 'deploy/agent/app', 'deploy/agent/lib', 'deploy/compose/operations.mjs', 'deploy/compose/licenses', 'scripts/build/bundle-tools.mjs', 'deploy/agent/agent.Dockerfile', 'deploy/agent/browser.Dockerfile', 'src', 'runtime', 'integrations/librechat/source.lock.json', 'integrations/librechat/customizations.patch', 'integrations/librechat/LICENSE', 'package-lock.json', 'tsconfig.json'];
  if (await run(['git', 'diff', '--name-only', sourceCommit, packageCommit, '--', ...paths], { cwd: ROOT })) throw new Failure('application/image inputs changed since the recorded build; rebuild first');
  const before = JSON.parse(await gitBytes(ROOT, sourceCommit, 'package.json')), after = JSON.parse(await gitBytes(ROOT, packageCommit, 'package.json'));
  delete before.scripts; delete after.scripts;
  if (!same(before, after)) throw new Failure('application package manifest changed; rebuild first');
}
