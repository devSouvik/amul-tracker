#!/usr/bin/env node

// Load .env file if present (local development). In production (Railway),
// env vars are injected directly and dotenv is a no-op.
require('dotenv').config();

const chalk = require('chalk');
const notifier = require('node-notifier');
const { checkStock } = require('./src/browserCheck');
const { loadExportedCookies } = require('./src/cookies');
const { sendStockAlert, isConfigured, providerName } = require('./src/emailNotifier');

function parseArgs(argv) {
  // CLI flags take priority; env vars are the fallback for cloud deployments.
  const args = {
    watch: false,
    interval: parseInt(process.env.CHECK_INTERVAL || '120', 10),
    url: process.env.PRODUCT_URL || null,
    pincode: process.env.PINCODE || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url'      || a === '-u') args.url      = argv[++i];
    if (a === '--pincode'  || a === '-p') args.pincode  = argv[++i];
    if (a === '--watch'    || a === '-w') args.watch    = true;
    if (a === '--interval' || a === '-i') args.interval = parseInt(argv[++i], 10);
    if (a === '--debug'    || a === '-d') args.debug    = true;
    if (a === '--import-cookies' || a === '-c') args.importCookies = argv[++i];
    if (a === '--help'     || a === '-h') args.help     = true;
  }
  return args;
}

function printHelp() {
  console.log(`
${chalk.bold('amul-stock-cli')} - check shop.amul.com product availability from the terminal

Usage:
  node cli.js --url <product-url> --pincode <6-digit-pincode> [--watch] [--interval <seconds>]

Options:
  -u, --url        Full product URL from shop.amul.com
  -p, --pincode    6-digit delivery pincode to check against
  -w, --watch      Keep checking repeatedly instead of a single one-off check
  -i, --interval   Seconds between checks in --watch mode (default: 120)
  -d, --debug      Print in-page console output for troubleshooting
  -c, --import-cookies Path to a cookie-export JSON file (one-time import; a
                        session already showing your pincode selected will
                        skip the modal entirely). Auto-saved after every
                        successful run afterwards, so this is only needed
                        once (or again after the session expires, ~7 days).
  -h, --help       Show this help

Env var equivalents (useful for cloud deploys):
  PRODUCT_URL      Same as --url
  PINCODE          Same as --pincode
  CHECK_INTERVAL   Same as --interval (seconds, default 120)

Email notifications (optional, set these in .env or Railway variables):
  SMTP_HOST        e.g. smtp.gmail.com
  SMTP_PORT        587 (default) or 465
  SMTP_USER        your Gmail address
  SMTP_PASS        Gmail App Password (16 chars)
  NOTIFY_EMAIL     recipient address (can be the same as SMTP_USER)

Example:
  node cli.js -u "https://shop.amul.com/en/product/amul-chocolate-whey-protein-34-g-or-pack-of-30-sachets" -p 302001 -w
  node cli.js -u "..." -p 302001 --import-cookies ./exported-cookies.json

Note: this drives a real headless Chrome (via Puppeteer), not plain HTTP
requests - shop.amul.com sits behind Cloudflare Bot Management, which
fingerprints the TLS/HTTP handshake itself, so plain HTTP clients get
rejected with a 401 even with valid session cookies attached.
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help || !args.url || !args.pincode) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  if (!/^\d{6}$/.test(args.pincode)) {
    console.error(chalk.red('Error: pincode must be exactly 6 digits.'));
    process.exit(1);
  }

  // Log SMTP config status clearly so Railway logs show if something is missing
  console.log(chalk.gray('[config] Email provider: ' + providerName()));
  if (isConfigured()) {
    console.log(chalk.cyan('📧 Email notifications enabled → ' + process.env.NOTIFY_EMAIL));
  } else {
    const missingResend = ['RESEND_API_KEY','RESEND_FROM','NOTIFY_EMAIL'].filter(k => !process.env[k]);
    const missingSMTP   = ['SMTP_HOST','SMTP_USER','SMTP_PASS','NOTIFY_EMAIL'].filter(k => !process.env[k]);
    console.log(chalk.yellow('[config] Email disabled. For Resend set: ' + missingResend.join(', ')));
    console.log(chalk.yellow('[config] Email disabled. For SMTP set:   ' + missingSMTP.join(', ')));
  }

  let lastStatus = null;
  let lastProductName = null;
  let lastPrice = null;
  let seedCookies = null;
  if (args.importCookies) {
    try {
      seedCookies = loadExportedCookies(args.importCookies);
      console.log(chalk.cyan(`Imported ${seedCookies.length} cookie(s) from ${args.importCookies}`));
    } catch (err) {
      console.error(chalk.red(`Could not read cookie file "${args.importCookies}": ${err.message}`));
      process.exit(1);
    }
  }

  const runCheck = async () => {
    const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    try {
      const result = await checkStock(args.url, args.pincode, {
        debug: args.debug,
        seedCookies,
      });
      // Only seed from the imported file on the very first check; after that,
      // rely on the auto-persisted session cookies from checkStock itself.
      seedCookies = null;

      const statusLine = result.inStock
        ? chalk.green.bold('IN STOCK ✅')
        : chalk.red.bold('OUT OF STOCK ❌');

      const qtyInfo = (result.inventoryQuantity !== null && result.inventoryQuantity !== undefined)
        ? chalk.cyan(` [Qty: ${result.inventoryQuantity}]`)
        : '';

      console.log(
        `[${time}] ${chalk.bold(result.productName)} (pincode ${args.pincode}) -> ${statusLine}` +
        (result.price ? chalk.gray(` (${result.price})`) : '') +
        qtyInfo
      );

      // ── Status-change notifications ──────────────────────────────────────
      const statusChanged = lastStatus !== null && result.inStock !== lastStatus;

      if (statusChanged) {
        // Desktop notification (local macOS only — no-ops on Linux/cloud)
        if (result.inStock) {
          const qtyMsg = result.inventoryQuantity ? ` (Qty: ${result.inventoryQuantity})` : '';
          notifier.notify({
            title: 'Amul Stock Alert',
            message: `${result.productName} is now IN STOCK for pincode ${args.pincode}!${qtyMsg}`,
            sound: true,
          });
        }

        // Email notification (works everywhere)
        sendStockAlert({
          productName: result.productName,
          productUrl: args.url,
          pincode: args.pincode,
          inStock: result.inStock,
          price: result.price,
        }).catch((err) => console.error(chalk.yellow(`[email] Failed to send: ${err.message}`)));
      }

      lastStatus = result.inStock;
      lastProductName = result.productName;
      lastPrice = result.price;
    } catch (err) {
      console.error(chalk.red(`[${time}] Error checking stock: ${err.message}`));
    }
  };

  // ── First check ─────────────────────────────────────────────────────────
  await runCheck();

  // ── Send startup email (so you know the deploy is alive) ─────────────────
  // Intentionally NOT gated on lastStatus !== null: even if the first check
  // failed (e.g. Puppeteer issue), the startup email should still fire so you
  // know the process is running and SMTP is working.
  if (args.watch && isConfigured()) {
    sendStockAlert({
      productName: lastProductName || args.url,
      productUrl: args.url,
      pincode: args.pincode,
      inStock: lastStatus ?? false,
      price: lastPrice,
      isStartup: true,
    }).then(() => {
      console.log(chalk.cyan('[email] Startup confirmation sent → ' + process.env.NOTIFY_EMAIL));
    }).catch((err) => {
      console.error(chalk.red('[email] Startup email FAILED: ' + err.message));
      console.error(chalk.red('[email] Check SMTP_HOST / SMTP_USER / SMTP_PASS in your Railway Variables'));
    });
  }

  if (args.watch) {
    console.log(chalk.gray(`Watching every ${args.interval}s. Press Ctrl+C to stop.`));
    setInterval(runCheck, args.interval * 1000);
  }
}

main().catch((err) => {
  console.error(chalk.red(`Fatal error: ${err.message}`));
  process.exit(1);
});