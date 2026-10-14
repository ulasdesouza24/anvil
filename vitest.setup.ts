import { sandboxReady } from "./src/core/tools/text.js";

// The code sandbox (QuickJS) loads before each test file, as the server loads it at the start.
await sandboxReady;
