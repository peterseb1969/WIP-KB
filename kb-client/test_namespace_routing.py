#!/usr/bin/env python3
"""Offline regression tests: every client call reaches the corpus it was pointed at.

A KB instance can hold several corpora (namespaces) side by side — `kb`, a second
one made with `kb-namespace.py create`, and the `library`. Each corpus numbers its
own cases, so a write or read sent to the wrong one is not an error the gateway can
catch: it lands, or answers, in the wrong knowledge base. These tests run the real
`kb-write.py` and `case-fetch.py` against a local stand-in gateway that records
every request, and check which namespace each one carried:

  - KB_NAMESPACE (and `namespace` in .claude/kb.json) pin every call, writes and
    reads alike; unset, the corpus is `kb`;
  - an explicit `--namespace` wins over the pin and is sent once, never twice;
  - `/types` spans every configured namespace unless a namespace was chosen, so an
    inherited default does not narrow it, while an explicit one does.

The stand-in answers with minimal JSON; a script that cannot use the answer may
exit non-zero, which is fine — only the requests it sent are checked.

Run: `python3 kb-client/test_namespace_routing.py`.
"""
import json
import os
import subprocess
import tempfile
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer

_here = os.path.dirname(os.path.abspath(__file__))
_fails = []
seen = []


class Gateway(BaseHTTPRequestHandler):
    def _answer(self, body):
        raw = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _record(self):
        u = urllib.parse.urlparse(self.path)
        q = urllib.parse.parse_qs(u.query)
        seen.append((self.command, u.path.split("/server-api/kb", 1)[-1], q.get("namespace", [])))

    def do_GET(self):
        self._record()
        self._answer({"items": [], "types": [], "total": 0})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        self._record()
        # Every requested edge is reported as having no target in this namespace,
        # as the gateway does for a target that lives in another corpus.
        edges = [{"type": e.get("type"), "target_key": e.get("target_key"), "status": "target_not_found"}
                 for e in body.get("edges") or []]
        self._answer({"result": "created", "document_id": "d", "synonym": "CASE-1", "edges": edges})

    def log_message(self, *a):
        pass


srv = HTTPServer(("127.0.0.1", 0), Gateway)
threading.Thread(target=srv.serve_forever, daemon=True).start()
URL = f"http://127.0.0.1:{srv.server_port}"

tmp = tempfile.mkdtemp()
key = os.path.join(tmp, "key")
with open(key, "w") as f:
    f.write("k")
# A repo with a session sentinel (case writes fill their attribution from it) and,
# for the kb.json case, a config naming its own corpus.
plain = os.path.join(tmp, "plain")
os.makedirs(os.path.join(plain, ".claude"))
with open(os.path.join(plain, ".claude", ".session-id"), "w") as f:
    f.write("APP-KB-20261101-120000\n")
configured = os.path.join(tmp, "configured")
os.makedirs(os.path.join(configured, ".claude"))
with open(os.path.join(configured, ".claude", ".session-id"), "w") as f:
    f.write("APP-KB-20261101-120000\n")
with open(os.path.join(configured, ".claude", "kb.json"), "w") as f:
    json.dump({"kb_app_url": URL, "kb_api_key_file": key, "namespace": "kb-work"}, f)
case_md = os.path.join(tmp, "case.md")
with open(case_md, "w") as f:
    f.write("---\ntitle: t\nstatus: open\ndoc_status: published\ntype: bug\nseverity: fyi\n"
            "component: other\ntarget_yac: any\n---\nbody\n")


def run(script, *args, cwd=plain, namespace=None, pair=True):
    """The (method, path, namespaces) requests one script run sent."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("KB_") and k != "CLAUDE_PROJECT_DIR"}
    env["PYTHONPATH"] = _here
    if pair:
        env.update(KB_APP_URL=URL, KB_API_KEY_FILE=key)
    if namespace is not None:
        env["KB_NAMESPACE"] = namespace
    seen.clear()
    subprocess.run(["python3", os.path.join(_here, script), *args], cwd=cwd, env=env,
                   capture_output=True, text=True, timeout=60)
    return list(seen)


def check(name, got, want):
    if got != want:
        _fails.append(f"{name}: got {got!r}, want {want!r}")


def namespaces(reqs, path):
    return [ns for (_m, p, ns) in reqs if p == path]


# 1. KB_NAMESPACE pins writes (create and patch) and reads to the chosen corpus.
r = run("kb-write.py", "CASE_RECORD", case_md, namespace="kb-work")
check("write.create", namespaces(r, "/write/CASE_RECORD"), [["kb-work"]])
r = run("kb-write.py", "CASE_RECORD", "--patch", "status=closed", "--match", "case_number=1",
        namespace="kb-work")
check("write.patch", namespaces(r, "/write/CASE_RECORD"), [["kb-work"]])
r = run("case-fetch.py", "list", namespace="kb-work")
check("read.list", sorted({tuple(ns) for (_m, p, ns) in r}), [("kb-work",)])

# 2. Unset, the corpus is kb.
r = run("kb-write.py", "CASE_RECORD", case_md)
check("default.write", namespaces(r, "/write/CASE_RECORD"), [["kb"]])

# 3. .claude/kb.json `namespace` pins the client like KB_NAMESPACE does.
r = run("kb-write.py", "CASE_RECORD", case_md, cwd=configured, pair=False)
check("kbjson.write", namespaces(r, "/write/CASE_RECORD"), [["kb-work"]])

# 4. An explicit --namespace wins over the pin, and is sent exactly once.
r = run("case-fetch.py", "search", "marker", "--namespace", "kb-work", namespace="kb")
check("search.explicit", [ns for (_m, p, ns) in r if p.startswith("/search")], [["kb-work"]])

# 5. /types: an inherited default does not narrow it; an explicit choice does.
r = run("kb-write.py", "--list")
check("types.inherited", namespaces(r, "/types"), [[]])
r = run("kb-write.py", "--list", namespace="kb-work")
check("types.explicit_env", namespaces(r, "/types"), [["kb-work"]])
r = run("kb-write.py", "--list", "--namespace", "kb-work")
check("types.explicit_flag", namespaces(r, "/types"), [["kb-work"]])

# 6. A link whose target is not in this corpus is written without the edge,
#    exit 0, and a warning names the missing target and the namespace.
env = {k: v for k, v in os.environ.items() if not k.startswith("KB_") and k != "CLAUDE_PROJECT_DIR"}
env.update(PYTHONPATH=_here, KB_APP_URL=URL, KB_API_KEY_FILE=key, KB_NAMESPACE="kb-work")
p = subprocess.run(["python3", os.path.join(_here, "kb-write.py"), "CASE_RECORD", case_md,
                    "--edge", "REFERENCES:CASE_RECORD:970"], cwd=plain, env=env,
                   capture_output=True, text=True, timeout=60)
check("edge.not_found.exit", p.returncode, 0)
check("edge.not_found.warning",
      "not linked — REFERENCES→970: no such CASE_RECORD in namespace kb-work" in p.stderr, True)

srv.shutdown()
if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print("OK — every call reaches the corpus it was pointed at")
