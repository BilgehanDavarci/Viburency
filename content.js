// content.js - TRY Converter: live & historical USD/EUR conversion
// Compatible with all Turkish e-commerce platforms (Akakçe, Hepsiburada, Trendyol, Epey, Amazon, etc.)

(function () {
  'use strict';

  if (window.__try2usd_injected) return;
  window.__try2usd_injected = true;

  const DEFAULT_PIN_SHORTCUT = { type: 'keyboard', code: 'KeyQ', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
  let settings = {
    enabled: true,
    displayMode: 'replace', // 'replace' | 'both_usd_first' | 'both_try_first'
    decimals: 2,
    customRate: null,
    targetCurrency: 'USD',
    pinDelaySeconds: 3,
    pinShortcut: DEFAULT_PIN_SHORTCUT
  };

  let latestRateInfo = { rate: 0.02035, date: null };
  const ratesCache = new Map();
  const compoundPriceStates = new WeakMap();
  const chartPriceStates = new WeakMap();
  let conversionVersion = 0;
  let activeScanVersion = null;
  let isProcessing = false;
  let hasPendingScan = false;
  let tooltipEl = null;
  const OWN_TOOLTIP_SELECTOR = '#try2usd-floating-tooltip, .try2usd-pinned-tooltip';
  const CONVERTED_PRICE_SELECTOR = '.try2usd-converted, [data-try2usd-last-converted]';
  const pinnedTooltips = new Set();
  let hoveredPrice = null;
  let hoveredPriceKey = null;
  let hoverPinTimer = null;
  let hoverWasPinned = false;
  let hoverPosition = { clientX: 0, clientY: 0 };
  let pinnedDrag = null;

  // Turkish Month Dictionary
  const TR_MONTHS = {
    'ocak': '01', 'oca': '01',
    'şubat': '02', 'subat': '02', 'şub': '02', 'sub': '02',
    'mart': '03', 'mar': '03',
    'nisan': '04', 'nis': '04',
    'mayıs': '05', 'mayis': '05', 'may': '05',
    'haziran': '06', 'haz': '06',
    'temmuz': '07', 'tem': '07',
    'ağustos': '08', 'agustos': '08', 'ağu': '08', 'agu': '08',
    'eylül': '09', 'eylul': '09', 'eyl': '09',
    'ekim': '10', 'eki': '10',
    'kasım': '11', 'kasim': '11', 'kas': '11',
    'aralık': '12', 'aralik': '12', 'ara': '12'
  };

  const MONTH_NAMES_REGEX = Object.keys(TR_MONTHS).join('|');

  // Universal Turkish Price Regex
  // Matches: 38.999,00 TL | 1.700.000 TL | 8 500 000 TL | 5.097 TL | 999 TL | ₺ 1.499 | 1.499 ₺
  const NUM_PATTERN = '(?:[0-9]{1,3}(?:[.\\s\u00a0][0-9]{3})+(?:,[0-9]{1,2})?|[0-9]{1,3}(?:\\.[0-9]{3})*(?:,[0-9]{1,2})?|[0-9]+(?:,[0-9]{1,2})?|[0-9]{1,3}(?:,[0-9]{3})*(?:\\.[0-9]{1,2})?|[0-9]+(?:\\.[0-9]{1,2})?)';
  const CURR_PATTERN = '(?:(?:TL|tl|TRY)\\b|₺)';
  // Recommendation widgets can wrap their currency in invisible bidi marks.
  const BIDI_MARKS = '[\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*';
  const PRICE_GAP = '[\\s\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]*';

  const PRICE_SUFFIX_REGEX = new RegExp(`${BIDI_MARKS}(${NUM_PATTERN})${PRICE_GAP}${CURR_PATTERN}${BIDI_MARKS}`, 'g');
  const PRICE_PREFIX_REGEX = new RegExp(`${BIDI_MARKS}${CURR_PATTERN}${PRICE_GAP}(${NUM_PATTERN})${BIDI_MARKS}`, 'gi');

  // Single price matcher (without global flag for testing/matching single strings)
  const SINGLE_PRICE_SUFFIX_REGEX = new RegExp(PRICE_SUFFIX_REGEX.source, 'i');
  const SINGLE_PRICE_PREFIX_REGEX = new RegExp(PRICE_PREFIX_REGEX.source, 'i');

  // Initialize extension
  async function init() {
    createFloatingTooltip();

    const stored = await chrome.storage.local.get(['enabled', 'displayMode', 'decimals', 'customRate', 'targetCurrency', 'pinDelaySeconds', 'pinShortcut']);
    if (typeof stored.enabled !== 'undefined') settings.enabled = stored.enabled;
    if (stored.displayMode) settings.displayMode = stored.displayMode;
    if (typeof stored.decimals !== 'undefined') settings.decimals = stored.decimals;
    if (stored.customRate) settings.customRate = stored.customRate;
    settings.targetCurrency = stored.targetCurrency === 'EUR' ? 'EUR' : 'USD';
    settings.pinDelaySeconds = normalizePinDelay(stored.pinDelaySeconds);
    settings.pinShortcut = normalizePinShortcut(stored.pinShortcut);
    if (settings.targetCurrency === 'EUR') latestRateInfo = { rate: 0, date: null };

    // Receive currency changes even while the initial rate request is pending.
    setupEventListeners();
    setupMutationObserver();
    await updateLatestRate();

    if (settings.enabled) {
      scheduleScan();
      scanChartTooltips();
    }

  }

  // Update latest exchange rate from background
  async function updateLatestRate() {
    const currency = settings.targetCurrency;
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_LATEST_RATE', currency });
      if (response && response.success && response.data) {
        if (currency !== settings.targetCurrency) return;
        latestRateInfo = response.data;
        if (latestRateInfo.rate > 0) {
          ratesCache.set(`${currency}:latest`, latestRateInfo.rate);
          if (latestRateInfo.date) ratesCache.set(`${currency}:${latestRateInfo.date}`, latestRateInfo.rate);
        }
      }
    } catch (err) {
      console.warn('[TRY2USD] Could not get latest rate from background:', err);
    }
  }

  // Request historical rate from background
  async function getRateForDate(dateStr) {
    const currency = settings.targetCurrency;
    // The pre-existing customRate setting is a TRY/USD override.
    if (currency === 'USD' && settings.customRate && typeof settings.customRate === 'number' && settings.customRate > 0) {
      return settings.customRate;
    }

    if (!dateStr || dateStr === 'latest') {
      return latestRateInfo.rate || (currency === 'USD' ? 0.02035 : 0);
    }

    const cacheKey = `${currency}:${dateStr}`;
    if (ratesCache.has(cacheKey)) {
      return ratesCache.get(cacheKey);
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_HISTORICAL_RATE',
        currency,
        date: dateStr
      });
      if (response && response.success && response.data && typeof response.data.rate === 'number') {
        if (response.data.rate > 0) ratesCache.set(cacheKey, response.data.rate);
        return response.data.rate;
      }
    } catch (err) {
      console.warn(`[TRY2USD] Failed to fetch rate for ${dateStr}:`, err);
    }

    return currency === settings.targetCurrency ? (latestRateInfo.rate || (currency === 'USD' ? 0.02035 : 0)) : 0;
  }

  // Universal Turkish Price Parser
  function parseAnyPriceNumber(str) {
    if (!str) return null;
    let s = str.trim().replace(/[\s\u00a0]+/g, '');
    if (s.includes('.') && s.includes(',')) {
      if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
        // Turkish format: 38.999,00 or 1.199,95
        s = s.replace(/\./g, '').replace(',', '.');
      } else {
        // US format: 1,199.95
        s = s.replace(/,/g, '');
      }
    } else if (s.includes(',')) {
      // Comma decimal: 149,90 or 9,9
      s = s.replace(',', '.');
    } else if (s.includes('.')) {
      const parts = s.split('.');
      if (parts.length > 2) {
        s = s.replace(/\./g, '');
      } else if (parts[1].length === 3) {
        // Thousands separator: 38.999 or 5.097
        s = s.replace(/\./g, '');
      } else {
        // Decimal with dot: 150.50
      }
    }
    const val = parseFloat(s);
    return isNaN(val) ? null : val;
  }

  // Internal DOM hooks stay compatible with existing installations.
  function formatCurrency(amount, decimals = 2) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: settings.targetCurrency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(amount);
  }

  // Format replacement string based on displayMode
  function formatReplacement(originalTRYText, usdValue, displayMode, decimals) {
    const formattedUSD = formatCurrency(usdValue, decimals);
    switch (displayMode) {
      case 'both_usd_first':
        return `${formattedUSD} (${originalTRYText.trim()})`;
      case 'both_try_first':
        return `${originalTRYText.trim()} (${formattedUSD})`;
      case 'replace':
      default:
        return formattedUSD;
    }
  }

  // Extract date string from text
  function parseDateString(text) {
    if (!text || typeof text !== 'string') return null;
    const clean = text.toLowerCase().trim();

    // 1. DD.MM.YYYY or DD/MM/YYYY or DD-MM-YYYY
    const dmyMatch = clean.match(/\b([0-3]?[0-9])[./\-]([0-1]?[0-9])[./\-]((?:19|20)\d{2})\b/);
    if (dmyMatch) {
      const day = dmyMatch[1].padStart(2, '0');
      const month = dmyMatch[2].padStart(2, '0');
      const year = dmyMatch[3];
      return `${year}-${month}-${day}`;
    }

    // 2. YYYY-MM-DD
    const ymdMatch = clean.match(/\b((?:19|20)\d{2})[./\-]([0-1]?[0-9])[./\-]([0-3]?[0-9])\b/);
    if (ymdMatch) {
      return `${ymdMatch[1]}-${ymdMatch[2].padStart(2, '0')}-${ymdMatch[3].padStart(2, '0')}`;
    }

    // 3. DD Month YYYY (e.g. 15 Mart 2024)
    const textDateRegex = new RegExp(`\\b([0-3]?[0-9])\\s+(${MONTH_NAMES_REGEX})\\.?\\s+((?:19|20)\\d{2})\\b`, 'i');
    const textMatch = clean.match(textDateRegex);
    if (textMatch) {
      const day = textMatch[1].padStart(2, '0');
      const month = TR_MONTHS[textMatch[2].toLowerCase()];
      const year = textMatch[3];
      if (month) return `${year}-${month}-${day}`;
    }

    // 4. Month YYYY (e.g. Mart 2024)
    const monthYearRegex = new RegExp(`\\b(${MONTH_NAMES_REGEX})\\.?\\s+((?:19|20)\\d{2})\\b`, 'i');
    const myMatch = clean.match(monthYearRegex);
    if (myMatch) {
      const month = TR_MONTHS[myMatch[1].toLowerCase()];
      const year = myMatch[2];
      if (month) return `${year}-${month}-15`;
    }

    // 5. DD.MM.YY (e.g. 15.03.24)
    const shortYearMatch = clean.match(/\b([0-3]?[0-9])[./\-]([0-1]?[0-9])[./\-](\d{2})\b/);
    if (shortYearMatch) {
      const day = shortYearMatch[1].padStart(2, '0');
      const month = shortYearMatch[2].padStart(2, '0');
      const year = `20${shortYearMatch[3]}`;
      return `${year}-${month}-${day}`;
    }

    return null;
  }

  // Check if an element is inside an explicit price history chart or table
  function isExplicitPriceHistoryContainer(el) {
    if (!el || !(el instanceof Element)) return false;

    // Dynamic chart tooltips
    if (isInsideChartTooltip(el)) return true;

    // Canvas / SVG charts / Highcharts containers
    if (el.closest('canvas, svg, .highcharts-container, .apexcharts-canvas, [class*="chart"], [class*="graph"], [id*="chart"], [id*="graph"], [id*="grafik"], [class*="grafik"]')) {
      return true;
    }

    // Explicit price history tables / sections (Epey, Akakçe, Sahibinden index)
    const historyContainer = el.closest(
      '[class*="price-history"], [id*="price-history"], [class*="price_history"], [id*="price_history"], ' +
      '[class*="fiyat-gecmis"], [id*="fiyat-gecmis"], [class*="fiyat_gecmis"], [id*="fiyat_gecmis"], ' +
      '[class*="fiyat-degisim"], [id*="fiyat-degisim"], [class*="price-change"], [id*="price-change"], ' +
      '[class*="tarihce"], [id*="tarihce"], [class*="endeks"], [id*="endeks"]'
    );
    if (historyContainer) return true;

    return false;
  }

  // Check if an element is in an active marketplace listing or classifieds context
  // (where prices are active asking prices and must strictly use today's live rate)
  function isListingOrClassifiedContext(el) {
    if (!el || !(el instanceof Element)) return false;

    // Domain check for classifieds and real estate/vehicle portals
    const host = window.location.hostname.toLowerCase();
    const listingDomains = [
      'sahibinden.com', 'hepsiemlak.com', 'emlakjet.com', 'arabam.com',
      'letgo.com', 'dolap.com', 'gardrops.com', 'zingat.com', 'tapu.com'
    ];
    if (listingDomains.some(d => host.endsWith(d))) {
      // If NOT inside an explicit price history modal/chart, it's an active listing!
      if (!isExplicitPriceHistoryContainer(el)) {
        return true;
      }
    }

    // DOM classes for listings, search results, and product cards
    if (el.closest(
      '[class*="searchResults"], [class*="classified"], [class*="listing"], [class*="search-result"], ' +
      '[class*="product-card"], [class*="productCard"], [class*="ilan"], [id*="searchResults"]'
    )) {
      if (!isExplicitPriceHistoryContainer(el)) {
        return true;
      }
    }

    return false;
  }

  // Filter out car model/trim identifiers like "Renault 12 TL", "Acura 3.2 TL"
  function isVehicleModelOrNonPrice(text, matchIndex, matchFullText, matchNumStr, parentElement) {
    const tryVal = parseAnyPriceNumber(matchNumStr);
    if (tryVal === null) return true;

    // Small numbers (<= 50) ending with "TL" are frequently vehicle models or trims
    if (tryVal <= 50) {
      // 1. If followed by a unit metric (e.g. / tablet, / lt, / adet, / kg, / m²), it is definitely a unit price, NOT a vehicle model!
      const textAfter = text.substring(matchIndex + matchFullText.length);
      if (/^\s*\/?\s*(?:tablet|tb|tbl|kapsül|kapsul|saşe|sase|adet|ad|adt|parça|parca|tane|lt|l|litre|ml|cl|dl|kg|kilo|gr?|gram|mg|m²|m2|m|mt|metre|metrekare|rulo|yıkama|yikama|porsiyon|öğün|ogun|paket|pkt|kutu|şişe|sise|çift|cift|bardak|gün|gun|ay|yıl|yil|doz)\b/i.test(textAfter)) {
        return false;
      }

      // 2. If located inside a price-specific or unit-price DOM container, it is a price, NOT a vehicle model
      if (parentElement && parentElement.closest('[class*="price"], [class*="Price"], [class*="prc"], [class*="fiyat"], [class*="Fiyat"], [class*="unit"]')) {
        return false;
      }

      const textBefore = text.substring(0, matchIndex).trim();
      // Preceding brand names (e.g. Renault 12 TL, Acura 3.2 TL)
      if (/(?:renault|acura|toros|broadway|fairway|spring|r\s*12|r\s*9|seat|honda)\b/i.test(textBefore)) {
        return true;
      }
      // Check parent/anchor context
      if (parentElement) {
        const fullContext = (parentElement.getAttribute('title') || parentElement.textContent || '').trim();
        if (/(?:renault|acura|toros|broadway|fairway|spring|r\s*12|r\s*9)\b/i.test(fullContext)) {
          return true;
        }
        // In classified titles or headings (Sahibinden, etc.), tiny numbers < 20 are model specs, not prices
        const isClassifiedTitle = parentElement.closest('h1, h2, h3, h4, [class*="classifiedTitle"], [class*="searchResultsTitle"], .classifiedTitle, [class*="classified"] a');
        if (isClassifiedTitle && tryVal < 20 && !textBefore.toLowerCase().includes('fiyat') && !textBefore.toLowerCase().includes('ücret')) {
          return true;
        }
      }
    }

    return false;
  }

  // Find associated contextual date for a price element
  function findContextualDate(element, inlineText) {
    if (!element || !(element instanceof Element)) {
      if (inlineText) return parseDateString(inlineText);
      return null;
    }

    // 1. In active marketplace listings and classifieds (Sahibinden, Hepsiemlak, etc.),
    // prices are active asking prices and must ALWAYS use today's live rate.
    // Publication / listing dates (İlan Tarihi) must NEVER be used as exchange rate dates.
    if (isListingOrClassifiedContext(element)) {
      return null;
    }

    // 2. Only search for historical dates if explicitly inside a price history chart or table
    if (isExplicitPriceHistoryContainer(element)) {
      if (inlineText) {
        const d = parseDateString(inlineText);
        if (d) return d;
      }

      const elText = element.textContent || '';
      const dFromEl = parseDateString(elText);
      if (dFromEl) return dFromEl;

      let curr = element;
      for (let depth = 0; depth < 5 && curr && curr !== document.body; depth++) {
        const attrDate = curr.getAttribute('data-date') ||
                         curr.getAttribute('data-time') ||
                         curr.getAttribute('data-timestamp') ||
                         curr.getAttribute('datetime');
        if (attrDate) {
          if (/^\d{10,13}$/.test(attrDate)) {
            const ts = parseInt(attrDate, 10);
            const dateObj = new Date(ts > 1e11 ? ts : ts * 1000);
            if (!isNaN(dateObj.getTime())) {
              return dateObj.toISOString().split('T')[0];
            }
          }
          const parsed = parseDateString(attrDate);
          if (parsed) return parsed;
        }

        // Check chart tooltips
        if (isInsideChartTooltip(curr)) {
          const tooltipDate = parseDateString(curr.textContent);
          if (tooltipDate) return tooltipDate;
        }

        // Check table row (<tr>) siblings inside price history tables
        if (curr.tagName === 'TR') {
          for (const cell of curr.children) {
            if (cell !== element && !cell.contains(element)) {
              const rowDate = parseDateString(cell.textContent);
              if (rowDate) return rowDate;
            }
          }
        }

        curr = curr.parentElement;
      }
    }

    // 3. For any other element, do not infer dates from arbitrary siblings or ancestors
    return null;
  }

  // Check if an element or any of its ancestors is a dynamic chart tooltip
  function isOwnTooltipNode(node) {
    const element = node instanceof Element ? node : node?.parentElement;
    return !!element?.closest(OWN_TOOLTIP_SELECTOR);
  }

  function isInsideChartTooltip(el) {
    if (!el) return false;
    const elem = el instanceof Element ? el : el.parentElement;
    if (!elem || !(elem instanceof Element)) return false;
    // A form control named "id" can shadow HTMLFormElement.id with an element.
    // Read the attribute so inspecting any text node cannot abort the scan.
    const id = elem.getAttribute('id') || '';
    if (id === 'try2usd-floating-tooltip') return false;

    if (id === 'tooltip') return true;
    if (elem.closest && elem.closest('#tooltip, .highcharts-tooltip, .apexcharts-tooltip, .chartjs-tooltip, g.highcharts-tooltip, .chart-tooltip, .graph-tooltip, [class*="chart"][class*="tooltip"], [class*="graph"][class*="tooltip"]')) {
      return true;
    }

    const cls = elem.getAttribute ? (elem.getAttribute('class') || '') : '';
    const isTooltipLike = id.toLowerCase().includes('tooltip') ||
                          cls.toLowerCase().includes('tooltip') ||
                          (elem.getAttribute && elem.getAttribute('role') === 'tooltip');

    if (isTooltipLike) {
      if (elem.closest && elem.closest('canvas, svg, .highcharts-container, .apexcharts-canvas, [class*="chart"], [class*="graph"], [id*="chart"], [id*="graph"], [class*="canvas"], [id*="canvas"], .canvas_v8_w')) {
        return true;
      }
    }

    return false;
  }

  // Helper to extract all price occurrences in a text string
  function extractAllPricesFromText(text, parentElement) {
    if (!text) return [];
    const results = [];

    const suffixRegex = new RegExp(PRICE_SUFFIX_REGEX);
    let m;
    while ((m = suffixRegex.exec(text)) !== null) {
      // Must not be preceded by a comma or period (which means it's just the kuruş part of a split price)
      if (m.index > 0 && /[.,]\s*$/.test(text.substring(0, m.index))) {
        continue;
      }
      if (!isVehicleModelOrNonPrice(text, m.index, m[0], m[1], parentElement)) {
        results.push({ fullText: m[0], numStr: m[1], index: m.index });
      }
    }

    const prefixRegex = new RegExp(PRICE_PREFIX_REGEX);
    while ((m = prefixRegex.exec(text)) !== null) {
      if (m.index > 0 && /[.,]\s*$/.test(text.substring(0, m.index))) {
        continue;
      }
      if (!isVehicleModelOrNonPrice(text, m.index, m[0], m[1], parentElement)) {
        if (!results.some(r => Math.abs(r.index - m.index) < 2)) {
          results.push({ fullText: m[0], numStr: m[1], index: m.index });
        }
      }
    }

    return results;
  }

  // Check if an element is a safe, single compound/split price container (Akakçe pt_v8, Hepsiburada finalPrice, etc.)
  function isSafeCompoundPriceContainer(el) {
    if (!el || !(el instanceof Element)) return false;
    if (isOwnTooltipNode(el)) return false;
    if (isInsideChartTooltip(el)) return false;
    if (el.classList.contains('try2usd-converted') || el.closest('.try2usd-converted')) return false;
    if (el.isContentEditable) return false;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'BUTTON', 'FORM'].includes(el.tagName)) return false;
    if (el.querySelector('button, input, select, textarea, form')) return false;
    if (el.querySelector('.try2usd-converted')) return false;

    // Never flatten containers that hold screen-reader accessible text alongside visual text
    if (el.querySelector('[class*="srOnly"], [class*="sr-only"], [class*="visually-hidden"], [class*="a-offscreen"]')) {
      return false;
    }

    const text = el.textContent.trim().replace(/\s+/g, ' ');
    if (text.length === 0 || text.length > 70) return false;

    // Disqualify if it starts with a comma/dot followed by digits (it is an orphaned decimal/kuruş fraction)
    if (/^(?:TL|tl|TRY|₺)?\s*[.,]\s*[0-9]/i.test(text)) {
      return false;
    }

    // Must contain Turkish currency indicator
    if (!text.includes('TL') && !text.includes('tl') && !text.includes('₺') && !text.includes('TRY')) {
      return false;
    }

    // 1. MUST NOT contain discount percentages (e.g. %50, -%20, % 15)
    // If it contains a discount badge, it is a multi-item container, NOT a single split price
    if (/(?:^|\s)%-?\s*\d+/.test(text) || /-\s*%\s*\d+/.test(text)) {
      return false;
    }

    // 2. MUST contain EXACTLY ONE price
    const priceMatches = extractAllPricesFromText(text, el);
    if (priceMatches.length !== 1) {
      return false;
    }

    // If the matched single price is preceded by a comma or period in the container, it is only a fraction
    if (priceMatches[0].index > 0 && /[.,]\s*$/.test(text.substring(0, priceMatches[0].index))) {
      return false;
    }

    // 3. Permit a short basket-price label as well as punctuation/unit metrics.
    const singlePrice = priceMatches[0].fullText;
    const remainder = text.replace(singlePrice, '').trim();

    const hasLogo = !!el.querySelector('b.v_v8, [class*="seller-logo"], [class*="merchant-logo"], [class*="store-logo"], [class*="logo"]');
    if (!hasLogo && remainder.length > 2) {
      // Check if remainder is a unit metric (e.g. "(/ tablet)", "(/ lt)", "/ adet", "/ kg", etc.)
      const cleanRemainder = remainder.replace(/[()[\],:;*]/g, '').trim();
      const isUnitPriceRemainder = /^\/?\s*(?:tablet|tb|tbl|kapsül|kapsul|saşe|sase|adet|ad|adt|parça|parca|tane|lt|l|litre|ml|cl|dl|kg|kilo|gr?|gram|mg|m²|m2|m|mt|metre|metrekare|rulo|yıkama|yikama|porsiyon|öğün|ogun|paket|pkt|kutu|şişe|sise|çift|cift|bardak|gün|gun|ay|yıl|yil|doz)\b/i.test(cleanRemainder);
      const isBasketPriceLabel = /^(?:sepette|sepete özel|sepetteki fiyat)$/i.test(cleanRemainder);
      if (!isUnitPriceRemainder && !isBasketPriceLabel) {
        // Other promotional copy can identify a container holding several items.
        return false;
      }
    }

    // 4. Must NOT have multiple child elements that represent distinct prices or discount badges
    // Structural sub-elements (currency symbols, kuruş/decimal fractions, integer spans) are part of the SAME price.
    const distinctPriceChildren = Array.from(el.querySelectorAll(
      '[class*="price"], [class*="Price"], [class*="fiyat"], [class*="Fiyat"], del, ins, [class*="discount"], [class*="indirim"], [class*="badge"], [class*="label"], [class*="Label"]'
    )).filter(child => {
      const cText = child.textContent.trim();
      const cls = (child.className || '').toString().toLowerCase();

      // Discount percentages or badges are distinct entities
      if (/%\s*\d+|\d+\s*%/.test(cText) || cls.includes('discount') || cls.includes('indirim') || cls.includes('badge')) {
        return true;
      }

      // Explicit strike-through or original price indicators
      if (['DEL', 'S', 'STRIKE'].includes(child.tagName) || cls.includes('old') || cls.includes('eski') || cls.includes('first')) {
        return true;
      }

      // Pure currency symbol without digits (e.g. "TL", "₺") is a sub-part, not a separate price
      if (!/\d/.test(cText)) {
        return false;
      }

      // Pure decimal/kuruş fraction (e.g. ",59", ".59", "59") is a sub-part of the same price
      if (/^[.,]?\s*\d{1,2}$/.test(cText)) {
        return false;
      }

      // Structural sub-parts identified by class (decimal, fraction, kurus, integer, currency, etc.)
      if (/decimal|fraction|kurus|kuruş|cent|penny|integer|currency|symbol|virgul|tam/i.test(cls)) {
        return false;
      }

      return true;
    });

    if (distinctPriceChildren.length > 1) {
      return false;
    }

    return true;
  }

  // Convert a compound price container (Akakçe pt_v8, Hepsiburada finalPrice, Trendyol prc-dsc, etc.)
  async function processCompoundPriceElement(el) {
    if (isInsideChartTooltip(el)) return false;
    if (!isSafeCompoundPriceContainer(el)) return false;

    const rawText = el.textContent;
    const fullText = rawText.trim().replace(/\s+/g, ' ');
    if (!fullText.includes('TL') && !fullText.includes('tl') && !fullText.includes('₺') && !fullText.includes('TRY')) {
      return false;
    }

    const match = fullText.match(SINGLE_PRICE_SUFFIX_REGEX) || fullText.match(SINGLE_PRICE_PREFIX_REGEX);
    if (!match) return false;
    if (isVehicleModelOrNonPrice(fullText, match.index, match[0], match[1], el)) return false;

    const tryVal = parseAnyPriceNumber(match[1]);
    if (tryVal === null || tryVal <= 0) return false;

    const associatedDate = findContextualDate(el, fullText);
    const version = conversionVersion;
    const rate = await getRateForDate(associatedDate);
    if (version !== conversionVersion || !settings.enabled || !(rate > 0)) return false;
    const usdVal = tryVal * rate;

    // A site may redraw while a historical rate is being fetched.
    if (el.textContent !== rawText || el.closest('.try2usd-converted')) return false;
    const snapshot = getPriceTextSnapshot(el, false);
    const rawMatch = snapshot.text.match(SINGLE_PRICE_SUFFIX_REGEX) || snapshot.text.match(SINGLE_PRICE_PREFIX_REGEX);
    if (!rawMatch) return false;
    const state = {
      segments: snapshot.segments,
      match: { index: rawMatch.index, fullText: rawMatch[0] },
      originals: snapshot.segments.map(segment => ({ node: segment.node, value: segment.node.nodeValue }))
    };
    compoundPriceStates.set(el, state);

    el.setAttribute('data-original-html', el.innerHTML);
    el.setAttribute('data-original-text', fullText);
    el.setAttribute('data-try-value', tryVal);
    el.setAttribute('data-usd-value', usdVal.toFixed(2));
    el.setAttribute('data-rate', rate);
    el.setAttribute('data-date', associatedDate || 'Live');
    el.classList.add('try2usd-converted');

    // Keep labels, seller logos, responsive classes and framework-owned nodes.
    renderCompoundPrice(state, usdVal);

    return true;
  }

  // Kitapyurdu carousels draw the lira glyph through .TL::before, leaving
  // textContent with only the number. Require that explicit icon in a price
  // value, and a complete numeric value, before treating bare text as TRY.
  async function processIconPriceElement(el) {
    if (!el || el.closest('.try2usd-converted') || el.isContentEditable) return false;
    const icons = Array.from(el.querySelectorAll(':scope > span.TL:empty'));
    if (icons.length !== 1) return false;
    const rawText = el.textContent;
    const numberMatch = rawText.match(new RegExp(`^\\s*(${NUM_PATTERN})\\s*$`));
    if (!numberMatch) return false;
    const tryVal = parseAnyPriceNumber(numberMatch[1]);
    if (tryVal === null || tryVal <= 0) return false;

    const associatedDate = findContextualDate(el, rawText);
    const version = conversionVersion;
    const rate = await getRateForDate(associatedDate);
    if (version !== conversionVersion || !settings.enabled || !(rate > 0)) return false;
    if (el.textContent !== rawText || el.closest('.try2usd-converted') || !el.contains(icons[0])) return false;
    const usdVal = tryVal * rate;
    const snapshot = getPriceTextSnapshot(el, false);
    const originalPriceText = `₺ ${numberMatch[1]}`;
    const state = {
      segments: snapshot.segments,
      match: { index: rawText.indexOf(numberMatch[1]), fullText: numberMatch[1] },
      originals: snapshot.segments.map(segment => ({ node: segment.node, value: segment.node.nodeValue })),
      originalPriceText,
      currencyIcons: icons
    };
    compoundPriceStates.set(el, state);
    el.setAttribute('data-original-html', el.innerHTML);
    el.setAttribute('data-original-text', originalPriceText);
    el.setAttribute('data-try-value', tryVal);
    el.setAttribute('data-usd-value', usdVal.toFixed(2));
    el.setAttribute('data-rate', rate);
    el.setAttribute('data-date', associatedDate || 'Live');
    el.classList.add('try2usd-converted');
    // The replacement includes its own currency; suppress the CSS-only glyph.
    for (const icon of icons) icon.classList.add('try2usd-currency-icon-hidden');
    renderCompoundPrice(state, usdVal);
    return true;
  }

  // Find the most appropriate compound/split price container for a given node or element
  function findBestCompoundContainer(node) {
    if (!node) return null;
    const parent = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (!parent) return null;

    const candidates = [];
    let curr = parent;
    for (let depth = 0; depth < 4 && curr && curr !== document.body; depth++) {
      if (curr.classList.contains('try2usd-converted') || curr.closest('.try2usd-converted')) {
        return null;
      }
      if (isSafeCompoundPriceContainer(curr)) {
        const text = curr.textContent.trim().replace(/\s+/g, ' ');
        const matches = extractAllPricesFromText(text, curr);
        if (matches.length === 1) {
          const val = parseAnyPriceNumber(matches[0].numStr);
          if (val !== null && val > 0) {
            candidates.push({ el: curr, val, text, depth });
          }
        }
      }
      curr = curr.parentElement;
    }

    if (candidates.length === 0) return null;

    // Prefer larger complete price over partial fractions (e.g. 16.070,60 TL over 60 TL).
    // If values are equal, prefer innermost specific element (smaller depth) to preserve outer icons/layout.
    candidates.sort((a, b) => {
      if (b.val !== a.val) return b.val - a.val;
      return a.depth - b.depth;
    });

    return candidates[0];
  }

  // Convert an inline text node
  async function processTextNode(node) {
    if (!node || node.nodeType !== Node.TEXT_NODE) return;
    const parent = node.parentElement;
    if (!parent) return;
    if (isOwnTooltipNode(parent)) return;

    if (isInsideChartTooltip(parent)) return;
    if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CODE', 'PRE'].includes(parent.tagName)) return;
    if (parent.closest('.try2usd-converted') || parent.isContentEditable) return;

    const text = node.nodeValue;
    if (!text || (!text.includes('TL') && !text.includes('tl') && !text.includes('₺') && !text.includes('TRY'))) {
      return;
    }

    // 1. CRITICAL CHECK: Does this text node belong to a split/compound parent price element?
    // (e.g. Cimri where span has "16.070" and child span has ",60 TL", Akakçe pt_v8, Hepsiburada finalPrice, etc.)
    const bestCompound = findBestCompoundContainer(node);
    if (bestCompound) {
      await processCompoundPriceElement(bestCompound.el);
      return;
    }

    // 2. Reject kuruş fractions starting with comma/dot if not resolved above
    if (/^[.,]\s*[0-9]/.test(text.trim())) {
      return;
    }

    // 3. Match standalone occurrences in this text node
    const matches = [];
    let match;

    const regexSuffix = new RegExp(PRICE_SUFFIX_REGEX);
    while ((match = regexSuffix.exec(text)) !== null) {
      if (!isVehicleModelOrNonPrice(text, match.index, match[0], match[1], parent)) {
        matches.push({ fullText: match[0], numStr: match[1], index: match.index });
      }
    }

    const regexPrefix = new RegExp(PRICE_PREFIX_REGEX);
    while ((match = regexPrefix.exec(text)) !== null) {
      if (!isVehicleModelOrNonPrice(text, match.index, match[0], match[1], parent)) {
        matches.push({ fullText: match[0], numStr: match[1], index: match.index });
      }
    }

    if (matches.length === 0) return;

    matches.sort((a, b) => a.index - b.index);

    const associatedDate = findContextualDate(parent, text);
    const version = conversionVersion;
    const rate = await getRateForDate(associatedDate);
    if (version !== conversionVersion || !settings.enabled || !(rate > 0)) return;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;

    for (const m of matches) {
      if (m.index < lastIndex) continue;

      if (m.index > lastIndex) {
        fragment.appendChild(document.createTextNode(text.substring(lastIndex, m.index)));
      }

      const tryVal = parseAnyPriceNumber(m.numStr);
      if (tryVal !== null && tryVal > 0) {
        const usdVal = tryVal * rate;
        const displayText = formatReplacement(m.fullText, usdVal, settings.displayMode, settings.decimals);

        const span = document.createElement('span');
        span.className = 'try2usd-converted';
        span.setAttribute('data-original-text', m.fullText);
        span.setAttribute('data-try-value', tryVal);
        span.setAttribute('data-usd-value', usdVal.toFixed(2));
        span.setAttribute('data-rate', rate);
        span.setAttribute('data-date', associatedDate || 'Live');
        span.textContent = displayText;

        fragment.appendChild(span);
      } else {
        fragment.appendChild(document.createTextNode(m.fullText));
      }

      lastIndex = m.index + m.fullText.length;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.substring(lastIndex)));
    }

    if (node.parentNode) {
      node.parentNode.replaceChild(fragment, node);
    }
  }

  // Process SVG text elements in charts (axis labels, standalone text)
  async function processSvgTextElement(svgTextEl) {
    if (!svgTextEl || svgTextEl.classList.contains('try2usd-converted')) return;
    if (svgTextEl.closest('.try2usd-converted') || svgTextEl.querySelector('.try2usd-converted')) return;
    if (isInsideChartTooltip(svgTextEl)) return; // Handled by dedicated chart tooltip engine

    const text = svgTextEl.textContent;
    if (!text || (!text.includes('TL') && !text.includes('tl') && !text.includes('₺') && !text.includes('TRY'))) {
      return;
    }

    const match = text.match(SINGLE_PRICE_SUFFIX_REGEX) || text.match(SINGLE_PRICE_PREFIX_REGEX);
    if (!match) return;

    const tryVal = parseAnyPriceNumber(match[1]);
    if (!tryVal) return;

    const associatedDate = findContextualDate(svgTextEl, text);
    const version = conversionVersion;
    const rate = await getRateForDate(associatedDate);
    if (version !== conversionVersion || !settings.enabled || !(rate > 0)) return;
    const usdVal = tryVal * rate;

    const snapshot = getPriceTextSnapshot(svgTextEl, false);
    const rawMatch = snapshot.text.match(SINGLE_PRICE_SUFFIX_REGEX) || snapshot.text.match(SINGLE_PRICE_PREFIX_REGEX);
    if (!rawMatch) return;
    const state = {
      segments: snapshot.segments,
      match: { index: rawMatch.index, fullText: rawMatch[0] },
      originals: snapshot.segments.map(segment => ({ node: segment.node, value: segment.node.nodeValue }))
    };
    compoundPriceStates.set(svgTextEl, state);
    svgTextEl.setAttribute('data-original-text', text);
    svgTextEl.setAttribute('data-try-value', tryVal);
    svgTextEl.setAttribute('data-usd-value', usdVal.toFixed(2));
    svgTextEl.setAttribute('data-rate', rate);
    svgTextEl.setAttribute('data-date', associatedDate || 'Live');
    svgTextEl.classList.add('try2usd-converted');

    renderCompoundPrice(state, usdVal);
  }

  // --- DEDICATED REAL-TIME CHART TOOLTIP ENGINE ---
  const CHART_TOOLTIP_SELECTORS = [
    '#tooltip',
    '.highcharts-tooltip',
    '.apexcharts-tooltip',
    '.chartjs-tooltip',
    'g.highcharts-tooltip',
    '.chart-tooltip',
    '.graph-tooltip',
    '[role="tooltip"]',
    '[class*="chart"][class*="tooltip"]',
    '[class*="graph"][class*="tooltip"]',
    '.canvas_v8_w #tooltip',
    'svg g[class*="tooltip"]',
    'svg text[class*="tooltip"]'
  ].join(', ');

  // Build one price string across inline spans/tspans while keeping offsets into
  // the original text nodes. Separate chart rows so dates/series cannot become
  // part of a neighboring price when textContent omits their visual line break.
  function getPriceTextSnapshot(root, separateRows = true) {
    let text = '';
    const segments = [];
    const rowTags = new Set(['br', 'div', 'p', 'li', 'tr', 'td', 'th', 'text']);
    const separateRow = () => {
      if (!separateRows) return;
      // A nonnumeric barrier also prevents the whitespace thousands pattern
      // from joining numbers on separate rows. It is never written to the DOM.
      if (text && !text.endsWith('\uFFFC')) text += '\uFFFC';
    };

    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const value = node.nodeValue || '';
        // Some charts put the date in an inline sibling immediately after TL.
        if (/(?:\bTL|\bTRY|₺)$/i.test(text) && /^\d/.test(value)) separateRow();
        segments.push({ node, start: text.length, end: text.length + value.length });
        text += value;
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const isRow = node !== root && rowTags.has(node.localName);
      if (isRow) separateRow();
      for (const child of node.childNodes) visit(child);
      if (isRow) separateRow();
    }

    visit(root);
    return { text, segments };
  }

  // Replace only the matched characters, retaining price/date elements and the
  // text nodes a chart may reuse on the next hover. Apply matches right to left
  // so offsets remain valid when several prices share a text node.
  function replacePriceText(segments, match, replacement, markerClass = null) {
    const start = match.index;
    const end = start + match.fullText.length;
    let inserted = false;
    for (const segment of segments) {
      if (segment.end <= start || segment.start >= end) continue;
      const from = Math.max(0, start - segment.start);
      const to = Math.min(segment.end, end) - segment.start;
      const value = segment.node.nodeValue;
      segment.node.nodeValue = value.slice(0, from) + (inserted ? '' : replacement) + value.slice(to);
      inserted = true;
      if (markerClass) segment.node.parentElement?.classList.add(markerClass);
    }
  }

  function renderCompoundPrice(state, usdVal) {
    for (const original of state.originals) original.node.nodeValue = original.value;
    const replacement = formatReplacement(state.originalPriceText || state.match.fullText, usdVal, settings.displayMode, settings.decimals);
    replacePriceText(state.segments, state.match, replacement);
  }

  // Process a dynamic chart tooltip element safely and repeatedly on every hovered point
  async function processChartTooltip(tooltipEl) {
    if (!tooltipEl || tooltipEl.id === 'try2usd-floating-tooltip') return;
    if (isOwnTooltipNode(tooltipEl)) return;

    const currentRaw = (tooltipEl.textContent || '').trim().replace(/\s+/g, ' ');
    if (!currentRaw) return;

    // Must contain Turkish currency indicator
    if (!currentRaw.includes('TL') && !currentRaw.includes('tl') &&
        !currentRaw.includes('₺') && !currentRaw.includes('TRY')) {
      return;
    }

    // Skip if already converted for this exact text content
    const lastConverted = tooltipEl.getAttribute('data-try2usd-last-converted');
    if (lastConverted && lastConverted === currentRaw) return;

    // Skip if currently waiting for a rate fetch for this exact raw text
    const pendingRaw = tooltipEl.getAttribute('data-try2usd-pending-raw');
    if (pendingRaw && pendingRaw === currentRaw) return;

    // Extract point date (from tooltip text, data attributes, or container)
    const pointText = getPriceTextSnapshot(tooltipEl).text;
    const dateStr = parseDateString(pointText) || findContextualDate(tooltipEl, pointText);

    tooltipEl.setAttribute('data-try2usd-pending-raw', currentRaw);

    const version = conversionVersion;
    const rate = await getRateForDate(dateStr);
    if (version !== conversionVersion || !settings.enabled) return;
    if (!(rate > 0)) {
      tooltipEl.removeAttribute('data-try2usd-pending-raw');
      return;
    }

    // If the user already scrubbed to another point while waiting, abandon this obsolete point
    const nowRaw = (tooltipEl.textContent || '').trim().replace(/\s+/g, ' ');
    if (nowRaw !== currentRaw) {
      if (tooltipEl.getAttribute('data-try2usd-pending-raw') === currentRaw) {
        tooltipEl.removeAttribute('data-try2usd-pending-raw');
      }
      return;
    }

    // Re-read nodes after the fetch: a chart can redraw the same point while
    // the request is pending. Match the whole price before editing any node;
    // a currency-bearing node can contain only the kuruş fragment.
    const snapshot = getPriceTextSnapshot(tooltipEl);
    const matches = [];
    for (const match of extractAllPricesFromText(snapshot.text, tooltipEl)
      .sort((a, b) => a.index - b.index || b.fullText.length - a.fullText.length)) {
      const previous = matches[matches.length - 1];
      if (!previous || previous.index + previous.fullText.length <= match.index) matches.push(match);
    }

    const originals = snapshot.segments.map(segment => ({ node: segment.node, value: segment.node.nodeValue }));
    let convertedAny = false;
    let lastUsdVal = null;
    for (const match of matches.reverse()) {
      const tryVal = parseAnyPriceNumber(match.numStr);
      if (tryVal === null || tryVal <= 0) continue;
      const usdVal = tryVal * rate;
      lastUsdVal = usdVal;
      const replacement = formatReplacement(match.fullText, usdVal, settings.displayMode, settings.decimals);
      replacePriceText(snapshot.segments, match, replacement, 'try2usd-chart-converted');
      convertedAny = true;
    }

    tooltipEl.removeAttribute('data-try2usd-pending-raw');

    if (convertedAny) {
      chartPriceStates.set(tooltipEl, originals);
      const convertedText = (tooltipEl.textContent || '').trim().replace(/\s+/g, ' ');
      tooltipEl.setAttribute('data-try2usd-last-converted', convertedText);
      tooltipEl.setAttribute('data-try2usd-last-raw', currentRaw);
      tooltipEl.setAttribute('data-original-text', currentRaw);
      tooltipEl.setAttribute('data-date', dateStr || 'Live');
      tooltipEl.setAttribute('data-rate', rate);
      if (lastUsdVal !== null) {
        tooltipEl.setAttribute('data-usd-value', lastUsdVal.toFixed(2));
      }
    }
  }

  // Scan all visible chart tooltips in sub-millisecond time
  async function scanChartTooltips() {
    if (!settings.enabled) return;
    try {
      const candidates = document.querySelectorAll(CHART_TOOLTIP_SELECTORS);
      for (const el of candidates) {
        if (!el || el.id === 'try2usd-floating-tooltip') continue;
        if (el.style && el.style.display === 'none') continue;
        if (el.getAttribute && (el.getAttribute('visibility') === 'hidden' || el.getAttribute('display') === 'none')) continue;
        await processChartTooltip(el);
      }
    } catch (err) {
      console.warn('[TRY2USD] Chart tooltip scan warning:', err);
    }
  }

  // Prefetch dates on chart axes and labels when cursor hovers near chart
  let lastPrefetchedContainer = null;
  async function prefetchChartDates(chartContainer) {
    if (!chartContainer || chartContainer === lastPrefetchedContainer) return;
    lastPrefetchedContainer = chartContainer;
    const currency = settings.targetCurrency;

    const datesFound = [];
    const walker = document.createTreeWalker(chartContainer, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue;
      if (v && /\d/.test(v)) {
        const d = parseDateString(v);
        if (d && !ratesCache.has(`${currency}:${d}`)) {
          datesFound.push(d);
        }
      }
    }

    const uniqueDates = Array.from(new Set(datesFound)).slice(0, 40);
    if (uniqueDates.length > 0) {
      try {
        const resp = await chrome.runtime.sendMessage({
          type: 'BATCH_GET_RATES',
          currency,
          dates: uniqueDates
        });
        if (resp && resp.success && resp.data) {
          for (const [d, r] of Object.entries(resp.data)) {
            if (r > 0) ratesCache.set(`${currency}:${d}`, r);
          }
        }
      } catch (e) {
        // silent
      }
    }
  }

  function restoreChartTooltip(el) {
    const current = (el.textContent || '').trim().replace(/\s+/g, ' ');
    // A chart may already have redrawn a different point; keep its new content.
    if (current === el.getAttribute('data-try2usd-last-converted')) {
      for (const original of chartPriceStates.get(el) || []) {
        if (el.contains(original.node)) original.node.nodeValue = original.value;
      }
    }
    chartPriceStates.delete(el);
    el.removeAttribute('data-try2usd-last-raw');
    el.removeAttribute('data-try2usd-last-converted');
    el.removeAttribute('data-try2usd-pending-raw');
  }

  // Revert all converted elements
  function revertAll() {
    const elements = document.querySelectorAll('.try2usd-converted');
    for (const el of elements) {
      const state = compoundPriceStates.get(el);
      if (state) {
        for (const original of state.originals) original.node.nodeValue = original.value;
        for (const icon of state.currencyIcons || []) icon.classList.remove('try2usd-currency-icon-hidden');
        compoundPriceStates.delete(el);
        el.classList.remove('try2usd-converted');
        continue;
      }
      const origHtml = el.getAttribute('data-original-html');
      const origText = el.getAttribute('data-original-text');

      if (origHtml) {
        el.innerHTML = origHtml;
        el.classList.remove('try2usd-converted');
      } else if (origText) {
        if (el.tagName === 'SPAN') {
          const textNode = document.createTextNode(origText);
          el.parentNode.replaceChild(textNode, el);
        } else {
          el.textContent = origText;
          el.classList.remove('try2usd-converted');
        }
      }
    }

    const chartTooltips = document.querySelectorAll('[data-try2usd-last-raw]');
    for (const ct of chartTooltips) {
      restoreChartTooltip(ct);
    }
    for (const pending of document.querySelectorAll('[data-try2usd-pending-raw]')) {
      pending.removeAttribute('data-try2usd-pending-raw');
    }
  }

  // Refresh display format of already converted elements
  function refreshConvertedElements() {
    const elements = document.querySelectorAll('.try2usd-converted');
    for (const el of elements) {
      const orig = el.getAttribute('data-original-text');
      const usdVal = parseFloat(el.getAttribute('data-usd-value'));
      if (orig && !isNaN(usdVal)) {
        const state = compoundPriceStates.get(el);
        if (state) renderCompoundPrice(state, usdVal);
        else el.textContent = formatReplacement(orig, usdVal, settings.displayMode, settings.decimals);
      }
    }

    const chartTooltips = document.querySelectorAll('[data-try2usd-last-raw]');
    for (const ct of chartTooltips) {
      restoreChartTooltip(ct);
    }
    scanChartTooltips();
  }

  // Main scan execution
  async function scanDocument() {
    if (!settings.enabled) return;
    const scanVersion = conversionVersion;
    if (isProcessing && activeScanVersion === scanVersion) {
      hasPendingScan = true;
      return;
    }
    isProcessing = true;
    activeScanVersion = scanVersion;
    hasPendingScan = false;

    try {
      // Process active chart tooltips first
      await scanChartTooltips();
      if (scanVersion !== conversionVersion) return;

      // CSS-only currency icons never reach the text-node currency filter.
      for (const icon of document.querySelectorAll('.price .value > span.TL:empty')) {
        if (scanVersion !== conversionVersion) return;
        await processIconPriceElement(icon.parentElement);
      }

      // Pass 1: Target leaf compound / split-price DOM structures (Akakçe pt_v8, Hepsiburada finalPrice, Trendyol prc-dsc, PttAVM, etc.)
      const splitPriceSelectors = [
        '.pt_v8',
        '.pr_v8',
        '.fy_v8',
        '[class*="finalPrice"]',
        '[class*="prc-dsc"]',
        '[class*="prc-org"]',
        '[class*="a-price-whole"]',
        '[class*="compactSpecialPrice"]',
        '[class*="compactOriginalPrice"]',
        '[class*="compactPriceLine"]',
        '[class*="unit-price"]',
        '[class*="unitPrice"]',
        '[class*="unit_price"]',
        '[class*="prc-box-unit"]',
        '[class*="prc-unit"]',
        '[class*="price-unit"]',
        'span[class*="h1Anp"]',
        'span[class*="zOmX7"]',
        'span[class*="K0cO0"]',
        'span.cell.price'
      ].join(', ');

      const candidateElements = document.querySelectorAll(splitPriceSelectors);
      for (const el of candidateElements) {
        if (scanVersion !== conversionVersion) return;
        if (!isInsideChartTooltip(el) && isSafeCompoundPriceContainer(el)) {
          await processCompoundPriceElement(el);
        }
      }

      // Pass 2: TreeWalker across all text nodes (excluding chart tooltips)
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode: function (node) {
            if (isOwnTooltipNode(node)) return NodeFilter.FILTER_SKIP;
            if (isInsideChartTooltip(node.parentElement)) {
              return NodeFilter.FILTER_SKIP;
            }
            const val = node.nodeValue;
            if (val && (val.includes('TL') || val.includes('tl') || val.includes('₺') || val.includes('TRY'))) {
              return NodeFilter.FILTER_ACCEPT;
            }
            return NodeFilter.FILTER_SKIP;
          }
        }
      );

      const textNodes = [];
      let current;
      while ((current = walker.nextNode())) {
        textNodes.push(current);
      }

      const BATCH = 35;
      for (let i = 0; i < textNodes.length; i += BATCH) {
        if (scanVersion !== conversionVersion) return;
        const batch = textNodes.slice(i, i + BATCH);
        await new Promise((resolve) => {
          requestAnimationFrame(async () => {
            for (const node of batch) {
              if (scanVersion !== conversionVersion) break;
              await processTextNode(node);
            }
            resolve();
          });
        });
      }

      // Pass 3: SVG Chart text elements (Highcharts, Epey, Akakçe, etc.)
      const svgTexts = document.querySelectorAll('svg text');
      for (const svgText of svgTexts) {
        if (scanVersion !== conversionVersion) return;
        if (!isInsideChartTooltip(svgText)) {
          await processSvgTextElement(svgText);
        }
      }
    } catch (err) {
      console.warn('[TRY2USD] Scan warning:', err);
    } finally {
      if (activeScanVersion === scanVersion) {
        isProcessing = false;
        if (hasPendingScan) {
          hasPendingScan = false;
          scheduleScan();
        }
      }
    }
  }

  let scanDebounceTimer = null;
  function scheduleScan() {
    clearTimeout(scanDebounceTimer);
    scanDebounceTimer = setTimeout(() => {
      scanDocument();
    }, 120);
  }

  // Floating and pinned conversion tooltips share the same price snapshot.
  function createFloatingTooltip() {
    if (tooltipEl) return;
    tooltipEl = document.createElement('div');
    tooltipEl.id = 'try2usd-floating-tooltip';
    tooltipEl.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltipEl);
  }

  function tooltipPriceKey(target) {
    return JSON.stringify([
      target.getAttribute('data-original-text'), target.getAttribute('data-usd-value'),
      target.getAttribute('data-rate'), target.getAttribute('data-date'),
      settings.targetCurrency, settings.decimals
    ]);
  }

  function showTooltip(target, event) {
    if (!tooltipEl || !target || !settings.enabled || isOwnTooltipNode(target)) return;
    hoverPosition = { clientX: event.clientX, clientY: event.clientY };
    const key = tooltipPriceKey(target);
    if (hoveredPrice === target && hoveredPriceKey === key) {
      if (!hoverWasPinned) positionTooltip(hoverPosition);
      return;
    }
    hideTooltip();
    hoveredPrice = target;
    hoveredPriceKey = key;
    const original = target.getAttribute('data-original-text') || target.textContent;
    const amount = Number(target.getAttribute('data-usd-value') || '0');
    const rate = Number(target.getAttribute('data-rate') || '0');
    const date = target.getAttribute('data-date') || 'Live';
    tooltipEl.innerHTML = `
      <div class="tooltip-title"><span></span></div>
      <div class="tooltip-row"><span>Original Price:</span><strong class="try2usd-tooltip-original" style="color:#f1f5f9;"></strong></div>
      <div class="tooltip-row"><span class="try2usd-tooltip-currency"></span><strong class="try2usd-tooltip-amount" style="color:#34d399;"></strong></div>
      <div class="tooltip-row"><span>Rate Date:</span><span class="tooltip-date"></span></div>
      <div class="tooltip-row" style="font-size:11px;opacity:0.8;margin-top:4px;"><span>Exchange Rate:</span><span class="try2usd-tooltip-rate"></span></div>
    `;
    tooltipEl.querySelector('.tooltip-title span').textContent = `💱 TRY → ${settings.targetCurrency} Conversion`;
    tooltipEl.querySelector('.try2usd-tooltip-original').textContent = original;
    tooltipEl.querySelector('.try2usd-tooltip-currency').textContent = `${settings.targetCurrency} Equivalent:`;
    tooltipEl.querySelector('.try2usd-tooltip-amount').textContent = formatCurrency(amount, settings.decimals);
    tooltipEl.querySelector('.tooltip-date').textContent = date === 'Live' ? '🟢 Today (Live Rate)' : '📅 ' + date;
    tooltipEl.querySelector('.try2usd-tooltip-rate').textContent = `1 ${settings.targetCurrency} ≈ ${rate > 0 ? (1 / rate).toFixed(2) : '-'} TL`;
    tooltipEl.classList.add('show');
    positionTooltip(event);
    hoverPinTimer = setTimeout(() => {
      hoverPinTimer = null;
      if (hoveredPrice !== target || !settings.enabled || !target.isConnected || document.hidden) {
        hideTooltip();
        return;
      }
      // A reused chart node can represent a different price or date mid-hover.
      if (tooltipPriceKey(target) !== key) {
        showTooltip(target, hoverPosition);
        return;
      }
      pinTooltip();
    }, settings.pinDelaySeconds * 1000);
  }

  function placeTooltipWindow(element, x, y) {
    const margin = 8;
    const maxX = Math.max(margin, window.innerWidth - element.offsetWidth - margin);
    const maxY = Math.max(margin, window.innerHeight - element.offsetHeight - margin);
    element.style.left = `${Math.max(margin, Math.min(x, maxX))}px`;
    element.style.top = `${Math.max(margin, Math.min(y, maxY))}px`;
  }

  function positionTooltip(event) {
    if (tooltipEl) placeTooltipWindow(tooltipEl, event.clientX + 14, event.clientY + 14);
  }

  function hideTooltip() {
    clearTimeout(hoverPinTimer);
    hoverPinTimer = null;
    hoveredPrice = null;
    hoveredPriceKey = null;
    hoverWasPinned = false;
    tooltipEl?.classList.remove('show');
  }

  function stopPinnedDrag() {
    if (!pinnedDrag) return;
    const { element, handle, pointerId } = pinnedDrag;
    pinnedDrag = null;
    element.classList.remove('try2usd-dragging');
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
  }

  function closePinnedTooltip(element) {
    if (pinnedDrag?.element === element) stopPinnedDrag();
    pinnedTooltips.delete(element);
    element.remove();
  }

  function pinTooltip() {
    clearTimeout(hoverPinTimer);
    hoverPinTimer = null;
    if (!tooltipEl?.classList.contains('show') || hoverWasPinned) return;
    const element = tooltipEl.cloneNode(true);
    element.removeAttribute('id');
    element.className = 'try2usd-pinned-tooltip';
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-label', `Pinned TRY to ${settings.targetCurrency} conversion`);
    element.tabIndex = -1;
    const conversionCard = document.createElement('div');
    conversionCard.className = 'try2usd-conversion-card';
    conversionCard.append(...element.childNodes);
    const affiliateCard = document.createElement('section');
    affiliateCard.className = 'try2usd-affiliate-placeholder';
    affiliateCard.setAttribute('aria-label', 'Affiliate links placeholder');
    affiliateCard.innerHTML = '<div class="try2usd-affiliate-title">Affiliate links</div><div class="try2usd-affiliate-empty">Partner offers will appear here.</div><span class="try2usd-affiliate-status">Coming soon</span>';
    element.append(conversionCard, affiliateCard);
    const handle = element.querySelector('.tooltip-title');
    handle.querySelector('span').textContent = `📌 TRY → ${settings.targetCurrency} Conversion`;
    handle.title = 'Drag to move';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'try2usd-pin-close';
    close.textContent = '×';
    close.title = 'Close pinned conversion';
    close.setAttribute('aria-label', 'Close pinned conversion');
    close.addEventListener('click', event => {
      event.stopPropagation();
      closePinnedTooltip(element);
    });
    handle.appendChild(close);
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      event.preventDefault();
      event.stopPropagation();
      hideTooltip();
      stopPinnedDrag();
      // The last pinned window in the DOM is on top.
      document.body.appendChild(element);
      const rect = element.getBoundingClientRect();
      pinnedDrag = { element, handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
      element.classList.add('try2usd-dragging');
      try { handle.setPointerCapture(event.pointerId); } catch (_) { /* Synthetic events have no active pointer capture. */ }
    });
    handle.addEventListener('lostpointercapture', () => {
      if (pinnedDrag?.element === element) stopPinnedDrag();
    });
    element.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        closePinnedTooltip(element);
      }
    });
    document.body.appendChild(element);
    pinnedTooltips.add(element);
    placeTooltipWindow(element, parseFloat(tooltipEl.style.left), parseFloat(tooltipEl.style.top));
    hoverWasPinned = true;
    tooltipEl.classList.remove('show');
  }

  function convertedPriceAt(target) {
    if (!(target instanceof Element) || isOwnTooltipNode(target)) return null;
    return target.closest(CONVERTED_PRICE_SELECTOR);
  }

  function clearPinnedTooltips() {
    for (const element of pinnedTooltips) closePinnedTooltip(element);
  }

  // Event Listeners
  function normalizePinDelay(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0.5 && value <= 60 ? value : 3;
  }

  function normalizePinShortcut(value) {
    return value?.type === 'keyboard' && typeof value.code === 'string' && value.code &&
      (value.ctrlKey || value.altKey || value.shiftKey || value.metaKey)
      ? value : DEFAULT_PIN_SHORTCUT;
  }

  function isEditing(target) {
    return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
  }

  function setupEventListeners() {
    document.addEventListener('keydown', event => {
      const shortcut = settings.pinShortcut;
      if (!settings.enabled || shortcut.type !== 'keyboard' || event.repeat || event.isComposing ||
          isEditing(event.target) || isEditing(document.activeElement) || isOwnTooltipNode(event.target) ||
          !hoveredPrice?.isConnected || hoverWasPinned || event.code !== shortcut.code ||
          ['ctrlKey', 'altKey', 'shiftKey', 'metaKey'].some(key => event[key] !== !!shortcut[key])) return;
      event.preventDefault();
      event.stopPropagation();
      showTooltip(hoveredPrice, hoverPosition);
      pinTooltip();
    }, true);
    document.addEventListener('mouseover', event => {
      const converted = convertedPriceAt(event.target);
      if (converted) showTooltip(converted, event);
    }, { passive: true });
    document.addEventListener('mousemove', event => {
      // Charts can replace their children without a new mouseover on the root.
      const converted = convertedPriceAt(event.target);
      if (converted) showTooltip(converted, event);
      else if (hoveredPrice) hideTooltip();
    }, { passive: true });
    document.addEventListener('mouseout', event => {
      if (!hoveredPrice || convertedPriceAt(event.target) !== hoveredPrice) return;
      if (event.relatedTarget instanceof Node && hoveredPrice.contains(event.relatedTarget)) return;
      hideTooltip();
    }, { passive: true });
    document.addEventListener('pointermove', event => {
      if (!pinnedDrag || event.pointerId !== pinnedDrag.pointerId) return;
      const drag = pinnedDrag;
      placeTooltipWindow(drag.element, drag.left + event.clientX - drag.x, drag.top + event.clientY - drag.y);
    }, { passive: true });
    document.addEventListener('pointerup', event => {
      if (event.pointerId === pinnedDrag?.pointerId) stopPinnedDrag();
    }, { passive: true });
    document.addEventListener('pointercancel', event => {
      if (event.pointerId === pinnedDrag?.pointerId) stopPinnedDrag();
    }, { passive: true });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hideTooltip(); stopPinnedDrag(); }
    });
    window.addEventListener('blur', () => { hideTooltip(); stopPinnedDrag(); });
    window.addEventListener('resize', () => {
      hideTooltip();
      stopPinnedDrag();
      for (const element of pinnedTooltips) placeTooltipWindow(element, parseFloat(element.style.left), parseFloat(element.style.top));
    });

    // Real-time chart scrubbing: canvas, svg, chart containers
    let lastChartScanTime = 0;
    let chartScanTimer = null;
    function handleChartMovement(e) {
      if (!settings.enabled) return;
      const target = e.target;
      if (!target || !(target instanceof Element)) return;
      if (isOwnTooltipNode(target)) return;

      const chartContainer = target.closest(
        'canvas, svg, .highcharts-container, .apexcharts-canvas, [class*="chart"], [class*="graph"], [id*="chart"], [id*="graph"], [id*="grafik"], [class*="grafik"], .canvas_v8_w, .highcharts-tooltip, .apexcharts-tooltip, [class*="tooltip"], #tooltip'
      );

      if (chartContainer) {
        prefetchChartDates(chartContainer);

        const now = Date.now();
        if (now - lastChartScanTime > 20) {
          lastChartScanTime = now;
          scanChartTooltips();
        }

        clearTimeout(chartScanTimer);
        chartScanTimer = setTimeout(() => {
          scanChartTooltips();
        }, 35);
      }
    }

    document.addEventListener('mousemove', handleChartMovement, { passive: true });
    document.addEventListener('touchmove', handleChartMovement, { passive: true });
    document.addEventListener('pointermove', handleChartMovement, { passive: true });

    // Infinite scroll & dynamic lazy loads
    window.addEventListener('scroll', () => {
      hideTooltip();
      scheduleScan();
    }, { passive: true });

    // Storage listener
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area === 'local') {
        let needsRevert = false;
        let needsRefresh = false;
        let needsRescan = false;

        if (changes.pinDelaySeconds || changes.pinShortcut) {
          if (changes.pinDelaySeconds) settings.pinDelaySeconds = normalizePinDelay(changes.pinDelaySeconds.newValue);
          if (changes.pinShortcut) settings.pinShortcut = normalizePinShortcut(changes.pinShortcut.newValue);
          // Restart a pending hover using the new delay, keeping existing snapshots.
          if (hoveredPrice && !hoverWasPinned) {
            const target = hoveredPrice;
            hideTooltip();
            showTooltip(target, hoverPosition);
          }
        }

        if (changes.enabled) {
          settings.enabled = changes.enabled.newValue;
          if (!settings.enabled) {
            conversionVersion++;
            needsRevert = true;
          }
          else needsRescan = true;
        }

        if (changes.displayMode) {
          settings.displayMode = changes.displayMode.newValue;
          needsRefresh = true;
        }

        if (changes.decimals) {
          settings.decimals = changes.decimals.newValue;
          needsRefresh = true;
        }

        if (changes.customRate) {
          settings.customRate = changes.customRate.newValue;
          needsRescan = true;
        }

        if (changes.targetCurrency) {
          settings.targetCurrency = changes.targetCurrency.newValue === 'EUR' ? 'EUR' : 'USD';
          const version = ++conversionVersion;
          latestRateInfo = { rate: 0, date: null };
          lastPrefetchedContainer = null;
          hideTooltip();
          revertAll();
          await updateLatestRate();
          if (version !== conversionVersion) return;
          needsRefresh = false;
          needsRescan = true;
        }

        if (needsRevert) {
          hideTooltip();
          clearPinnedTooltips();
          revertAll();
        } else if (needsRefresh) {
          refreshConvertedElements();
        } else if (needsRescan) {
          scheduleScan();
          scanChartTooltips();
        }
      }
    });
  }

  // MutationObserver for dynamic SPAs, charts, and content changes
  function setupMutationObserver() {
    const observer = new MutationObserver((mutations) => {
      if (!settings.enabled) return;
      let shouldScanDoc = false;
      let hasChartMutation = false;

      for (const m of mutations) {
        const target = m.target;
        if (isOwnTooltipNode(target)) continue;
        if (target && (isInsideChartTooltip(target) || (target.nodeType === Node.TEXT_NODE && isInsideChartTooltip(target.parentElement)))) {
          hasChartMutation = true;
          break;
        }
        if (m.addedNodes.length > 0 || m.type === 'characterData') {
          shouldScanDoc = true;
        }
      }

      if (hasChartMutation) {
        // Immediate, instant conversion for chart tooltips (0ms delay!)
        scanChartTooltips();
      }

      if (shouldScanDoc) {
        scheduleScan();
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
