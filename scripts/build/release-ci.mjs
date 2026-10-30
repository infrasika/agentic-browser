#!/usr/bin/env node
// CI orchestration reuses the same build, publication and bundle tools as local releases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NAMES, credentials, inspect, plan, publish, Registry, verifyPublic } from './publish-agent-images.mjs';
import { validateReport } from './package-agent.mjs';
import { writeCompose } from './package-compose.mjs';
import { verifyCompose } from '../../test/acceptance/verify-compose.mjs';
import { cli, digest, json, run } from '../../deploy/agent/lib/system.mjs';

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
        assert(new RegExp('^ghcr\\.io/' + namespace + '/' + NAMES[name] + '@sha256:[a-f0-9]{64}$').test(child.reference));
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
    const output = path.resolve('output/registry-bundle');
    console.log('Packaging the verified platform digests');
    await script('package-agent', ['--build-report', path.join(artifact(arch), 'report.json'), '--version', version, '--release', 'publication/release.json', '--output', output]);
    const bundle = path.join(output, 'agentic-browser-agent-' + version);
    fs.mkdirSync('delivery');
    const archive = 'agentic-browser-agent-' + version + '-linux-' + arch + '.tar.gz';
    fs.copyFileSync(path.join(output, 'agentic-browser-agent-' + version + '.tar.gz'), path.join('delivery', archive));
    write('delivery/public-pull-' + arch + '.json', publicReceipt);
    // Run the archive actually being delivered, outside the source tree, without npm tools.
    const extracted = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, 'agent-release-'));
    await run(['tar', '-xzf', path.resolve('delivery', archive), '-C', extracted]);
    const installed = path.join(extracted, path.basename(bundle));
    const hostTools = path.join(extracted, 'host-tools'); fs.mkdirSync(hostTools);
    for (const tool of ['node', 'docker', 'flock']) fs.symlinkSync(await run(['which', tool]), path.join(hostTools, tool));
    const work = path.join(extracted, 'acceptance');
    console.log('Running the delivered archive on a fresh native host');
    try {
      await run([process.execPath, path.join(installed, 'acceptance/verify.mjs'), '--work', work], { cwd: extracted, env: { ...process.env, PATH: hostTools, AGENT_ACCEPTANCE_DIAGNOSTICS: '1' }, stdout: 1, stderr: 2, timeout: 2_700_000, maxBuffer: 8 * 1024 * 1024 });
    } finally {
      if (fs.existsSync(path.join(work, 'report.json'))) fs.copyFileSync(path.join(work, 'report.json'), 'delivery/acceptance-' + arch + '.json');
    }
    const evidence = json('delivery/acceptance-' + arch + '.json');
    assert.equal(evidence.passed, true); assert.equal(evidence.cleanup.passed, true);
    assert.equal(evidence.bundleVersion, version); assert.equal(evidence.packageCommit, process.env.GITHUB_SHA);
    console.log('Verifying the Docker-only Compose deployment');
    const composeEvidence = await verifyCompose({ release, work: path.join(extracted, 'compose-acceptance') });
    composeEvidence.packageCommit = process.env.GITHUB_SHA;
    write('delivery/compose-acceptance-' + arch + '.json', composeEvidence);
    assert.equal(composeEvidence.passed, true, 'Compose deployment acceptance failed');
  } else if (command === 'collect') {
    for (const platform of ['amd64', 'arm64']) {
      const report = json('delivery/acceptance-' + platform + '.json');
      assert.equal(report.passed, true); assert.equal(report.cleanup.passed, true);
      assert.equal(report.bundleVersion, version); assert.equal(report.packageCommit, process.env.GITHUB_SHA);
      assert(Object.values(report.images).every(image => image.platform === 'linux/' + platform));
      const compose = json('delivery/compose-acceptance-' + platform + '.json');
      assert.equal(compose.passed, true); assert.equal(compose.cleanup.passed, true);
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
    fs.writeFileSync('release-notes.md', `LibreChat-based Agent preview for Linux amd64 and arm64.\n\nThree project images (Agent, Browser Service, Chrome Runtime) plus digest-pinned Nginx, MongoDB and Redis. For Docker-only deployment, download compose.yaml, settings.json and secrets.env, verify SHA256SUMS, fill in the configuration and run docker compose up -d; follow COMPOSE.md. MIT-licensed project; component licenses remain in the images and artifacts. Both native platforms passed first start, real Chrome handoff/resume, restart persistence, separate configuration directories and invalid-configuration acceptance. The container ops service also passed account creation/reset, consistent backup, fresh-project restore, failed-upgrade rollback, interrupted-backup recovery, scheduled retention and same-day restart deduplication; all test resources were cleaned. The alternative installation archives retain the Node.js 24+ and flock management workflow. GitHub repository access is required to download this private repository's assets; images are anonymously pullable.\n\nBoth native Linux runners passed bundle installation, real Chrome browsing, human handoff/resume, backup/restore, interrupted-backup recovery and failed-upgrade protection using a simulated model. Reports and immutable image references are attached. This does not verify a production model, public HTTPS, SMTP, Mac Docker builds or migration from the old controller architecture.\n\nInstall this preview separately from old controller releases; do not use the old controller installer. No latest image tag is updated.\n\nSource: ${process.env.GITHUB_SHA}\nActions: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}\n`);
  } else throw new Error('Use stage, merge, package or collect');
}
cli(main);
