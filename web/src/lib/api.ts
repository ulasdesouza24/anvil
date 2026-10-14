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
  /** "editor": a test run of the workflow editor. */
  origin?: "editor";
  dryRun?: boolean;
  targetNodeId?: string;
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
  sideEffects?: boolean;
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

/* ------------------------- workflow editor (docs/WORKFLOW_EDITOR.md) ------------------------- */

export type PinData = Record<string, { output: unknown; ports?: string[] }>;

/** The unsaved work of the workflow editor for one agent. */
export interface WorkflowDraft {
  agentId: string;
  baseVersion: number;
  spec: AgentSpec;
  pinData?: PinData;
  testInput?: unknown;
  updatedAt: number;
}

/** The static view of one step: its ports (with "error" last), its output fields, and if it changes the outside world. */
export interface NodeInspection {
  ports: string[];
  outputSchema?: Record<string, unknown>;
  sideEffects: boolean;
  category?: string;
  title?: string;
}

export interface Inspection {
  valid: boolean;
  errors: number;
  warnings: number;
  diagnostics: Diagnostic[];
  nodes: Record<string, NodeInspection>;
}

export interface SpecDiff {
  added: string[];
  removed: string[];
  changed: { id: string; fields: string[] }[];
  moved: string[];
  edgesAdded: AgentSpec["edges"];
  edgesRemoved: AgentSpec["edges"];
  fields: string[];
}

export interface MergeResult {
  spec: AgentSpec;
  conflicts: { kind: "node" | "field"; id: string }[];
}

/** The answer of a save that started from an older version (HTTP 409). */
export interface SaveConflict {
  error: string;
  conflict: true;
  baseVersion: number;
  latestVersion: number;
  merge?: MergeResult;
  theirs: AgentSpec;
}

export interface TestWebhookEvent {
  payload: unknown;
  headers: Record<string, string>;
  query: Record<string, string>;
  /** The agent input that the trigger maps the event to. */
  input: unknown;
}

export type WorkflowRunMode = "full" | "to_node" | "node_only";

/* ------------------------- accounts, settings, bazaar (docs/HOSTING.md) ------------------------- */

/** The API address. Empty: the same origin (the local Anvil, or a proxy). A web app on Vercel sets VITE_API_BASE. */
export const API_BASE = ((import.meta.env.VITE_API_BASE as string | undefined) ?? "").replace(/\/+$/, "");

export interface Account {
  id: string;
  username: string;
  createdAt: number;
}

export interface SettingField {
  path: string;
  group: string;
  label: string;
  help: string;
  type: "number" | "integer" | "boolean" | "enum" | "text" | "list";
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  unit?: string;
}

export interface Me {
  hosted: boolean;
  account: Account | null;
  models: { llm: string; decision: string };
  key: { configured: boolean; hint: string | null; fromEnv: boolean };
  settings: { values: Record<string, unknown>; overrides: Record<string, unknown>; defaults: Record<string, unknown> };
  fields: SettingField[];
  groups: string[];
}

export interface ListingSummary {
  id: string;
  ownerId: string;
  owner: string;
  agentId: string;
  version: number;
  title: string;
  description: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  uses: number;
  steps: number;
  stepTypes: string[];
  inputs: string[];
}

export interface Listing extends ListingSummary {
  spec: AgentSpec;
  classes: { type: string; title: string; kind: string; sideEffects: boolean }[];
  mine: boolean;
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
  const full = `${API_BASE}${url}`;
  if (!token) return full;
  return `${full}${full.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
}

function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function reportUnauthorized(status: number): void {
  if (status === 401) window.dispatchEvent(new Event("anvil:unauthorized"));
}

async function req<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    signal,
    headers: { ...authHeaders(), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    reportUnauthorized(res.status);
    const err = new Error((data as { error?: string }).error ?? `HTTP ${res.status}`) as Error & { data?: unknown; status?: number };
    err.data = data;
    err.status = res.status;
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
  const res = await fetch(`${API_BASE}/api/files`, { method: "POST", headers: authHeaders(), body: form });
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
  // Accounts, settings and the Agent Bazaar (docs/HOSTING.md, docs/BAZAAR.md).
  app: () => req<{ hosted: boolean; decisionModel: string }>("GET", "/api/app"),
  register: (username: string, password: string) => req<{ account: Account; token: string }>("POST", "/api/auth/register", { username, password }),
  login: (username: string, password: string) => req<{ account: Account; token: string }>("POST", "/api/auth/login", { username, password }),
  logoutAll: () => req<{ ok: true }>("POST", "/api/auth/logout-all"),
  /** Deletes the account and all its data. The password confirms it. */
  deleteAccount: (password: string) => req<{ deleted: true }>("DELETE", "/api/me", { password }),
  me: () => req<Me>("GET", "/api/me"),
  saveSettings: (values: Record<string, unknown>) => req<Me>("PUT", "/api/me/settings", { values }),
  saveKey: (apiKey: string) => req<Me>("PUT", "/api/me/key", { apiKey }),
  saveUsername: (username: string) => req<Me>("PUT", "/api/me/username", { username }),
  savePassword: (current: string, next: string) => req<{ token: string }>("PUT", "/api/me/password", { current, next }),
  bazaar: (q: { q?: string; sort?: "new" | "popular"; mine?: boolean } = {}) =>
    req<ListingSummary[]>(
      "GET",
      `/api/bazaar?${new URLSearchParams(
        Object.entries(q)
          .filter(([, v]) => v !== undefined && v !== "" && v !== false)
          .map(([k, v]) => [k, String(v)]),
      )}`,
    ),
  listing: (id: string) => req<Listing>("GET", `/api/bazaar/${id}`),
  shareAgent: (body: { agentId: string; version?: number; title?: string; description?: string; tags?: string[] }) => req<ListingSummary>("POST", "/api/bazaar", body),
  unshare: (id: string) => req<{ ok: true }>("DELETE", `/api/bazaar/${id}`),
  useListing: (id: string) => req<{ agentId: string; classes: string[] }>("POST", `/api/bazaar/${id}/use`),
  exportAgent: (id: string, version?: number) => req<AgentSpec>("GET", `/api/agents/${id}/export${version ? `?version=${version}` : ""}`),
  // The workflow editor (docs/WORKFLOW_EDITOR.md).
  inspect: (spec: AgentSpec) => req<Inspection>("POST", "/api/workflow/inspect", { spec }),
  diffSpecs: (a: AgentSpec, b: AgentSpec) => req<SpecDiff>("POST", "/api/workflow/diff", { a, b }),
  mergeSpecs: (base: AgentSpec, ours: AgentSpec, theirs: AgentSpec) => req<MergeResult>("POST", "/api/workflow/merge", { base, ours, theirs }),
  createBlank: (name?: string) => req<AgentSummary>("POST", "/api/agents/blank", { name }),
  draft: (agentId: string) => req<WorkflowDraft>("GET", `/api/agents/${agentId}/draft`),
  saveDraft: (agentId: string, draft: Pick<WorkflowDraft, "spec" | "baseVersion"> & Partial<Pick<WorkflowDraft, "pinData" | "testInput">>) =>
    req<{ ok: true; updatedAt: number; latestVersion: number }>("PUT", `/api/agents/${agentId}/draft`, draft),
  discardDraft: (agentId: string) => req<{ deleted: boolean }>("DELETE", `/api/agents/${agentId}/draft`),
  /** Saves the draft as a new version. A newer version than baseVersion throws an error with data: SaveConflict. */
  publishDraft: (agentId: string, spec: AgentSpec, baseVersion: number, note?: string, force = false) =>
    req<{ agent: AgentSummary; version: number }>("POST", `/api/agents/${agentId}/draft/save`, { spec, baseVersion, note, force }),
  /** A test run of the draft. dryRun defaults to true: actions with a side effect give a preview. */
  runWorkflow: (body: { agentId: string; spec: AgentSpec; input?: unknown; mode?: WorkflowRunMode; target?: string; pinData?: PinData; reuseRunId?: string; dryRun?: boolean }) =>
    req<{ runId: string }>("POST", "/api/workflow/run", body),
  /** The AI assistant: a run of anvil-assistant. Its output is {spec, summary}: the person accepts or rejects it. */
  assist: (agentId: string, spec: AgentSpec, instruction: string, selection?: string[]) =>
    req<{ runId: string }>("POST", "/api/workflow/assist", { agentId, spec, instruction, selection }),
  listenWebhook: (agentId: string, triggerId: string, timeoutMs = 120_000, signal?: AbortSignal) =>
    req<{ captured: boolean; event?: TestWebhookEvent }>("POST", `/api/agents/${agentId}/triggers/${triggerId}/listen`, { timeoutMs }, signal),
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
  saveAgent: (id: string, spec: unknown, note?: string, baseVersion?: number) => req<AgentSummary>("PUT", `/api/agents/${id}`, { spec, note, baseVersion }),
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
  /** origin "editor" gives only the test runs of the workflow editor, "!editor" leaves them out. */
  runs: (q: { agentId?: string; kind?: string; limit?: number; parent?: string; origin?: "editor" | "!editor" } = {}) => {
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
