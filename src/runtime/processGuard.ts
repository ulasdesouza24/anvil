/**
 * A promise error without a handler stops a Node process by default. In Anvil such an
 * error comes from the code of one step (for example agent-written code). It must not
 * stop the server, the CLI, or a benchmark with all their other runs. The guard logs it.
 */
let installed = false;

export function guardProcess(name: string, log: (message: string) => void = (m) => console.error(m)): void {
  if (installed) return;
  installed = true;
  process.on("unhandledRejection", (reason) => {
    const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    log(`[${name}] a promise failed without a handler. The process continues.\n${text.slice(0, 2000)}`);
  });
}
