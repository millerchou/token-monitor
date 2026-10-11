'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSandboxProfile, collectorEnvironment } = require('../../src/localOnly/sandbox');

test('macOS enforces credential/symlink denial, read-only logs, no network and no CLI execution', { skip: process.platform !== 'darwin' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-boundary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'fake-home');
  const dataDir = path.join(root, 'data');
  const appRoot = path.join(root, 'code');
  const logs = path.join(homeDir, '.codex/sessions');
  for (const dir of [logs, dataDir, appRoot]) fs.mkdirSync(dir, { recursive: true });
  const log = path.join(logs, 'usage.jsonl');
  fs.writeFileSync(log, 'local-log-fixture');
  const secret = path.join(homeDir, '.codex/auth.json');
  fs.writeFileSync(secret, 'FAKE_TOKEN_NEVER_A_REAL_CREDENTIAL');
  const alias = path.join(logs, 'escaped.jsonl');
  fs.symlinkSync(secret, alias);
  const outside = path.join(root, 'opaque.json');
  fs.writeFileSync(outside, 'FAKE_SECRET_OUTSIDE_HOME');
  const outsideAlias = path.join(logs, 'outside.jsonl');
  fs.symlinkSync(outside, outsideAlias);
  const script = `
    const fs = require('node:fs'); const net = require('node:net'); const cp = require('node:child_process');
    const blocked = (fn) => { try { fn(); return false; } catch (e) { return ['EPERM', 'EACCES'].includes(e.code); } };
    const result = { log: fs.readFileSync(${JSON.stringify(log)}, 'utf8'),
      credential: blocked(() => fs.readFileSync(${JSON.stringify(secret)})),
      symlink: blocked(() => fs.readFileSync(${JSON.stringify(alias)})),
      outsideSymlink: blocked(() => fs.readFileSync(${JSON.stringify(outsideAlias)})),
      logWrite: blocked(() => fs.writeFileSync(${JSON.stringify(log)}, 'changed')),
      execution: ['EPERM','EACCES'].includes(cp.spawnSync('/usr/bin/true').error?.code) };
    fs.writeFileSync(${JSON.stringify(path.join(dataDir, 'cache.json'))}, '{}'); result.cacheWrite = true;
    const socket = net.connect({host:'127.0.0.1',port:9});
    socket.once('error', e => {result.network = ['EPERM','EACCES'].includes(e.code); console.log(JSON.stringify(result));});
    socket.once('connect', () => {result.network=false; socket.destroy(); console.log(JSON.stringify(result));});
    socket.setTimeout(2000, () => {socket.destroy(); process.exitCode=1;});
  `;
  const profile = createSandboxProfile({ homeDir, dataDir, appRoot, executable: process.execPath, scanner: process.execPath });
  const run = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e', script], {
    env: collectorEnvironment({ homeDir, dataDir }), encoding: 'utf8', timeout: 10000
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message || `Sandbox process signal: ${run.signal}`);
  assert.deepEqual(JSON.parse(run.stdout), { log: 'local-log-fixture', credential: true, symlink: true, outsideSymlink: true, logWrite: true, execution: true, cacheWrite: true, network: true });
  assert.equal(fs.readFileSync(log, 'utf8'), 'local-log-fixture');
});
