#!/usr/bin/env python3
"""Offline regression test: a write the gateway answers with 404 is a refusal.

A patch whose match names no document gets 404 with the gateway's reason. The
client used to treat every 404 as "route absent" and return None, so kb-write.py
printed "? ()" and exited 0 for a status change that changed nothing. Writes now
raise GatewayRefusal; the server's own route-absent shape ({"error":
"not_found", "path": …}) and every 404 on a read still return None.

A local HTTP server stands in for the gateway. Run: `python3 kb-client/test_write_404.py`.
"""
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _here)
key = os.path.join(tempfile.mkdtemp(), "key")
with open(key, "w") as f:
    f.write("k")
os.environ.pop("CLAUDE_PROJECT_DIR", None)
os.chdir(tempfile.mkdtemp())  # no .claude/kb.json here: the env pair decides


class Gateway(BaseHTTPRequestHandler):
    def _answer(self):
        if "route-absent" in self.path:
            body = {"error": "not_found", "path": self.path}
        else:
            body = {"error": "CASE_RECORD where case_number=99999 not found in kb"}
        raw = json.dumps(body).encode()
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._answer()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length") or 0))
        self._answer()

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), Gateway)
threading.Thread(target=srv.serve_forever, daemon=True).start()
os.environ["KB_APP_URL"] = f"http://127.0.0.1:{srv.server_port}"
os.environ["KB_API_KEY_FILE"] = key

import kb_client_core as core  # noqa: E402

_fails = []


def check(name, got, want):
    if got != want:
        _fails.append(f"{name}: got {got!r}, want {want!r}")


try:
    core.gw_post("/write/CASE_RECORD", {"patch": {"status": "open"}, "match": {"case_number": 99999}})
    check("write.missing_doc", "no exception", "GatewayRefusal")
except core.GatewayRefusal as e:
    check("write.missing_doc.msg", "not found" in str(e), True)
check("write.route_absent", core.gw_post("/route-absent", {"x": 1}), {})
check("read.missing", core.gw_get("/cases/99999"), None)

srv.shutdown()
if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print("OK — a write's 404 is a refusal; reads and absent routes are unchanged")
