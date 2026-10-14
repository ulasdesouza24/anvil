# The hosted Anvil API (docs/HOSTING.md). The web app is on Vercel, so this image has no browser and no Docker CLI:
# a hosted workspace runs no Python sandbox and no local browser. Code steps run in QuickJS (WebAssembly).
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
# Playwright gets no browser download: the hosted mode does not use it.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY . .

ENV NODE_ENV=production \
    ANVIL_HOSTED=on \
    ANVIL_HOST=0.0.0.0 \
    ANVIL_DATA_DIR=/data \
    ANVIL_SANDBOX=off \
    ANVIL_HEALTH_EVERY=off
# The volume gets the owner of this folder: the server runs as the user "node", not as root.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
# Node runs the server directly (not through npx), so it gets SIGTERM and saves its data on stop.
CMD ["node", "--import", "tsx", "src/server/index.ts"]
