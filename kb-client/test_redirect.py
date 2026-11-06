#!/usr/bin/env python3
"""Offline regression test: the client never follows a redirect, and says where the KB went.

An install that serves each app on its own origin answers the KB's old URL with
301 to the new one. A POST does not follow that, and following a GET would send
the API key to whatever host the redirect names. So every redirect raises
KbMoved: to another origin, with the origin to set as kb_app_url; within the same
origin, naming the target. Reads (GET), writes (POST) and file downloads alike;
the key is never sent to the redirect's target.

A local HTTP server stands in for the old URL, a second one for the new origin.
Run: `python3 kb-client/test_redirect.py`.
"""
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

new_origin_hits = []


class NewOrigin(BaseHTTPRequestHandler):
    def _answer(self):
        new_origin_hits.append((self.command, self.path, self.headers.get("X-API-Key")))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    do_GET = do_POST = _answer

    def log_message(self, *a):
        pass


new_srv = HTTPServer(("127.0.0.1", 0), NewOrigin)
threading.Thread(target=new_srv.serve_forever, daemon=True).start()
NEW = f"http://localhost:{new_srv.server_port}"  # another origin: a different host name


class OldUrl(BaseHTTPRequestHandler):
    def _answer(self):
        if self.command == "POST":
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
        same = "same-origin" in self.path
        self.send_response(308 if "permanent" in self.path else 301)
        self.send_header("Location", ("/elsewhere" if same else NEW) + self.path)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_POST = _answer

    def log_message(self, *a):
        pass


old_srv = HTTPServer(("127.0.0.1", 0), OldUrl)
threading.Thread(target=old_srv.serve_forever, daemon=True).start()
OLD = f"http://127.0.0.1:{old_srv.server_port}"
os.environ["KB_APP_URL"] = OLD
os.environ["KB_API_KEY_FILE"] = key

import kb_client_core as core  # noqa: E402

_fails = []


def check(name, fn, want_in):
    try:
        fn()
    except core.KbMoved as e:
        missing = [w for w in want_in if w not in str(e)]
        if missing:
            _fails.append(f"{name}: message lacks {missing}: {e}")
        return
    except Exception as e:  # noqa: BLE001
        _fails.append(f"{name}: raised {type(e).__name__}, not KbMoved: {e}")
        return
    _fails.append(f"{name}: no error — the redirect was followed")


check("GET to another origin", lambda: core.gw_get("/cases/5"), [NEW, "kb_app_url", "301"])
check("POST to another origin", lambda: core.gw_post("/write/CASE_RECORD", {"x": 1}), [NEW, "kb_app_url"])
check("308 to another origin", lambda: core.gw_get("/permanent"), [NEW, "308"])
check("file download", lambda: core.gw_get_bytes("/export"), [NEW, "kb_app_url"])
check("upload", lambda: core.gw_post_bytes("/upload", b"x", "text/plain", "f.txt"), [NEW, "kb_app_url"])
check("same-origin redirect", lambda: core.gw_get("/same-origin"), ["/elsewhere", "not followed"])

if new_origin_hits:
    _fails.append(f"the redirect target was contacted (key sent there): {new_origin_hits}")

for f in _fails:
    print("FAIL", f)
print("6/6 redirect cases refused, target never contacted" if not _fails else f"{len(_fails)} failure(s)")
sys.exit(1 if _fails else 0)
