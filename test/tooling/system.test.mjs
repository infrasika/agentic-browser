import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import * as ctl from '../../deploy/agent/lib/system.mjs';
import { sleep } from '../../deploy/agent/lib/system.mjs';
import { temporary } from './fixtures.mjs';
test('atomic writes never follow private symlinks', () => temporary(async root => {
  ctl.atomic(path.join(root, 'original'), 'keep'); fs.symlinkSync(path.join(root, 'original'), path.join(root, 'link'));
  assert.throws(() => ctl.atomic(path.join(root, 'link'), 'replace')); assert.equal(fs.readFileSync(path.join(root, 'original'), 'utf8'), 'keep');
}));
test('operation lock excludes concurrent maintenance and is released normally', { skip: process.platform !== 'linux' && 'Linux deployment lock' }, () => temporary(async root => {
  const lock = path.join(root, 'lock'), unlock = await ctl.operationLock(lock);
  await assert.rejects(ctl.operationLock(lock), /operation_in_progress/); await unlock(); await (await ctl.operationLock(lock))();
}));
test('killing an operator releases its kernel lock without deleting a lock file', { skip: process.platform !== 'linux' && 'Linux deployment lock' }, () => temporary(async root => {
  const module = pathToFileURL(path.resolve('deploy/agent/lib/system.mjs')).href, lock = path.join(root, 'lock');
  const child = spawn(process.execPath, ['--input-type=module','-e',`import {operationLock} from ${JSON.stringify(module)}; await operationLock(${JSON.stringify(lock)}); console.log('ready'); await new Promise(r=>setTimeout(r,60000));`], { stdio: ['ignore','pipe','pipe'] }); child.stderr.resume();
  const done = new Promise(r => child.once('close', r));
  try { await new Promise((r,j) => { child.stdout.once('data', r); child.once('error',j); }); await assert.rejects(ctl.operationLock(lock)); child.kill('SIGKILL'); await done; await sleep(100); await (await ctl.operationLock(lock))(); }
  finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done; }
}));
