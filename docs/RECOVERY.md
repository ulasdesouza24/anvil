# Recovery: a waiting run after a restart

A run can wait for a person: a `human_approval` or a `human_input` step. Before, a restart of the server failed each waiting run. Now the run starts again. The code is in `src/runtime/runManager.ts` (`recover`) and `src/core/engine.ts` (`replay`).

## How it works

1. When a step finishes, the run manager keeps its full output and its ports in memory: the checkpoint.
2. When a step starts to wait for a person, the checkpoint goes to the run record on disk at once.
3. When the server starts, the store keeps a waiting top run that has a checkpoint. It does not mark it as failed.
4. `recover()` starts each such run again with the same run id. The steps of the checkpoint replay: they give their recorded output and do not run again.
5. The waiting step asks the person again. The answer continues the run.
6. When the run ends, the record has no checkpoint. Its cost is the cost before the restart and the cost after it.

The recovered run has the log line "recovered after a restart". Each replayed step has the log line "replayed".

## Limits

- Only a top run that waits recovers. A run that runs (not waits) at the restart fails with "Interrupted", because a step of it can be in the middle of an action.
- A wait inside a sub-agent replays the parent step: the sub-agent runs again from its start. The effect record (docs/EFFECTS.md) stops a second send of its done actions.
- A step that was in the middle of an action at the restart runs again. The effect record finds the started action and fails the step with a clear message. It does not send it two times.
- The checkpoint masks the values of secrets (docs/SECRETS.md), the same as the run record.
