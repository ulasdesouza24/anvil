"""The bridge to the Anvil host: one JSON line out, one JSON line back (docs/SANDBOX.md, section 2.4).

The protocol uses the real stdin and stdout of the process. The runner sends
the print output of the program to a buffer, so it does not mix with the protocol.
"""
import json
import sys
import threading

_lock = threading.Lock()
_next_id = 0


class ToolError(Exception):
    """A tool call that the host rejected or that failed on the host."""


def _send(message):
    sys.__stdout__.write(json.dumps(message, default=str) + "\n")
    sys.__stdout__.flush()


def _receive(expected_id):
    line = sys.__stdin__.readline()
    if not line:
        raise ToolError("the host closed the bridge")
    answer = json.loads(line)
    if answer.get("id") != expected_id:
        raise ToolError(f"bridge protocol error: expected answer {expected_id}, got {answer.get('id')}")
    return answer


def request(message):
    """Sends one request to the host and waits for its answer."""
    global _next_id
    with _lock:
        _next_id += 1
        message = {**message, "id": _next_id}
        _send(message)
        answer = _receive(_next_id)
    if not answer.get("ok"):
        raise ToolError(answer.get("error") or "the tool call failed")
    return answer.get("value")
