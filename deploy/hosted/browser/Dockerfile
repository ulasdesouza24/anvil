# The remote browser of a hosted Anvil (docs/HOSTING.md). It runs in gVisor, on a network with no route to the
# internet: each page request goes through the guarded proxy of Anvil, which blocks private addresses.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /srv
RUN npm init -y >/dev/null && npm install --no-audit --no-fund playwright-core@1.63.0
COPY server.mjs ./
USER pwuser
CMD ["node", "server.mjs"]
