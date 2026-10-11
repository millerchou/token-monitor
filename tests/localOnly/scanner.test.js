'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { scannerBinary } = require('../../src/localOnly/runner');
const { createSandboxProfile, collectorEnvironment } = require('../../src/localOnly/sandbox');
const { extractUsageFromTokscale } = require('../../src/shared/usage');
const { writeJson } = require('../../src/localOnly/publicData');

test('pinned native scanner prices a local fixture from the public cache while offline', { skip: process.platform !== 'darwin' }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-offline-price-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, 'fixture-home');
  const dataDir = path.join(root, 'data');
  const logs = path.join(homeDir, '.claude/projects/example');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'tmp'), { recursive: true });
  const row = { type: 'assistant', uuid: 'fixture-message', sessionId: 'fixture-session', timestamp: new Date().toISOString(),
    message: { id: 'fixture-message', role: 'assistant', model: 'claude-sonnet-4-6', content: [{ type: 'text', text: 'fixture only' }],
      usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
  fs.writeFileSync(path.join(logs, 'fixture-session.jsonl'), `${JSON.stringify(row)}\n`);
  const timestamp = Math.floor(Date.now() / 1000);
  const cache = path.join(dataDir, 'tokscale/cache');
  writeJson(path.join(cache, 'pricing-litellm.json'), { timestamp, data: { 'claude-sonnet-4-6': { input_cost_per_token: 0.001, output_cost_per_token: 0.002 } } });
  for (const name of ['pricing-openrouter.json', 'pricing-models-dev.json']) writeJson(path.join(cache, name), { timestamp, data: {} });
  const scanner = scannerBinary();
  const profile = createSandboxProfile({ homeDir, dataDir, appRoot: path.resolve(__dirname, '../..'), executable: scanner, scanner });
  const result = spawnSync('/usr/bin/sandbox-exec', ['-p', profile, scanner,
    '--home', homeDir, '--json', '--client', 'claude', '--group-by', 'client,session,model', '--no-spinner'], {
    env: collectorEnvironment({ dataDir }), cwd: dataDir, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const usage = extractUsageFromTokscale(JSON.parse(result.stdout));
  assert.equal(usage.totalTokens, 1100);
  assert.ok(Math.abs(usage.costUsd - 1.2) < 1e-8, `Expected cached-price cost 1.2, got ${usage.costUsd}`);
});
