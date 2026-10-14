// The Playwright browser server of a hosted Anvil (docs/HOSTING.md). Anvil connects with ANVIL_BROWSER_WS.
import { chromium } from "playwright-core";

const proxy = process.env.ANVIL_BROWSER_PROXY;
if (!proxy) throw new Error("Set ANVIL_BROWSER_PROXY: each page request must go through the guarded proxy of Anvil");

const server = await chromium.launchServer({
  host: "0.0.0.0",
  port: Number(process.env.PORT || 3000),
  wsPath: process.env.ANVIL_BROWSER_WS_PATH || "/anvil",
  headless: true,
  // Each request goes through the proxy, also a request to a local name: nothing bypasses it.
  proxy: { server: proxy, bypass: "<-loopback>" },
  args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-dev-shm-usage", "--disable-blink-features=AutomationControlled"],
});
console.log(`browser server on ${server.wsEndpoint()} (proxy ${proxy})`);
for (const s of ["SIGINT", "SIGTERM"]) process.on(s, () => server.close().then(() => process.exit(0)));
