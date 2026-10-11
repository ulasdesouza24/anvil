"""Runs one program of an agent (docs/SANDBOX.md, section 2.4).

Input: the first line on stdin is {"code": "..."}.
Output: protocol lines on stdout. The last line is
{"type": "done", "result": ..., "stdout": "...", "error": null | "..."}.
"""
import contextlib
import io
import json
import os
import sys
import traceback

MAX_OUTPUT = int(os.environ.get("ANVIL_MAX_OUTPUT", "1000000"))
PACKAGES = "/work/.packages"


def main():
    first = sys.__stdin__.readline()
    try:
        job = json.loads(first)
    except ValueError:
        job = {"code": ""}
    if os.path.isdir(PACKAGES) and PACKAGES not in sys.path:
        sys.path.insert(0, PACKAGES)

    import anvil  # noqa: E402  (the SDK must load after the path setup)

    buffer = io.StringIO()
    error = None
    # Large input data comes as DATA, not in the code (see the code_agent node).
    scope = {"__name__": "__main__", "DATA": job.get("data") or {}}
    with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
        try:
            exec(compile(job.get("code", ""), "<agent program>", "exec"), scope)
        except SystemExit:
            pass
        except BaseException:  # the agent must see each error of its program
            error = traceback.format_exc(limit=8)

    value = anvil._RESULT["value"] if anvil._RESULT["set"] else scope.get("RESULT")
    out = buffer.getvalue()
    truncated = len(out) > MAX_OUTPUT
    done = {"type": "done", "result": value, "stdout": out[:MAX_OUTPUT], "truncated": truncated, "error": error}
    text = json.dumps(done, default=str)
    if len(text) > MAX_OUTPUT * 2:
        done = {"type": "done", "result": None, "stdout": out[:MAX_OUTPUT], "truncated": True, "error": error or "the result is too large"}
        text = json.dumps(done, default=str)
    sys.__stdout__.write(text + "\n")
    sys.__stdout__.flush()


if __name__ == "__main__":
    main()
