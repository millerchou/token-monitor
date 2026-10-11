'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

// This is a build policy, not a preference. Never read it from settings or env.
const CLIENTS = Object.freeze(['claude', 'codex']);
const PUBLIC_URLS = Object.freeze({
  litellm: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json',
  modelsDev: 'https://models.dev/api.json',
  openrouter: 'https://openrouter.ai/api/v1/models',
  rates: 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',
  ratesFallback: 'https://latest.currency-api.pages.dev/v1/currencies/usd.json'
});
const PUBLIC_URL_SET = new Set(Object.values(PUBLIC_URLS));

function assertPublicUrl(value) {
  // Exact strings deliberately reject query strings, URL credentials, alternate
  // ports, redirects and model/account-dependent URLs. No caller supplies headers.
  if (typeof value !== 'string' || !PUBLIC_URL_SET.has(value)) {
    throw new Error('Local edition: network destination is not public pricing or exchange rates');
  }
  return value;
}

function allowedRendererResource(url, roots) {
  if (url.startsWith('data:')) return true;
  if (!url.startsWith('file:')) return false;
  try {
    const file = fs.realpathSync(fileURLToPath(url));
    return roots.some((root) => file.startsWith(fs.realpathSync(root) + path.sep));
  } catch (_) { return false; }
}

function localSessionRequest(stats, args) {
  if (!CLIENTS.includes(args?.client) || typeof args?.sessionId !== 'string'
    || !args.sessionId || args.sessionId.length > 1024 || /[\\/\0]/.test(args.sessionId)) throw new Error('Invalid local session');
  const period = ['today', 'month', 'allTime'].includes(args.period) ? args.period : 'allTime';
  // Upstream's normalized usage row identifies a session by sessionId (not id).
  const known = Object.values(stats?.periods?.[period]?.sessions || {})
    .find((row) => row.client === args.client && row.sessionId === args.sessionId);
  if (!known) throw new Error('Local session does not belong to the current snapshot');
  return { client: args.client, sessionId: args.sessionId, period: period === 'allTime' ? 'total' : period, sessionCost: known.costUsd };
}

const IPC_CHANNELS = Object.freeze([
  'settings:get', 'settings:update', 'stats:get', 'stats:allTimeSessions', 'session:getDetail',
  'stream:status', 'dashboard:getHistory', 'dashboard:open', 'app:getInfo',
  'appearance:preview', 'appearance:getBackgroundImage', 'appearance:getNativeMaterial',
  'tokscale:getStatus', 'tray:setIcons', 'clipboard:write', 'usage:rescanClient',
  'appUpdate:getState', 'hub:getInfo', 'hub:getBuildStatus', 'syncContent:status',
  'publicData:refresh'
]);

module.exports = { CLIENTS, PUBLIC_URLS, assertPublicUrl, allowedRendererResource, localSessionRequest, IPC_CHANNELS };
