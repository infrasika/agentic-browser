import { readFile } from 'node:fs/promises';

// Acceptance must exercise an explicit image set, never stale local preview tags.
export async function acceptanceRelease() {
  const index = process.argv.indexOf('--release');
  if (index < 0 || !process.argv[index + 1]) throw new Error('Provide --release /path/to/release.json');
  const release = JSON.parse(await readFile(process.argv[index + 1], 'utf8'));
  const names = ['agent', 'browser', 'gateway', 'mongo', 'redis', 'runtime'];
  if (!release.images || JSON.stringify(Object.keys(release.images).sort()) !== JSON.stringify(names)
      || !/^[a-zA-Z0-9_.-]{1,80}$/.test(release.version)) throw new Error('Invalid six-image release manifest');
  for (const image of Object.values(release.images)) {
    if (typeof image !== 'string' || !/^(?:[a-zA-Z0-9./:_-]+@)?sha256:[a-f0-9]{64}$/.test(image)) {
      throw new Error('Acceptance requires immutable image references');
    }
  }
  return release;
}
