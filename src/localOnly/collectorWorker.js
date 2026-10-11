'use strict';

// Always launched by runner.js inside Seatbelt. This entry never loads the
// account/limits runtime or the upstream Electron main process.
const fs = require('node:fs');
const net = require('node:net');
const { spawnSync } = require('node:child_process');
const readline = require('node:readline');
const { CLIENTS } = require('./policy');

const write = (payload, flushed) => process.stdout.write(`LOCAL_ONLY:${JSON.stringify(payload)}\n`, flushed);

async function checkBoundary(canary) {
  let credentialDenied = false;
  try { fs.readFileSync(canary); } catch (error) { credentialDenied = ['EPERM', 'EACCES'].includes(error.code); }
  const cli = spawnSync('/usr/bin/true', [], { stdio: 'ignore' });
  const executionDenied = ['EPERM', 'EACCES'].includes(cli.error?.code);
  const networkDenied = await new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port: 9 });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', (error) => resolve(['EPERM', 'EACCES'].includes(error.code)));
    socket.setTimeout(2000, () => { socket.destroy(); resolve(false); });
  });
  return { credentialDenied, executionDenied, networkDenied };
}

async function run(config) {
  const boundary = await checkBoundary(config.canary);
  write({ type: 'boundary', ...boundary });
  if (!Object.values(boundary).every(Boolean)) throw new Error('Local collection isolation failed');
  if (config.probeOnly) return;

  const { startCollector } = require('../shared/collector');
  const { aggregateDevices } = require('../shared/usage');
  let collector;
  let stopping = false;
  let retainedHistory = null;
  const publish = (summary, reason) => {
    if (summary.history) retainedHistory = summary.history;
    const record = { ...summary, deviceId: 'local', limits: { providers: [] } };
    const stats = aggregateDevices([record], 0);
    stats.snapshotId = `${Date.now()}`;
    if (retainedHistory) stats.historyPreview = retainedHistory;
    // A large all-time snapshot cannot be truncated by process.exit while its
    // stdout pipe is still draining (the one-shot verification uses this path).
    write({ type: 'stats', stats, history: retainedHistory, reason }, config.once ? () => { void stop(); } : undefined);
  };
  async function stop() {
    if (stopping) return;
    stopping = true;
    collector?.stop();
    await collector?.whenIdle?.();
    process.exit(0);
  }
  collector = startCollector({
    clients: CLIENTS.join(','), deviceId: 'local', agentVersion: config.version,
    agentRuntime: 'local-only', allTimeSince: '2024-01-01',
    watchEnabled: !config.once, intervalMs: 300000, historyEnabled: true,
    historyIntervalMs: 900000, wslScanEnabled: false,
    projectsEnabled: true, codexLocalUsageEnabled: false, codexDotsVisible: false,
    osInfo: { osName: 'macOS' }, customScanPaths: {},
    commandTimeoutMs: 180000, historyTimeoutMs: 180000,
    onUpdate: publish,
    onError: () => write({ type: 'error', error: 'Local log collection failed; account access remains disabled' }),
    logger: () => {}
  });
  const input = readline.createInterface({ input: process.stdin });
  input.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch (_) { return; }
    if (message.type === 'refresh') void collector.tick('manual', { forceHistory: true });
    if (message.type === 'stop') void stop();
    if (message.type === 'detail' && CLIENTS.includes(message.args?.client) && typeof message.args?.sessionId === 'string') {
      try {
        const { readSessionDetail } = require('../shared/sessionDetail');
        const value = readSessionDetail({ client: message.args.client, sessionId: message.args.sessionId,
          period: ['today', 'month', 'total'].includes(message.args.period) ? message.args.period : 'total',
          sessionCost: Number(message.args.sessionCost) || 0, home: require('node:os').homedir() });
        write({ type: 'detail', id: message.id, value });
      } catch (_) { write({ type: 'detail', id: message.id, value: { found: false, error: 'Local session is unavailable' } }); }
    }
  });
  process.on('SIGTERM', () => { void stop(); });
  process.on('SIGINT', () => { void stop(); });
  process.stdin.on('end', () => { void stop(); });
}

if (require.main === module) {
  run(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')))
    .catch(() => { write({ type: 'error', error: 'Collector could not start with the required isolation' }); process.exitCode = 1; });
}

module.exports = { checkBoundary };
