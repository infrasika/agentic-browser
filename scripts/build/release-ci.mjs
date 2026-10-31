#!/usr/bin/env node
// CI reuses the same image publication and Compose delivery tools as local releases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NAMES, credentials, inspect, plan, publish, Registry, verifyPublic, verifyNativeBuild } from './publish-agent-images.mjs';
import { validateReport } from './release-images.mjs';
import { writeCompose } from './package-compose.mjs';
import { verifyCompose } from '../../test/acceptance/verify-compose.mjs';
import { cli, digest, Failure, json, run } from '../../deploy/agent/lib/system.mjs';

const version = process.env.RELEASE_VERSION;
const namespace = process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase();
const arch = process.env.RELEASE_ARCH;
const command = process.argv[2];
const script = (file, args) => run([process.execPath, 'scripts/build/' + file + '.mjs', ...args], { timeout: 7_200_000, stdout: 1, maxBuffer: 8 * 1024 * 1024 });
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const artifact = platform => path.join('artifacts', 'build-' + platform);

async function main() {
  assert(/^v\d+\.\d+\.\d+-preview\.\d+$/.test(version), 'Use a new vX.Y.Z-preview.N version');
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(namespace), 'Invalid package owner');
  if (command === 'stage' || command === 'package') {
    assert(['amd64', 'arm64'].includes(arch));
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, arch === 'amd64' ? 'x64' : 'arm64', 'Native runner required');
  }
  if (command === 'stage') {
    await script('build-agent-images', ['--run', '--committed', '--platforms', 'linux/' + arch, '--tag', version]);
    const builds = fs.readdirSync('output/build').filter(name => name.startsWith('build-'));
    assert.equal(builds.length, 1, 'Use a fresh CI workspace');
    const report = json(path.join('output/build', builds[0], arch, 'report.json'));
    console.log('Checking Agent source access under a non-default UID');
    await run(['docker', 'run', '--rm', '--network=none', '--read-only', '--user=65534:65534', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--memory=256m', '--entrypoint=node', report.images.agent.id,
      '--input-type=module', '-e', "import fs from 'node:fs'; for (const file of ['/app/package.json','/app/api/server/index.js','/app/client/dist/index.html']) fs.accessSync(file, fs.constants.R_OK); await import('/app/selfhost/settings.mjs');"], { stderr: 2 });
    const prepared = await plan([report], version, namespace);
    const [, receipt] = await publish(prepared, new Registry(await credentials()), run, inspect, { stageOnly: true });
    fs.mkdirSync('handoff'); write('handoff/report.json', report); write('handoff/publication.json', receipt);
  } else if (command === 'merge') {
    const reports = [];
    for (const platform of ['amd64', 'arm64']) {
      const report = json(path.join(artifact(platform), 'report.json'));
      const receipt = json(path.join(artifact(platform), 'publication.json'));
      validateReport(report);
      assert.equal(report.platform, 'linux/' + platform);
      // plan() below compares all image inputs with HEAD. This permits a CI or
      // packaging-only repair to resume immutable builds from an earlier run.
      assert.equal(receipt.version, version); assert.equal(receipt.namespace, namespace); assert.equal(receipt.staged, true);
      for (const [name, image] of Object.entries(report.images)) {
        const child = receipt.images[name].platforms[report.platform];
        assert.equal(child.id, image.id);
        if (!new RegExp('^ghcr\\.io/' + namespace + '/' + NAMES[name] + '@sha256:[a-f0-9]{64}$').test(child.reference)) throw new Failure('Invalid staged image reference: ' + name);
        await run(['docker', 'pull', '--platform', report.platform, child.reference], { timeout: 900_000 });
        assert.equal((await inspect(child.reference)).Id, image.id);
      }
      reports.push(report);
    }
    const prepared = await plan(reports, version, namespace);
    const [release, receipt] = await publish(prepared, new Registry(await credentials()));
    fs.mkdirSync('publication'); write('publication/release.json', release); write('publication/publication.json', receipt);
  } else if (command === 'package') {
    const release = json('publication/release.json');
    assert.equal(release.version, version);
    // No registry credentials: each new native host must pull all six images anonymously.
    console.log('Verifying anonymous pulls for linux/' + arch);
    const publicReceipt = await verifyPublic({ ...release, platforms: ['linux/' + arch] });
    const buildReport=json(path.join(artifact(arch),'report.json'));
    validateReport(buildReport); assert.equal(buildReport.platform,'linux/'+arch);
    console.log('Anonymous pulls passed; verifying native manifest and local image identities');
    publicReceipt.nativeBuild = await verifyNativeBuild(release, buildReport);
    fs.mkdirSync('delivery');
    write('delivery/public-pull-' + arch + '.json', publicReceipt);
    const work=path.join(process.env.RUNNER_TEMP,'compose-acceptance');
    console.log('Verifying Docker-only deployment, business isolation and container operations');
    const evidence=await verifyCompose({release,work});
    evidence.packageCommit=process.env.GITHUB_SHA;
    write('delivery/compose-acceptance-'+arch+'.json',evidence);
    assert.equal(evidence.passed,true,'Compose acceptance failed');
  } else if (command === 'collect') {
    const release=json('publication/release.json'), publication=json('publication/publication.json');
    assert.equal(release.version,version);assert.equal(publication.version,version);
    assert.equal(publication.published,true);assert.equal(publication.namespace,namespace);
    assert.equal(publication.toolCommit,process.env.GITHUB_SHA);
    for (const platform of ['amd64', 'arm64']) {
      const publicPull=json('delivery/public-pull-'+platform+'.json');
      assert.equal(publicPull.anonymousPullVerified,true);
      assert.equal(publicPull.version,version);
      assert.deepEqual(publicPull.images,json('publication/release.json').images);
      const compose = json('delivery/compose-acceptance-' + platform + '.json');
      assert.equal(compose.passed, true); assert.equal(compose.cleanup.passed, true); assert.equal(compose.cleanup.remaining, 0);
      assert.equal(compose.version, version); assert.equal(compose.packageCommit, process.env.GITHUB_SHA);
      assert.equal(compose.architecture, platform === 'amd64' ? 'x64' : 'arm64');
      assert.equal(compose.hostPlatform, 'linux'); assert.equal(compose.hostNodeOnDeploymentPath, false);
      assert.deepEqual(compose.images, json('publication/release.json').images);
    }
    writeCompose(json('publication/release.json'), 'compose-delivery');
    for (const file of fs.readdirSync('compose-delivery')) fs.copyFileSync(path.join('compose-delivery', file), path.join('delivery', file));
    for (const file of ['release.json', 'publication.json']) fs.copyFileSync('publication/' + file, 'delivery/' + file);
    let sums = '';
    for (const file of fs.readdirSync('delivery').sort()) sums += await digest('delivery/' + file) + '  ' + file + '\n';
    fs.writeFileSync('delivery/SHA256SUMS', sums);
    fs.writeFileSync('release-notes.md', `Agentic Browser MIT-licensed preview for Linux amd64 and arm64.

Download the release assets, verify SHA256SUMS, configure settings.json and secrets.env, then follow DEPLOYMENT.md. Docker Engine and Docker Compose are the server requirements; administration runs inside the supplied ops container. All six images use immutable digests. Component licenses remain in the images.

Both native Linux runners verified anonymous image pulls, startup, real Chrome handoff/resume, account isolation, queue admission, credits and daily budgets, logout cleanup, TLS mail password recovery, persistent data, consistent backups, fresh-project restores, failed-upgrade rollback, interrupted-backup recovery and scheduled retention. Acceptance uses simulated model and mail services; no paid model or external mail is called. Reports are attached. This does not verify a production model, public HTTPS, Mac Docker builds or off-host disaster recovery.

Source: ${process.env.GITHUB_SHA}
Actions: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}
`);
  } else throw new Error('Use stage, merge, package or collect');
}
cli(main);
