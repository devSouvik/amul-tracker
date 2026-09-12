const puppeteer = require('puppeteer');
const { loadCachedCookies, saveCookies } = require('./cookies');

/**
 * Checks live stock for one shop.amul.com product URL + pincode by driving a
 * real headless Chrome instance.
 *
 * Why a real browser and not plain HTTP requests:
 * shop.amul.com sits behind Cloudflare Bot Management. That system issues a
 * `__cf_bm` cookie and fingerprints the TLS/HTTP handshake itself (JA3/JA4),
 * which differs between Node's TLS stack and a real browser's - no set of
 * spoofed headers fixes that mismatch. Requests from a plain HTTP client get
 * a 401 "Unauthorized" straight from the origin even with valid session
 * cookies attached. A real Chrome (via Puppeteer) presents a genuine
 * fingerprint, so the same pincode-select + stock-check flow that works in
 * a normal browser tab works here too.
 *
 * Session reuse: Amul ties your selected pincode/region to the `jsessionid`
 * cookie server-side. Once we've selected a pincode successfully, we persist
 * the resulting cookies to disk; subsequent calls load them back in before
 * navigating, so the modal doesn't reappear until that session actually
 * expires (observed ~7 days for jsessionid).
 */
/**
 * Pull the trailing slug out of a full shop.amul.com product URL.
 */
function extractAliasFromUrl(urlOrAlias) {
  try {
    const u = new URL(urlOrAlias);
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1];
  } catch {
    return urlOrAlias;
  }
}

async function checkStock(productUrl, pincode, { debug = false, seedCookies = null } = {}) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
    );

    if (debug) page.on('console', (msg) => console.error(`[page] ${msg.text()}`));

    // Prefer an explicitly supplied one-time import; otherwise fall back to
    // whatever we auto-saved from a previous successful run.
    const cookiesToLoad = seedCookies || loadCachedCookies();
    if (cookiesToLoad && cookiesToLoad.length) {
      // setCookie requires the page to have a document for the target
      // domain first, or you can pass fully-qualified cookies with `domain`
      // set (which we have from the export) and call it before navigation.
      await page.setCookie(...cookiesToLoad);
      if (debug) console.error(`[debug] pre-loaded ${cookiesToLoad.length} cookie(s) before navigation`);
    }

    await page.goto(productUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    if (debug) console.error(`[debug] page loaded: ${page.url()}`);

    // The pincode modal only appears if no region is selected yet for this
    // browser session. If a valid session cookie was loaded above, this will
    // be false and we skip straight to reading stock.
    // We check that the modal is *actually shown* (Bootstrap adds .show + display:block),
    // not just present in the DOM (the modal markup is always rendered by Vue).
    const modalPresent = await page
      .waitForFunction(
        () => {
          const m = document.querySelector('#locationWidgetModal');
          if (!m) return false;
          const style = window.getComputedStyle(m);
          return m.classList.contains('show') || style.display === 'block';
        },
        { timeout: 8000 }
      )
      .then(() => true)
      .catch(() => false);
    if (debug) console.error(`[debug] pincode modal present: ${modalPresent}`);

    if (modalPresent) {
      // Focus the input first so it's interactive
      await page.click('#locationWidgetModal input#search');

      // Set the value and fire both `input` + `keyup` events that Vue 3 watchers
      // listen to. page.type() alone sometimes fails to trigger the async
      // pincode-lookup in headless mode because the synthetic keyboard events
      // may not propagate through Vue's reactivity system reliably.
      await page.evaluate((pc) => {
        const el = document.querySelector('#locationWidgetModal input#search');
        if (!el) return;
        el.value = pc;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: pc[pc.length - 1], inputType: 'insertText' }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: pc[pc.length - 1] }));
      }, pincode);

      // The dropdown first renders a transient status line (e.g. "not
      // serviceable" or "showing result for..."), then - after a short async
      // lookup - the actual selectable result appears as an
      // `<a class="searchitem-name">` inside a `.list-group-item`. We must
      // wait for that specific anchor, not just any `.list-group-item`,
      // otherwise we can end up clicking the transient status line itself.
      const hasResult = await page
        .waitForFunction(
          () => document.querySelectorAll('#automatic .list-group-item .searchitem-name').length >= 1,
          { timeout: 12000 }
        )
        .then(() => true)
        .catch(() => false);

      if (!hasResult) {
        const statusText = await page
          .$eval('#automatic', (el) => el.textContent.trim())
          .catch(() => '');
        throw new Error(
          `No selectable location appeared for pincode ${pincode}. ` +
          `Amul's own message: "${statusText || '(none)'}"`
        );
      }

      const itemsInfo = await page.$$eval('#automatic .list-group-item .searchitem-name', (els) =>
        els.map((el) => el.textContent.trim())
      );
      if (debug) {
        console.error(`[debug] found ${itemsInfo.length} selectable result(s): ${JSON.stringify(itemsInfo)}`);
      }

      const firstOption = await page.$('#automatic .list-group-item .searchitem-name');
      try {
        await firstOption.click({ delay: 50 });
      } catch (clickErr) {
        if (debug) console.error(`[debug] element.click() failed (${clickErr.message}), falling back to coordinate click`);
        const box = await firstOption.boundingBox();
        if (box) {
          await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        }
      }

      const modalClosed = await page
        .waitForSelector('#locationWidgetModal', { hidden: true, timeout: 15000 })
        .then(() => true)
        .catch(() => false);

      if (!modalClosed) {
        const modalHtml = await page
          .$eval('#locationWidgetModal', (el) => el.outerHTML.slice(0, 2000))
          .catch(() => '(could not read modal HTML)');
        const shotPath = `/tmp/amul-modal-debug-${Date.now()}.png`;
        await page.screenshot({ path: shotPath }).catch(() => { });
        console.error(`[debug] Modal did not close after clicking an option.`);
        console.error(`[debug] Modal HTML snapshot: ${modalHtml}`);
        console.error(`[debug] Screenshot saved to: ${shotPath}`);
        throw new Error(
          `Pincode modal did not close after selecting a location - the site's ` +
          `markup or selectors may have changed. See screenshot at ${shotPath} ` +
          `and the [debug] logs above.`
        );
      }
    }

    // Wait for the product page elements to settle - wait for schema.org Product markup or h1
    await page.waitForSelector('[itemtype*="schema.org/Product"], h1', { timeout: 15000 }).catch(() => {});

    // Evaluate stock and product metadata from the rendered page.
    //
    // KEY DESIGN DECISION - Schema.org is the authoritative source:
    // Amul's server-side rendering sets `link[itemprop="availability"]` inside
    // the Schema.org Product/Offer block based on actual inventory for the
    // active pincode. This is the *only* reliable signal because:
    //   - "Add to Cart" buttons can be disabled for UX reasons (e.g. qty = 0 in
    //     the input) even while the item is in stock.
    //   - A product page often contains a related-products grid at the bottom
    //     with "Notify Me" buttons for *other* out-of-stock variants; those
    //     must NOT be mistaken for the main product being out of stock.
    // DOM button signals are only used as a secondary fallback when schema is absent.
    const evalResult = await page.evaluate(() => {
      // ── 1. Schema.org availability (authoritative) ──────────────────────────
      const productSchema = document.querySelector('[itemtype*="schema.org/Product"]');
      // Look inside the Offer block first, then anywhere in the Product block
      const availLink =
        productSchema?.querySelector('[itemtype*="schema.org/Offer"] link[itemprop="availability"]') ||
        productSchema?.querySelector('link[itemprop="availability"]') ||
        productSchema?.querySelector('[itemprop="availability"]');
      const schemaHref = availLink ? (availLink.getAttribute('href') || availLink.textContent || '') : '';
      const isSchemaInStock    = /InStock/i.test(schemaHref);
      const isSchemaOutOfStock = /OutOfStock/i.test(schemaHref);

      // ── 2. Product name ─────────────────────────────────────────────────────
      const schemaNameEl = productSchema?.querySelector('[itemprop="name"]');
      const metaTitleEl  = document.querySelector('meta[property="og:title"]');
      const h1El         = document.querySelector('h1');
      const productName  =
        schemaNameEl?.textContent?.replace(/\s+/g, ' ').trim() ||
        metaTitleEl?.getAttribute('content')?.trim() ||
        h1El?.textContent?.trim() ||
        document.title.split('|')[0].trim() ||
        'Product';

      // ── 3. Price ────────────────────────────────────────────────────────────
      const schemaPriceEl = productSchema?.querySelector('[itemprop="price"]');
      const priceEl = document.querySelector('.product-price, .price-new, .price');
      let price = schemaPriceEl
        ? schemaPriceEl.textContent.trim()
        : (priceEl ? priceEl.textContent.trim() : null);
      if (price && !/₹/.test(price)) price = `₹${price}`;

      // ── 4. Schema-first stock determination ─────────────────────────────────
      // If schema is present, trust it completely and skip all DOM heuristics.
      if (schemaHref) {
        return {
          inStock: isSchemaInStock,
          productName,
          price,
          debugDetails: { source: 'schema', schemaHref, isSchemaInStock, isSchemaOutOfStock }
        };
      }

      // ── 5. DOM fallback (only when schema is absent) ─────────────────────────
      // Scope strictly to the *top-of-page* product action bar.
      // Amul's product page structure: the first `.add-to-cart` / `[title="Notify Me"]`
      // elements at the top of `.product-details` belong to the main product.
      // The related-products grid that follows also has these buttons but must be excluded.

      // Find the earliest Add to Cart button that is NOT inside a mobile grid card
      const topAddToCartBtn = document.querySelector(
        '.product-details .product-detail-action [title="Add to Cart"], ' +
        '.product-detail-action .add-to-cart, ' +
        '.product-info .add-to-cart, ' +
        // broader fallback – first .add-to-cart in the page body that isn't inside .product-grid-item
        'body .add-to-cart:not(.product-grid-item *):not(.mobile-btn)'
      );
      const topAddToCartActive = !!topAddToCartBtn &&
        !topAddToCartBtn.hasAttribute('disabled') &&
        !topAddToCartBtn.classList.contains('disabled');

      // "Notify Me" scoped to just the main product area (not the grid)
      const topNotifyMeBtn = document.querySelector(
        '.product-detail-action [title="Notify Me"], ' +
        '.product-info [title="Notify Me"], ' +
        '.product-info .product-enquiry-wrap, ' +
        '.product-detail-action .product-enquiry-wrap'
      );
      const topHasNotifyMe = !!topNotifyMeBtn;

      // Sold-out badge scoped to main product area
      const topSoldOutBadge = document.querySelector(
        '.product-detail-action .stock-indicator, .stock-indicator-text, .outofstock'
      );
      const topHasSoldOut = !!topSoldOutBadge &&
        /sold\s*out|out\s*of\s*stock/i.test(topSoldOutBadge.textContent || '');

      const inStock = !topHasNotifyMe && !topHasSoldOut && topAddToCartActive;

      return {
        inStock,
        productName,
        price,
        debugDetails: {
          source: 'dom-fallback',
          schemaHref: '(absent)',
          topAddToCartActive,
          topHasNotifyMe,
          topHasSoldOut
        }
      };
    });

    const { inStock, productName, price, debugDetails } = evalResult;

    if (debug) {
      console.error(`[debug] Evaluated stock for "${productName}": inStock=${inStock}`);
      console.error(`[debug] Details: ${JSON.stringify(debugDetails)}`);
    }

    // Persist cookies from this successful session so the next run can skip
    // the pincode modal entirely.
    const currentCookies = await page.cookies();
    saveCookies(currentCookies);
    if (debug) console.error(`[debug] saved ${currentCookies.length} cookie(s) for next run`);

    return {
      inStock,
      productName,
      price,
      inventoryQuantity: null,
      detectionMethod: 'dom+schema'
    };
  } finally {
    await browser.close();
  }
}

module.exports = { checkStock, extractAliasFromUrl };