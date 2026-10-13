import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';

export interface RuntimeVolume { name: string; root: string }

// The controller sees the whole private volume. A browser/proxy only receives
// one existing subdirectory; never map the complete identity/Profile store.
export async function runtimeMount(directory: string, target: string, volume?: RuntimeVolume, readonly = false) {
  const source = await realpath(directory);
  if (/[,\r\n]/.test(source) || !/^\/[a-z]+$/.test(target)) throw new Error('Invalid runtime mount');
  let mount: string;
  if (volume) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/.test(volume.name)) throw new Error('Invalid volume name');
    const subpath = relative(await realpath(volume.root), source);
    if (!subpath || isAbsolute(subpath) || subpath.split(sep).includes('..')) throw new Error('Runtime mount must be a private volume subdirectory');
    mount = `type=volume,src=${volume.name},dst=${target},volume-subpath=${subpath},volume-nocopy`;
  } else mount = `type=bind,src=${source},dst=${target}`;
  return mount + (readonly ? ',readonly' : '');
}
