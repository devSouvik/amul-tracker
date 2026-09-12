# Use the official Puppeteer image — Chrome is pre-installed, no manual
# browser setup needed. The image sets PUPPETEER_EXECUTABLE_PATH and
# PUPPETEER_SKIP_CHROMIUM_DOWNLOAD automatically.
FROM ghcr.io/puppeteer/puppeteer:22

WORKDIR /app

# Install production dependencies only (skip devDeps, skip Chromium download)
COPY package*.json ./
RUN npm ci --omit=dev

# Copy source (node_modules and secrets are excluded via .dockerignore)
COPY . .

# The image already runs as non-root user `pptruser` — no USER switch needed.
# --no-sandbox is set inside browserCheck.js for container compatibility.

# URL, PINCODE, CHECK_INTERVAL, and SMTP_* are all injected as env vars at
# runtime (Railway → Variables tab). No need to hardcode them here.
CMD ["node", "cli.js", "--watch"]
