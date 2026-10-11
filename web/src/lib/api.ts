import type { AgentSpec, Diagnostic, HumanRequest, Lesson, RunRecord, StoredAgent, Taxonomy, Usage } from "@core/types";
import type { Quality } from "@core/quality";

export type { AgentSpec, Diagnostic, Lesson, RunRecord, StoredAgent, Taxonomy, Usage };

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  system: boolean;
  currentVersion: number;
  versions: number;
  createdAt: number;
  updatedAt: number;
  score: number | null;
  passRate: number | null;
  nodeCount: number;
  nodeTypes: string[];
  tests: number;
  pattern: string | null;
  /** The class of the agent in the library (docs/LIBRARY.md). */
  taxonomy: Taxonomy | null;
  quality: Quality;
}

/** The library: the class of each agent, which agents can be examples, and the lessons of each domain. */
export interface LibraryView {
  enabled: boolean;
  domains: string[];
  agents: { id: string; name: string; taxonomy: Taxonomy | null; example: boolean; reason: string | null }[];
  lessons: Record<string, Lesson[]>;
}

export interface RunSummary {
  id: string;
  agentId: string;
  agentName: string;
  version: number;
  kind: RunRecord["kind"];
  parentRunId?: string;
  status: RunRecord["status"];
  error?: string;
  startedAt: number;
  endedAt?: number;
  usage: Usage;
  resultAgentId?: string;
  inputPreview?: string;
}

export interface Turn {
  role: "user" | "assistant";
  content: string;
  at: number;
  runId?: string;
}

export interface Session {
  id: string;
  agentId: string;
  version: number;
  turns: Turn[];
  done: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ConverseResult {
  session: Session;
  reply: string;
  done: boolean;
  runId: string;
  status: string;
  error?: string;
}

export interface NodeClassInfo {
  type: string;
  title: string;
  category: string;
  description: string;
  whenToUse: string;
  configSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  internal: boolean;
  custom?: { kind: string; status: string; secrets: string[]; approved: boolean; createdBy: string; version: number };
}

export interface CustomClass {
  type: string;
  title: string;
  category: string;
  description: string;
  whenToUse: string;
  configSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  example: Record<string, unknown>;
  sideEffects: boolean;
  secrets: string[];
  missingSecrets: string[];
  impl: { kind: "http" | "code" | "llm" | "mcp"; [k: string]: unknown };
  tests: { name: string; config: Record<string, unknown>; checks: unknown[] }[];
  version: number;
  createdBy: string;
  createdAt: number;
  approved: boolean;
  status: "passed" | "failed" | "untested";
  testReport: { name: string; passed: boolean; error?: string; output?: unknown }[];
  usedBy: string[];
}

export type TriggerDef =
  | { id: string; type: "schedule"; cron?: string; every?: string; timezone?: string; enabled: boolean; description?: string; input?: unknown }
  | { id: string; type: "webhook"; respond: boolean; enabled: boolean; description?: string; input?: unknown }
  | {
      id: string;
      type: "poll";
      source: { kind: "rss" | "json" | "page"; url: string; itemsPath?: string; idPath?: string };
      every: string;
      skipExisting: boolean;
      maxPerCheck: number;
      enabled: boolean;
      description?: string;
      input?: unknown;
    }
  | { id: string; type: "agent"; agentId: string; on: "completed" | "failed" | "any"; enabled: boolean; description?: string; input?: unknown };

export interface TriggerView {
  agentId: string;
  agentName: string;
  version: number;
  trigger: TriggerDef;
  enabled: boolean;
  schedule?: string;
  webhookPath?: string;
  state: {
    nextAt?: number;
    lastCheckedAt?: number;
    lastFiredAt?: number;
    lastRunId?: string;
    lastStatus?: string;
    lastError?: string;
    fireCount: number;
    skippedOverlap: number;
    queued?: number;
  };
}

export interface McpServerStatus {
  config: {
    name: string;
    transport: "stdio" | "http";
    command?: string;
    args: string[];
    env: Record<string, string>;
    url?: string;
    headers: Record<string, string>;
    enabled: boolean;
    description?: string;
  };
  connected: boolean;
  error?: string;
  serverInfo?: { name?: string; version?: string };
  tools: { name: string; type: string; description?: string; readOnly: boolean; approved: boolean }[];
}

export type BenchReport = import("../../../src/bench/runner").BenchReport & {
  delta: { cases: { id: string; score: number | null; costUsd: number | null }[]; meanScore: number | null; costUsd: number | null };
};

export interface ValidationResult {
  valid: boolean;
  errors: number;
  warnings: number;
  diagnostics: Diagnostic[];
}

export interface GateDecisionView {
  at: number;
  client: string;
  project: string;
  version?: string;
  file?: string;
  decision: "allowed" | "blocked";
  reason: string;
}

export interface SandboxStatus {
  available: boolean;
  reason?: string;
  mode: "docker" | "off";
  network: "isolated" | "allowlist" | "open";
  image: string;
  pool: number;
  timeoutMs: number;
  memory: string;
  cpus: number;
  maxSecondsPerRun: number;
  gate: { index: string; vulnCheck: "osv" | "off"; allow: string[]; deny: string[] };
  decisions: GateDecisionView[];
}

export interface AgentSandbox {
  allowlist: { plan: string[]; request: string[]; approved: string[] };
  maxSeconds: number | null;
  network: SandboxStatus["network"];
}

export interface Health {
  ok: boolean;
  keyConfigured: boolean;
  models: { llm: string; decision: string };
  tiers: Record<string, { model: string; reasoning: string }>;
  providerSort: string;
}

export interface ModelsCheck {
  enabled: boolean;
  builders: string[];
  judge: string;
  ok: string[];
  failed: { model: string; error: string }[];
}

export type HealthStatus = "healthy" | "broken" | "unknown";

export interface HealthCheck {
  at: number;
  version: number;
  status: HealthStatus;
  score: number | null;
  passRate: number | null;
  baseline: number | null;
  tests: number;
  failed: string[];
  cause?: string;
  costUsd: number;
  fixRunId?: string;
}

export interface AgentHealth {
  agentId: string;
  status: HealthStatus;
  last?: HealthCheck;
  history: HealthCheck[];
}

export interface Feedback {
  id: string;
  agentId: string;
  version: number;
  runId: string;
  reason: string;
  expected?: string;
  testId: string;
  criteria: string[];
  at: number;
}

export interface FeedbackTest {
  id: string;
  name: string;
  input: Record<string, unknown>;
  criteria: string[];
  checks: [];
}

export interface SecretState {
  enabled: boolean;
  secrets: { name: string; source: "ui" | "env"; updatedAt?: number; hint: string }[];
  needed: { name: string; usedBy: string[] }[];
  hostHeaders: Record<string, Record<string, string>>;
  envHostHeaders: string[];
}

const TOKEN_KEY = "anvilToken";

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // The request will show the token dialog again if storage is unavailable.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage may be unavailable in a restricted browser.
  }
}

export function withToken(url: string): string {
  const token = getToken();
  if (!token) return url;
  return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function reportUnauthorized(status: number): void {
  if (status === 401) window.dispatchEvent(new Event("anvil:unauthorized"));
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { ...authHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    reportUnauthorized(res.status);
    const err = new Error((data as { error?: string }).error ?? `HTTP ${res.status}`) as Error & { data?: unknown };
    err.data = data;
    throw err;
  }
  return data as T;
}

/** An attached file (docs/FILES.md): its metadata and the start of its content. */
export interface FileView {
  id: string;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  kind: "text" | "table" | "json" | "pdf" | "document" | "image" | "other";
  pages: number | null;
  sheets: { name: string; columns: string[]; totalRows: number }[] | null;
  chars: number;
  truncated: boolean;
  note: string | null;
  preview: string;
}

/** Uploads files as multipart form data. The server reads each file now. */
async function uploadFiles(list: File[]): Promise<FileView[]> {
  const form = new FormData();
  for (const f of list) form.append("file", f, f.name);
  const res = await fetch("/api/files", { method: "POST", headers: authHeaders(), body: form });
  const data = (await res.json().catch(() => ({}))) as { files?: FileView[]; error?: string };
  if (!res.ok) {
    reportUnauthorized(res.status);
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data.files ?? [];
}

function health(): Promise<Health>;
function health(agentId: string): Promise<AgentHealth>;
function health(agentId?: string): Promise<Health | AgentHealth> {
  return agentId ? req<AgentHealth>("GET", `/api/health/agents/${agentId}`) : req<Health>("GET", "/api/health");
}

export const api = {
  uploadFiles,
  file: (id: string) => req<FileView>("GET", `/api/files/${id}`),
  deleteFile: (id: string) => req<{ deleted: boolean }>("DELETE", `/api/files/${id}`),
  health,
  healthList: () => req<AgentHealth[]>("GET", "/api/health/agents"),
  checkHealth: (agentId: string) => req<AgentHealth>("POST", `/api/health/agents/${agentId}/check`),
  registry: () => req<{ classes: NodeClassInfo[]; tools: { name: string; description: string; sideEffects: boolean }[] }>("GET", "/api/registry"),
  agents: () => req<AgentSummary[]>("GET", "/api/agents"),
  agent: (id: string) => req<StoredAgent>("GET", `/api/agents/${id}`),
  validate: (spec: unknown) => req<ValidationResult>("POST", "/api/validate", { spec }),
  importAgent: (spec: unknown) => req<AgentSummary>("POST", "/api/agents", { spec }),
  saveAgent: (id: string, spec: unknown, note?: string) => req<AgentSummary>("PUT", `/api/agents/${id}`, { spec, note }),
  setCurrent: (id: string, version: number) => req<AgentSummary>("POST", `/api/agents/${id}/current`, { version }),
  deleteAgent: (id: string) => req<{ ok: boolean }>("DELETE", `/api/agents/${id}`),
  run: (id: string, input: unknown, version?: number) => req<{ runId: string }>("POST", `/api/agents/${id}/run`, { input, version }),
  createSession: (agentId: string, version?: number, message?: string) =>
    req<{ session: Session } | ConverseResult>("POST", `/api/agents/${agentId}/sessions`, { version, message }),
  listSessions: (agentId: string) => req<Session[]>("GET", `/api/agents/${agentId}/sessions`),
  getSession: (sid: string) => req<Session>("GET", `/api/sessions/${sid}`),
  sendMessage: (sid: string, content: string) => req<ConverseResult>("POST", `/api/sessions/${sid}/messages`, { content }),
  deleteSession: (sid: string) => req<{ ok: true }>("DELETE", `/api/sessions/${sid}`),
  build: (body: {
    request: string;
    candidates?: number | "auto";
    clarify?: boolean;
    evaluate?: boolean;
    optimize?: boolean;
    testCount?: number;
    useLibrary?: boolean;
    examples?: string[];
    excludeExamples?: string[];
    files?: string[];
    tools?: unknown;
  }) => req<{ runId: string }>("POST", "/api/build", body),
  modelsCheck: () => req<ModelsCheck>("GET", "/api/models/check"),
  library: () => req<LibraryView>("GET", "/api/library"),
  classifyLibrary: (force = false) => req<{ classified: { agentId: string; taxonomy: Taxonomy }[] }>("POST", "/api/library/classify", { force }),
  deleteLesson: (domain: string, id: string) => req<{ deleted: boolean }>("DELETE", `/api/library/lessons/${encodeURIComponent(domain)}/${encodeURIComponent(id)}`),
  refine: (id: string, instruction: string, optimize = false) => req<{ runId: string }>("POST", `/api/agents/${id}/refine`, { instruction, optimize }),
  evaluate: (id: string, version?: number) => req<{ runId: string }>("POST", `/api/agents/${id}/evaluate`, { version }),
  evolve: (id: string, rounds = 2) => req<{ runId: string }>("POST", `/api/agents/${id}/evolve`, { rounds }),
  runs: (q: { agentId?: string; kind?: string; limit?: number; parent?: string } = {}) => {
    const p = new URLSearchParams(
      Object.entries(q)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, String(v)]),
    );
    return req<RunSummary[]>("GET", `/api/runs?${p}`);
  },
  runRecord: (id: string) => req<RunRecord & { active: boolean; pending: { nodeId: string; request: HumanRequest }[] }>("GET", `/api/runs/${id}`),
  giveFeedback: (runId: string, reason: string, expected?: string) =>
    req<{ feedback: Feedback; test: FeedbackTest }>("POST", `/api/runs/${runId}/feedback`, { reason, ...(expected ? { expected } : {}) }),
  feedbackList: (agentId: string) => req<Feedback[]>("GET", `/api/agents/${agentId}/feedback`),
  improveFromFeedback: (agentId: string) => req<{ runId: string }>("POST", `/api/agents/${agentId}/improve`, {}),
  resume: (id: string, nodeId: string, value: unknown) => req<{ ok: boolean }>("POST", `/api/runs/${id}/resume`, { nodeId, value }),
  cancel: (id: string) => req<{ ok: boolean }>("POST", `/api/runs/${id}/cancel`),
  classes: () => req<CustomClass[]>("GET", "/api/classes"),
  saveClass: (def: unknown) => req<{ class: CustomClass; diagnostics: Diagnostic[] }>("POST", "/api/classes", { def }),
  generateClass: (request: string) => req<{ runId: string }>("POST", "/api/classes/generate", { request }),
  approveClass: (type: string, approved: boolean) => req<CustomClass>("POST", `/api/classes/${type}/approve`, { approved }),
  retestClass: (type: string) => req<CustomClass>("POST", `/api/classes/${type}/test`),
  deleteClass: (type: string, force = false) => req<{ ok: boolean }>("DELETE", `/api/classes/${type}${force ? "?force=true" : ""}`),
  triggers: (agentId?: string) => req<TriggerView[]>("GET", `/api/triggers${agentId ? `?agentId=${agentId}` : ""}`),
  saveTrigger: (agentId: string, trigger: unknown) => req<TriggerView[]>("POST", `/api/agents/${agentId}/triggers`, { trigger }),
  deleteTrigger: (agentId: string, id: string) => req<TriggerView[]>("DELETE", `/api/agents/${agentId}/triggers/${id}`),
  setTriggerEnabled: (agentId: string, id: string, enabled: boolean) => req<TriggerView[]>("PATCH", `/api/agents/${agentId}/triggers/${id}`, { enabled }),
  fireTrigger: (agentId: string, id: string, input?: unknown) =>
    req<{ runId?: string; queued?: boolean; eventId?: string; position?: number }>("POST", `/api/agents/${agentId}/triggers/${id}/fire`, { input }),
  webhookInfo: (agentId: string, id: string, rotate = false) =>
    req<{ url: string; token: string; curl: string; auth?: "either" | "hmac" | "token"; signature?: string; curlSigned?: string }>(
      "GET",
      `/api/agents/${agentId}/triggers/${id}/webhook${rotate ? "?rotate=true" : ""}`,
    ),
  sandboxStatus: () => req<SandboxStatus>("GET", "/api/sandbox/status"),
  agentSandbox: (id: string) => req<AgentSandbox>("GET", `/api/agents/${id}/sandbox`),
  saveAgentSandbox: (id: string, allowDomains: string[]) => req<{ allowlist: AgentSandbox["allowlist"] }>("PUT", `/api/agents/${id}/sandbox`, { allowDomains }),
  mcpServers: () => req<McpServerStatus[]>("GET", "/api/mcp/servers"),
  addMcpServer: (server: unknown) =>
    req<{ sync: { added: string[]; failed: { tool: string; error: string }[] }; servers: McpServerStatus[] }>("POST", "/api/mcp/servers", { server }),
  refreshMcpServer: (name: string) => req<{ servers: McpServerStatus[] }>("POST", `/api/mcp/servers/${name}/refresh`),
  approveMcpServer: (name: string, approved = true) => req<{ changed: number }>("POST", `/api/mcp/servers/${name}/approve`, { approved }),
  removeMcpServer: (name: string, force = false) => req<{ ok: boolean }>("DELETE", `/api/mcp/servers/${name}${force ? "?force=true" : ""}`),
  mcpExpose: () => req<{ url: string; tokenRequired: boolean; tools: string[]; snippets: { claudeCode: string; claudeDesktop: string; cursor: string } }>("GET", "/api/mcp/expose"),
  secrets: () => req<SecretState>("GET", "/api/secrets"),
  setSecret: (name: string, value: string) => req<SecretState>("PUT", `/api/secrets/${encodeURIComponent(name)}`, { value }),
  deleteSecret: (name: string) => req<SecretState>("DELETE", `/api/secrets/${encodeURIComponent(name)}`),
  setHostHeaders: (host: string, headers: Record<string, string>) => req<SecretState>("PUT", `/api/host-headers/${encodeURIComponent(host)}`, { headers }),
  bench: () => req<BenchReport[]>("GET", "/api/bench"),
  usage: () =>
    req<{
      totals: { runs: number; costUsd: number; llmCalls: number; decisionCalls: number; inputTokens: number; outputTokens: number; failures: number };
      byKind: Record<string, { runs: number; costUsd: number; llmCalls: number; decisionCalls: number; tokens: number }>;
      byDay: Record<string, { costUsd: number; runs: number }>;
      byAgent: Record<string, { name: string; runs: number; costUsd: number; failures: number }>;
    }>("GET", "/api/usage"),
};
