/**
 * emailNotifier.js
 *
 * Sends stock-alert emails via SMTP (Gmail or any other provider).
 * All config comes from environment variables — no credentials are
 * hardcoded. Call `isConfigured()` first to check if SMTP is set up;
 * if not, calls to `sendStockAlert` are silent no-ops.
 *
 * Required env vars
 *   SMTP_HOST      e.g. smtp.gmail.com
 *   SMTP_PORT      587 (STARTTLS) or 465 (SSL)
 *   SMTP_USER      your Gmail address
 *   SMTP_PASS      Gmail App Password (16-char, spaces ok)
 *   NOTIFY_EMAIL   where to send alerts (can equal SMTP_USER)
 *
 * Optional
 *   SMTP_FROM      sender label address (defaults to SMTP_USER)
 */

'use strict';

const nodemailer = require('nodemailer');

function isConfigured() {
  return !!(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS &&
    process.env.NOTIFY_EMAIL
  );
}

function createTransporter() {
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465, // true = SSL, false = STARTTLS (port 587)
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * @param {object} opts
 * @param {string}  opts.productName
 * @param {string}  opts.productUrl
 * @param {string}  opts.pincode
 * @param {boolean} opts.inStock
 * @param {string|null} opts.price
 * @param {boolean} [opts.isStartup=false]  true → sends a "tracker started" email
 */
async function sendStockAlert({
  productName,
  productUrl,
  pincode,
  inStock,
  price,
  isStartup = false,
}) {
  if (!isConfigured()) return;

  const transporter = createTransporter();
  const statusLabel = inStock ? 'IN STOCK \u2705' : 'OUT OF STOCK \u274c';
  const statusColor = inStock ? '#22c55e' : '#ef4444';
  const time = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const subject = isStartup
    ? `[Amul Tracker] Now watching: ${productName}`
    : `[Amul Tracker] ${productName} is now ${statusLabel}`;

  const bodyTitle = isStartup ? 'Tracker Started \ud83d\ude80' : 'Stock Status Changed';
  const bodyIntro = isStartup
    ? "Your Amul stock tracker is up and running. You'll get an email whenever the stock status changes."
    : "The stock status for a product you're tracking has just changed.";

  const ctaHtml = inStock && !isStartup
    ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr><td align="center">
          <a href="${productUrl}"
             style="display:inline-block;padding:13px 36px;background:#a0ce4e;color:#1a3c00;
                    border-radius:8px;font-size:15px;font-weight:700;text-decoration:none;">
            \ud83d\uded2 Buy Now &rarr;
          </a>
        </td></tr>
      </table>`
    : `<table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
        <tr><td align="center">
          <a href="${productUrl}"
             style="display:inline-block;padding:13px 36px;background:#f3f4f6;color:#374151;
                    border-radius:8px;font-size:15px;font-weight:600;text-decoration:none;">
            View Product &rarr;
          </a>
        </td></tr>
      </table>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:40px 16px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0"
             style="background:#fff;border-radius:14px;overflow:hidden;
                    box-shadow:0 4px 16px rgba(0,0,0,0.08);max-width:560px;width:100%;">

        <!-- Header -->
        <tr>
          <td style="background:#a0ce4e;padding:28px 36px;text-align:center;">
            <p style="margin:0;font-size:24px;font-weight:800;color:#1a3c00;letter-spacing:-0.5px;">
              \ud83e\udd5b Amul Stock Tracker
            </p>
            <p style="margin:6px 0 0;font-size:13px;color:#3a6400;font-weight:500;">
              ${bodyTitle}
            </p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:32px 36px 8px;">
            <p style="margin:0 0 24px;font-size:15px;color:#4b5563;line-height:1.6;">${bodyIntro}</p>

            <!-- Product card -->
            <table width="100%" cellpadding="0" cellspacing="0"
                   style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:10px;margin-bottom:24px;">
              <tr><td style="padding:20px 24px;">
                <p style="margin:0 0 3px;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;color:#9ca3af;font-weight:600;">Product</p>
                <p style="margin:0 0 20px;font-size:17px;font-weight:700;color:#111827;line-height:1.4;">${productName}</p>

                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td width="50%" style="padding-bottom:16px;vertical-align:top;">
                      <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;color:#9ca3af;font-weight:600;">Status</p>
                      <span style="display:inline-block;padding:5px 14px;background:${statusColor};color:#fff;border-radius:20px;font-size:13px;font-weight:700;">
                        ${statusLabel}
                      </span>
                    </td>
                    <td width="50%" style="padding-bottom:16px;vertical-align:top;">
                      <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;color:#9ca3af;font-weight:600;">Price</p>
                      <p style="margin:0;font-size:17px;font-weight:700;color:#111827;">${price || '\u2014'}</p>
                    </td>
                  </tr>
                  <tr>
                    <td colspan="2">
                      <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:0.8px;color:#9ca3af;font-weight:600;">Delivery Pincode</p>
                      <p style="margin:0;font-size:15px;color:#111827;font-weight:600;">\ud83d\udccd ${pincode}</p>
                    </td>
                  </tr>
                </table>
              </td></tr>
            </table>

            ${ctaHtml}
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="padding:16px 36px 20px;border-top:1px solid #f3f4f6;text-align:center;">
            <p style="margin:0;font-size:12px;color:#d1d5db;">Checked at ${time} IST &middot; amul-tracker</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  await transporter.sendMail({
    from: `"Amul Tracker" <${process.env.SMTP_FROM || process.env.SMTP_USER}>`,
    to: process.env.NOTIFY_EMAIL,
    subject,
    html,
  });
}

module.exports = { sendStockAlert, isConfigured };
