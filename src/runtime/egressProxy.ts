import http from "node:http";
import net from "node:net";
import { guardedLookup, isBlockedAddress } from "./netGuard.js";

/**
 * The guarded forward proxy of the remote browser (docs/HOSTING.md). The browser runs in a container without a
 * route to the internet: each of its requests goes through this proxy. The proxy connects only to public
 * addresses, after the DNS lookup (so a name that points to a private address is blocked too), and only to
 * web ports. A page cannot reach the server, its private network, or the cloud metadata address.
 */

export interface EgressProxyOptions {
  port: number;
  host?: string;
  /** The ports that a page can reach. */
  ports?: number[];
  /** The DNS lookup. Tests give their own. */
  lookup?: typeof guardedLookup;
  log?: (m: string) => void;
}

const DEFAULT_PORTS = [80, 443, 8080, 8443];

/** Connects to host:port only when the host and the port are allowed. */
function guardedConnect(host: string, port: number, opts: Required<Pick<EgressProxyOptions, "ports" | "lookup">>): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (!opts.ports.includes(port)) return reject(new Error(`the port ${port} is not a web port`));
    const h = host.replace(/^\[|\]$/g, "");
    if (net.isIP(h) && isBlockedAddress(h)) return reject(new Error(`${h} is a private or local address`));
    const sock = net.connect({ host: h, port, lookup: opts.lookup as never, timeout: 30_000 });
    sock.once("connect", () => {
      sock.setTimeout(0);
      resolve(sock);
    });
    sock.once("timeout", () => sock.destroy(new Error("the connection timed out")));
    sock.once("error", reject);
  });
}

export function startEgressProxy(o: EgressProxyOptions): http.Server {
  const cfg = { ports: o.ports ?? DEFAULT_PORTS, lookup: o.lookup ?? guardedLookup };
  const log = o.log ?? (() => undefined);
  const refuse = (sock: net.Socket, reason: string) =>
    sock.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nBlocked by the Anvil egress policy: ${reason}`);

  const server = http.createServer(async (req, res) => {
    // A plain HTTP request through the proxy has an absolute URL.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("only absolute http URLs");
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end("only http URLs: use CONNECT for https");
      return;
    }
    const port = Number(url.port || 80);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const blocked = !cfg.ports.includes(port) ? `the port ${port} is not a web port` : net.isIP(host) && isBlockedAddress(host) ? `${host} is a private or local address` : "";
    if (blocked) {
      log(`[egress] blocked ${url.host}: ${blocked}`);
      res.writeHead(403, { "Content-Type": "text/plain" }).end(`Blocked by the Anvil egress policy: ${blocked}`);
      return;
    }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !/^(proxy-connection|proxy-authorization|connection|keep-alive)$/i.test(k)));
    const up = http.request(
      { host, port, method: req.method, path: `${url.pathname}${url.search}`, headers, lookup: cfg.lookup as never, agent: false, timeout: 60_000 },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
      },
    );
    up.on("timeout", () => up.destroy(new Error("the request timed out")));
    up.on("error", (e) => {
      log(`[egress] ${url.host}: ${e.message}`);
      if (!res.headersSent) res.writeHead(/private or local/.test(e.message) ? 403 : 502, { "Content-Type": "text/plain" });
      res.end(`Blocked or failed: ${e.message}`);
    });
    req.pipe(up);
  });

  server.on("connect", async (req, client: net.Socket, head: Buffer) => {
    client.on("error", () => undefined);
    const [host, portText] = (req.url ?? "").split(/:(?=\d+$)/);
    let up: net.Socket;
    try {
      up = await guardedConnect(host, Number(portText || 443), cfg);
    } catch (e) {
      log(`[egress] blocked ${req.url}: ${(e as Error).message}`);
      return refuse(client, (e as Error).message);
    }
    client.write("HTTP/1.1 200 Connection established\r\n\r\n");
    if (head.length) up.write(head);
    up.pipe(client);
    client.pipe(up);
    up.on("error", () => client.destroy());
    client.on("close", () => up.destroy());
  });

  server.listen(o.port, o.host ?? "0.0.0.0", () => log(`[egress] guarded proxy on ${o.host ?? "0.0.0.0"}:${o.port}`));
  return server;
}
