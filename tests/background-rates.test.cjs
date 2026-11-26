const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');

function worker(initial = {}, fetchImpl) {
  const data = structuredClone(initial);
  const requests = [];
  let listener, installed, alarm;
  const chrome = {
    storage: { local: {
      async get(keys) {
        if (typeof keys === 'string') keys = [keys];
        return structuredClone(Object.fromEntries(keys.filter(key => key in data).map(key => [key, data[key]])));
      },
      async set(values) { Object.assign(data, structuredClone(values)); }
    } },
    runtime: { onInstalled: { addListener(fn) { installed = fn; } }, onMessage: { addListener(fn) { listener = fn; } } },
    alarms: { create: async () => {}, onAlarm: { addListener(fn) { alarm = fn; } } }
  };
  const context = vm.createContext({ chrome, Date, Map, Set, Promise, console: { warn() {}, error() {} }, fetch: async url => {
    requests.push(url);
    if (fetchImpl) return fetchImpl(url);
    const parsed = new URL(url);
    const currency = parsed.searchParams.get('symbols');
    const date = parsed.pathname.split('/').pop();
    return { ok: true, json: async () => ({ date: date === 'latest' ? '2026-10-19' : date, rates: { [currency]: currency === 'EUR' ? 0.015 : 0.02 } }) };
  } });
  vm.runInContext(source, context);
  return { data, requests, install: () => installed(), alarm: () => alarm({ name: 'refresh_latest_rate' }),
    send: message => new Promise(resolve => { assert.equal(listener(message, {}, resolve), true); }) };
}

test('Upgrade retains existing USD settings/cache and adds USD default', async () => {
  const w = worker({ enabled: false, displayMode: 'both_usd_first', decimals: 0, historicalRates: { '2024-01-15': 0.0332 } });
  await w.install();
  assert.equal(w.data.targetCurrency, 'USD');
  assert.equal(w.data.enabled, false);
  assert.equal(w.data.decimals, 0);
  assert.equal(w.data.displayMode, 'both_usd_first');
  assert.deepEqual(w.data.historicalRates, { '2024-01-15': 0.0332 });
});

test('Messages without currency keep using the legacy USD cache', async () => {
  const w = worker({ latestRate: 0.02, latestRateDate: '2026-10-19', latestRateTime: Date.now() });
  const result = await w.send({ type: 'GET_LATEST_RATE' });
  assert.equal(result.data.rate, 0.02);
  assert.equal(result.data.currency, 'USD');
  assert.equal(w.requests.length, 0);
});

test('EUR latest requests use TRY/EUR and leave USD cache intact', async () => {
  const w = worker({ latestRate: 0.02 });
  const result = await w.send({ type: 'GET_LATEST_RATE', currency: 'EUR' });
  assert.equal(result.data.rate, 0.015);
  assert.equal(w.data.latestRateEUR, 0.015);
  assert.equal(w.data.latestRate, 0.02);
  const request = new URL(w.requests[0]);
  assert.equal(request.searchParams.get('base'), 'TRY');
  assert.equal(request.searchParams.get('symbols'), 'EUR');
});

test('Historical USD and EUR entries for one date remain separate', async () => {
  const w = worker({ historicalRates: { '2024-01-15': 0.0332 } });
  const euro = await w.send({ type: 'GET_HISTORICAL_RATE', date: '2024-01-15', currency: 'EUR' });
  assert.equal(euro.data.rate, 0.015);
  assert.equal(w.data.historicalRatesEUR['2024-01-15'], 0.015);
  const dollar = await w.send({ type: 'GET_HISTORICAL_RATE', date: '2024-01-15', currency: 'USD' });
  assert.equal(dollar.data.rate, 0.0332);
  const again = await w.send({ type: 'GET_HISTORICAL_RATE', date: '2024-01-15', currency: 'EUR' });
  assert.equal(again.data.source, 'cache');
  assert.equal(w.requests.length, 1);
});

test('Concurrent batch cache writes retain every EUR date', async () => {
  const w = worker({ historicalRates: { '2024-01-15': 0.0332 } });
  const dates = Array.from({ length: 8 }, (_, i) => `2024-02-${String(i + 1).padStart(2, '0')}`);
  const result = await w.send({ type: 'BATCH_GET_RATES', dates: [...dates, dates[0]], currency: 'EUR' });
  assert.equal(Object.keys(result.data).length, 8);
  assert.equal(Object.keys(w.data.historicalRatesEUR).length, 8);
  assert.equal(w.requests.length, 8);
  assert.equal(w.data.historicalRates['2024-01-15'], 0.0332);
});

test('Offline EUR with no EUR cache never uses a USD fallback', async () => {
  const w = worker({ latestRate: 0.02 }, async () => { throw new Error('offline'); });
  const result = await w.send({ type: 'GET_LATEST_RATE', currency: 'EUR' });
  assert.equal(result.data.rate, null);
  assert.equal(result.data.currency, 'EUR');
  assert.equal(w.data.latestRateEUR, undefined);
});

test('Offline EUR uses its own stale cache', async () => {
  const w = worker({ latestRate: 0.02, latestRateEUR: 0.015, latestRateTimeEUR: 1 }, async () => { throw new Error('offline'); });
  const result = await w.send({ type: 'GET_LATEST_RATE', currency: 'EUR' });
  assert.equal(result.data.rate, 0.015);
  assert.equal(result.data.isFallback, true);
});

test('Network failure retries the existing fallback host with EUR', async () => {
  const w = worker({}, async url => {
    if (url.includes('frankfurter.dev')) throw new Error('offline');
    return { ok: true, json: async () => ({ date: '2026-10-19', rates: { EUR: 0.015 } }) };
  });
  const result = await w.send({ type: 'FORCE_REFRESH_RATE', currency: 'EUR' });
  assert.equal(result.data.latestRate, 0.015);
  assert.equal(w.requests.length, 2);
  assert.match(w.requests[1], /frankfurter\.app/);
  assert.equal(new URL(w.requests[1]).searchParams.get('symbols'), 'EUR');
});

test('Clear Cache clears historical entries for both currencies', async () => {
  const w = worker({ historicalRates: { '2024-01-15': 0.03 }, historicalRatesEUR: { '2024-01-15': 0.025 } });
  await w.send({ type: 'CLEAR_CACHE', currency: 'EUR' });
  assert.deepEqual(w.data.historicalRates, {});
  assert.deepEqual(w.data.historicalRatesEUR, {});
});

test('Hourly refresh honors the selected EUR currency', async () => {
  const w = worker({ targetCurrency: 'EUR', latestRate: 0.02 });
  await w.alarm();
  assert.equal(w.data.latestRateEUR, 0.015);
  assert.equal(w.data.latestRate, 0.02);
});

test('Cache stats report only the selected currency history', async () => {
  const w = worker({ historicalRates: { a: 0.03, b: 0.03 }, historicalRatesEUR: { a: 0.025 } });
  assert.equal((await w.send({ type: 'GET_CACHE_STATS', currency: 'EUR' })).data.cachedHistoricalDatesCount, 1);
  assert.equal((await w.send({ type: 'GET_CACHE_STATS', currency: 'USD' })).data.cachedHistoricalDatesCount, 2);
});

test('Concurrent requests for one currency/date share one fetch', async () => {
  const w = worker();
  await Promise.all(Array.from({ length: 5 }, () => w.send({ type: 'GET_HISTORICAL_RATE', date: '2024-03-15', currency: 'EUR' })));
  assert.equal(w.requests.length, 1);
});
