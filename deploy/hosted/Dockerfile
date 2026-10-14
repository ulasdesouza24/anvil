# The hosted Anvil API (docs/HOSTING.md). The web app is on Vercel. The browser runs in its own container
# (deploy/hosted/browser), and the Python sandbox runs in gVisor containers that the Docker guard checks.
# This image is also the image of the Docker guard (another command, see compose.yaml).
FROM node:22-bookworm-slim

# The Docker CLI: Anvil starts the sandbox containers through the socket of the Docker guard, never the real socket.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

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
    ANVIL_HEALTH_EVERY=off
# The volume gets the owner of this folder: the server runs as the user "node", not as root.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
# Node runs the server directly (not through npx), so it gets SIGTERM and saves its data on stop.
CMD ["node", "--import", "tsx", "src/server/index.ts"]
