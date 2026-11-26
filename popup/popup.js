// Existing popup controls, with a shared USD/EUR selection.
document.addEventListener('DOMContentLoaded', async () => {
  const byId = id => document.getElementById(id);
  const toggleEnabled = byId('toggle-enabled');
  const selectCurrency = byId('select-target-currency');
  const selectDisplayMode = byId('select-display-mode');
  const selectDecimals = byId('select-decimals');
  const liveRateDisplay = byId('live-rate-display');
  const liveRateDate = byId('live-rate-date');
  const btnRefreshRate = byId('btn-refresh-rate');
  const cacheStatsText = byId('cache-stats-text');
  const testTryInput = byId('test-try-input');
  const testDateInput = byId('test-date-input');
  const btnTestConvert = byId('btn-test-convert');
  const testResult = byId('test-result');
  const pinDelay = byId('pin-delay');
  const pinTrigger = byId('pin-trigger');
  const pinShortcut = byId('pin-shortcut');
  const shortcutHelp = byId('pin-shortcut-help');
  let shortcut = null;
  let currency = 'USD';
  let resultVersion = 0;
  const symbol = () => currency === 'EUR' ? '€' : '$';
  const format = (amount, digits = 2) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits
  }).format(amount);
  const send = (type, extra = {}, selected = currency) => chrome.runtime.sendMessage({ type, currency: selected, ...extra });

  function updateCurrencyLabels() {
    document.querySelector('.logo-icon').textContent = `₺→${symbol()}`;
    selectDisplayMode.options[0].textContent = `Replace with ${currency} (${symbol()}850)`;
    selectDisplayMode.options[1].textContent = `TRY first: 29.399 TL (${symbol()}850)`;
    selectDisplayMode.options[2].textContent = `${currency} first: ${symbol()}850 (29.399 TL)`;
    selectDecimals.options[0].textContent = `2 Decimals (${symbol()}850.50)`;
    selectDecimals.options[1].textContent = `Rounded (${symbol()}851)`;
    btnTestConvert.textContent = `Convert to ${currency}`;
  }

  function displayRateInfo(rate, date) {
    if (!(rate > 0)) {
      liveRateDisplay.textContent = 'Rate unavailable';
      liveRateDate.textContent = `Refresh to retry the ${currency} rate`;
      return;
    }
    liveRateDisplay.textContent = `1 ${currency} = ${(1 / rate).toFixed(2)} TRY`;
    liveRateDate.textContent = `1 TRY = ${symbol()}${rate.toFixed(5)} • ${date || 'Cached fallback'}`;
  }

  async function loadLiveRate(force = false) {
    const selected = currency;
    liveRateDisplay.textContent = force ? 'Updating...' : 'Loading...';
    try {
      const response = await send(force ? 'FORCE_REFRESH_RATE' : 'GET_LATEST_RATE', {}, selected);
      if (selected !== currency) return;
      if (!response?.success || !response.data) throw new Error('Rate unavailable');
      displayRateInfo(force ? response.data.latestRate : response.data.rate,
        force ? response.data.latestRateDate : response.data.date);
    } catch (error) {
      if (selected === currency) displayRateInfo(null);
    }
  }

  async function loadCacheStats() {
    const selected = currency;
    try {
      const response = await send('GET_CACHE_STATS', {}, selected);
      if (selected === currency) cacheStatsText.textContent = `Cached Dates: ${response?.data?.cachedHistoricalDatesCount || 0}`;
    } catch (error) {
      if (selected === currency) cacheStatsText.textContent = 'Cached Dates: 0';
    }
  }

  testDateInput.max = new Date().toISOString().split('T')[0];
  const settings = await chrome.storage.local.get(['enabled', 'displayMode', 'decimals', 'targetCurrency', 'pinDelaySeconds', 'pinShortcut']);
  currency = settings.targetCurrency === 'EUR' ? 'EUR' : 'USD';
  selectCurrency.value = currency;
  toggleEnabled.checked = settings.enabled !== false;
  if (settings.displayMode) selectDisplayMode.value = settings.displayMode;
  if (typeof settings.decimals !== 'undefined') selectDecimals.value = String(settings.decimals);
  updateCurrencyLabels();

  const validDelay = value => typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 60;
  pinDelay.value = validDelay(settings.pinDelaySeconds) ? settings.pinDelaySeconds : 3;
  if (settings.pinShortcut?.type === 'keyboard' && typeof settings.pinShortcut.code === 'string' && settings.pinShortcut.code &&
      (settings.pinShortcut.ctrlKey || settings.pinShortcut.altKey || settings.pinShortcut.shiftKey || settings.pinShortcut.metaKey)) shortcut = settings.pinShortcut;
  const defaultShortcut = { type: 'keyboard', code: 'KeyQ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
  const isDefaultShortcut = shortcut && shortcut.code === 'KeyQ' && shortcut.ctrlKey && !shortcut.altKey && !shortcut.shiftKey && !shortcut.metaKey;
  pinTrigger.value = shortcut && !isDefaultShortcut ? 'keyboard' : 'default';
  function displayShortcut() {
    byId('pin-shortcut-row').hidden = pinTrigger.value !== 'keyboard';
    pinShortcut.value = shortcut ? [shortcut.ctrlKey && 'Ctrl', shortcut.altKey && 'Alt', shortcut.shiftKey && 'Shift', shortcut.metaKey && 'Meta', shortcut.code.replace(/^Key|^Digit/, '')].filter(Boolean).join(' + ') : '';
  }
  displayShortcut();
  pinDelay.addEventListener('change', () => {
    const value = Number(pinDelay.value);
    if (!validDelay(value)) { pinDelay.reportValidity(); return; }
    chrome.storage.local.set({ pinDelaySeconds: value });
  });
  pinTrigger.addEventListener('change', () => {
    if (pinTrigger.value === 'default') chrome.storage.local.set({ pinShortcut: defaultShortcut });
    else if (shortcut) chrome.storage.local.set({ pinShortcut: shortcut });
    displayShortcut();
    if (pinTrigger.value === 'keyboard') {
      shortcutHelp.textContent = shortcut ? 'Hover a price and press this shortcut to pin it.' : 'Press a shortcut to save it. Ctrl + Q stays active until then.';
      pinShortcut.focus();
    }
  });
  pinShortcut.addEventListener('keydown', event => {
    if (event.key === 'Tab') return;
    event.preventDefault();
    if (event.repeat || /^(Control|Alt|Shift|Meta)$/.test(event.key)) return;
    if (!event.code || event.key === 'Escape' || !(event.ctrlKey || event.altKey || event.shiftKey || event.metaKey)) {
      shortcutHelp.textContent = 'Use Ctrl, Alt or Shift with a key. Browser-reserved shortcuts may be unavailable.';
      return;
    }
    shortcut = { type: 'keyboard', code: event.code, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey, metaKey: event.metaKey };
    chrome.storage.local.set({ pinShortcut: shortcut });
    shortcutHelp.textContent = 'Saved. Hover a price and press this shortcut to pin it.';
    displayShortcut();
  });

  toggleEnabled.addEventListener('change', () => chrome.storage.local.set({ enabled: toggleEnabled.checked }));
  selectDisplayMode.addEventListener('change', () => chrome.storage.local.set({ displayMode: selectDisplayMode.value }));
  selectDecimals.addEventListener('change', () => chrome.storage.local.set({ decimals: Number(selectDecimals.value) }));
  selectCurrency.addEventListener('change', async () => {
    currency = selectCurrency.value === 'EUR' ? 'EUR' : 'USD';
    resultVersion++;
    testResult.classList.add('hidden');
    updateCurrencyLabels();
    await chrome.storage.local.set({ targetCurrency: currency });
    await Promise.all([loadLiveRate(), loadCacheStats()]);
  });
  btnRefreshRate.addEventListener('click', async () => {
    btnRefreshRate.style.transform = 'rotate(360deg)';
    await loadLiveRate(true);
    setTimeout(() => { btnRefreshRate.style.transform = 'none'; }, 300);
    await loadCacheStats();
  });
  byId('btn-clear-cache').addEventListener('click', async () => {
    await send('CLEAR_CACHE');
    await loadCacheStats();
  });
  btnTestConvert.addEventListener('click', async () => {
    const version = ++resultVersion;
    const selected = currency;
    const amount = Number(testTryInput.value);
    testResult.classList.remove('hidden');
    if (!Number.isFinite(amount) || amount <= 0) {
      testResult.textContent = 'Please enter a valid price in TL.';
      return;
    }
    const date = testDateInput.value;
    testResult.textContent = 'Looking up exchange rate...';
    try {
      const response = await send(date ? 'GET_HISTORICAL_RATE' : 'GET_LATEST_RATE', date ? { date } : {}, selected);
      if (version !== resultVersion || selected !== currency) return;
      if (!response?.success || !(response.data?.rate > 0)) throw new Error('Could not fetch rate for this date.');
      const { rate, actualDate } = response.data;
      const effectiveDate = date ? (actualDate || date) : `Live (${response.data.date || 'Cached fallback'})`;
      testResult.innerHTML = `<div style="font-size:14px;font-weight:700;color:#34d399;margin-bottom:4px;">${format(amount * rate)}</div>
        <div style="font-size:11px;color:#94a3b8;">📅 Rate on <strong>${effectiveDate}</strong>: 1 TRY = ${symbol()}${rate.toFixed(5)} (1 ${currency} ≈ ${(1 / rate).toFixed(2)} TL)</div>`;
      await loadCacheStats();
    } catch (error) {
      if (version === resultVersion) testResult.textContent = error.message;
    }
  });
  await Promise.all([loadLiveRate(), loadCacheStats()]);
});
