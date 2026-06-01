#!/usr/bin/env python3
"""migrate-case-record-v2.py — CASE-425 migration: backfill CASE-<n> synonyms.

Part of the CASE_RECORD v2 identity move (CASE-425): identity becomes the
registry-assigned document_id (UUID); `case_number` stays a display field whose
human-handle + uniqueness role is carried by a `CASE-<n>` Registry synonym.

This script backfills that synonym onto every existing CASE_RECORD so legacy
cases resolve by `CASE-<n>` the same way new (v2-allocated) cases will. Now that
the synonym claim is atomic (CASE-427) and edge synonyms are template-scoped
(CASE-430), an add_synonym that hits a cross-owner conflict is reported loudly —
so this backfill DOUBLES AS A COLLISION DETECTOR for the CASE-02 family.

It is idempotent: re-adding a case's own synonym is a no-op (CASE-427 self
no-op). Default is --dry-run (read-only). Use --apply to write.

SEQUENCING (read before --apply):
  - Safe to run the synonym backfill any time post-427 (this script). It does
    NOT change the template and does NOT touch document identity.
  - The template flip to v2 (identity_fields: []) and the FR-YAC loader switch
    to resolve-then-update / allocate-then-create must land TOGETHER — if the
    template is v2 but a loader still create_document()s on re-mirror, every
    re-mirror APPENDS a duplicate (v2 has no identity to upsert on). This script
    does not flip the template.
  - Run against local kb first; the k8s/prod cluster only after BE-YAC deploys
    427/430/434/436 there.

Env (mirrors case-fetch.py):
  KB_LOCAL_URL        default https://localhost:8443
  KB_LOCAL_KEY_FILE   default ~/.wip-deploy/wip-dev-local/secrets/api-key
  KB_BASE_URL         default https://wip-kb.local   (remote canonical)
  KB_API_KEY_FILE     default ~/.wip-deploy/wip-kb/secrets/api-key
  KB_NAMESPACE        default kb
  KB_VERIFY_TLS       default false

Usage:
  python3 tools/migrate-case-record-v2.py                 # dry-run, local
  python3 tools/migrate-case-record-v2.py --apply         # write, local
  python3 tools/migrate-case-record-v2.py --target remote # dry-run, remote
  python3 tools/migrate-case-record-v2.py --apply --target both
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

REMOTE_URL = os.environ.get("KB_BASE_URL", "https://wip-kb.local")
REMOTE_KEY = Path(os.environ.get("KB_API_KEY_FILE",
                                 str(Path.home() / ".wip-deploy/wip-kb/secrets/api-key"))).expanduser()
LOCAL_URL = os.environ.get("KB_LOCAL_URL", "https://localhost:8443")
LOCAL_KEY = Path(os.environ.get("KB_LOCAL_KEY_FILE",
                                str(Path.home() / ".wip-deploy/wip-dev-local/secrets/api-key"))).expanduser()
NAMESPACE = os.environ.get("KB_NAMESPACE", "kb")
VERIFY_TLS = os.environ.get("KB_VERIFY_TLS", "false").lower() == "true"

TEMPLATE_VALUE = "CASE_RECORD"
ENTITY_TYPE = "documents"


def _ssl_ctx() -> ssl.SSLContext | None:
    if VERIFY_TLS:
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _post(base_url: str, key_file: Path, path: str, body: object) -> dict:
    req = urllib.request.Request(
        f"{base_url}{path}",
        data=json.dumps(body).encode("utf-8"),
        method="POST",
        headers={"Content-Type": "application/json", "X-API-Key": key_file.read_text().strip()},
    )
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx(), timeout=20)
    except urllib.error.HTTPError as e:
        snippet = e.read()[:300].decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {base_url}{path}: {snippet}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"{base_url}{path} unreachable: {e}") from e
    return json.loads(resp.read())


def enumerate_cases(base_url: str, key_file: Path) -> list[dict]:
    """Return [{document_id, case_number}] for every active CASE_RECORD (paginated)."""
    out: list[dict] = []
    page = 1
    while True:
        payload = _post(
            base_url, key_file,
            f"/api/document-store/documents/query?namespace={NAMESPACE}",
            {"template_id": TEMPLATE_VALUE, "filters": [], "page": page, "page_size": 100},
        )
        items = payload.get("items") or []
        for it in items:
            data = it.get("data") or {}
            out.append({"document_id": it.get("document_id"), "case_number": data.get("case_number")})
        pages = payload.get("pages") or 1
        if page >= pages or not items:
            break
        page += 1
    return out


def analyze(cases: list[dict]) -> dict:
    """Group by case_number; surface dupes (collisions) and missing/odd numbers."""
    by_number: dict[object, list[str]] = {}
    null_numbered: list[str] = []
    for c in cases:
        n = c["case_number"]
        if n is None:
            null_numbered.append(c["document_id"])
            continue
        by_number.setdefault(n, []).append(c["document_id"])
    collisions = {n: ids for n, ids in by_number.items() if len(ids) > 1}
    return {"by_number": by_number, "collisions": collisions, "null_numbered": null_numbered}


def add_synonym(base_url: str, key_file: Path, doc_id: str, case_number: int) -> dict:
    res = _post(base_url, key_file, "/api/registry/synonyms/add", [{
        "target_id": doc_id,
        "synonym_namespace": NAMESPACE,
        "synonym_entity_type": ENTITY_TYPE,
        "synonym_composite_key": {"value": f"CASE-{case_number}"},
    }])
    results = res.get("results") or [res]
    return results[0]


def run(base_url: str, key_file: Path, apply: bool) -> int:
    label = f"{base_url} (ns={NAMESPACE})"
    print(f"=== {label} — {'APPLY' if apply else 'DRY-RUN'} ===")
    cases = enumerate_cases(base_url, key_file)
    a = analyze(cases)
    print(f"  CASE_RECORD docs:        {len(cases)}")
    print(f"  distinct case_numbers:   {len(a['by_number'])}")
    print(f"  null case_numbers:       {len(a['null_numbered'])}")
    print(f"  source-set collisions:   {len(a['collisions'])}")
    if a["collisions"]:
        print("  !! collisions (decide winner policy before --apply):")
        for n, ids in sorted(a["collisions"].items()):
            print(f"     CASE-{n}: {ids}")
    if a["null_numbered"]:
        print(f"  !! {len(a['null_numbered'])} docs have no case_number (skipped): {a['null_numbered'][:5]}...")

    targets = [(c["document_id"], c["case_number"]) for c in cases if c["case_number"] is not None]
    if not apply:
        print(f"  would attempt {len(targets)} CASE-<n> synonym claims (idempotent; self no-op).")
        print("  (dry-run: no writes)")
        return 0

    added = conflicts = errors = noop = 0
    for doc_id, n in targets:
        try:
            r = add_synonym(base_url, key_file, doc_id, n)
        except RuntimeError as e:
            errors += 1
            print(f"  CASE-{n} {doc_id}: TRANSPORT ERROR {e}")
            continue
        status = r.get("status")
        if status == "added":
            added += 1
        elif status in ("skipped", "unchanged"):
            noop += 1
        elif status == "error":
            err = r.get("error", "")
            if "different entry" in err or r.get("error_code") == "synonym_conflict":
                conflicts += 1
                print(f"  CASE-{n} COLLISION: {doc_id} vs {err}")
            else:
                errors += 1
                print(f"  CASE-{n} {doc_id}: ERROR {err}")
        else:
            print(f"  CASE-{n} {doc_id}: status={status} {r}")
    print(f"  added={added} noop={noop} conflicts={conflicts} errors={errors}")
    return 1 if (conflicts or errors) else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="CASE-425 CASE_RECORD v2 synonym backfill")
    ap.add_argument("--apply", action="store_true", help="write synonyms (default: dry-run)")
    ap.add_argument("--target", choices=["local", "remote", "both"], default="local")
    args = ap.parse_args()

    targets = {"local": [(LOCAL_URL, LOCAL_KEY)],
               "remote": [(REMOTE_URL, REMOTE_KEY)],
               "both": [(LOCAL_URL, LOCAL_KEY), (REMOTE_URL, REMOTE_KEY)]}[args.target]
    rc = 0
    for base_url, key_file in targets:
        try:
            rc |= run(base_url, key_file, args.apply)
        except RuntimeError as e:
            print(f"  FATAL: {e}")
            rc |= 2
    return rc


if __name__ == "__main__":
    sys.exit(main())
