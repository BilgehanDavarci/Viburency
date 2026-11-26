'use strict';
(async () => {
  const results = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for popup');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const markup = (await (await fetch('../popup/popup.html')).text())
    .replace('<head>', `<head><base href="${new URL('../popup/', location.href)}">`)
    .replace('<script src="popup.js"></script>', '');

  async function fixture(settings = {}, options = {}) {
    const frame = document.createElement('iframe');
    document.getElementById('preview').replaceChildren(frame);
    const win = frame.contentWindow;
    const doc = win.document;
    doc.open(); doc.write(markup); doc.close();
    await waitFor(() => doc.readyState === 'complete');
    const state = { enabled: true, displayMode: 'both_try_first', decimals: 2, ...settings };
    const requests = [], pending = [];
    let cleared = false;
    win.chrome = {
      storage: { local: { get: async () => ({ ...state }), set: async value => Object.assign(state, value) } },
      runtime: { sendMessage: async message => {
        requests.push(message);
        const currency = message.currency || 'USD';
        const rate = currency === 'EUR' ? (options.euroRate === null ? null : 0.015) : 0.02;
        switch (message.type) {
          case 'GET_LATEST_RATE': return { success: true, data: { rate, date: '2026-10-19', currency } };
          case 'FORCE_REFRESH_RATE': return { success: true, data: { latestRate: currency === 'EUR' ? 0.016 : 0.021, latestRateDate: '2026-10-19', currency } };
          case 'GET_HISTORICAL_RATE':
            if (options.deferHistory) return new Promise(resolve => pending.push({ ...message, resolve }));
            return { success: true, data: { rate: currency === 'EUR' ? 0.018 : 0.025, actualDate: '2024-03-15', currency } };
          case 'GET_CACHE_STATS': return { success: true, data: { cachedHistoricalDatesCount: cleared ? 0 : currency === 'EUR' ? 3 : 12 } };
          case 'CLEAR_CACHE': cleared = true; return { success: true };
        }
      } }
    };
    const script = doc.createElement('script');
    script.src = new URL('../popup/popup.js', location.href);
    const loaded = new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; });
    doc.body.appendChild(script); await loaded;
    doc.dispatchEvent(new win.Event('DOMContentLoaded'));
    await waitFor(() => doc.getElementById('live-rate-display').textContent !== 'Loading...');
    const change = (id, value) => {
      const el = doc.getElementById(id); el.value = value; el.dispatchEvent(new win.Event('change', { bubbles: true }));
    };
    return { doc, win, state, requests, pending, change };
  }

  async function test(name, run) {
    const row = document.createElement('li'); document.getElementById('results').appendChild(row);
    try { await run(); results.push({ name, passed: true }); row.className = 'pass'; row.textContent = 'PASS: ' + name; }
    catch (error) { results.push({ name, passed: false, error: String(error) }); row.className = 'fail'; row.textContent = 'FAIL: ' + name + ' — ' + error.message; }
  }

  await test('Existing popup layout is renamed and defaults to USD', async () => {
    const { doc } = await fixture();
    assert(doc.title === 'Viburency' && doc.querySelector('h1').textContent === 'Viburency', 'Old extension name remains');
    assert(doc.getElementById('select-target-currency').value === 'USD', 'Existing installation lost USD default');
    assert(doc.getElementById('live-rate-display').textContent === '1 USD = 50.00 TRY', 'USD banner incorrect');
    assert(doc.getElementById('select-display-mode').value === 'both_try_first', 'Saved display mode lost');
    assert(doc.body.scrollWidth === 320 && doc.body.scrollHeight <= 600, 'Popup exceeds original width or Chrome popup height');
  });
  await test('Saved Euro preference drives every label and live banner', async () => {
    const { doc } = await fixture({ targetCurrency: 'EUR' });
    assert(doc.getElementById('live-rate-display').textContent === '1 EUR = 66.67 TRY', 'EUR banner incorrect');
    assert(doc.querySelector('.logo-icon').textContent === '₺→€', 'Logo did not follow Euro');
    assert(doc.getElementById('btn-test-convert').textContent === 'Convert to EUR', 'Calculator still targets USD');
    assert([...doc.querySelectorAll('option')].filter(e => e.parentElement.id !== 'select-target-currency').every(e => !e.textContent.includes('$')), 'USD examples remain in EUR settings');
  });
  await test('Currency dropdown saves EUR while retaining format and precision', async () => {
    const { doc, state, change } = await fixture({ displayMode: 'both_usd_first', decimals: 0 });
    change('select-target-currency', 'EUR');
    await waitFor(() => doc.getElementById('live-rate-display').textContent.includes('1 EUR'));
    assert(state.targetCurrency === 'EUR' && state.displayMode === 'both_usd_first' && state.decimals === 0, 'Currency change reset existing settings');
    assert(doc.getElementById('cache-stats-text').textContent === 'Cached Dates: 3', 'Stats did not switch to EUR cache');
  });
  await test('Euro quick converter uses live and date-specific Euro rates', async () => {
    const { doc, requests } = await fixture({ targetCurrency: 'EUR' });
    doc.getElementById('test-try-input').value = '1000';
    doc.getElementById('btn-test-convert').click();
    await waitFor(() => doc.getElementById('test-result').textContent.includes('€15.00'));
    doc.getElementById('test-date-input').value = '2024-03-17';
    doc.getElementById('btn-test-convert').click();
    await waitFor(() => doc.getElementById('test-result').textContent.includes('€18.00'));
    assert(doc.getElementById('test-result').textContent.includes('2024-03-15'), 'Historical effective date lost');
    assert(requests.some(r => r.type === 'GET_HISTORICAL_RATE' && r.currency === 'EUR' && r.date === '2024-03-17'), 'Calculator requested wrong historical pair');
  });
  await test('Refresh, cache clear and enable toggle retain their behavior', async () => {
    const { doc, state, win } = await fixture({ targetCurrency: 'EUR' });
    doc.getElementById('btn-refresh-rate').click();
    await waitFor(() => doc.getElementById('live-rate-display').textContent === '1 EUR = 62.50 TRY');
    doc.getElementById('btn-clear-cache').click();
    await waitFor(() => doc.getElementById('cache-stats-text').textContent === 'Cached Dates: 0');
    doc.getElementById('toggle-enabled').checked = false;
    doc.getElementById('toggle-enabled').dispatchEvent(new win.Event('change'));
    assert(state.enabled === false, 'Enable toggle stopped saving');
  });
  await test('A stale USD calculator result cannot appear after switching to EUR', async () => {
    const { doc, pending, change } = await fixture({}, { deferHistory: true });
    doc.getElementById('test-try-input').value = '1000';
    doc.getElementById('test-date-input').value = '2024-03-17';
    doc.getElementById('btn-test-convert').click();
    await waitFor(() => pending.length === 1);
    change('select-target-currency', 'EUR');
    await waitFor(() => doc.getElementById('live-rate-display').textContent.includes('1 EUR'));
    pending[0].resolve({ success: true, data: { rate: 0.025 } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(doc.getElementById('test-result').classList.contains('hidden'), 'Stale USD result reopened calculator output');
    assert(!doc.getElementById('test-result').textContent.includes('$'), 'Stale USD result leaked into EUR');
  });
  await test('Unavailable EUR shows an unavailable rate instead of a USD fallback', async () => {
    const { doc } = await fixture({ targetCurrency: 'EUR' }, { euroRate: null });
    assert(doc.getElementById('live-rate-display').textContent === 'Rate unavailable', 'Unavailable EUR displayed a rate');
    doc.getElementById('test-try-input').value = '1000'; doc.getElementById('btn-test-convert').click();
    await waitFor(() => doc.getElementById('test-result').textContent.includes('Could not fetch'));
    assert(!doc.getElementById('test-result').textContent.includes('$'), 'Unavailable EUR used dollars');
  });
  await test('Pin settings default to three seconds and Ctrl+Q, and validate changes', async () => {
    const { doc, state, change } = await fixture();
    assert(doc.getElementById('pin-delay').value === '3', 'Wrong default delay');
    assert(doc.getElementById('pin-trigger').value === 'default', 'Ctrl+Q is not default');
    assert(doc.getElementById('pin-shortcut-row').hidden, 'Custom field should be hidden for default shortcut');
    change('pin-delay', '1.5');
    assert(state.pinDelaySeconds === 1.5, 'Delay not saved');
    change('pin-delay', '-1');
    assert(state.pinDelaySeconds === 1.5, 'Invalid delay saved');
    change('pin-delay', '');
    assert(state.pinDelaySeconds === 1.5, 'Empty delay saved');
    assert(state.targetCurrency === undefined && state.displayMode === 'both_try_first', 'Pin settings changed conversion settings');
  });
  await test('Pin keyboard shortcut can be captured, restored and reset to Ctrl+Q', async () => {
    const { doc, win, state, change } = await fixture({ pinDelaySeconds: 8 });
    assert(doc.getElementById('pin-delay').value === '8', 'Saved timer not restored');
    change('pin-trigger', 'keyboard');
    const input = doc.getElementById('pin-shortcut');
    assert(!doc.getElementById('pin-shortcut-row').hidden, 'Capture field is hidden');
    input.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, key: 'p', code: 'KeyP' }));
    assert(!state.pinShortcut, 'Unmodified typing shortcut was accepted');
    input.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, key: 'P', code: 'KeyP', altKey: true, shiftKey: true }));
    assert(state.pinShortcut.code === 'KeyP' && state.pinShortcut.altKey && state.pinShortcut.shiftKey, 'Shortcut was not saved');
    assert(input.value === 'Alt + Shift + P', 'Shortcut display is incorrect');
    const saved = { ...state };
    change('pin-trigger', 'default');
    assert(state.pinShortcut.code === 'KeyQ' && state.pinShortcut.ctrlKey && !state.pinShortcut.shiftKey, 'Default reset did not save Ctrl+Q');
    const restored = await fixture(saved);
    assert(restored.doc.getElementById('pin-trigger').value === 'keyboard', 'Saved keyboard selection lost');
    assert(restored.doc.getElementById('pin-shortcut').value === 'Alt + Shift + P', 'Saved shortcut lost');
    restored.doc.querySelector('.pin-settings').open = true;
    assert(restored.doc.body.scrollWidth === 320, 'Expanded settings overflow horizontally');
  });
  await test('Legacy middle-click preference displays the new Ctrl+Q default', async () => {
    const { doc } = await fixture({ pinShortcut: { type: 'middle' } });
    assert(doc.getElementById('pin-trigger').value === 'default', 'Legacy mouse preference retained');
    assert(doc.getElementById('pin-trigger').selectedOptions[0].textContent.includes('Ctrl + Q'), 'Default shortcut label missing');
  });
  window.testResults = results;
  const failed = results.filter(result => !result.passed).length;
  document.getElementById('summary').textContent = `${results.length - failed}/${results.length} passed; ${failed} failed.`;
  document.title = failed ? 'FAIL: popup regressions' : 'PASS: popup regressions';
})();
