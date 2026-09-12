# amul-stock-cli

A terminal-only tool to check product availability on `shop.amul.com` for a given
pincode — **no Telegram bot, just run it from your terminal.**

## Why Puppeteer, and not plain HTTP requests

I initially tried talking to shop.amul.com's internal JSON API directly with
`axios` (no browser at all) — cookie jar, matching browser headers, the
works. It got as far as establishing a session cookie, then got a `401
Unauthorized` on every subsequent call.

The reason: shop.amul.com sits behind **Cloudflare Bot Management**, which
issues a `__cf_bm` cookie and fingerprints the TLS/HTTP handshake itself
(JA3/JA4). That fingerprint differs between Node's TLS stack and a real
browser's, and no amount of spoofed headers fixes that — the origin server
rejects the request as non-browser traffic even with a valid session cookie
attached.

So this tool drives a real headless Chrome via **Puppeteer** instead,
reproducing the same steps a person does by hand:

1. Load the product page (and load previously cached session cookies).
2. If no session is active, type the pincode into the location modal and click the result.
3. Query Amul's internal product REST API (`/api/1/entity/ms.products?q={"alias":"..."}&limit=1`)
   directly from inside the browser context — inheriting all session cookies and Cloudflare
   clearance — to get structured JSON (`name`, `price`, `available`, `inventory_quantity`).
4. Fall back to resilient DOM selectors if the internal API response is unavailable.

Puppeteer was chosen over Playwright because it only needs to drive a single
Chromium instance here — Playwright's default install pulls down Chromium +
Firefox + WebKit (much heavier) unless you explicitly restrict it to one
browser.

## Setup

```bash
cd amul-tracker
npm install
```

## Usage

One-off check:

```bash
node cli.js --url "https://shop.amul.com/en/product/amul-chocolate-whey-protein-34-g-or-pack-of-30-sachets" --pincode 302001
```

Continuous watch mode (checks every 90 seconds, sends a desktop notification
the moment it flips to in-stock):

```bash
node cli.js -u "https://shop.amul.com/en/product/amul-chocolate-whey-protein-34-g-or-pack-of-30-sachets" -p 302001 --watch --interval 90
```

Add `--debug` to see in-page console output if a run fails and you need to
diagnose why.

### Skipping the pincode modal (importing/persisting cookies)

Once a run successfully selects a pincode, the resulting session cookies are
auto-saved to `.amul-session-cookies.json` in this folder. Every later run
loads them back in before navigating — if Amul's server still recognizes
that session as having a region selected, the modal never appears at all.

You don't need to do anything for this after the first successful run. But
if you'd rather seed it from a pincode you already selected manually in your
own browser, export your cookies (e.g. with a "Cookie Editor"/"EditThisCookie"
browser extension) to a JSON file and run:

```bash
node cli.js -u "..." -p 302017 --import-cookies ./exported-cookies.json
```

That import only matters once — after that run succeeds, its own
auto-persisted cookies take over.

Session cookies aren't permanent (the `jsessionid` observed here lasted
about 7 days); once it expires, the tool just falls back to the normal
type-pincode → click-result flow and saves a fresh session again.

## Files

- `cli.js` — command-line entry point (argument parsing, printing, watch loop).
- `src/browserCheck.js` — the Puppeteer automation: opens the page, manages pincode
  selection, queries in-page REST API, and falls back to DOM selectors.
- `src/cookies.js` — cookie normalization, caching, and persistence between runs.
- `.amul-session-cookies.json` — auto-persisted session cookies from successful runs.

## If it stops working

Amul may change class names, selectors, or the modal's structure over time.
If checks start failing:

1. Run with `--debug` to see what's happening in the page.
2. Open the real product page in a visible (non-headless) browser and check
   whether the selectors in `src/browserCheck.js` (`#locationWidgetModal`,
   `.product-details`, `.add-to-cart`, etc.) still match the current markup.
3. Update the selectors accordingly.

## Notes

- No Telegram, no server, no persistent bot process — run it directly in a
  terminal, inside `tmux`/`screen` for long `--watch` sessions, or as a
  single-shot command from cron/a scheduled task.
- Desktop notifications use `node-notifier`, cross-platform (macOS/Linux/
  Windows), no bot token required.
- Each check launches and closes its own headless Chromium instance — this
  is slower than a pure-API approach would have been, but it's what's needed
  to get past Cloudflare's bot detection reliably.