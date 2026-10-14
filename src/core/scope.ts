import { AsyncLocalStorage } from "node:async_hooks";

/**
 * The scope of a workspace (docs/HOSTING.md). A hosted Anvil has one workspace for each user. A request, a run,
 * and a trigger of a user run in the scope of that user, so a secret lookup reads only the secrets of that user.
 * Outside a scope (the local, single-user Anvil, the CLI, the tests), the process environment is the source.
 */
export interface WorkspaceScope {
  /** The secrets of the workspace (name → value). A hosted workspace never reads the process environment. */
  env: Record<string, string | undefined>;
  /** Host headers from the UI of the workspace (host → header → template with ${NAME}). */
  hostHeaders: Record<string, Record<string, string>>;
}

const storage = new AsyncLocalStorage<WorkspaceScope>();

/** Runs fn in the scope. Timers, promises, and runs that start in fn keep the scope. */
export function runInScope<T>(scope: WorkspaceScope, fn: () => T): T {
  return storage.run(scope, fn);
}

export function currentScope(): WorkspaceScope | undefined {
  return storage.getStore();
}

/** The secrets of the current workspace, or the process environment outside a workspace. */
export function currentEnv(): Record<string, string | undefined> {
  return storage.getStore()?.env ?? process.env;
}
