import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { atomic, exists } from '../../deploy/agent/lib/system.mjs';
const ROOT = path.resolve(import.meta.dirname, '../..');
export const ENTRIES = { agentctl: 'deploy/agent/agentctl.mjs', bundle: 'deploy/agent/bundle.mjs', 'acceptance/verify': 'test/acceptance/verify-bundle.mjs' };

// Source tools use npm dependencies; release tools carry those dependencies in
// their own single-file modules. No npm registry access is needed at deployment.
export async function bundleTools(destination, { source = ROOT, only = Object.keys(ENTRIES) } = {}) {
  const notices = new Map();
  for (const name of only) {
    const result = await build({ entryPoints: [path.join(source, ENTRIES[name])], absWorkingDir: source, nodePaths: [path.join(ROOT, 'node_modules')], bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false, metafile: true, legalComments: 'inline', define: { AGENT_BUNDLED: 'true' }, banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" }, logLevel: 'silent' });
    const file = path.join(destination, name + '.mjs'); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); atomic(file, result.outputFiles[0].contents);
    for (const input of Object.keys(result.metafile.inputs)) {
      if (!input.includes('node_modules/')) continue;
      let directory = path.dirname(path.resolve(source, input));
      while (directory !== path.dirname(directory)) {
        if (exists(path.join(directory, 'package.json'))) {
          const info = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
          if (info.name && info.version) {
            const license = fs.readdirSync(directory).find(n => /^licen[cs]e(?:\..+)?$/i.test(n));
            if (!license) throw new Error('Missing bundled dependency license: ' + info.name);
            notices.set(info.name + '@' + info.version, fs.readFileSync(path.join(directory, license), 'utf8')); break;
          }
        }
        directory = path.dirname(directory);
      }
    }
  }
  const licenses = path.join(destination, 'LICENSES'); fs.mkdirSync(licenses, { recursive: true, mode: 0o700 });
  atomic(path.join(licenses, 'TOOLS.txt'), [...notices].sort(([a], [b]) => a.localeCompare(b)).map(([name, license]) => `${name}\n${license}`).join('\n\n'));
}
