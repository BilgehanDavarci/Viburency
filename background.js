// TRY Converter service worker. Existing USD storage keys remain compatible.
const API_BASE = 'https://api.frankfurter.dev/v1';
const API_FALLBACK = 'https://api.frankfurter.app';
const CACHE_TTL_MS = 60 * 60 * 1000;
const FALLBACK_LATEST_RATE = 0.02035;
const inFlightRates = new Map();
let cacheWriteQueue = Promise.resolve();

function normalizeCurrency(currency) {
  return currency === 'EUR' ? 'EUR' : 'USD';
}

function rateKeys(currency) {
  const suffix = currency === 'EUR' ? 'EUR' : '';
  return {
    rate: `latestRate${suffix}`, date: `latestRateDate${suffix}`,
    time: `latestRateTime${suffix}`, history: `historicalRates${suffix}`
  };
}

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get(['enabled', 'displayMode', 'decimals', 'targetCurrency']);
  const defaults = {};
  if (typeof settings.enabled === 'undefined') defaults.enabled = true;
  if (!settings.displayMode) defaults.displayMode = 'replace';
  if (typeof settings.decimals === 'undefined') defaults.decimals = 2;
  if (!['USD', 'EUR'].includes(settings.targetCurrency)) defaults.targetCurrency = 'USD';
  if (Object.keys(defaults).length) await chrome.storage.local.set(defaults);
  await chrome.alarms.create('refresh_latest_rate', { periodInMinutes: 60 });
  await fetchAndCacheLatestRate(normalizeCurrency(settings.targetCurrency));
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name === 'refresh_latest_rate') {
    const { targetCurrency } = await chrome.storage.local.get('targetCurrency');
    await fetchAndCacheLatestRate(normalizeCurrency(targetCurrency));
  }
});

async function fetchRate(date, currency) {
  let lastError;
  for (const base of [API_BASE, API_FALLBACK]) {
    try {
      const response = await fetch(`${base}/${date}?base=TRY&symbols=${currency}`);
      if (!response.ok) throw new Error(`HTTP error ${response.status}`);
      const data = await response.json();
      const rate = data?.rates?.[currency];
      if (!Number.isFinite(rate) || rate <= 0) throw new Error(`Missing ${currency} rate`);
      return { rate, date: data.date };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function fetchAndCacheLatestRate(currency = 'USD') {
  currency = normalizeCurrency(currency);
  const keys = rateKeys(currency);
  try {
    const fresh = await fetchRate('latest', currency);
    const timestamp = Date.now();
    await chrome.storage.local.set({ [keys.rate]: fresh.rate, [keys.date]: fresh.date, [keys.time]: timestamp });
    return { latestRate: fresh.rate, latestRateDate: fresh.date, latestRateTime: timestamp, currency };
  } catch (error) {
    console.warn(`[TRY Converter] Latest ${currency} rate unavailable:`, error);
  }
  const cached = await chrome.storage.local.get([keys.rate, keys.date, keys.time]);
  // Never relabel a USD rate as EUR. With no EUR cache, leave prices unconverted.
  const rate = cached[keys.rate] || (currency === 'USD' ? FALLBACK_LATEST_RATE : null);
  return {
    latestRate: rate, latestRateDate: cached[keys.date] || null,
    latestRateTime: cached[keys.time] || null, currency, isFallback: true
  };
}

async function getLatestRate(currency = 'USD') {
  currency = normalizeCurrency(currency);
  const keys = rateKeys(currency);
  const cached = await chrome.storage.local.get([keys.rate, keys.date, keys.time]);
  if (cached[keys.rate] > 0 && cached[keys.time] && Date.now() - cached[keys.time] < CACHE_TTL_MS) {
    return { rate: cached[keys.rate], date: cached[keys.date], timestamp: cached[keys.time], currency };
  }
  const fresh = await fetchAndCacheLatestRate(currency);
  return { rate: fresh.latestRate, date: fresh.latestRateDate, timestamp: fresh.latestRateTime, currency, isFallback: fresh.isFallback };
}

function cacheHistoricalRate(key, date, rate) {
  const write = cacheWriteQueue.then(async () => {
    const cached = await chrome.storage.local.get(key);
    await chrome.storage.local.set({ [key]: { ...(cached[key] || {}), [date]: rate } });
  });
  cacheWriteQueue = write.catch(() => {});
  return write;
}

async function getHistoricalRate(dateStr, currency = 'USD') {
  currency = normalizeCurrency(currency);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const today = new Date().toISOString().split('T')[0];
  if (dateStr > today) dateStr = today;
  const key = rateKeys(currency).history;
  const cached = await chrome.storage.local.get(key);
  if (typeof cached[key]?.[dateStr] === 'number') {
    return { date: dateStr, rate: cached[key][dateStr], currency, source: 'cache' };
  }
  const requestKey = `${currency}:${dateStr}`;
  if (inFlightRates.has(requestKey)) return inFlightRates.get(requestKey);
  const request = (async () => {
    try {
      const fresh = await fetchRate(dateStr, currency);
      await cacheHistoricalRate(key, dateStr, fresh.rate);
      return { date: dateStr, rate: fresh.rate, actualDate: fresh.date, currency, source: 'network' };
    } catch (error) {
      console.warn(`[TRY Converter] Historical ${currency} fetch failed for ${dateStr}:`, error);
      const latest = await getLatestRate(currency);
      return { date: dateStr, rate: latest.rate, currency, isFallback: true };
    }
  })();
  inFlightRates.set(requestKey, request);
  try { return await request; }
  finally { inFlightRates.delete(requestKey); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      const currency = normalizeCurrency(message.currency);
      switch (message.type) {
        case 'GET_LATEST_RATE':
          sendResponse({ success: true, data: await getLatestRate(currency) });
          break;
        case 'FORCE_REFRESH_RATE':
          sendResponse({ success: true, data: await fetchAndCacheLatestRate(currency) });
          break;
        case 'GET_HISTORICAL_RATE':
          sendResponse({ success: true, data: await getHistoricalRate(message.date, currency) });
          break;
        case 'BATCH_GET_RATES': {
          const dates = [...new Set(Array.isArray(message.dates) ? message.dates : [])];
          const results = {};
          for (let i = 0; i < dates.length; i += 5) {
            await Promise.all(dates.slice(i, i + 5).map(async date => {
              const result = await getHistoricalRate(date, currency);
              if (result?.rate > 0) results[date] = result.rate;
            }));
          }
          sendResponse({ success: true, data: results });
          break;
        }
        case 'CLEAR_CACHE':
          await cacheWriteQueue;
          await chrome.storage.local.set({ historicalRates: {}, historicalRatesEUR: {} });
          sendResponse({ success: true });
          break;
        case 'GET_CACHE_STATS': {
          const keys = rateKeys(currency);
          const cached = await chrome.storage.local.get([keys.history, keys.rate, keys.date, keys.time]);
          sendResponse({ success: true, data: {
            cachedHistoricalDatesCount: Object.keys(cached[keys.history] || {}).length,
            latestRate: cached[keys.rate], latestRateDate: cached[keys.date], latestRateTime: cached[keys.time], currency
          } });
          break;
        }
        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      console.error('[TRY Converter] Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();
  return true;
});
