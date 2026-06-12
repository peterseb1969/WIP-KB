#!/usr/bin/env python3
"""
kb-bulk-mirror.py — Bulk loader for flat files into the kb namespace.

This is FRanC's bootstrap/backfill loader. For single-record
ongoing writes use tools/add-to-kb.py (CASE-307).

Usage:
    python3 tools/kb-bulk-mirror.py --dry-run         # parse + report counts, no writes
    python3 tools/kb-bulk-mirror.py --nodes           # load CASE_RECORD + JOURNEY_ENTRY + DOCUMENT
    python3 tools/kb-bulk-mirror.py --edges           # derive REFERENCES (related: + body) + SUPERSEDES
    python3 tools/kb-bulk-mirror.py --check           # report drift between flats and KB (no writes)

Env-var overrides (default targets the canonical wip-kb.local instance):
    KB_BASE_URL      https://wip-kb.local (default; CASE-444 aligned — was
                     localhost:8443 while the cluster lagged the schema)
    KB_API_KEY_FILE  ~/.wip-deploy/wip-kb/secrets/api-key (default;
                     KB_KEY_FILE is a deprecated alias — CASE-444)
    KB_NAMESPACE     kb

Post-CASE-318 contract:
    CASE_RECORD declares identity_fields=["case_number"] (data.case_number).
    JOURNEY_ENTRY declares identity_fields=["title"] (data.title).
    REFERENCES declares identity_fields=["source_ref", "target_ref"].
    The loader does NOT pre-fetch active docs and dedup client-side. It
    just POSTs every doc; the platform's identity_hash dedup decides
    per-item whether the result is `created` (new identity) or `updated`
    (existing identity, version bumped). Both count as success.

assert_bulk_success: every bulk POST checks results[].status; failures
print and exit code is non-zero.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

# Default targets the canonical wip-kb.local instance (single canonical since
# 2026-06-01; the old localhost default predated the cluster running the
# current schema — CASE-444 aligned it with the rest of the bundle).
# Env-var override switches to any other kb instance on demand, but then
# KB_API_KEY_FILE must name that instance's key (pairing guard, CASE-444).
from kb_write_core import CANONICAL_BASE_URL, DEV_ROOT, resolve_key_file

REPO = DEV_ROOT / "FR-YAC"  # flat-file corpus root (CASE-444: no /Users/<user> literals)
BASE_URL = os.environ.get("KB_BASE_URL", CANONICAL_BASE_URL)
KEY_FILE = resolve_key_file(BASE_URL, CANONICAL_BASE_URL, "wip-kb",
                            "KB_API_KEY_FILE", "KB_KEY_FILE")
BATCH_SIZE = 50

# Constants + pure helpers + doc builders live in kb_write_core
# (CASE-407 consolidation). This file stays the bulk reconciliation /
# pagination / drift-check surface; doc shape lives there.
from kb_write_core import (
    NAMESPACE,
    DEV_ROOT,
    TPL_CASE,
    TPL_JOURNEY,
    TPL_DOCUMENT,
    TPL_REFERENCES,
    TPL_SUPERSEDES,
    VALID_TARGETS,
    DOC_PATH_RE,
    parse_frontmatter,
    normalize_target,
    parse_journal_date,
    parse_day_number,
    detect_document_meta,
    build_case_doc as _build_case_doc_core,
    build_journey_doc as _build_journey_doc_core,
    build_document_doc as _build_document_doc_core,
)


try:
    from kb_client_handshake import verify_from_env
except ImportError:  # handshake module not alongside — no-op
    def verify_from_env(api_key: str = "") -> None:  # type: ignore[misc]
        return None


def build_case_doc(path: Path) -> dict:
    text = path.read_text()
    fm, _ = parse_frontmatter(text)
    return _build_case_doc_core(
        path, text, fm, template_id=resolve_template_id(TPL_CASE), loader="kb-bulk-mirror.py",
    )


def build_journey_doc(path: Path) -> dict | None:
    text = path.read_text()
    fm, _ = parse_frontmatter(text)
    return _build_journey_doc_core(
        path, text, fm, template_id=resolve_template_id(TPL_JOURNEY), loader="kb-bulk-mirror.py",
    )


def build_document_doc(path: Path) -> dict | None:
    text = path.read_text()
    fm, _ = parse_frontmatter(text)
    return _build_document_doc_core(
        path, text, fm, template_id=resolve_template_id(TPL_DOCUMENT), loader="kb-bulk-mirror.py",
    )

_TEMPLATE_ID_CACHE: dict[str, str] = {}


def resolve_template_id(value: str) -> str:
    """Resolve a template's UUID from its value/synonym. Cached per process."""
    if value in _TEMPLATE_ID_CACHE:
        return _TEMPLATE_ID_CACHE[value]
    status, body = http_request(
        "GET",
        f"/api/template-store/templates/by-value/{value}?namespace={NAMESPACE}",
    )
    if status != 200 or not body.get("template_id"):
        print(
            f"ERROR: cannot resolve template '{value}' in namespace '{NAMESPACE}' "
            f"(HTTP {status}: {str(body)[:200]}). The kb namespace may have been "
            f"nuked without re-seeding.",
            file=sys.stderr,
        )
        sys.exit(1)
    _TEMPLATE_ID_CACHE[value] = body["template_id"]
    return _TEMPLATE_ID_CACHE[value]

# Day numbering reference (CLAUDE.md §5: Day 1 = 2026-03-14).
DAY_ONE = date(2026, 3, 14)

# VALID_TARGETS imported from kb_write_core (CASE-407).

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE


# ----------------------------------------------------------------------- HTTP

def _api_key() -> str:
    return KEY_FILE.read_text().strip()


def http_request(method: str, path: str, body: object | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"X-API-Key": _api_key()}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE_URL}{path}", data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, context=ssl_ctx) as resp:
            return resp.status, json.loads(resp.read() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or "{}")
        except json.JSONDecodeError:
            return e.code, {"raw": str(e)}


# parsing helpers + doc builders + detect_document_meta + parse_day_number
# imported from kb_write_core (CASE-407). Thin wrappers near the top of
# this file inject kb-bulk-mirror's resolve_template_id + loader identity
# into the shared builders.


def all_documents() -> list[dict]:
    """Walk FR-YAC/papers/*.md (FRanC's per-repo bulk scope per CASE-346
    §"Role split"). BE-YAC and APP-KB run their own bulks for their repos
    via their own invocations of add-to-kb.py."""
    paths = sorted((REPO / "papers").glob("*.md"))
    return [d for d in (build_document_doc(p) for p in paths) if d]


def all_cases() -> list[dict]:
    return [build_case_doc(p) for p in sorted((REPO / "yac-discussions").glob("CASE-*.md"))]


def all_journeys() -> list[dict]:
    paths = sorted(
        (REPO / "dayJournals").glob("WIP_Journey_Day*.md"),
        key=lambda p: parse_day_number(p.name) or 0.0,
    )
    return [d for d in (build_journey_doc(p) for p in paths) if d]


# ------------------------------------------------------------------- KB state

def fetch_all_active_documents() -> list[dict]:
    """Page through /api/document-store/documents and return active items."""
    out: list[dict] = []
    page = 1
    while True:
        status, body = http_request(
            "GET",
            f"/api/document-store/documents?namespace={NAMESPACE}&page={page}&page_size=200",
        )
        if status != 200:
            print(f"WARN list_documents page {page} -> {status}: {str(body)[:200]}", file=sys.stderr)
            break
        items = body.get("items", body if isinstance(body, list) else [])
        # Filter client-side; deletion_mode=retain leaves tombstones with status != active.
        out.extend(it for it in items if it.get("status") == "active")
        if len(items) < 200:
            break
        page += 1
    return out


def existing_mirrors(active_docs: list[dict]) -> set[str]:
    return {
        ((it.get("metadata") or {}).get("custom", {}) or {}).get("flat_file_mirror")
        for it in active_docs
    } - {None, ""}


def case_number_to_doc_ids(active_docs: list[dict]) -> dict[int, list[str]]:
    """Post-CASE-318: case_number lives in `data.case_number`, not metadata."""
    out: dict[int, list[str]] = {}
    for it in active_docs:
        if it.get("template_value") != TPL_CASE:
            continue
        cn = (it.get("data") or {}).get("case_number")
        if cn is not None:
            out.setdefault(int(cn), []).append(it["document_id"])
    return out


def document_path_to_doc_id(active_docs: list[dict]) -> dict[str, str]:
    """Per CASE-346: data.path is DOCUMENT identity, so the mapping is 1:1."""
    out: dict[str, str] = {}
    for it in active_docs:
        if it.get("template_value") != TPL_DOCUMENT:
            continue
        p = (it.get("data") or {}).get("path")
        if p:
            out[p] = it["document_id"]
    return out


# -------------------------------------------------------------------- writers

def assert_bulk_success(response: dict, label: str) -> tuple[int, int]:
    """Return (succeeded, failed)."""
    results = response.get("results", response if isinstance(response, list) else [])
    if not isinstance(results, list):
        print(f"  {label}: unexpected response shape: {str(response)[:200]}", file=sys.stderr)
        return 0, 0
    OK_STATES = ("created", "updated", "skipped", "unchanged", "deleted")
    ok = sum(1 for r in results if r.get("status") in OK_STATES)
    fail = len(results) - ok
    if fail:
        for r in results:
            if r.get("status") not in OK_STATES:
                print(
                    f"  {label} FAIL idx={r.get('index')} code={r.get('error_code')} err={r.get('error')}",
                    file=sys.stderr,
                )
    return ok, fail


def post_bulk_documents(docs: list[dict], label: str) -> tuple[int, int]:
    status, body = http_request("POST", "/api/document-store/documents", docs)
    if status >= 400:
        print(f"  {label}: HTTP {status}: {str(body)[:300]}", file=sys.stderr)
        return 0, len(docs)
    return assert_bulk_success(body, label)


def _resolve_case_id(case_synonym: str) -> str | None:
    """Resolve a CASE-<n> synonym to its document_id, or None (CASE-425/437)."""
    status, body = http_request(
        "POST", "/api/registry/entries/lookup/by-key",
        [{"namespace": NAMESPACE, "entity_type": "documents",
          "composite_key": {"value": case_synonym}, "search_synonyms": True}])
    if status >= 400 or status == 0 or not isinstance(body, dict):
        return None
    results = body.get("results") or []
    r = results[0] if results else {}
    return r.get("entry_id") if r.get("status") == "found" else None


def post_cases_v2(cases: list[dict]) -> tuple[int, int]:
    """v2 resolve-then-update for CASE_RECORD bulk (CASE-425/437): resolve each
    CASE-<n> synonym → PATCH existing in place, create the rest. Safe under v1
    (case_number identity) and v2 (identity_fields:[]). Journeys/documents keep
    plain create-upsert (their title/path identity is unchanged in v2)."""
    patches: list[dict] = []
    creates: list[dict] = []
    for doc in cases:
        syn = (doc.get("synonyms") or [{}])[0].get("value")
        did = _resolve_case_id(syn) if syn else None
        if did:
            patches.append({"document_id": did, "patch": doc["data"]})
        else:
            creates.append(doc)
    print(f"  cases: {len(patches)} update / {len(creates)} create")
    ok = fail = 0
    for i, batch in enumerate(chunked(patches, BATCH_SIZE), 1):
        status, body = http_request(
            "PATCH", f"/api/document-store/documents?namespace={NAMESPACE}", batch)
        if status >= 400:
            print(f"  case-update batch {i}: HTTP {status}: {str(body)[:200]}", file=sys.stderr)
            fail += len(batch)
            continue
        o, f = assert_bulk_success(body, f"case-update batch {i}")
        ok += o
        fail += f
    for i, batch in enumerate(chunked(creates, BATCH_SIZE), 1):
        o, f = post_bulk_documents(batch, f"case-create batch {i}")
        ok += o
        fail += f
    return ok, fail


def chunked(lst: list, n: int):
    for i in range(0, len(lst), n):
        yield lst[i : i + n]


# ------------------------------------------------------------------ subcommands

def cmd_dry_run(_args):
    cases = all_cases()
    journeys = all_journeys()
    documents = all_documents()
    print(f"cases:     {len(cases)}  bytes={sum(len(json.dumps(d)) for d in cases)}")
    print(f"journeys:  {len(journeys)}  bytes={sum(len(json.dumps(d)) for d in journeys)}")
    print(f"documents: {len(documents)}  bytes={sum(len(json.dumps(d)) for d in documents)}")
    print(f"avg case body: {sum(len(d['data']['body']) for d in cases) // len(cases) if cases else 0}")
    print(f"max case body: {max(len(d['data']['body']) for d in cases) if cases else 0}")
    if documents:
        kinds = {}
        for d in documents:
            kinds[d['data']['kind']] = kinds.get(d['data']['kind'], 0) + 1
        print(f"document kinds: {kinds}")


def cmd_check(_args):
    active = fetch_all_active_documents()
    mirrors = existing_mirrors(active)
    cases = all_cases()
    journeys = all_journeys()
    documents = all_documents()

    case_paths = {d["metadata"]["flat_file_mirror"] for d in cases}
    journey_paths = {d["metadata"]["flat_file_mirror"] for d in journeys}
    document_paths = {d["metadata"]["flat_file_mirror"] for d in documents}

    missing_cases = case_paths - mirrors
    missing_journeys = journey_paths - mirrors
    missing_documents = document_paths - mirrors
    extra_in_kb = mirrors - case_paths - journey_paths - document_paths

    print(f"KB active docs: {len(active)}")
    print(f"  mirrored flat files: {len(mirrors)}")
    print(f"flat cases:     {len(cases)}; missing in KB: {len(missing_cases)}")
    print(f"flat journeys:  {len(journeys)}; missing in KB: {len(missing_journeys)}")
    print(f"flat documents: {len(documents)}; missing in KB: {len(missing_documents)}")
    print(f"KB mirrors with no flat file: {len(extra_in_kb)}")
    if missing_cases:
        print("\nMissing case mirrors (sample):")
        for p in sorted(missing_cases)[:10]:
            print(f"  {p}")
    if missing_documents:
        print("\nMissing document mirrors:")
        for p in sorted(missing_documents):
            print(f"  {p}")
    if extra_in_kb:
        print("\nKB mirrors not matched to any flat file:")
        for p in sorted(extra_in_kb)[:10]:
            print(f"  {p}")


def cmd_nodes(_args):
    # Post-CASE-318: no client-side dedup. CASE_RECORD declares
    # identity_fields=["case_number"]; JOURNEY_ENTRY declares
    # identity_fields=["title"]; DOCUMENT declares identity_fields=["path"]
    # (CASE-346). The platform computes identity_hash from those data fields
    # and decides per-doc whether the POST is a create (new identity_hash)
    # or an update (existing identity_hash, version bumped).
    # assert_bulk_success accepts both as success.
    cases = all_cases()
    journeys = all_journeys()
    documents = all_documents()
    other = journeys + documents
    print(f"To post: {len(cases)} cases (v2 resolve-then-update) + {len(other)} journeys/documents (create-upsert)")
    if not (cases or other):
        return

    # CASE-464 Phase 4 (Roll B): ALL bulk writes retired — every template has a
    # gateway verb; a wholesale re-mirror would clobber gateway-side state.
    app_url = os.environ.get("KB_APP_URL", "https://wip-kb.local")
    base_path = os.environ.get("KB_APP_BASE_PATH", "/apps/kb")
    raise SystemExit(
        f"[kb-client] bulk kb mirroring has been RETIRED (CASE-464): writes go "
        f"through the KB write-gateway verbs at {app_url}{base_path}/server-api/kb/"
        "(cases|sessions/mirror|journeys/mirror|documents/mirror|stats/snapshot). "
        "--dry-run and --check remain available for corpus analysis.")
    total_ok = total_fail = 0
    # journeys + documents keep create-upsert (title/path identity unchanged in v2).
    for i, batch in enumerate(chunked(other, BATCH_SIZE), 1):
        ok, fail = post_bulk_documents(batch, f"nodes batch {i}")
        total_ok += ok
        total_fail += fail
        print(f"  batch {i}: ok={ok} fail={fail}")

    print(f"\nDONE nodes. ok={total_ok} failed={total_fail}")
    if total_fail:
        sys.exit(1)


def cmd_edges(_args):
    # CASE-464 Phase 4 (Roll B): edge writes retired — the gateway derives
    # edges at write time (REFERENCES on case file, CONTINUES_FROM on session
    # mirror). Bulk edge backfill is an operator action via the platform API.
    raise SystemExit("[kb-client] bulk edge derivation has been RETIRED (CASE-464): "
                     "the KB write-gateway derives edges at write time.")
    active = fetch_all_active_documents()
    case_to_doc_ids = case_number_to_doc_ids(active)
    doc_path_to_doc_id = document_path_to_doc_id(active)
    print(f"Loaded {sum(len(v) for v in case_to_doc_ids.values())} case docs across {len(case_to_doc_ids)} case_numbers, {len(doc_path_to_doc_id)} DOCUMENT records")

    # Build a map from flat_file_mirror -> doc_id (for the "source" side of edges).
    mirror_to_doc_id: dict[str, str] = {}
    for it in active:
        custom = ((it.get("metadata") or {}).get("custom", {}) or {})
        if custom.get("flat_file_mirror"):
            mirror_to_doc_id[custom["flat_file_mirror"]] = it["document_id"]

    ref_edges: list[dict] = []     # REFERENCES from related: + body-scan
    super_edges: list[dict] = []   # SUPERSEDES from superseded_by:
    skipped = 0

    # --- CASE_RECORD scan: related: → REFERENCES, superseded_by: → SUPERSEDES ---
    for path in sorted((REPO / "yac-discussions").glob("CASE-*.md")):
        text = path.read_text()
        fm, _ = parse_frontmatter(text)
        source_doc_id = mirror_to_doc_id.get(f"yac-discussions/{path.name}")
        if not source_doc_id:
            skipped += 1
            continue

        # REFERENCES from related: (existing logic — multi-target per case_number)
        for case_num_str in re.findall(r"CASE-(\d+)", fm.get("related", "")):
            case_num = int(case_num_str)
            for target_doc_id in case_to_doc_ids.get(case_num, []):
                if target_doc_id == source_doc_id:
                    continue
                ref_edges.append({
                    "template_id": resolve_template_id(TPL_REFERENCES),
                    "namespace": NAMESPACE,
                    "created_by": "kb-bulk-mirror",
                    "data": {"source_ref": source_doc_id, "target_ref": target_doc_id},
                    "metadata": {
                        "edge_kind": "REFERENCES",
                        "rationale": f"frontmatter related: cites CASE-{case_num}",
                        "loader": "kb-bulk-mirror.py",
                    },
                })

        # SUPERSEDES from superseded_by: per CASE-350 (newer→older convention).
        # source = newer (named in frontmatter), target = current/older.
        for case_num_str in re.findall(r"CASE-(\d+)", fm.get("superseded_by", "")):
            case_num = int(case_num_str)
            for newer_doc_id in case_to_doc_ids.get(case_num, []):
                if newer_doc_id == source_doc_id:
                    continue
                super_edges.append({
                    "template_id": resolve_template_id(TPL_SUPERSEDES),
                    "namespace": NAMESPACE,
                    "created_by": "kb-bulk-mirror",
                    "data": {"source_ref": newer_doc_id, "target_ref": source_doc_id},
                    "metadata": {
                        "edge_kind": "SUPERSEDES",
                        "rationale": f"frontmatter superseded_by: CASE-{case_num}",
                        "loader": "kb-bulk-mirror.py",
                    },
                })

    # --- DOCUMENT scan: body-scan REFERENCES to other DOCUMENT records ---
    # Per CASE-346 §"Role split" row 2.
    for path in sorted((REPO / "papers").glob("*.md")):
        meta = detect_document_meta(path)
        if meta is None:
            continue
        repo_origin, repo_relative_path, _kind = meta
        source_doc_id = doc_path_to_doc_id.get(repo_relative_path)
        if not source_doc_id:
            skipped += 1
            continue
        text = path.read_text()
        fm, _ = parse_frontmatter(text)

        # superseded_by: on papers — also emit SUPERSEDES (paper v2 scenario)
        for case_num_str in re.findall(r"CASE-(\d+)", fm.get("superseded_by", "")):
            case_num = int(case_num_str)
            for newer_doc_id in case_to_doc_ids.get(case_num, []):
                if newer_doc_id == source_doc_id:
                    continue
                super_edges.append({
                    "template_id": resolve_template_id(TPL_SUPERSEDES),
                    "namespace": NAMESPACE,
                    "created_by": "kb-bulk-mirror",
                    "data": {"source_ref": newer_doc_id, "target_ref": source_doc_id},
                    "metadata": {
                        "edge_kind": "SUPERSEDES",
                        "rationale": f"paper frontmatter superseded_by: CASE-{case_num}",
                        "loader": "kb-bulk-mirror.py",
                    },
                })

        # Body-scan for DOCUMENT path references.
        seen_targets: set[str] = set()
        for m in DOC_PATH_RE.finditer(text):
            ref_repo = m.group("repo") or repo_origin
            ref_path = f"{ref_repo}/{m.group('sub')}/{m.group('file')}"
            tgt = doc_path_to_doc_id.get(ref_path)
            if not tgt or tgt == source_doc_id or tgt in seen_targets:
                continue
            seen_targets.add(tgt)
            ref_edges.append({
                "template_id": resolve_template_id(TPL_REFERENCES),
                "namespace": NAMESPACE,
                "created_by": "kb-bulk-mirror",
                "data": {"source_ref": source_doc_id, "target_ref": tgt},
                "metadata": {
                    "edge_kind": "REFERENCES",
                    "rationale": f"body mention: {ref_path}",
                    "loader": "kb-bulk-mirror.py",
                },
            })

    print(f"REFERENCES to post: {len(ref_edges)}")
    print(f"SUPERSEDES to post: {len(super_edges)}")
    print(f"Skipped (no doc_id in KB): {skipped}")

    total_ok = total_fail = 0
    for label, edges in (("REFERENCES", ref_edges), ("SUPERSEDES", super_edges)):
        if not edges:
            continue
        for i, batch in enumerate(chunked(edges, BATCH_SIZE), 1):
            ok, fail = post_bulk_documents(batch, f"{label} batch {i}")
            total_ok += ok
            total_fail += fail
            print(f"  {label} batch {i}: ok={ok} fail={fail}")

    # Both REFERENCES and SUPERSEDES have identity_fields=[source_ref, target_ref]
    # so re-running upserts (no duplicates). assert_bulk_success accepts "updated"
    # alongside "created".
    print(f"\nDONE edges. created/updated={total_ok} failed={total_fail}")
    if total_fail:
        sys.exit(1)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--dry-run", action="store_true", help="parse + count, no HTTP")
    g.add_argument("--check", action="store_true", help="report drift between flats and KB")
    g.add_argument("--nodes", action="store_true", help="bulk-load CASE_RECORD + JOURNEY_ENTRY")
    g.add_argument("--edges", action="store_true", help="derive REFERENCES edges from related:")
    args = ap.parse_args()

    if args.dry_run:
        return cmd_dry_run(args)
    if args.check:
        return cmd_check(args)
    if args.nodes:
        return cmd_nodes(args)
    if args.edges:
        return cmd_edges(args)


if __name__ == "__main__":
    main()
