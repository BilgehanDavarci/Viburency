# Chrome Web Store Listing: TRY Converter

## Store Listing Metadata

- **Name**: TRY Converter
- **Short Name**: TRY Converter
- **Version**: 1.0.0
- **Summary**: Automatically converts Turkish Lira (TRY/₺) prices to USD or EUR across the web, including accurate historical rates for price charts.
- **Category**: Shopping / Productivity
- **Default Language**: English

## Store Description

### Detailed Description
Tired of manually converting Turkish Lira prices when shopping online or analyzing price trends? 

TRY Converter automatically identifies Turkish Lira (TL / ₺ / TRY) prices on any website and seamlessly displays them in US Dollars or Euros. 

Unlike basic currency converters that only apply today's exchange rate to everything, this extension features **Smart Historical Date Detection**: when looking at a price history chart or historical price table (such as on Epey, Akakçe, or e-commerce price tracking tools), the extension automatically extracts the date of each recorded price and converts it using the exact official European Central Bank exchange rate on that specific day!

### Key Features:
- **Instant Live Conversion**: Converts all regular product prices across Turkish e-commerce and comparison websites using real-time exchange rates.
- **Accurate Historical Conversions**: Automatically links prices in price history graphs, charts, and tables with their respective recorded dates, fetching and applying historical rates back to 1999.
- **Multiple Display Modes**: Choose whether to replace the price directly, show USD or EUR alongside the original TL, or show TL with the selected currency in parentheses.
- **Detailed Hover Tooltip**: Hover over any converted price to inspect the original TL amount, converted USD or EUR amount, the date used, and the exact conversion rate.
- **Pinned Conversion Windows**: Hover to pin a conversion snapshot (three seconds by default, adjustable in the panel). Press Ctrl+Q while hovering to pin immediately, or choose your own keyboard shortcut. Drag its title bar to move it and use the red × to close it. Keep several windows open to compare prices. Each pinned conversion includes a matching affiliate placeholder card; affiliate links are not functional yet.
- **High Performance & Non-Intrusive**: Uses requestAnimationFrame batching and debounced DOM observers so websites load smoothly without lag.
- **Built-in Quick Calculator**: Open the extension popup to check current rates, test custom dates, or convert any amount on the fly.
- **Privacy First**: No tracking, no analytics, and no personal data collection.

---

## Permissions Justification

| Permission | Justification |
| :--- | :--- |
| `storage` | Required to save user preferences (display format, decimal precision, enabled/disabled state) and locally cache exchange rates to minimize network requests. |
| `alarms` | Required to periodically refresh the live exchange rate in the background once every hour without keeping the browser awake. |
| `host_permissions: https://api.frankfurter.app/*` | Required to fetch daily and historical TRY-to-USD and TRY-to-EUR exchange rates directly from the open European Central Bank data API. |

---

## Privacy & Data Use Disclosures
- **Single Purpose**: Automatically convert Turkish Lira currency amounts to US Dollars on web pages.
- **User Data Collection**: None. The extension does not collect, transmit, or store any personal data, browsing history, or user identity. All preferences and exchange rate caches remain local on the user's device.
- **Network Requests**: Only outbound requests to `https://api.frankfurter.app` to retrieve currency exchange rates.

---

## Version History
- **v1.2.0** (2026-10-20): Added three-second hover pinning, draggable conversion windows, red close buttons, and protection against converting the extension's own tooltip text.
- **v1.1.0** (2026-10-19): Renamed to TRY Converter; added USD/EUR selection, separate currency caches, and live/historical Euro conversion throughout the existing popup and page UI.
- **v1.0.0** (2026-10-04): Initial release with live conversion, contextual historical date detection for charts/tables, customizable display modes, and offline caching.

