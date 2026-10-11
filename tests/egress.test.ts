import { describe, expect, it } from "vitest";
import { checkEgress, domainAllowed, findSecret, hostSecretValues, type EgressPolicy } from "../src/core/egress.js";

const policy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  allowDomains: new Set(["api.example.com", "data.gov.tr"]),
  maxBody: 1000,
  evaluation: false,
  secretValues: ["s3cr3t-value-of-the-host"],
  ...over,
});

describe("egress policy", () => {
  it("allows a GET to an allowed domain and its subdomains", () => {
    expect(checkEgress({ tool: "fetch_url", url: "https://api.example.com/v1/rates?base=EUR", method: "GET" }, policy())).toMatchObject({ allowed: true, needsApproval: false, host: "api.example.com" });
    expect(domainAllowed("x.data.gov.tr", new Set(["data.gov.tr"]))).toBe(true);
    expect(domainAllowed("evildata.gov.tr", new Set(["data.gov.tr"]))).toBe(false);
  });

  it("blocks a domain that is not on the allowlist, and says how to add it", () => {
    const d = checkEgress({ tool: "fetch_url", url: "https://attacker.test/collect", method: "GET" }, policy());
    expect(d).toMatchObject({ allowed: false, host: "attacker.test" });
    expect((d as { reason: string }).reason).toMatch(/not on the allowlist .* Sandbox tab/);
  });

  it("asks a person for a request that sends data, and blocks it in evaluation runs", () => {
    expect(checkEgress({ tool: "http_request", url: "https://api.example.com/items", method: "POST", body: { a: 1 } }, policy())).toMatchObject({ allowed: true, needsApproval: true });
    const e = checkEgress({ tool: "http_request", url: "https://api.example.com/items", method: "POST", body: { a: 1 } }, policy({ evaluation: true }));
    expect((e as { reason: string }).reason).toMatch(/Evaluation runs never send data out/);
  });

  it("blocks a request with a secret of the host or a credential pattern", () => {
    const host = checkEgress({ tool: "fetch_url", url: "https://api.example.com/?k=s3cr3t-value-of-the-host", method: "GET" }, policy());
    expect((host as { reason: string }).reason).toBe("the request contains a secret of the Anvil host");
    expect(findSecret("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345", [])).toBe("a bearer token");
    expect(findSecret("key=sk-or-v1-0123456789abcdef0123", [])).toBe("an API key (sk-...)"); // gitleaks:allow (a fake value for the test)
    expect(findSecret("AKIAABCDEFGHIJKLMNOP", [])).toBe("an AWS access key"); // gitleaks:allow (a fake value for the test)
    expect(findSecret("a normal sentence", [])).toBeNull();
  });

  it("blocks a request that sends more than the size limit, also in the URL query", () => {
    const big = checkEgress({ tool: "http_request", url: `https://api.example.com/?q=${"x".repeat(2000)}`, method: "GET" }, policy());
    expect((big as { reason: string }).reason).toMatch(/The limit is 1000 bytes/);
  });

  it("allows only http and https", () => {
    expect(checkEgress({ tool: "fetch_url", url: "file:///etc/passwd", method: "GET" }, policy({ allowDomains: new Set([""]) })).allowed).toBe(false);
  });

  it("takes the secret values of the host from variables with KEY, TOKEN, SECRET, or PASSWORD in the name", () => {
    expect(hostSecretValues({ OPENROUTER_API_KEY: "sk-or-very-long-key", HOME: "/Users/someone/home", DB_PASSWORD: "short", GH_TOKEN: "ghp_aaaaaaaaaaaaaaaa" })).toEqual([
      "sk-or-very-long-key",
      "ghp_aaaaaaaaaaaaaaaa",
    ]);
  });
});
