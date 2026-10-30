#!/usr/bin/env node
// CI orchestration reuses the same build, publication and bundle tools as local releases.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { NAMES, credentials, inspect, plan, publish, Registry, verifyPublic } from './publish-agent-images.mjs';
import { validateReport } from './package-agent.mjs';
import { cli, digest, json, run } from '../../deploy/agent/lib/system.mjs';

const version = process.env.RELEASE_VERSION;
const namespace = process.env.GITHUB_REPOSITORY_OWNER?.toLowerCase();
const arch = process.env.RELEASE_ARCH;
const command = process.argv[2];
const script = (file, args) => run([process.execPath, 'scripts/build/' + file + '.mjs', ...args], { timeout: 7_200_000, maxBuffer: 8 * 1024 * 1024 });
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
      assert.equal(report.sourceCommits.browser, process.env.GITHUB_SHA);
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
    const publicReceipt = await verifyPublic({ ...release, platforms: ['linux/' + arch] });
    const output = path.resolve('output/registry-bundle');
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
    try {
      console.log(await run([process.execPath, path.join(installed, 'acceptance/verify.mjs'), '--work', work], { cwd: extracted, env: { ...process.env, PATH: hostTools }, timeout: 2_700_000, maxBuffer: 8 * 1024 * 1024 }));
    } finally {
      if (fs.existsSync(path.join(work, 'report.json'))) fs.copyFileSync(path.join(work, 'report.json'), 'delivery/acceptance-' + arch + '.json');
    }
    const evidence = json('delivery/acceptance-' + arch + '.json');
    assert.equal(evidence.passed, true); assert.equal(evidence.cleanup.passed, true);
    assert.equal(evidence.bundleVersion, version); assert.equal(evidence.packageCommit, process.env.GITHUB_SHA);
  } else if (command === 'collect') {
    for (const platform of ['amd64', 'arm64']) {
      const report = json('delivery/acceptance-' + platform + '.json');
      assert.equal(report.passed, true); assert.equal(report.cleanup.passed, true);
      assert.equal(report.bundleVersion, version); assert.equal(report.packageCommit, process.env.GITHUB_SHA);
      assert(Object.values(report.images).every(image => image.platform === 'linux/' + platform));
    }
    for (const file of ['release.json', 'publication.json']) fs.copyFileSync('publication/' + file, 'delivery/' + file);
    let sums = '';
    for (const file of fs.readdirSync('delivery').sort()) sums += await digest('delivery/' + file) + '  ' + file + '\n';
    fs.writeFileSync('delivery/SHA256SUMS', sums);
    fs.writeFileSync('release-notes.md', `LibreChat-based Agent preview for Linux amd64 and arm64.\n\nThree project images (Agent, Browser Service, Chrome Runtime) plus digest-pinned Nginx, MongoDB and Redis. Download the archive matching your CPU and verify it with SHA256SUMS. Extract it and follow README.md inside; Node.js 24+, Docker and flock are required. GitHub repository access is required to download this private repository's assets; images are anonymously pullable.\n\nBoth native Linux runners passed bundle installation, real Chrome browsing, human handoff/resume, backup/restore, interrupted-backup recovery and failed-upgrade protection using a simulated model. Reports and immutable image references are attached. This does not verify a production model, public HTTPS, SMTP, Mac Docker builds or migration from the old controller architecture.\n\nInstall this preview separately from old controller releases; do not use the old controller installer. No latest image tag is updated.\n\nSource: ${process.env.GITHUB_SHA}\nActions: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}\n`);
  } else throw new Error('Use stage, merge, package or collect');
}
cli(main);
