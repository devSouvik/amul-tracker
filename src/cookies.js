const fs = require('fs');
const path = require('path');

// Where we persist the session cookies picked up after a successful run,
// so subsequent runs can skip the pincode modal entirely.
const DEFAULT_CACHE_PATH = path.join(process.cwd(), '.amul-session-cookies.json');

/**
 * Converts a cookie-export-extension style array (EditThisCookie, Cookie
 * Editor, etc. - the format with `expirationDate`, `hostOnly`, `session`,
 * ...) into the shape Puppeteer's page.setCookie() expects.
 */
function fromBrowserExport(exported) {
    return exported.map((c) => {
        const cookie = {
            name: c.name,
            value: c.value,
            domain: c.domain,
            path: c.path || '/',
            httpOnly: !!c.httpOnly,
            secure: !!c.secure
        };
        if (typeof c.expirationDate === 'number') {
            cookie.expires = c.expirationDate;
        }
        // Puppeteer only accepts 'Strict' | 'Lax' | 'None' (capitalized) - drop
        // anything else (null, "no_restriction", "unspecified", etc.) rather
        // than pass through a value Puppeteer will reject.
        const sameSiteMap = { strict: 'Strict', lax: 'Lax', none: 'None' };
        const normalized = (c.sameSite || '').toLowerCase().replace('_restriction', '');
        if (sameSiteMap[normalized]) {
            cookie.sameSite = sameSiteMap[normalized];
        }
        return cookie;
    });
}

/** Load a user-exported cookie JSON file (one-time import) and normalize it. */
function loadExportedCookies(filePath) {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw.cookies || [];
    return fromBrowserExport(list);
}

/** Load previously auto-persisted session cookies, if any exist and look usable. */
function loadCachedCookies(cachePath = DEFAULT_CACHE_PATH) {
    try {
        const raw = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        return Array.isArray(raw) ? raw : null;
    } catch {
        return null;
    }
}

/** Persist the browser's current cookies for reuse on the next run. */
function saveCookies(cookies, cachePath = DEFAULT_CACHE_PATH) {
    try {
        fs.writeFileSync(cachePath, JSON.stringify(cookies, null, 2));
    } catch (err) {
        // Non-fatal - worst case, next run just goes through the modal again.
        console.error(`Warning: could not persist session cookies (${err.message})`);
    }
}

module.exports = { fromBrowserExport, loadExportedCookies, loadCachedCookies, saveCookies, DEFAULT_CACHE_PATH };