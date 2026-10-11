import { buildCustomClass, CustomClassDefZ, testClassDef, validateClassDef, type ClassRuntimeEnv, type CustomClassDef } from "../core/customClass.js";
import type { Registry } from "../core/registry.js";
import type { Diagnostic } from "../core/types.js";
import type { Brain } from "../llm/brain.js";
import type { FileStore } from "../store/fileStore.js";

export interface ClassService {
  list(): CustomClassDef[];
  get(type: string): CustomClassDef | undefined;
  /** Validate, (optionally) test, persist and register a class definition. */
  save(raw: unknown, opts?: { brain?: Brain; test?: boolean; createdBy?: string }): Promise<{ def?: CustomClassDef; diagnostics: Diagnostic[] }>;
  approve(type: string, approved: boolean): Promise<CustomClassDef>;
  retest(type: string, brain: Brain): Promise<CustomClassDef>;
  remove(type: string): Promise<boolean>;
  /** Agents that use a class (to warn before deleting it). */
  usedBy(type: string): string[];
}

/** Owns the lifecycle of runtime-defined node classes: store ⇄ registry. */
export class ClassManager implements ClassService {
  /** Runtime services that class tests can use (the browser, MCP). Set after they exist. */
  private runtime: ClassRuntimeEnv = {};

  constructor(
    private store: FileStore,
    private registry: Registry,
  ) {}

  attach(runtime: ClassRuntimeEnv) {
    this.runtime = { ...this.runtime, ...runtime };
  }

  /** Register every stored class at boot; invalid ones are skipped with a warning. */
  loadAll(): number {
    let n = 0;
    for (const raw of this.store.listClassDefs()) {
      const { def, diagnostics } = validateClassDef(raw, this.registry);
      const errors = diagnostics.filter((d) => d.severity === "error");
      if (!def || errors.length) {
        console.warn(`[classes] skipping ${String(raw.type)}: ${errors.map((d) => d.message).join("; ")}`);
        continue;
      }
      this.registry.upsert(buildCustomClass(def));
      n++;
    }
    return n;
  }

  list(): CustomClassDef[] {
    return this.store.listClassDefs().map((c) => CustomClassDefZ.parse(c));
  }

  get(type: string): CustomClassDef | undefined {
    const raw = this.store.getClassDef(type);
    return raw ? CustomClassDefZ.parse(raw) : undefined;
  }

  async save(raw: unknown, opts: { brain?: Brain; test?: boolean; createdBy?: string } = {}) {
    const input = { ...(raw as Record<string, unknown>), ...(opts.createdBy ? { createdBy: opts.createdBy } : {}) };
    const { def, diagnostics } = validateClassDef(input, this.registry);
    if (!def || diagnostics.some((d) => d.severity === "error")) return { def: undefined, diagnostics };
    let next: CustomClassDef = { ...def, createdAt: this.get(def.type)?.createdAt ?? Date.now() };
    // Classes that can change the outside world start unapproved when a model wrote them.
    // Tools that a person or a platform gives (createdBy "given") are approved: they are the tools of the task.
    if (next.sideEffects && next.createdBy !== "user" && next.createdBy !== "given") next.approved = this.get(def.type)?.approved ?? false;
    if (opts.test !== false && opts.brain) {
      const t = await testClassDef(next, opts.brain, this.runtime);
      next = { ...next, status: t.status, testReport: t.report };
      if (t.skippedReason) diagnostics.push({ severity: "info", code: "CLASS_TEST_SKIPPED", message: t.skippedReason });
    }
    const saved = CustomClassDefZ.parse(await this.store.saveClassDef(next));
    this.registry.upsert(buildCustomClass(saved));
    return { def: saved, diagnostics };
  }

  async approve(type: string, approved: boolean) {
    const def = this.get(type);
    if (!def) throw new Error(`class ${type} not found`);
    const saved = CustomClassDefZ.parse(await this.store.saveClassDef({ ...def, approved }));
    this.registry.upsert(buildCustomClass(saved));
    return saved;
  }

  async retest(type: string, brain: Brain) {
    const def = this.get(type);
    if (!def) throw new Error(`class ${type} not found`);
    const t = await testClassDef(def, brain, this.runtime);
    const saved = CustomClassDefZ.parse(await this.store.saveClassDef({ ...def, status: t.status, testReport: t.report }));
    this.registry.upsert(buildCustomClass(saved));
    return saved;
  }

  async remove(type: string) {
    const ok = await this.store.deleteClassDef(type);
    if (ok) this.registry.remove(type);
    return ok;
  }

  usedBy(type: string): string[] {
    return this.store
      .listAgents()
      .filter((a) =>
        a.versions
          .find((v) => v.version === a.currentVersion)
          ?.spec.nodes.some((n) => n.type === type || (n.type === "map" && (n.config as { nodeType?: string }).nodeType === type)),
      )
      .map((a) => a.id);
  }
}
