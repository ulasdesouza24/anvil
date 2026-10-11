# Anvil in a container.
# The Playwright image has Node and Chromium for the browser node.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

# The Docker CLI: the Python sandbox starts its containers on the Docker of the host (through the mounted socket).
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

ENV NODE_ENV=production \
    ANVIL_HOST=0.0.0.0 \
    ANVIL_GATE_BIND=0.0.0.0 \
    ANVIL_DATA_DIR=/data
VOLUME /data
EXPOSE 8787 3141
# Node runs the server directly (not through npx), so it gets SIGTERM and removes its sandbox containers on stop.
CMD ["node", "--import", "tsx", "src/server/index.ts"]
