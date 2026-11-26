'use strict';

(async () => {
  const results = [];
  const testFilter = new URLSearchParams(location.search).get('test');
  const liveRate = 0.02;
  const historicalRate = 0.025;
  const date = '<div class="point-date">31/08/2026</div>';
  const usd = (value, rate, decimals = 2) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', minimumFractionDigits: decimals,
    maximumFractionDigits: decimals
  }).format(value * rate);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const waitFor = async (predicate, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('Timed out waiting for conversion');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };

  async function fixture(markup, mode = 'both_try_first', options = {}) {
    const frame = document.createElement('iframe');
    if (options.width) frame.style.width = options.width + 'px';
    if (options.height) frame.style.height = options.height + 'px';
    document.getElementById('preview').replaceChildren(frame);
    const win = frame.contentWindow;
    const doc = win.document;
    doc.open();
    doc.write('<!doctype html><meta charset="utf-8"><body>' + markup);
    doc.close();
    const requests = [];
    const deferred = [];
    const latestPending = [];
    const storageListeners = [];
    win.chrome = {
      storage: {
        local: { get: async () => ({ enabled: true, displayMode: mode, decimals: options.decimals ?? 2, targetCurrency: options.currency || 'USD', pinDelaySeconds: options.pinDelaySeconds, pinShortcut: options.pinShortcut }) },
        onChanged: { addListener: listener => storageListeners.push(listener) }
      },
      runtime: {
        sendMessage: async message => {
          requests.push(message);
          const currency = message.currency === 'EUR' ? 'EUR' : 'USD';
          if (message.type === 'GET_LATEST_RATE') {
            if (options.deferLatest && currency === 'USD') {
              return new Promise(resolve => latestPending.push({ currency, resolve }));
            }
            return { success: true, data: { rate: currency === 'EUR' ? (options.euroRate === undefined ? 0.015 : options.euroRate) : liveRate, date: '2026-10-19', currency } };
          }
          if (message.type === 'GET_HISTORICAL_RATE') {
            if (options.deferHistory) {
              return new Promise(resolve => deferred.push({ date: message.date, currency, resolve }));
            }
            return { success: true, data: { rate: currency === 'EUR' ? 0.018 : historicalRate, date: message.date, currency } };
          }
          return { success: true, data: {} };
        }
      }
    };
    if (options.prepare) options.prepare(doc, win);
    const stylesheet = doc.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = new URL('../content.css', location.href).href;
    const styled = new Promise((resolve, reject) => { stylesheet.onload = resolve; stylesheet.onerror = reject; });
    doc.head.appendChild(stylesheet);
    await styled;
    const script = doc.createElement('script');
    script.src = new URL('../content.js', location.href).href;
    const loaded = new Promise((resolve, reject) => { script.onload = resolve; script.onerror = reject; });
    doc.body.appendChild(script);
    await loaded;
    const changeSettings = changes => storageListeners.forEach(listener => listener(changes, 'local'));
    return { win, doc, requests, deferred, latestPending, frame, changeSettings };
  }

  async function test(name, run) {
    if (testFilter && !name.includes(testFilter)) return;
    const row = document.createElement('li');
    document.getElementById('results').appendChild(row);
    try {
      await run();
      results.push({ name, passed: true });
      row.className = 'pass';
      row.textContent = 'PASS: ' + name;
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
      row.className = 'fail';
      row.textContent = 'FAIL: ' + name + ' — ' + error.message;
    }
  }

  for (const mode of ['replace', 'both_try_first', 'both_usd_first']) {
    for (const [name, price, original, value] of [
      ['Cimri split decimal', '43.877<span class="fraction">,83 TL</span>', '43.877,83 TL', 43877.83],
      ['zero kuruş', '43.877<span class="fraction">,00 TL</span>', '43.877,00 TL', 43877],
      ['separate currency', '<b>43.877</b><span>,83</span><i> TL</i>', '43.877,83 TL', 43877.83],
      ['currency prefix', '<span>₺ </span><b>43.877</b><i>,83</i>', '₺ 43.877,83', 43877.83],
      ['single text node', '43.877,83 TL', '43.877,83 TL', 43877.83]
    ]) {
      await test(`${name}: ${mode}`, async () => {
        const { doc, win, requests } = await fixture(`<div id="tooltip"><div class="point-price">${price}</div>${date}</div>`, mode);
        const tooltip = doc.getElementById('tooltip');
        await waitFor(() => tooltip.hasAttribute('data-try2usd-last-converted'));
        const converted = usd(value, historicalRate);
        const expected = mode === 'replace' ? converted : mode === 'both_try_first'
          ? `${original} (${converted})` : `${converted} (${original})`;
        const actual = doc.querySelector('.point-price').textContent;
        assert(actual === expected, `Expected ${expected}; got ${actual}`);
        assert(doc.querySelector('.point-date').textContent === '31/08/2026', 'Point date changed');
        assert(tooltip.dataset.date === '2026-08-31', 'Wrong historical date');
        assert(requests.some(r => r.type === 'GET_HISTORICAL_RATE' && r.date === '2026-08-31'), 'Historical rate was not requested');
        const markup = tooltip.innerHTML;
        tooltip.dispatchEvent(new win.MouseEvent('pointermove', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 100));
        assert(tooltip.innerHTML === markup, 'Repeated scan converted the price twice');
      });
    }
  }

  await test('Tooltip keeps nested elements and event listeners', async () => {
    const { doc, win } = await fixture(`<div id="tooltip"><b id="whole">43.877</b><i id="fraction">,83 TL</i> ${date}</div>`);
    const whole = doc.getElementById('whole');
    const fraction = doc.getElementById('fraction');
    let clicked = false;
    fraction.addEventListener('click', () => { clicked = true; });
    await waitFor(() => doc.getElementById('tooltip').hasAttribute('data-try2usd-last-converted'));
    assert(doc.getElementById('whole') === whole && doc.getElementById('fraction') === fraction, 'Price elements replaced');
    fraction.dispatchEvent(new win.MouseEvent('click'));
    assert(clicked, 'Listener lost');
  });

  await test('Multiple split prices in one tooltip', async () => {
    const { doc } = await fixture(`<div id="tooltip"><div id="a">43.877<span>,83 TL</span></div><div id="b">59.358<i>,04 TL</i></div>${date}</div>`);
    await waitFor(() => doc.getElementById('tooltip').hasAttribute('data-try2usd-last-converted'));
    assert(doc.getElementById('a').textContent === `43.877,83 TL (${usd(43877.83, historicalRate)})`, 'First price incorrect');
    assert(doc.getElementById('b').textContent === `59.358,04 TL (${usd(59358.04, historicalRate)})`, 'Second price incorrect');
  });

  await test('SVG tooltip with split tspans', async () => {
    const { doc } = await fixture('<svg><g class="highcharts-tooltip"><text id="svg-price"><tspan>43.877</tspan><tspan>,83 TL</tspan></text><text>31/08/2026</text></g></svg>');
    const tooltip = doc.querySelector('.highcharts-tooltip');
    await waitFor(() => tooltip.hasAttribute('data-try2usd-last-converted'));
    assert(doc.getElementById('svg-price').textContent === `43.877,83 TL (${usd(43877.83, historicalRate)})`, 'SVG price incorrect');
    assert(doc.querySelectorAll('tspan').length === 2, 'SVG tspans removed');
  });

  await test('Dynamic tooltip reuses its text nodes for the next point', async () => {
    const { doc } = await fixture(`<div id="tooltip"><div id="point">43.877<span>,83 TL</span></div>${date}</div>`);
    const tooltip = doc.getElementById('tooltip');
    await waitFor(() => tooltip.hasAttribute('data-try2usd-last-converted'));
    const point = doc.getElementById('point');
    point.firstChild.nodeValue = '59.358';
    point.querySelector('span').firstChild.nodeValue = ',04 TL';
    doc.querySelector('.point-date').textContent = '01/09/2026';
    await waitFor(() => tooltip.dataset.date === '2026-09-01');
    assert(point.textContent === `59.358,04 TL (${usd(59358.04, historicalRate)})`, 'New point price incorrect');
  });

  await test('Slow historical fetch does not overwrite a newer point', async () => {
    const { doc, deferred } = await fixture(`<div id="tooltip"><div id="point">43.877<span>,83 TL</span></div>${date}</div>`, 'replace', { deferHistory: true });
    await waitFor(() => deferred.length === 1);
    doc.getElementById('point').innerHTML = '59.358<span>,04 TL</span>';
    doc.querySelector('.point-date').textContent = '01/09/2026';
    await waitFor(() => deferred.some(item => item.date === '2026-09-01'));
    for (const item of deferred.filter(item => item.date === '2026-09-01')) {
      item.resolve({ success: true, data: { rate: 0.03 } });
    }
    await waitFor(() => doc.getElementById('tooltip').dataset.date === '2026-09-01');
    for (const item of deferred.filter(item => item.date === '2026-08-31')) {
      item.resolve({ success: true, data: { rate: historicalRate } });
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(doc.getElementById('point').textContent === usd(59358.04, 0.03), 'Obsolete fetch overwrote new point');
  });

  await test('Static Cimri split price still uses live rate', async () => {
    const { doc } = await fixture('<span class="h1Anp" id="static-price">16.070<span>,60 TL</span></span>');
    const price = doc.getElementById('static-price');
    await waitFor(() => price.classList.contains('try2usd-converted'));
    assert(price.textContent === `16.070,60 TL (${usd(16070.60, liveRate)})`, 'Static price incorrect');
    assert(price.dataset.tryValue === '16070.6', 'Wrong whole TRY value');
  });

  await test('Same point redrawn during a slow fetch converts attached nodes', async () => {
    const markup = `<div id="point">43.877<span>,83 TL</span></div>${date}`;
    const { doc, deferred } = await fixture(`<div id="tooltip">${markup}</div>`, 'replace', { deferHistory: true });
    await waitFor(() => deferred.length === 1);
    const tooltip = doc.getElementById('tooltip');
    tooltip.innerHTML = markup;
    for (const item of deferred) item.resolve({ success: true, data: { rate: historicalRate } });
    await waitFor(() => tooltip.hasAttribute('data-try2usd-last-converted'));
    assert(doc.getElementById('point').textContent === usd(43877.83, historicalRate), 'Redrawn point was left unconverted');
  });

  await test('Multiple prices in the same text node keep their surrounding labels', async () => {
    const { doc } = await fixture(`<div id="tooltip"><div id="line">Low: 43.877,83 TL; High: 59.358,04 TL.</div>${date}</div>`);
    await waitFor(() => doc.getElementById('tooltip').hasAttribute('data-try2usd-last-converted'));
    assert(doc.getElementById('line').textContent === `Low: 43.877,83 TL (${usd(43877.83, historicalRate)}); High: 59.358,04 TL (${usd(59358.04, historicalRate)}).`, 'Labels or prices corrupted');
  });

  await test('Separate chart rows cannot be joined as thousands groups', async () => {
    const { doc } = await fixture(`<div id="tooltip"><div id="series">123</div><div id="point">456 TL</div>${date}</div>`, 'replace');
    await waitFor(() => doc.getElementById('tooltip').hasAttribute('data-try2usd-last-converted'));
    assert(doc.getElementById('series').textContent === '123', 'Series number was treated as part of price');
    assert(doc.getElementById('point').textContent === usd(456, historicalRate), 'Price joined to another row');
  });

  await test('Tooltip without a date uses the live rate and rounded display', async () => {
    const { doc } = await fixture('<div id="tooltip">43.877<span>,83 TL</span></div>', 'replace', { decimals: 0 });
    const tooltip = doc.getElementById('tooltip');
    await waitFor(() => tooltip.hasAttribute('data-try2usd-last-converted'));
    assert(tooltip.textContent === usd(43877.83, liveRate, 0), 'Live rounded conversion incorrect');
    assert(tooltip.dataset.date === 'Live', 'Live tooltip received a historical date');
  });

  await test('Turkish formats and unit prices remain supported', async () => {
    const { doc } = await fixture('<p id="grouped">1.700.000 TL</p><p id="spaces">8 500 000 TL</p><p id="unit">(5,83 TL / tablet)</p>');
    await waitFor(() => doc.querySelectorAll('.try2usd-converted').length === 3);
    assert(doc.getElementById('grouped').textContent.includes(usd(1700000, liveRate)), 'Grouped thousands incorrect');
    assert(doc.getElementById('spaces').textContent.includes(usd(8500000, liveRate)), 'Space thousands incorrect');
    assert(doc.getElementById('unit').textContent === `(5,83 TL (${usd(5.83, liveRate)}) / tablet)`, 'Unit price incorrect');
  });

  for (const mode of ['replace', 'both_try_first', 'both_usd_first']) {
    await test(`Watsons recommendations with bidi currency marks: ${mode}`, async () => {
      const { doc } = await fixture('<div id="popular"><div class="ins-product-price" contenteditable="false" aria-hidden="true"><span>224,90</span><span> \u202a₺\u202c</span></div></div>', mode);
      const price = doc.querySelector('.ins-product-price');
      await waitFor(() => price.classList.contains('try2usd-converted'));
      assert(price.dataset.tryValue === '224.9', 'Wrong Watsons TRY amount');
      assert(price.textContent.includes(usd(224.9, liveRate)), 'Popular product did not convert');
      assert((price.textContent.match(/\$/g) || []).length === 1, 'Watsons price duplicated');
    });

    await test(`Boyner separate text nodes keep Sepette label: ${mode}`, async () => {
      let label;
      const { doc } = await fixture('<div><span id="old">2.299,89 TL</span><span id="discount">%45 İndirim</span><span id="offer" class="price_priceMain__DrVVQ price_priceMainBestOffer__qp2Sz"><span id="label" class="price_priceMainText__6p5Zp">Sepette</span></span></div>', mode, {
        prepare(doc) {
          label = doc.getElementById('label');
          const offer = doc.getElementById('offer');
          ['1.264,94', ' ', 'TL'].forEach(value => offer.appendChild(doc.createTextNode(value)));
        }
      });
      const offer = doc.getElementById('offer');
      await waitFor(() => offer.textContent.includes('$'));
      const converted = usd(1264.94, liveRate);
      const expected = mode === 'replace' ? converted : mode === 'both_try_first'
        ? `1.264,94 TL (${converted})` : `${converted} (1.264,94 TL)`;
      assert(offer.textContent === 'Sepette' + expected, `Wrong basket price: ${offer.textContent}`);
      assert(doc.getElementById('label') === label && label.textContent === 'Sepette', 'Sepette label was replaced');
      assert(doc.getElementById('discount').textContent === '%45 İndirim', 'Discount badge changed');
      assert(doc.getElementById('old').textContent.includes(usd(2299.89, liveRate)), 'Old price lost');
    });
  }

  await test('Watsons recommendations inserted after initial scan convert', async () => {
    const { doc, win } = await fixture('<div id="popular"></div>');
    await new Promise(resolve => setTimeout(resolve, 200));
    doc.getElementById('popular').innerHTML = '<div class="ins-product-price"><span>54,95</span><span> \u202a₺\u202c</span></div>';
    await waitFor(() => doc.querySelector('.ins-product-price').textContent.includes('$'));
    const before = doc.querySelector('.ins-product-price').textContent;
    win.dispatchEvent(new win.Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert(doc.querySelector('.ins-product-price').textContent === before, 'Dynamic recommendation converted twice');
  });

  await test('Boyner display changes keep label and restore original split nodes', async () => {
    let label;
    let originalNodes;
    const { doc, changeSettings } = await fixture('<span id="offer" class="price_priceMainBestOffer__qp2Sz"><span id="label">Sepette</span></span>', 'both_try_first', {
      prepare(doc) {
        label = doc.getElementById('label');
        const offer = doc.getElementById('offer');
        originalNodes = ['3.150', ' ', 'TL'].map(value => offer.appendChild(doc.createTextNode(value)));
      }
    });
    const offer = doc.getElementById('offer');
    await waitFor(() => offer.textContent.includes('$'));
    changeSettings({ displayMode: { newValue: 'replace' } });
    await waitFor(() => offer.textContent === 'Sepette$63.00');
    assert(doc.getElementById('label') === label, 'Changing display removed the label');
    changeSettings({ decimals: { newValue: 0 } });
    await waitFor(() => offer.textContent === 'Sepette$63');
    changeSettings({ enabled: { newValue: false } });
    assert(offer.textContent === 'Sepette3.150 TL', 'Disabling did not restore original price');
    assert(doc.getElementById('label') === label, 'Disabling replaced label element');
    assert(originalNodes.every(node => node.parentNode === offer), 'Original React text nodes replaced');
    changeSettings({ enabled: { newValue: true } });
    await waitFor(() => offer.textContent === 'Sepette$63');
  });

  await test('Incehesap responsive price stays single on desktop and mobile', async () => {
    const { doc, win, frame } = await fixture('<style>.hidden{display:none}@media(min-width:768px){.md\\:hidden{display:none}.md\\:block{display:block}}</style><div><span id="mobile" class="md:hidden" itemprop="price">43.999 TL</span><span id="desktop" class="hidden md:block" itemprop="price">43.999 TL</span></div>', 'both_try_first', { width: 1000 });
    const mobile = doc.getElementById('mobile');
    const desktop = doc.getElementById('desktop');
    await waitFor(() => mobile.textContent.includes('$') && desktop.textContent.includes('$'));
    assert(win.getComputedStyle(mobile).display === 'none', 'Mobile-only price became visible on desktop');
    assert(win.getComputedStyle(desktop).display === 'block', 'Desktop price display changed');
    frame.style.width = '390px';
    await waitFor(() => win.innerWidth === 390);
    assert(win.getComputedStyle(mobile).display !== 'none', 'Mobile price is hidden on mobile');
    assert(win.getComputedStyle(desktop).display === 'none', 'Desktop-only price became visible on mobile');
  });

  await test('Boyner basket price wraps fully inside a narrow flex card', async () => {
    const { doc, win } = await fixture('<style>.basket{display:flex;flex-wrap:nowrap;white-space:nowrap;overflow:hidden;width:146px;font:16px/22px sans-serif}</style><span id="offer" class="basket price_priceMainBestOffer__qp2Sz" style="-webkit-line-clamp:1"><span id="label">Sepette</span></span>', 'both_try_first', {
      prepare(doc) {
        const offer = doc.getElementById('offer');
        ['4.999,99', ' ', 'TL'].forEach(value => offer.appendChild(doc.createTextNode(value)));
      }
    });
    const offer = doc.getElementById('offer');
    await waitFor(() => offer.textContent.includes('$100.00'));
    assert(win.getComputedStyle(offer).flexWrap === 'wrap', 'Basket row cannot wrap');
    assert(offer.scrollWidth <= offer.clientWidth + 1, 'Converted price exceeds card width');
    assert(offer.clientHeight > 22, 'Basket price is still clamped to a single line');
  });

  await test('Compound price keeps seller logo, split elements and listeners', async () => {
    let logo;
    let fraction;
    let clicked = false;
    const { doc, win, changeSettings } = await fixture('<span id="price" class="pt_v8"><b class="v_v8" id="logo"><img alt="Seller" width="16" height="16"></b>38.999<i id="fraction">,00 TL</i></span>', 'both_try_first', {
      prepare(doc) {
        logo = doc.getElementById('logo');
        fraction = doc.getElementById('fraction');
        logo.addEventListener('click', () => { clicked = true; });
      }
    });
    const price = doc.getElementById('price');
    await waitFor(() => price.textContent.includes('$779.98'));
    changeSettings({ displayMode: { newValue: 'replace' } });
    assert(price.textContent === '$779.98', 'Seller price formatting incorrect');
    assert(doc.getElementById('logo') === logo && doc.getElementById('fraction') === fraction, 'Compound markup replaced');
    logo.dispatchEvent(new win.MouseEvent('click'));
    assert(clicked, 'Seller logo listener lost');
    changeSettings({ enabled: { newValue: false } });
    assert(price.textContent === '38.999,00 TL' && fraction.textContent === ',00 TL', 'Split price not restored');
  });

  const iconPrice = value => `<div class="price"><div class="price-new"><span class="value"><span class="TL"></span> ${value}</span></div></div>`;
  const iconStyle = '<style>.TL::before{content:"\\f195"}</style>';
  for (const mode of ['replace', 'both_try_first', 'both_usd_first']) {
    await test(`Kitapyurdu CSS currency icon prices: ${mode}`, async () => {
      const { doc, win } = await fixture(iconStyle + ['198,00', '308,00', '165,00', '313,50', '1469,90', '1.469,90'].map(iconPrice).join(''), mode);
      const prices = [...doc.querySelectorAll('.value')];
      await waitFor(() => prices.every(price => price.textContent.includes('$')));
      for (const [index, value] of [198, 308, 165, 313.5, 1469.9, 1469.9].entries()) {
        const number = ['198,00', '308,00', '165,00', '313,50', '1469,90', '1.469,90'][index];
        const converted = usd(value, liveRate);
        const original = `₺ ${number}`;
        const expected = mode === 'replace' ? converted : mode === 'both_try_first'
          ? `${original} (${converted})` : `${converted} (${original})`;
        assert(prices[index].textContent.trim() === expected, `Wrong Kitapyurdu price: ${prices[index].textContent}`);
        assert(Number(prices[index].dataset.tryValue) === value, 'Wrong full TRY amount');
        assert(win.getComputedStyle(prices[index].querySelector('.TL')).display === 'none', 'CSS lira icon would duplicate the replacement currency');
      }
    });
  }

  await test('Kitapyurdu CSS icon restores across display changes and disable/re-enable', async () => {
    let icon;
    const { doc, win, changeSettings } = await fixture(iconStyle + iconPrice('313,50'), 'both_try_first', {
      prepare(doc) { icon = doc.querySelector('.TL'); }
    });
    const price = doc.querySelector('.value');
    await waitFor(() => price.textContent.includes('$6.27'));
    changeSettings({ displayMode: { newValue: 'replace' } });
    assert(price.textContent.trim() === '$6.27', 'Replace mode left a TRY amount');
    changeSettings({ displayMode: { newValue: 'both_usd_first' } });
    assert(price.textContent.trim() === '$6.27 (₺ 313,50)', 'Mode change lost original currency');
    changeSettings({ enabled: { newValue: false } });
    assert(price.textContent === ' 313,50', 'Original numeric text not restored');
    assert(doc.querySelector('.TL') === icon && icon.innerHTML === '', 'Original empty icon replaced');
    assert(win.getComputedStyle(icon).display !== 'none', 'Original icon remains hidden after disable');
    changeSettings({ enabled: { newValue: true } });
    await waitFor(() => price.textContent.includes('$6.27'));
    assert(price.textContent.trim() === '$6.27 (₺ 313,50)', 'Re-enable duplicates the converted price');
  });

  await test('Kitapyurdu delayed carousel items convert without changing shipping text', async () => {
    const { doc, win } = await fixture(iconStyle + '<div id="carousel"></div>');
    await new Promise(resolve => setTimeout(resolve, 200));
    doc.getElementById('carousel').innerHTML = iconPrice('313,50') + '<div id="shipping">24 Saatte Kargoda</div>';
    const price = doc.querySelector('.value');
    await waitFor(() => price.textContent.includes('$6.27'));
    const converted = price.textContent;
    win.dispatchEvent(new win.Event('scroll'));
    await new Promise(resolve => setTimeout(resolve, 250));
    assert(price.textContent === converted, 'Carousel converted twice');
    assert(doc.getElementById('shipping').textContent === '24 Saatte Kargoda', 'Shipping promise treated as a price');
  });

  await test('CSS icon detection ignores other currencies, bare numbers and mixed product copy', async () => {
    const { doc } = await fixture(iconStyle + '<div class="price"><span class="value" id="eur"><span class="EUR"></span> 198,00</span><span class="value" id="bare">198,00</span><span class="value" id="mixed"><span class="TL"></span> 198,00 puan</span></div><div id="not-price"><span class="TL"></span>198,00</div>');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert(doc.querySelectorAll('.try2usd-converted').length === 0, 'An unconfirmed TRY amount was converted');
    assert(!doc.querySelector('.try2usd-currency-icon-hidden'), 'An unconverted currency icon was hidden');
  });

  const civilForm = '<form id="product-form-civil">\n<input type="hidden" name="id" value="56157039100276">\n</form>';
  const civilCard = '<div class="card_product_Price"><div class="card_product_price-top"><small class="card_compare_price">249,99TL</small><span class="card_product_badge">%33</span></div><span class="card_sale_price">165,00TL</span></div>';
  const civilProduct = '<div class="price price--on-sale"><div class="price__regular"><span class="price-item price-item--regular">199,99TL</span></div><div class="price__sale"><span class="price-item price-item--sale price-item--last">179,99TL</span></div><span class="badge">%10</span></div>';
  for (const mode of ['replace', 'both_try_first', 'both_usd_first']) {
    for (const [layout, markup, selector, value, oldSelector, oldValue, discount] of [
      ['homepage', civilCard, '.card_sale_price', 165, '.card_compare_price', 249.99, '%33'],
      ['product page', civilProduct, '.price-item--sale', 179.99, '.price-item--regular', 199.99, '%10']
    ]) {
      await test(`Civilim ${layout} with a form input named id: ${mode}`, async () => {
        const warnings = [];
        const { doc } = await fixture('<small class="unit-price">6,67TL / ADET</small>' + civilForm + markup, mode, {
          prepare(doc, win) {
            const originalWarn = win.console.warn.bind(win.console);
            win.console.warn = (...args) => { warnings.push(args.map(String).join(' ')); originalWarn(...args); };
          }
        });
        assert(doc.querySelector('form').id === doc.querySelector('input[name="id"]'), 'Fixture did not reproduce the form id collision');
        const price = doc.querySelector(selector);
        await waitFor(() => price.textContent.includes('$'));
        const original = layout === 'homepage' ? '165,00TL' : '179,99TL';
        const converted = usd(value, liveRate);
        const expected = mode === 'replace' ? converted : mode === 'both_try_first'
          ? `${original} (${converted})` : `${converted} (${original})`;
        assert(price.textContent.trim() === expected, 'Civilim main price incorrect');
        assert(doc.querySelector(oldSelector).textContent.includes(usd(oldValue, liveRate)), 'Old price did not convert');
        assert(doc.querySelector('.card_product_badge, .badge').textContent === discount, 'Discount changed');
        assert(doc.querySelector('.unit-price').textContent.includes(usd(6.67, liveRate)), 'Unit price stopped converting');
        assert(!warnings.some(warning => warning.includes('[TRY2USD]')), 'Price scan logged an exception');
      });
    }
  }

  await test('Civilim variant price redraws convert while Shopify forms remain present', async () => {
    const { doc } = await fixture(civilForm + civilProduct);
    await waitFor(() => doc.querySelector('.price-item--sale').textContent.includes('$3.60'));
    const input = doc.querySelector('input[name="id"]');
    input.value = '56157039133044';
    doc.querySelector('.price__sale').innerHTML = '<span class="price-item price-item--sale">219,99TL</span>';
    await waitFor(() => doc.querySelector('.price-item--sale').textContent.includes('$4.40'));
    assert(doc.querySelector('.price-item--sale').textContent.trim() === '219,99TL ($4.40)', 'Updated variant price converted incorrectly');
    assert(doc.querySelector('input[name="id"]') === input && input.value === '56157039133044', 'Product variant form changed');
  });

  const euro = (value, rate, decimals = 2) => new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'EUR', minimumFractionDigits: decimals, maximumFractionDigits: decimals
  }).format(value * rate);
  for (const mode of ['replace', 'both_try_first', 'both_usd_first']) {
    await test(`EUR covers Civilim, Watsons, Kitapyurdu, Boyner and chart prices: ${mode}`, async () => {
      const { doc } = await fixture(iconStyle + civilForm + civilCard + iconPrice('198,00') + '<div class="ins-product-price"><span>224,90</span><span> \u202a₺\u202c</span></div><span id="offer"><span id="label">Sepette</span></span><div id="tooltip"><div id="chart-price">43.877<span>,83 TL</span></div>' + date + '</div>', mode, {
        currency: 'EUR', prepare(doc) {
          ['1.264,94', ' ', 'TL'].forEach(value => doc.getElementById('offer').appendChild(doc.createTextNode(value)));
        }
      });
      await waitFor(() => [...doc.querySelectorAll('.card_sale_price, .value, .ins-product-price, #offer, #chart-price')].every(e => e.textContent.includes('€')));
      for (const [selector, amount] of [['.card_sale_price', 165], ['.value', 198], ['.ins-product-price', 224.9], ['#offer', 1264.94]]) {
        const price = doc.querySelector(selector);
        assert(price.textContent.includes(euro(amount, 0.015)), `Wrong EUR amount at ${selector}`);
        assert(!price.textContent.includes('$'), 'USD leaked into EUR conversion');
      }
      const chart = doc.getElementById('chart-price');
      const original = '43.877,83 TL';
      const converted = euro(43877.83, 0.018);
      const expected = mode === 'replace' ? converted : mode === 'both_try_first' ? `${original} (${converted})` : `${converted} (${original})`;
      assert(chart.textContent === expected, 'Historical EUR price incorrect');
      assert(doc.getElementById('label').textContent === 'Sepette', 'Basket label lost');
    });
  }

  await test('USD/EUR switching rerenders full prices and chart markup without duplicating', async () => {
    let fraction;
    const { doc, win, requests, changeSettings } = await fixture(iconStyle + iconPrice('198,00') + '<span class="h1Anp" id="static">16.070<span>,60 TL</span></span><div id="tooltip"><div id="chart-price">43.877<span id="chart-fraction">,83 TL</span></div>' + date + '</div>', 'both_try_first', {
      prepare(doc) { fraction = doc.getElementById('chart-fraction'); }
    });
    await waitFor(() => doc.getElementById('static').textContent.includes('$321.41'));
    await waitFor(() => doc.getElementById('chart-price').textContent.includes('$1,096.95'));
    changeSettings({ targetCurrency: { newValue: 'EUR' } });
    await waitFor(() => doc.getElementById('static').textContent.includes(euro(16070.6, 0.015)));
    await waitFor(() => doc.getElementById('chart-price').textContent.includes(euro(43877.83, 0.018)));
    assert(doc.getElementById('chart-fraction') === fraction, 'Switching currency replaced chart markup');
    assert(doc.querySelector('.value').textContent.trim() === '₺ 198,00 (€2.97)', 'CSS icon currency switch incorrect');
    doc.getElementById('static').dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, clientX: 5, clientY: 5 }));
    assert(doc.getElementById('try2usd-floating-tooltip').textContent.includes('EUR Equivalent:'), 'Hover popup still says USD');
    changeSettings({ decimals: { newValue: 0 } });
    await waitFor(() => doc.getElementById('chart-price').textContent === '43.877,83 TL (€790)');
    changeSettings({ targetCurrency: { newValue: 'USD' }, decimals: { newValue: 2 } });
    await waitFor(() => doc.getElementById('chart-price').textContent === '43.877,83 TL ($1,096.95)');
    await waitFor(() => doc.getElementById('static').textContent === '16.070,60 TL ($321.41)');
    assert(doc.getElementById('static').textContent === '16.070,60 TL ($321.41)', 'Switch back did not restore USD rate');
    assert(requests.some(r => r.type === 'GET_HISTORICAL_RATE' && r.currency === 'USD') && requests.some(r => r.type === 'GET_HISTORICAL_RATE' && r.currency === 'EUR'), 'Currency-specific history not requested');
  });

  await test('Obsolete USD historical response cannot overwrite a new EUR conversion', async () => {
    const { doc, deferred, changeSettings } = await fixture('<div id="tooltip"><div id="point">43.877<span>,83 TL</span></div>' + date + '</div>', 'replace', { deferHistory: true });
    await waitFor(() => deferred.some(item => item.currency === 'USD'));
    changeSettings({ targetCurrency: { newValue: 'EUR' } });
    await waitFor(() => deferred.some(item => item.currency === 'EUR'));
    for (const item of deferred.filter(item => item.currency === 'EUR')) item.resolve({ success: true, data: { rate: 0.018 } });
    await waitFor(() => doc.getElementById('point').textContent === euro(43877.83, 0.018));
    for (const item of deferred.filter(item => item.currency === 'USD')) item.resolve({ success: true, data: { rate: 0.025 } });
    await new Promise(resolve => setTimeout(resolve, 100));
    assert(doc.getElementById('point').textContent === euro(43877.83, 0.018), 'Stale USD response was relabeled as EUR');
  });

  await test('Unavailable EUR rate leaves original TRY prices intact', async () => {
    const { doc } = await fixture(iconStyle + iconPrice('198,00') + civilCard, 'replace', { currency: 'EUR', euroRate: null });
    await new Promise(resolve => setTimeout(resolve, 350));
    assert(doc.querySelector('.card_sale_price').textContent === '165,00TL', 'Unavailable EUR used a USD fallback');
    assert(doc.querySelector('.value').textContent === ' 198,00', 'Unavailable EUR changed the icon price');
    assert(!doc.querySelector('.try2usd-converted'), 'Unavailable rate created converted markers');
  });

  await test('SVG axis labels convert once and preserve tspans across USD/EUR switches', async () => {
    const { doc, changeSettings } = await fixture('<svg><text id="axis"><tspan>1.000 TL</tspan></text></svg>');
    const axis = doc.getElementById('axis');
    const tspan = axis.querySelector('tspan');
    await waitFor(() => axis.textContent === '1.000 TL ($20.00)');
    await new Promise(resolve => setTimeout(resolve, 200));
    assert(axis.textContent === '1.000 TL ($20.00)', 'SVG second scan duplicated USD');
    changeSettings({ targetCurrency: { newValue: 'EUR' } });
    await waitFor(() => axis.textContent === '1.000 TL (€15.00)');
    assert(axis.querySelector('tspan') === tspan, 'SVG currency switch replaced tspan');
    changeSettings({ enabled: { newValue: false } });
    assert(axis.textContent === '1.000 TL', 'Disabled SVG not restored');
    changeSettings({ targetCurrency: { newValue: 'USD' } });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert(axis.textContent === '1.000 TL', 'Disabled conversion restarted on currency change');
    changeSettings({ enabled: { newValue: true } });
    await waitFor(() => axis.textContent === '1.000 TL ($20.00)');
  });

  await test('Currency selection during initial USD fetch is not missed', async () => {
    const { doc, latestPending, changeSettings } = await fixture('<span class="h1Anp" id="price">1.000 TL</span>', 'replace', { deferLatest: true });
    await waitFor(() => latestPending.length === 1);
    changeSettings({ targetCurrency: { newValue: 'EUR' } });
    await waitFor(() => doc.getElementById('price').textContent === '€15.00');
    latestPending[0].resolve({ success: true, data: { rate: 0.02, date: '2026-10-19', currency: 'USD' } });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert(doc.getElementById('price').textContent === '€15.00', 'Initial USD response overrode selected EUR');
  });

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const hover = (win, element) => element.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true, clientX: 40, clientY: 30 }));
  const leave = (win, element, destination = element.ownerDocument.body) => element.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: destination }));
  const pinOptions = { width: 640, height: 400 };

  await test('Three-second hover pins once; window persists, drags, clamps and closes', async () => {
    const { doc, win, frame } = await fixture('<span id="price" class="h1Anp">31.959,06 TL</span>', 'both_try_first', pinOptions);
    const price = doc.getElementById('price');
    await waitFor(() => price.classList.contains('try2usd-converted'));
    const started = win.performance.now();
    hover(win, price);
    assert(doc.getElementById('try2usd-floating-tooltip').classList.contains('show'), 'Short-hover tooltip did not appear');
    await delay(2600);
    assert(!doc.querySelector('.try2usd-pinned-tooltip'), 'Pinned before three seconds');
    await waitFor(() => doc.querySelector('.try2usd-pinned-tooltip'), 2500);
    assert(win.performance.now() - started >= 3000, 'Pin timer was shorter than three seconds');
    const pin = doc.querySelector('.try2usd-pinned-tooltip');
    assert(pin.getAttribute('role') === 'dialog', 'Pinned window is not accessible as a dialog');
    assert(pin.querySelector('.try2usd-tooltip-original').textContent === '31.959,06 TL', 'Original price was converted a second time');
    assert(pin.querySelector('.try2usd-tooltip-rate').textContent === '1 USD ≈ 50.00 TL', 'Exchange-rate text was converted again');
    assert(win.getComputedStyle(pin.querySelector('button')).color === 'rgb(248, 113, 113)', 'Close button is not red');
    price.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
    assert(doc.querySelectorAll('.try2usd-pinned-tooltip').length === 1, 'One continuous hover pinned twice');
    const text = pin.textContent;
    const initial = pin.getBoundingClientRect();
    leave(win, price);
    doc.body.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 200 }));
    win.dispatchEvent(new win.Event('scroll'));
    doc.body.appendChild(Object.assign(doc.createElement('p'), { textContent: '2.000 TL' }));
    await delay(300);
    assert(pin.isConnected && pin.textContent === text, 'Mouse leave or document rescan changed the pinned snapshot');
    assert(pin.getBoundingClientRect().left === initial.left, 'Pinned tooltip still follows the mouse');
    assert(!pin.querySelector('.try2usd-converted'), 'Pinned content was scanned as page prices');

    const handle = pin.querySelector('.tooltip-title');
    const pointer = (target, type, x, y) => target.dispatchEvent(new win.PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
    pointer(handle, 'pointerdown', initial.left + 20, initial.top + 10);
    pointer(doc, 'pointermove', initial.left + 120, initial.top + 90);
    pointer(doc, 'pointerup', initial.left + 120, initial.top + 90);
    assert(Math.abs(pin.getBoundingClientRect().left - initial.left - 100) < 1, 'Window did not drag horizontally');
    assert(Math.abs(pin.getBoundingClientRect().top - initial.top - 80) < 1, 'Window did not drag vertically');
    const moved = pin.getBoundingClientRect();
    pointer(handle, 'pointerdown', moved.left + 20, moved.top + 10);
    pointer(doc, 'pointermove', 5000, 5000);
    pointer(doc, 'pointerup', 5000, 5000);
    let rect = pin.getBoundingClientRect();
    assert(rect.right <= win.innerWidth - 7 && rect.bottom <= win.innerHeight - 7, 'Window can be dragged off-screen');
    frame.style.width = '220px';
    await waitFor(() => {
      const resized = pin.getBoundingClientRect();
      return win.innerWidth === 220 && resized.left >= 7 && resized.right <= 213;
    });
    rect = pin.getBoundingClientRect();
    assert(rect.left >= 7 && rect.right <= 213, 'Window did not remain reachable after resize');
    pin.querySelector('.try2usd-pin-close').click();
    assert(!doc.querySelector('.try2usd-pinned-tooltip'), 'Red close button did not close the window');
  });

  await test('Moving within a price keeps the timer; leaving another price cancels it', async () => {
    const { doc, win } = await fixture('<span id="one" class="h1Anp"><span id="part">1.000</span> TL</span><span id="two" class="h1Anp">2.000 TL</span>', 'both_try_first', pinOptions);
    const one = doc.getElementById('one'), two = doc.getElementById('two');
    await waitFor(() => one.textContent.includes('$20.00') && two.textContent.includes('$40.00'));
    hover(win, one);
    await delay(1600);
    leave(win, one, doc.getElementById('part'));
    hover(win, doc.getElementById('part'));
    await waitFor(() => doc.querySelector('.try2usd-pinned-tooltip'), 2000);
    leave(win, one, two);
    hover(win, two);
    await delay(500);
    leave(win, two);
    await delay(2800);
    assert(doc.querySelectorAll('.try2usd-pinned-tooltip').length === 1, 'Leaving before three seconds still pinned the second price');
    assert(!doc.getElementById('try2usd-floating-tooltip').classList.contains('show'), 'Transient tooltip remained after leaving');
  });

  await test('Several pinned snapshots retain their currencies and close independently', async () => {
    const { doc, win, changeSettings } = await fixture('<span id="one" class="h1Anp">1.000 TL</span><span id="two" class="h1Anp">2.000 TL</span>', 'both_try_first', pinOptions);
    const one = doc.getElementById('one'), two = doc.getElementById('two');
    await waitFor(() => one.textContent.includes('$20.00'));
    hover(win, one);
    await waitFor(() => doc.querySelector('.try2usd-pinned-tooltip'), 5000);
    const first = doc.querySelector('.try2usd-pinned-tooltip');
    const firstText = first.textContent;
    leave(win, one);
    changeSettings({ targetCurrency: { newValue: 'EUR' } });
    await waitFor(() => two.textContent.includes('€30.00'));
    hover(win, two);
    await waitFor(() => doc.querySelectorAll('.try2usd-pinned-tooltip').length === 2, 5000);
    const second = [...doc.querySelectorAll('.try2usd-pinned-tooltip')].find(element => element !== first);
    assert(first.textContent === firstText && first.textContent.includes('USD Equivalent:'), 'Existing USD snapshot was relabeled as EUR');
    assert(second.textContent.includes('EUR Equivalent:') && second.textContent.includes('€30.00'), 'Second snapshot did not capture EUR');
    first.querySelector('button').click();
    assert(!first.isConnected && second.isConnected, 'Closing one snapshot closed another');
    changeSettings({ enabled: { newValue: false } });
    assert(!doc.querySelector('.try2usd-pinned-tooltip'), 'Disabling left pinned windows behind');
    assert(!doc.getElementById('try2usd-floating-tooltip').classList.contains('show'), 'Disabling left the hover tooltip visible');
  });

  await test('A changing chart point restarts the pin timer and captures the new date', async () => {
    const { doc, win } = await fixture('<div id="tooltip"><div id="point">43.877<span>,83 TL</span></div>' + date + '</div>', 'both_try_first', pinOptions);
    const tooltip = doc.getElementById('tooltip');
    await waitFor(() => tooltip.hasAttribute('data-try2usd-last-converted'));
    hover(win, tooltip);
    await delay(1600);
    doc.getElementById('point').innerHTML = '59.358<span>,04 TL</span>';
    doc.querySelector('.point-date').textContent = '01/09/2026';
    await waitFor(() => tooltip.dataset.date === '2026-09-01');
    tooltip.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 40, clientY: 30 }));
    await delay(1600);
    assert(!doc.querySelector('.try2usd-pinned-tooltip'), 'Pinned a point that was hovered for less than three seconds');
    await waitFor(() => doc.querySelector('.try2usd-pinned-tooltip'), 2500);
    const pin = doc.querySelector('.try2usd-pinned-tooltip');
    assert(pin.querySelector('.tooltip-date').textContent.includes('2026-09-01'), 'Pinned the old chart date');
    assert(pin.querySelector('.try2usd-tooltip-amount').textContent === usd(59358.04, historicalRate), 'Pinned the old chart amount');
    pin.focus();
    pin.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
    assert(!pin.isConnected, 'Escape did not close a focused pinned window');
  });

  await test('Immediate pin: Ctrl+Q pins once and leaves mouse clicks alone', async () => {
    const { win, doc } = await fixture('<a href="#product">199,99 TL</a><a id="other" href="#other">Other link</a>');
    await waitFor(() => doc.querySelector('.try2usd-converted'));
    const price = doc.querySelector('.try2usd-converted');
    const mouse = (target, type, button) => {
      const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, button, clientX: 40, clientY: 30 });
      target.dispatchEvent(event); return event;
    };
    assert(!mouse(price, 'mousedown', 0).defaultPrevented, 'Left click was swallowed');
    assert(!mouse(doc.getElementById('other'), 'mousedown', 1).defaultPrevented, 'Unrelated middle click swallowed');
    assert(!mouse(price, 'mousedown', 1).defaultPrevented, 'Middle-click was intercepted');
    assert(!mouse(price, 'auxclick', 1).defaultPrevented, 'Auxclick was intercepted');
    const key = () => {
      const event = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'q', code: 'KeyQ', ctrlKey: true });
      doc.body.dispatchEvent(event); return event;
    };
    assert(!key().defaultPrevented, 'Shortcut was intercepted without a hovered price');
    hover(win, price);
    assert(key().defaultPrevented, 'Default shortcut was not consumed');
    assert(doc.querySelectorAll('.try2usd-pinned-tooltip').length === 1, 'Ctrl+Q did not pin immediately');
    key();
    assert(doc.querySelectorAll('.try2usd-pinned-tooltip').length === 1, 'One hover created duplicate windows');
    await delay(3200);
    assert(doc.querySelectorAll('.try2usd-pinned-tooltip').length === 1, 'Old hover timer created another window');
  });

  await test('Immediate pin: configured keyboard shortcut respects modifiers and editing', async () => {
    const shortcut = { type: 'keyboard', code: 'KeyP', altKey: true, shiftKey: true };
    const { win, doc, changeSettings } = await fixture('<b>250 TL</b><input id="edit">', 'both_try_first', { pinShortcut: shortcut });
    await waitFor(() => doc.querySelector('.try2usd-converted'));
    const price = doc.querySelector('.try2usd-converted');
    hover(win, price);
    const key = (target, extra = {}) => {
      const event = new win.KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyP', key: 'P', altKey: true, shiftKey: true, ...extra });
      target.dispatchEvent(event); return event;
    };
    assert(!key(doc.body, { shiftKey: false }).defaultPrevented, 'Wrong modifiers matched');
    doc.getElementById('edit').focus();
    assert(!key(doc.getElementById('edit')).defaultPrevented, 'Shortcut intercepted input typing');
    doc.getElementById('edit').blur();
    assert(!key(doc.body, { repeat: true }).defaultPrevented, 'Key repeat was swallowed');
    const middle = new win.MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 1 });
    price.dispatchEvent(middle);
    assert(!middle.defaultPrevented, 'Old mouse shortcut remained active');
    assert(key(doc.body).defaultPrevented, 'Configured shortcut did not match');
    assert(doc.querySelectorAll('.try2usd-pinned-tooltip').length === 1, 'Keyboard did not pin immediately');
    changeSettings({ pinShortcut: { newValue: { type: 'middle' } } });
    price.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: doc.body }));
    assert(!key(doc.body).defaultPrevented, 'Keyboard shortcut remained active after changing setting');
    hover(win, price);
    doc.body.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, code: 'KeyQ', key: 'q', ctrlKey: true }));
    assert(doc.querySelectorAll('.try2usd-pinned-tooltip').length === 2, 'Legacy middle setting did not fall back to Ctrl+Q');
  });

  await test('Pin delay: saved and live settings control the timer without changing snapshots', async () => {
    const { win, doc, changeSettings } = await fixture('<b>250 TL</b>', 'both_try_first', { pinDelaySeconds: 0.5 });
    await waitFor(() => doc.querySelector('.try2usd-converted'));
    const price = doc.querySelector('.try2usd-converted');
    hover(win, price);
    await waitFor(() => doc.querySelector('.try2usd-pinned-tooltip'), 1200);
    price.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: doc.body }));
    changeSettings({ pinDelaySeconds: { newValue: 10 } });
    hover(win, price);
    await delay(650);
    assert(doc.querySelectorAll('.try2usd-pinned-tooltip').length === 1, 'New longer delay ignored');
    changeSettings({ pinDelaySeconds: { newValue: 0.5 } });
    await waitFor(() => doc.querySelectorAll('.try2usd-pinned-tooltip').length === 2, 1200);
    changeSettings({ pinDelaySeconds: { newValue: -1 } });
    price.dispatchEvent(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: doc.body }));
    hover(win, price);
    await delay(650);
    assert(doc.querySelectorAll('.try2usd-pinned-tooltip').length === 2, 'Invalid setting caused an immediate pin');
  });

  await test('Affiliate placeholder sits below the conversion card and moves and closes with it', async () => {
    const { win, doc, changeSettings } = await fixture('<b>250 TL</b>', 'both_try_first', { width: 640, height: 600, pinShortcut: { type: 'middle' } });
    await waitFor(() => doc.querySelector('.try2usd-converted'));
    hover(win, doc.querySelector('.try2usd-converted'));
    doc.body.dispatchEvent(new win.KeyboardEvent('keydown', { bubbles: true, code: 'KeyQ', key: 'q', ctrlKey: true }));
    const pin = doc.querySelector('.try2usd-pinned-tooltip');
    assert(pin, 'Legacy middle setting did not use Ctrl+Q');
    const affiliate = pin.querySelector('.try2usd-affiliate-placeholder');
    const conversion = pin.querySelector('.try2usd-conversion-card');
    const a = affiliate.getBoundingClientRect(), c = conversion.getBoundingClientRect();
    assert(a.top >= c.bottom + 7 && Math.abs(a.width - c.width) < 1, 'Affiliate card is not aligned beneath conversion');
    assert(a.height >= c.height * 0.7 && a.height <= c.height * 1.5, 'Affiliate card size does not match');
    assert(affiliate.textContent.includes('Coming soon') && !affiliate.querySelector('a, button, iframe'), 'Placeholder contains functional links or controls');
    const handle = pin.querySelector('.tooltip-title');
    handle.dispatchEvent(new win.PointerEvent('pointerdown', { bubbles: true, button: 0, pointerId: 9, clientX: 40, clientY: 30 }));
    doc.dispatchEvent(new win.PointerEvent('pointermove', { bubbles: true, pointerId: 9, clientX: 100, clientY: 90 }));
    doc.dispatchEvent(new win.PointerEvent('pointerup', { bubbles: true, pointerId: 9 }));
    assert(Math.abs(affiliate.getBoundingClientRect().top - a.top - 60) < 1, 'Affiliate card did not move with conversion');
    changeSettings({ enabled: { newValue: false } });
    assert(!affiliate.isConnected, 'Disabling left affiliate placeholder behind');
  });

  window.testResults = results;
  const failed = results.filter(result => !result.passed).length;
  document.getElementById('summary').textContent = `${results.length - failed}/${results.length} passed; ${failed} failed.`;
  document.title = failed ? `FAIL: ${failed} price regressions` : 'PASS: price regressions';
})();
