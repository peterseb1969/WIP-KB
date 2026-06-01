#!/usr/bin/env python3
"""case_allocate.py — kb-only case-number allocator (CASE-425/437).

Replaces the filesystem noclobber claim (`case-helper.sh claim`, CASE-306). The
case number is a Registry synonym (`CASE-<n>`) of the case's UUID document_id;
allocation is allocate-then-create on the atomic synonym claim (CASE-427/436):

    n = max(existing case_number) + 1
    loop:
        create CASE_RECORD with data.case_number=n + synonym {value: "CASE-n"}
        ├─ success            -> return (n, document_id)
        └─ synonym_conflict   -> n += 1, retry   (another filer took CASE-n)

The synonym claim is the single serializer — no FS lock, no server counter. A
stale max read (the /documents/query lag) is harmless: the claim catches the
collision and the loop advances. Single canonical instance (dual-write retired).

CLI:
    python3 case_allocate.py --title "..." [--body-file F] [--type bug] \
        [--severity annoying] [--component registry] [--filed-by SID] [--app KB]
    -> prints "CASE-<n> <document_id>"

Env: KB_BASE_URL (default https://wip-kb.local), KB_KEY_FILE
     (default ~/.wip-deploy/wip-kb/secrets/api-key), KB_NAMESPACE (kb),
     KB_VERIFY_TLS (false).
"""
from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

BASE = os.environ.get("KB_BASE_URL", "https://wip-kb.local")
KEY = Path(os.environ.get("KB_KEY_FILE", str(Path.home() / ".wip-deploy/wip-kb/secrets/api-key"))).expanduser()
NS = os.environ.get("KB_NAMESPACE", "kb")
VERIFY_TLS = os.environ.get("KB_VERIFY_TLS", "false").lower() == "true"
MAX_RETRIES = 100


def _ctx() -> ssl.SSLContext | None:
    if VERIFY_TLS:
        return None
    c = ssl.create_default_context()
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


def _req(method: str, path: str, body: object | None = None) -> tuple[int, object]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"X-API-Key": KEY.read_text().strip()}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method, headers=headers)
    try:
        r = urllib.request.urlopen(req, context=_ctx(), timeout=20)
        return r.status, json.loads(r.read() or "null")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or "null")
        except json.JSONDecodeError:
            return e.code, {"raw": str(e)}
    except (urllib.error.URLError, OSError) as e:
        return 0, {"raw": str(e)}


def resolve_template_id(value: str = "CASE_RECORD") -> str:
    s, d = _req("GET", f"/api/template-store/templates/by-value/{value}?namespace={NS}")
    if s >= 400 or not isinstance(d, dict):
        raise RuntimeError(f"cannot resolve template {value} in {NS}: HTTP {s} {d}")
    tid = d.get("id") or d.get("template_id")
    if not tid:
        raise RuntimeError(f"template {value} has no id: {d}")
    return tid


def current_max_case_number() -> int:
    """Max data.case_number across CASE_RECORDs (paginated). Best-effort seed for
    the candidate — the synonym claim is the correctness guard, not this read."""
    mx, page = 0, 1
    while True:
        s, d = _req("POST", f"/api/document-store/documents/query?namespace={NS}",
                    {"template_id": "CASE_RECORD", "filters": [], "page": page, "page_size": 100})
        if s >= 400 or not isinstance(d, dict):
            raise RuntimeError(f"max-scan query failed: HTTP {s} {d}")
        items = d.get("items") or []
        for it in items:
            n = (it.get("data") or {}).get("case_number")
            if isinstance(n, int) and n > mx:
                mx = n
        if page >= (d.get("pages") or 1) or not items:
            break
        page += 1
    return mx


def allocate_and_create(data: dict, template_id: str | None = None) -> tuple[int, str]:
    """Allocate the next CASE-<n> and create the CASE_RECORD. `data` must NOT
    include case_number (assigned here). Returns (case_number, document_id)."""
    tid = template_id or resolve_template_id()
    n = current_max_case_number() + 1
    for _ in range(MAX_RETRIES):
        doc = {
            "template_id": tid, "namespace": NS, "created_by": "case_allocate.py",
            "data": {**data, "case_number": n},
            "synonyms": [{"value": f"CASE-{n}"}],
        }
        s, d = _req("POST", "/api/document-store/documents", [doc])
        r = (d.get("results") or [d])[0] if isinstance(d, dict) else {}
        status = r.get("status") if isinstance(r, dict) else None
        if status in ("created", "updated"):
            return n, r.get("document_id")
        err = (r.get("error") or "") if isinstance(r, dict) else str(d)
        if (isinstance(r, dict) and r.get("error_code") == "synonym_conflict") or "different entry" in err:
            n += 1  # CASE-n taken by a concurrent filer — advance and retry
            continue
        raise RuntimeError(f"allocate failed at CASE-{n}: HTTP {s} {r or d}")
    raise RuntimeError(f"allocate exhausted {MAX_RETRIES} retries")


def main() -> int:
    ap = argparse.ArgumentParser(description="kb-only case-number allocator (CASE-425/437)")
    ap.add_argument("--title", required=True)
    ap.add_argument("--body-file")
    ap.add_argument("--body", default="")
    for f in ("type", "severity", "component", "filed-by", "app", "target-yac"):
        ap.add_argument(f"--{f}", default="")
    args = ap.parse_args()
    body = Path(args.body_file).read_text() if args.body_file else args.body
    filed_by = getattr(args, "filed_by") or "unknown"
    data = {
        "title": args.title, "body": body, "authored_by": filed_by,
        "doc_status": "published", "tags": ["case-mirror", "status-open"], "root": True,
        "source_yac": filed_by, "target_yac": getattr(args, "target_yac") or "any",
        "status": "open", "severity": args.severity, "type": args.type,
        "component": args.component, "filed_by": filed_by, "app": args.app,
    }
    n, doc_id = allocate_and_create(data)
    print(f"CASE-{n} {doc_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
