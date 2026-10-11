"""The Anvil SDK for programs in the sandbox.

    from anvil import tools, classes, result

    page = tools.web_fetch(url="https://example.com")
    rows = classes.x_src_rates(base="EUR")
    install("rapidfuzz==3.9.7")   # through the package gate, wheels only
    pages = tools.parallel([("web_fetch", {"url": u}) for u in urls])
    result({"count": len(rows["rates"])})

Each call goes to the Anvil host. The host applies the rules of the agent:
the tool allowlist, the budgets, robots.txt, the egress policy, and approvals.
"""
from ._bridge import ToolError, request

__all__ = ["tools", "classes", "result", "install", "ToolError"]

_RESULT = {"set": False, "value": None}


class _Tools:
    """Calls Anvil agent tools: tools.web_fetch(url=...), tools.http_request(...)."""

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def call(**args):
            return request({"type": "call", "tool": name, "args": args})

        call.__name__ = name
        return call

    def parallel(self, calls):
        """Runs several tool calls at the same time. calls: a list of (tool, args) pairs."""
        items = [{"tool": t, "args": a or {}} for t, a in calls]
        return request({"type": "parallel", "calls": items})


class _Classes:
    """Calls tested node classes of the Anvil library: classes.x_src_rates(base="EUR")."""

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)

        def call(**config):
            return request({"type": "call", "tool": "class:" + name, "args": config})

        call.__name__ = name
        return call


tools = _Tools()
classes = _Classes()


def result(value):
    """Sets the result of the program. Only this value goes back to the agent."""
    _RESULT["set"] = True
    _RESULT["value"] = value
    return value


def install(*packages):
    """Installs packages through the package gate (OSV-checked wheels only).

    Returns the record of the install. A blocked package raises ToolError with the reason.
    """
    import importlib
    import sys

    record = request({"type": "install", "packages": list(packages)})
    if "/work/.packages" not in sys.path:
        sys.path.insert(0, "/work/.packages")
    importlib.invalidate_caches()
    return record
