'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { PUBLIC_URLS, assertPublicUrl } = require('./policy');
const { parseUsdRates } = require('../shared/exchangeRates');

const REFRESH_MS = 60 * 60 * 1000;
const MAX_BYTES = 24 * 1024 * 1024;

function fetchPublicJson(url, { request = https.get, timeoutMs = 20000 } = {}) {
  assertPublicUrl(url);
  return new Promise((resolve, reject) => {
    // node:https does not inherit browser cookies, proxy credentials, .netrc or
    // provider SDK configuration. GET and these two headers are the entire API.
    const req = request(url, {
      method: 'GET', agent: false,
      headers: { accept: 'application/json', 'user-agent': 'TokenMonitor-Local-PublicData/1' }
    }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Public data HTTP ${res.statusCode}; redirects are refused`));
        return;
      }
      const chunks = [];
      let bytes = 0;
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_BYTES) {
          res.destroy(new Error('Public data exceeds size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (_) { reject(new Error('Public data is not valid JSON')); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Public data request timed out')));
  });
}

function finitePrice(value) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeLiteLlm(payload) {
  const result = Object.create(null);
  for (const [id, row] of Object.entries(payload || {})) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
    const prices = Object.create(null);
    for (const [key, value] of Object.entries(row)) {
      // Keep the upstream engine's long-context and cache-tier price fields.
      if (!/^(?:(?:input|output)_cost_per_token|cache_(?:read|creation)_input_token_cost)(?:_above_[a-z0-9_]+)?$/.test(key)) continue;
      const price = finitePrice(value);
      if (price !== null) prices[key] = price;
    }
    if (Object.keys(prices).length) result[id] = prices;
  }
  return result;
}

function normalizeModelsDev(payload) {
  const result = Object.create(null);
  for (const [providerId, provider] of Object.entries(payload || {})) {
    for (const [key, model] of Object.entries(provider?.models || {})) {
      const input = finitePrice(model?.cost?.input);
      const output = finitePrice(model?.cost?.output);
      if (input === null || output === null) continue;
      const row = { input_cost_per_token: input / 1e6, output_cost_per_token: output / 1e6 };
      for (const [source, target] of [['cache_read', 'cache_read_input_token_cost'], ['cache_write', 'cache_creation_input_token_cost']]) {
        const price = finitePrice(model.cost[source]);
        if (price !== null) row[target] = price / 1e6;
      }
      result[`${providerId}/${model.id || key}`.toLowerCase()] = row;
    }
  }
  return result;
}

function normalizeOpenRouter(payload) {
  const result = Object.create(null);
  for (const model of Array.isArray(payload?.data) ? payload.data : []) {
    const input = finitePrice(model?.pricing?.prompt);
    const output = finitePrice(model?.pricing?.completion);
    if (!model.id || input === null || output === null) continue;
    const row = { input_cost_per_token: input, output_cost_per_token: output };
    for (const [source, target] of [['input_cache_read', 'cache_read_input_token_cost'], ['input_cache_write', 'cache_creation_input_token_cost']]) {
      const price = finitePrice(model.pricing[source]);
      if (price !== null) row[target] = price;
    }
    result[model.id] = row;
  }
  return result;
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function createPublicData({ dataDir, fetchJson = fetchPublicJson, now = Date.now }) {
  const cacheDir = path.join(dataDir, 'tokscale', 'cache');
  const statePath = path.join(dataDir, 'public-data.json');
  let state = readJson(statePath, { sources: {}, rates: null });
  let inFlight = null;
  const snapshot = () => structuredClone(state);

  async function refreshSource(id, filename, normalize, force) {
    const previous = state.sources[id];
    if (!force && previous?.updatedAt && now() - previous.updatedAt < REFRESH_MS && fs.existsSync(path.join(cacheDir, filename))) return;
    try {
      const data = normalize(await fetchJson(PUBLIC_URLS[id]));
      const count = Object.keys(data).length;
      if (!count) throw new Error('Public price source contains no usable prices');
      writeJson(path.join(cacheDir, filename), { timestamp: Math.floor(now() / 1000), data });
      state.sources[id] = { updatedAt: now(), count, error: null };
    } catch (error) {
      state.sources[id] = { ...previous, error: error.message };
    }
  }

  async function refreshRates(force) {
    if (!force && state.rates?.fetchedAt && now() - state.rates.fetchedAt < 24 * REFRESH_MS) return;
    let failure;
    for (const id of ['rates', 'ratesFallback']) {
      try {
        const value = await fetchJson(PUBLIC_URLS[id]);
        const rates = parseUsdRates(value);
        if (!rates) throw new Error('Public exchange rates are incomplete');
        state.rates = { rates, date: value.date || null, source: PUBLIC_URLS[id], fetchedAt: now(), error: null };
        return;
      } catch (error) { failure = error; }
    }
    state.rates = { ...state.rates, error: failure?.message || 'Exchange-rate update failed' };
  }

  function refresh({ force = false } = {}) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      await Promise.all([
        refreshSource('litellm', 'pricing-litellm.json', normalizeLiteLlm, force),
        refreshSource('modelsDev', 'pricing-models-dev.json', normalizeModelsDev, force),
        refreshSource('openrouter', 'pricing-openrouter.json', normalizeOpenRouter, force),
        refreshRates(force)
      ]);
      writeJson(statePath, state);
      return snapshot();
    })().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { snapshot, refresh };
}

module.exports = { REFRESH_MS, fetchPublicJson, normalizeLiteLlm, normalizeModelsDev, normalizeOpenRouter, createPublicData, readJson, writeJson };
