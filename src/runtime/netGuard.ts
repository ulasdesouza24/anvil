import dns from "node:dns";
import net from "node:net";
import { Agent, buildConnector, setGlobalDispatcher } from "undici";

/**
 * The network guard of a hosted Anvil (docs/HOSTING.md). Users write the URLs of their agents, so a request
 * must not reach the server itself or its private network: loopback, private ranges, link-local (the cloud
 * metadata address 169.254.169.254), CGNAT, and multicast. The guard checks the address at connect time,
 * after the DNS lookup, so a DNS name that points to a private address (DNS rebinding) is also blocked.
 */

const BLOCKED_V4: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const toInt = (ip: string) => ip.split(".").reduce((a, b) => (a << 8) + Number(b), 0) >>> 0;

/** True when a request must not go to this address. */
export function isBlockedAddress(address: string): boolean {
  let ip = address.toLowerCase();
  if (ip.startsWith("::ffff:") && net.isIPv4(ip.slice(7))) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const n = toInt(ip);
    return BLOCKED_V4.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      return (n & mask) === (toInt(base) & mask);
    });
  }
  if (net.isIPv6(ip)) {
    // Loopback, unspecified, unique local (fc00::/7), link-local (fe80::/10), multicast, and the NAT64 prefix.
    return ip === "::1" || ip === "::" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip) || ip.startsWith("ff") || ip.startsWith("64:ff9b:");
  }
  return true;
}

export class BlockedAddressError extends Error {
  readonly code = "ANVIL_BLOCKED_ADDRESS";
}

/** A DNS lookup that refuses a blocked address. undici calls it for each new connection. */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: (...a: any[]) => void): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = (addresses as dns.LookupAddress[]).filter((a) => !isBlockedAddress(a.address));
    if (!list.length) return callback(new BlockedAddressError(`${hostname} points to a private or local address. The hosted service does not send requests there.`));
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

let installed = false;

/** Routes each fetch of this process through the guard. Requests to an IP address are checked the same way. */
export function installNetGuard(): void {
  if (installed) return;
  installed = true;
  const base = buildConnector({ lookup: guardedLookup as never });
  setGlobalDispatcher(
    new Agent({
      // A host that is an IP address has no DNS lookup, so the connector checks it first.
      connect: (opts, callback) => {
        const host = String(opts.hostname).replace(/^\[|\]$/g, "");
        if (net.isIP(host) && isBlockedAddress(host))
          return callback(new BlockedAddressError(`${host} is a private or local address. The hosted service does not send requests there.`), null);
        return base(opts, callback);
      },
    }),
  );
}
