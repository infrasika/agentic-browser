#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const usage = `Trigger the GitHub Actions preview release (no local image build).
Usage: npm run release [-- [vX.Y.Z-preview.N] [--ref main] [--build-run-id RUN_ID] [--dry-run]]
Defaults to package.json's version with a v prefix when no version is supplied.
Requires GitHub CLI (gh) authenticated with access to this repository.
The selected remote ref must already contain the changes to release.`;
const root = path.resolve(import.meta.dirname, '../..');

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      ref: { type: 'string', default: 'main' },
      'build-run-id': { type: 'string' },
      'dry-run': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) console.log(usage);
  else {
    if (positionals.length > 1) throw new Error('Provide at most one explicit preview version.');
    const version = positionals[0] ?? 'v' + JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (!/^v\d+\.\d+\.\d+-preview\.\d+$/.test(version)) throw new Error('Set package.json version to X.Y.Z-preview.N or provide an explicit vX.Y.Z-preview.N.');
    if (!values.ref || values.ref.startsWith('-')) throw new Error('Provide a valid remote ref.');
    if (values['build-run-id'] !== undefined && !/^[1-9]\d*$/.test(values['build-run-id'])) throw new Error('build-run-id must be a positive GitHub Actions run ID.');
    const args = ['workflow', 'run', 'release-agent.yml', '--ref', values.ref, '-f', 'version=' + version];
    if (values['build-run-id']) args.push('-f', 'build_run_id=' + values['build-run-id']);
    console.log((values['dry-run'] ? 'Dry run: ' : 'Dispatching: ') + 'gh ' + args.map(arg => JSON.stringify(arg)).join(' '));
    if (!values['dry-run']) {
      const result = spawnSync('gh', args, { cwd: root, stdio: 'inherit' });
      if (result.error) throw new Error(result.error.code === 'ENOENT' ? 'Install GitHub CLI (gh), then run gh auth login.' : 'Unable to start GitHub CLI.');
      process.exitCode = result.status ?? 1;
    }
  }
} catch (error) {
  console.error(error.message + '\n\n' + usage);
  process.exitCode = 1;
}
