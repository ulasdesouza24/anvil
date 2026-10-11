import { describe, expect, it } from "vitest";
import { FileStore } from "../src/store/fileStore.js";
import { tmpDir } from "./helpers.js";

describe("a data folder that two processes share", () => {
  it("a KV change of one process (the CLI) is visible to the other (the server)", async () => {
    const dir = tmpDir();
    const server = new FileStore(dir).init();
    const cli = new FileStore(dir).init();
    expect(await server.get("health", "a")).toBeUndefined();
    await cli.set("health", "a", { status: "broken" });
    await cli.flush();
    // The file time can have a low resolution: make the change newer for the test.
    await new Promise((r) => setTimeout(r, 20));
    expect(await server.get("health", "a")).toEqual({ status: "broken" });
    // A write of the server keeps the key of the CLI.
    await server.set("health", "b", { status: "healthy" });
    await server.flush();
    expect(Object.keys(await cli.list("health")).sort()).toEqual(["a", "b"]);
  });
});

describe("runs of another process", () => {
  it("the server keeps a running run of a live process, and marks the run of a dead process as interrupted", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { spawn, spawnSync } = await import("node:child_process");
    const live = spawn("sleep", ["10"]);
    const dead = spawnSync("true").pid;
    try {
      const dir = tmpDir();
      new FileStore(dir).init();
      const run = (id: string, pid?: number) => ({ id, agentId: "a", agentName: "a", version: 1, kind: "build", status: "running", input: {}, startedAt: 1, usage: { llmCalls: 0, decisionCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }, nodeStates: {}, events: [], ...(pid ? { pid } : {}) });
      fs.writeFileSync(path.join(dir, "runs", "run_live.json"), JSON.stringify(run("run_live", live.pid)));
      fs.writeFileSync(path.join(dir, "runs", "run_dead.json"), JSON.stringify(run("run_dead", dead)));
      fs.writeFileSync(path.join(dir, "runs", "run_old.json"), JSON.stringify(run("run_old")));
      const server = new FileStore(dir).init();
      expect((await server.getRun("run_live"))?.status).toBe("running");
      expect((await server.getRun("run_dead"))?.status).toBe("failed");
      expect((await server.getRun("run_old"))?.error).toMatch(/Interrupted/);
    } finally {
      live.kill();
    }
  });
});
