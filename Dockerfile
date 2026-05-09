# syntax=docker/dockerfile:1

FROM node:lts-bookworm AS builder
WORKDIR /src
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM node:lts-bookworm
WORKDIR /app
COPY package*.json ./

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y libnss3 \
    libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libgbm1 libxkbcommon0 libasound2 libcups2 xvfb

ARG SUNO_COOKIE
RUN if [ -z "$SUNO_COOKIE" ]; then echo "Warning: SUNO_COOKIE is not set. You will have to set the cookies in the Cookie header of your requests."; fi
ENV SUNO_COOKIE=${SUNO_COOKIE}
# Disable GPU acceleration, as with it suno-api won't work in a Docker environment
ENV BROWSER_DISABLE_GPU=true

# Explicitly unset PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD here in case it's set
# globally on Railway (we removed it from env vars but cache might still
# be poisoned). We need Chromium for Option B AccountManager.ts which uses
# rebrowser-playwright-core to drive headless logins.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN npm install --only=production

# Install Chromium via the rebrowser-playwright-core CLI directly. This is
# the package AccountManager.ts uses (NOT the standard playwright). Using
# its own bin avoids version mismatch between which Chromium downloads vs
# which Chromium it tries to launch.
# Cache-buster comment: 2026-05-09 force download
RUN node node_modules/rebrowser-playwright-core/cli.js install chromium

COPY --from=builder /src/.next ./.next
EXPOSE 3000
CMD ["npm", "run", "start"]
