'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { createSandboxProfile, collectorEnvironment } = require('./sandbox');
const { writeJson } = require('./publicData');

function unpacked(file) { return file.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`); }

function scannerBinary() {
  const manifest = require('../../scripts/vendor/tokscale.json');
  const target = manifest.platforms[`darwin-${process.arch}`];
  if (!target || manifest.mode !== 'override') throw new Error('Local edition requires a pinned scanner');
  const root = path.dirname(require.resolve(`${target.package}/package.json`));
  const binary = unpacked(path.join(root, 'bin', 'tokscale'));
  const actual = crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex');
  if (actual !== target.sha256) throw new Error('Scanner checksum does not match the audited vendor manifest');
  return binary;
}

function startIsolatedCollector({ homeDir, dataDir, executable = process.execPath, onMessage, onExit, once = false, probeOnly = false, version }) {
  if (process.platform !== 'darwin') throw new Error('Local edition requires macOS process isolation');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  for (const name of ['tmp', 'collector', 'tokscale/cache', 'probe']) fs.mkdirSync(path.join(dataDir, name), { recursive: true, mode: 0o700 });
  const canary = path.join(dataDir, 'probe', 'auth.json');
  writeJson(canary, { access_token: 'LOCAL_ONLY_FAKE_CREDENTIAL_CANARY' });
  const scanner = scannerBinary();
  const worker = path.join(__dirname, 'collectorWorker.js');
  const appRoot = __dirname.includes(`${path.sep}app.asar${path.sep}`)
    ? path.dirname(__dirname.split(`${path.sep}app.asar${path.sep}`)[0] + `${path.sep}app.asar`)
    : path.resolve(__dirname, '../..');
  const profile = createSandboxProfile({ homeDir, dataDir, appRoot, executable, scanner });
  const config = path.join(dataDir, 'collector-run.json');
  writeJson(config, { canary, once, probeOnly, version });
  const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, executable, worker, config], {
    env: collectorEnvironment({ homeDir, dataDir }),
    stdio: ['pipe', 'pipe', 'pipe'], detached: true, cwd: dataDir
  });
  let verified = false;
  let stopped = false;
  let exited = false;
  let killTimer;
  let requestSequence = 0;
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (!line.startsWith('LOCAL_ONLY:')) return;
    let message;
    try { message = JSON.parse(line.slice(11)); } catch (_) { return; }
    if (message.type === 'detail' && pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      clearTimeout(request.timer);
      request.resolve(message.value);
      return;
    }
    if (message.type === 'boundary') {
      verified = message.credentialDenied && message.executionDenied && message.networkDenied;
      if (!verified) { stop(); return; }
    }
    if (message.type === 'stats' && !verified) { stop(); return; }
    onMessage?.(message);
  });
  // Never echo native scanner output: it may contain local session names.
  child.stderr.resume();
  child.stdin.on('error', () => {});
  child.on('error', () => onMessage?.({ type: 'error', error: 'Unable to start isolated collector' }));
  child.once('exit', () => { exited = true; clearTimeout(killTimer); });
  child.on('close', (code) => {
    clearTimeout(killTimer);
    lines.close();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('Collector stopped')); }
    pending.clear();
    if (!stopped && (code !== 0 || (!once && !probeOnly))) onMessage?.({ type: 'error', error: 'Isolated collector stopped' });
    onExit?.(code);
  });
  function send(message) {
    if (!stopped && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  function stop() {
    if (stopped || exited) return;
    send({ type: 'stop' });
    stopped = true;
    child.stdin.end();
    killTimer = setTimeout(() => {
      if (!exited) { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }
    }, 5000);
    killTimer.unref();
  }
  function detail(args) {
    if (!verified || stopped || exited) return Promise.reject(new Error('Isolated collector is not ready'));
    return new Promise((resolve, reject) => {
      const id = String(++requestSequence);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Local session read timed out')); }, 20000);
      pending.set(id, { resolve, reject, timer });
      send({ type: 'detail', id, args });
    });
  }
  return { refresh: () => send({ type: 'refresh' }), detail, stop, pid: child.pid };
}

module.exports = { scannerBinary, startIsolatedCollector };
