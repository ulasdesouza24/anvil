"""The anvil-gate sidecar (docs/SANDBOX.md, sections 2.8 and 2.9).

The sidecar is on two networks: the internal sandbox network and the default
bridge. On port 3141, it forwards only GET requests for the package index
(/simple/...) and for package files (/files/...) to the package gate on the
Anvil host. It adds the address of the client, so the gate can tell which
sandbox asked. On port 3128, it is the forward proxy of the allowlist mode:
the host decides for each domain.
"""
import http.server
import os
import select
import socket
import socketserver
import urllib.error
import urllib.parse
import urllib.request

TARGET = os.environ["ANVIL_GATE_TARGET"]  # for example http://host.docker.internal:3141
ALLOWED = ("/simple/", "/files/")


class Proxy(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if not self.path.startswith(ALLOWED) or ".." in self.path:
            self.send_error(404, "not a package path")
            return
        req = urllib.request.Request(TARGET + self.path, headers={"Accept": self.headers.get("Accept", "*/*"), "X-Anvil-Client": self.client_address[0]})
        try:
            with urllib.request.urlopen(req, timeout=120) as res:
                self.send_response(res.status)
                for k, v in res.headers.items():
                    if k.lower() in ("content-type", "content-length"):
                        self.send_header(k, v)
                self.end_headers()
                while chunk := res.read(65536):
                    self.wfile.write(chunk)
        except urllib.error.HTTPError as e:
            self.send_error(e.code, e.reason)
        except Exception as e:  # the gate is not available
            self.send_error(502, str(e)[:200])

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


def egress_allowed(client, host, port):
    """Asks the Anvil host if this sandbox may contact host:port (the allowlist of its run)."""
    q = urllib.parse.urlencode({"client": client, "host": host, "port": port})
    try:
        with urllib.request.urlopen(f"{TARGET}/egress?{q}", timeout=10) as res:
            return res.status == 200, ""
    except urllib.error.HTTPError as e:
        return False, e.read().decode("utf-8", "replace")[:300]
    except Exception as e:
        return False, f"the egress check is not available: {e}"[:300]


class EgressProxy(http.server.BaseHTTPRequestHandler):
    """The forward proxy of the allowlist mode. It checks only the domain: an HTTPS tunnel hides the method and the body."""

    def _deny(self, reason):
        self.send_response(403, "Blocked by the egress policy")
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(f"Blocked by the egress policy: {reason}".encode())

    def do_CONNECT(self):
        host, _, port = self.path.partition(":")
        ok, reason = egress_allowed(self.client_address[0], host, port or "443")
        if not ok:
            return self._deny(reason)
        try:
            upstream = socket.create_connection((host, int(port or 443)), timeout=30)
        except OSError as e:
            self.send_error(502, str(e)[:200])
            return
        self.send_response(200, "Connection established")
        self.end_headers()
        conns = [self.connection, upstream]
        try:
            while True:
                readable, _, broken = select.select(conns, [], conns, 60)
                if broken or not readable:
                    break
                for c in readable:
                    data = c.recv(65536)
                    if not data:
                        return
                    (upstream if c is self.connection else self.connection).sendall(data)
        finally:
            upstream.close()

    def _forward(self):
        u = urllib.parse.urlsplit(self.path)
        if u.scheme != "http" or not u.hostname:
            return self._deny("only absolute http URLs and HTTPS tunnels are allowed")
        ok, reason = egress_allowed(self.client_address[0], u.hostname, str(u.port or 80))
        if not ok:
            return self._deny(reason)
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(self.path, data=body, method=self.command, headers={k: v for k, v in self.headers.items() if k.lower() not in ("proxy-connection", "connection", "host")})
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                payload = res.read()
                self.send_response(res.status)
                self.send_header("Content-Type", res.headers.get("Content-Type", "application/octet-stream"))
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        except urllib.error.HTTPError as e:
            self.send_error(e.code, e.reason)
        except Exception as e:
            self.send_error(502, str(e)[:200])

    do_GET = do_POST = do_PUT = do_PATCH = do_DELETE = do_HEAD = _forward

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    import threading

    threading.Thread(target=Server(("0.0.0.0", 3128), EgressProxy).serve_forever, daemon=True).start()
    Server(("0.0.0.0", 3141), Proxy).serve_forever()
