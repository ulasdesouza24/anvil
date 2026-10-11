import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AnvilConfig } from "../src/core/config.js";
import type { Answer, Question } from "../src/core/types.js";
import type { ModelClient } from "../src/llm/brain.js";
import type { ChatRequest, ChatResult, DecideRequest, DecideResult } from "../src/llm/openrouter.js";
import { createAnvil } from "../src/runtime/anvil.js";

export class FakeClient implements ModelClient {
  readonly config: AnvilConfig;
  chats: ChatRequest[] = [];
  decisions: DecideRequest[] = [];
  constructor(
    private onChat: (req: ChatRequest) => string | Partial<ChatResult> = () => "ok",
    private onDecide: (id: string, q: Question, state: unknown) => Answer = defaultAnswer,
  ) {
    this.config = { ...loadConfig(), apiKey: "test", dataDir: tmpDir() };
  }
  async chat(req: ChatRequest): Promise<ChatResult> {
    this.chats.push(req);
    const r = this.onChat(req);
    const base = { content: "", toolCalls: [], finishReason: "stop", model: "fake", usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.0001 }, latencyMs: 1 };
    return typeof r === "string" ? { ...base, content: r } : { ...base, ...r };
  }
  async decide(req: DecideRequest): Promise<DecideResult> {
    this.decisions.push(req);
    const answers = Object.fromEntries(Object.entries(req.questions).map(([id, q]) => [id, this.onDecide(id, q, req.state)]));
    return { answers, model: "fake-jev", usage: { inputTokens: 20, outputTokens: 0, costUsd: 0.00001 }, latencyMs: 1 };
  }
}

export function defaultAnswer(_id: string, q: Question): Answer {
  if (q.type === "choice") {
    const keys = Object.keys(q.criteria);
    return { type: "choice", choice: keys[0], confidence: 0.9, probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.95 : 0.05 / (keys.length - 1)])) };
  }
  if (q.type === "score") return { type: "score", score: 1, confidence: 0.9, probabilities: {} };
  // The action gate asks if a message only gives information: by default, it does not (the gate passes).
  if (_id === "only_information") return { type: "noul", noul: 0.1 };
  // The claim check of a conversation turn: by default, a reply does not say that an action is done.
  if (_id === "claims_action") return { type: "noul", noul: 0.1 };
  return { type: "noul", noul: 0.9 };
}

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "anvil-test-"));
}

export async function anvilWith(client: FakeClient) {
  return createAnvil({ client, config: { dataDir: client.config.dataDir, maxParallel: 4 } });
}
