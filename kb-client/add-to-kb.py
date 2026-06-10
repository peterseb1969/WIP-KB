#!/usr/bin/env python3
"""
tools/add-to-kb.py — single-file dual-write to wip-kb.

Standardized end-of-filing step for /case file, /day-report, etc. Each
agent runs this after writing a flat file; the script POSTs the canonical
KB record (CASE_RECORD / JOURNEY_ENTRY / etc.) and derives REFERENCES
edges from frontmatter `related:` mentions.

Usage:
    python3 tools/add-to-kb.py <flat-file-path>          # write (platform dedups)
    python3 tools/add-to-kb.py --check <flat-file-path>  # dry run; show built doc
    python3 tools/add-to-kb.py --quiet <flat-file-path>  # success silent; errors still print

Targets (dual-write, since 2026-05-14):
    Every invocation POSTs to both kb endpoints:
      - local:  https://localhost:8443        (FRanC dev install on this Mac)
      - remote: https://wip-kb.local          (k8s cluster, stable post-CASE-374)

    Tolerate one-side failure: exit 0 if at least one target succeeds; exit 1
    only if both fail. A stderr warning names the failing target(s). Each
    target's per-record edges (REFERENCES, SUPERSEDES) are derived independently
    since the edges live in each kb's own graph.

    Env (single canonical target since 2026-06-01; key rule per CASE-444):
      KB_BASE_URL       target instance (default https://wip-kb.local)
      KB_API_KEY_FILE   key file for that instance (KB_KEY_FILE accepted as a
                        deprecated alias; default ~/.wip-deploy/wip-kb/secrets/
                        api-key — only valid for the default target, otherwise
                        the script fails loud rather than 401 with a wrong key)

Per CASE-307, this is the canonical write surface for ongoing
single-record dual-writes. Bulk historical backfill goes through
tools/kb-bulk-mirror.py. MCP is the read + operator surface.

Post-CASE-318 contract:
    CASE_RECORD declares identity_fields=["case_number"] (data.case_number).
    JOURNEY_ENTRY declares identity_fields=["title"] (data.title).
    DOCUMENT declares identity_fields=["path"] (data.path).
    The platform computes identity_hash and decides per-POST whether the
    result is `created` (new identity_hash) or `updated` (existing
    identity_hash, version bumped). Both are success. The loader does
    NOT query for existing records — the platform IS the dedup.

Edge derivation and forward references (CASE-350 load-order note):
    Edges (REFERENCES, SUPERSEDES, DOCUMENT body-scan REFERENCES) look up
    targets in kb at emit time. If the target hasn't been mirrored yet,
    the edge is silently skipped — same shape as REFERENCES has always
    had. The single-file canonical flow assumes targets already exist
    (you mirror a case AFTER the cases it references are mirrored).

    If you hit a forward-reference (target landed AFTER the source),
    just re-run `add-to-kb.py <source>` — the POST is idempotent
    (same identity_hash → version bump, no duplicate); the second-call
    edge-derivation sees the now-present target and emits the edge.

    For fresh-namespace bulk loads where forward references are common
    (alphabetic order; CASE-309 ref'ing CASE-310 lands before 310),
    use tools/kb-bulk-mirror.py instead — its two-pass design
    (--nodes then --edges) sees the full corpus during edge derivation.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path


# Dual-write targets. Each filing POSTs to both; tolerate one-side failure
# (exit 0 if at least one succeeds, exit 1 only if all fail). The remote
# k8s cluster (`wip-kb.local`) became stable 2026-05-14 after CASE-374's
# preset flip + the WIP-KB k8s migration; both surfaces now run the same
# post-CASE-318 schema, so dual-write is safe.
#
# Env overrides: KB_BASE_URL (target) + KB_API_KEY_FILE (its key; KB_KEY_FILE
# is a deprecated alias). Key resolution + pairing guard live in
# kb_write_core.resolve_key_file (CASE-444).

class Target:
    """One kb endpoint. Per-target template UUID cache + cached api key."""
    def __init__(self, name: str, base_url: str, key_file: Path):
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.key_file = key_file
        self._template_cache: dict[str, str] = {}
        self._api_key: str | None = None

    def api_key(self) -> str:
        if self._api_key is None:
            self._api_key = self.key_file.read_text().strip()
        return self._api_key

    def __repr__(self) -> str:
        return f"Target({self.name}, {self.base_url})"


# Single canonical instance (dual-write retired per Peter, 2026-06-01). All
# writes go to ONE instance — eliminates the divergent-allocator / per-target
# document_id problems (CASE-425 §"Why not multi-instance"; a single canonical
# instance + a KB-YAC-maintained sync, not per-agent multi-writes). Default is
# wip-kb.local; override KB_BASE_URL + KB_API_KEY_FILE for a client served
# from a different instance (key resolution: CASE-444).
from kb_write_core import CANONICAL_BASE_URL, DEV_ROOT, resolve_key_file

REPO = DEV_ROOT / "FR-YAC"  # FR-YAC root (CASE-444: no /Users/<user> literals)

_BASE_URL = os.environ.get("KB_BASE_URL", CANONICAL_BASE_URL)
CANONICAL_TARGET = Target(
    name="canonical",
    base_url=_BASE_URL,
    key_file=resolve_key_file(_BASE_URL, CANONICAL_BASE_URL, "wip-kb",
                              "KB_API_KEY_FILE", "KB_KEY_FILE"),
)
TARGETS: list[Target] = [CANONICAL_TARGET]

# Module-level "currently active" target. Read by http_request /
# resolve_template_id / _api_key. Single-target now; the loop in main() is kept
# for structure (and to re-enable a second target trivially if ever needed).
_active_target: Target = CANONICAL_TARGET

# Constants + pure helpers + doc builders live in kb_write_core
# (CASE-407 consolidation). Imported here so this file stays the
# dual-write + HTTP + edge-derivation surface; doc shape lives there.
from kb_write_core import (
    NAMESPACE,
    DEV_ROOT,
    TPL_CASE,
    TPL_JOURNEY,
    TPL_DOCUMENT,
    TPL_SESSION,
    TPL_REFERENCES,
    TPL_SUPERSEDES,
    TPL_CONTINUES_FROM,
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
    build_session_doc as _build_session_doc_core,
)


try:
    from kb_client_handshake import verify_from_env
except ImportError:  # handshake module not alongside — no-op
    def verify_from_env(api_key: str = "") -> None:  # type: ignore[misc]
        return None


def build_case_doc(path: Path, text: str, fm: dict[str, str]) -> dict:
    return _build_case_doc_core(
        path, text, fm, template_id=resolve_template_id(TPL_CASE), loader="add-to-kb.py",
    )


def build_journey_doc(path: Path, text: str, fm: dict[str, str]) -> dict | None:
    return _build_journey_doc_core(
        path, text, fm, template_id=resolve_template_id(TPL_JOURNEY), loader="add-to-kb.py",
    )


def build_document_doc(path: Path, text: str, fm: dict[str, str]) -> dict | None:
    return _build_document_doc_core(
        path, text, fm, template_id=resolve_template_id(TPL_DOCUMENT), loader="add-to-kb.py",
    )


def build_session_doc(path: Path, text: str, fm: dict[str, str]) -> dict | None:
    return _build_session_doc_core(
        path, text, fm, template_id=resolve_template_id(TPL_SESSION), loader="add-to-kb.py",
    )

def resolve_template_id(value: str) -> str:
    """Resolve a template's UUID from its value/synonym for the currently
    active target. Cached per target. Raises RuntimeError on failure so
    the dual-write loop can isolate per-target failures (instead of exiting
    the whole process).
    """
    cache = _active_target._template_cache
    if value in cache:
        return cache[value]
    status, body = http_request(
        "GET",
        f"/api/template-store/templates/by-value/{value}?namespace={NAMESPACE}",
    )
    if status != 200 or not body.get("template_id"):
        raise RuntimeError(
            f"cannot resolve template '{value}' in namespace '{NAMESPACE}' on "
            f"{_active_target.name} (HTTP {status}: {str(body)[:200]}). The kb "
            f"namespace may have been nuked without re-seeding."
        )
    cache[value] = body["template_id"]
    return cache[value]

DAY_ONE = date(2026, 3, 14)
# VALID_TARGETS imported from kb_write_core (CASE-407).

ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE


# ----------------------------------------------------------------------- HTTP

def _api_key() -> str:
    return _active_target.api_key()


def http_request(method: str, path: str, body: object | None = None) -> tuple[int, dict]:
    """HTTP request against the currently active target (see _active_target)."""
    data = json.dumps(body).encode() if body is not None else None
    headers = {"X-API-Key": _api_key()}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"{_active_target.base_url}{path}", data=data, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(req, context=ssl_ctx) as resp:
            return resp.status, json.loads(resp.read() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or "{}")
        except json.JSONDecodeError:
            return e.code, {"raw": str(e)}
    except urllib.error.URLError as e:
        # Connection refused / DNS / TLS / timeout. Surface as HTTP 0 so the
        # dual-write loop can treat it as a target-level failure rather than
        # an unhandled exception.
        return 0, {"raw": f"URLError: {e.reason}"}


# ------------------------------------------ CASE_RECORD v2 upsert (CASE-425/437)

def resolve_case_id(case_synonym: str) -> str | None:
    """Resolve a CASE-<n> synonym to its document_id on the active target, or None.
    The CASE-<n> Registry synonym is the v2 resolution handle (CASE-425)."""
    status, body = http_request(
        "POST", "/api/registry/entries/lookup/by-key",
        [{"namespace": NAMESPACE, "entity_type": "documents",
          "composite_key": {"value": case_synonym}, "search_synonyms": True}])
    if status >= 400 or status == 0 or not isinstance(body, dict):
        return None
    results = body.get("results") or []
    r = results[0] if results else {}
    return r.get("entry_id") if r.get("status") == "found" else None


def upsert_case(tgt_doc: dict) -> tuple[int, dict, str, str]:
    """v2 resolve-then-update for CASE_RECORD. Resolve the doc's CASE-<n> synonym;
    if it exists, PATCH that doc's data in place; else create. Returns
    (http_status, body, doc_id, result_status).

    Safe under BOTH identity models: PATCH-by-id is version-agnostic, and the
    create path still upserts under v1 (case_number identity) while registering
    the CASE-<n> synonym. Under v2 (identity_fields:[]) a re-mirror resolves and
    PATCHes (no duplicate); a genuinely new case creates. Relies on the synonym
    backfill having run before the v2 template flip so existing cases resolve."""
    syns = tgt_doc.get("synonyms") or []
    case_key = syns[0].get("value") if syns else None
    existing = resolve_case_id(case_key) if case_key else None
    if existing:
        status, body = http_request(
            "PATCH", f"/api/document-store/documents?namespace={NAMESPACE}",
            [{"document_id": existing, "patch": tgt_doc["data"]}])
        return status, body, existing, "updated"
    status, body = http_request("POST", "/api/document-store/documents", [tgt_doc])
    results = body.get("results", []) if isinstance(body, dict) else (body if isinstance(body, list) else [])
    doc_id = results[0].get("document_id", "?") if results else "?"
    rstatus = results[0].get("status", "?") if results else "?"
    return status, body, doc_id, rstatus


# parse_frontmatter / normalize_target / parse_journal_date / parse_day_number
# imported from kb_write_core (CASE-407).

# ------------------------------------------------------------- template detect

# detect_document_meta imported from kb_write_core (CASE-407).


def detect_template(path: Path) -> str:
    """Return the template_id for the given flat-file path, or empty string."""
    name = path.name
    parent = path.parent.name
    grandparent = path.parent.parent.name if path.parent.parent else ""
    if parent == "yac-discussions" and name.startswith("CASE-"):
        return TPL_CASE
    if parent == "dayJournals" and name.startswith("WIP_Journey_Day"):
        return TPL_JOURNEY
    # SESSION: reports/<id>/session.md (CASE-389)
    if grandparent == "reports" and name == "session.md":
        return TPL_SESSION
    if detect_document_meta(path) is not None:
        return TPL_DOCUMENT
    return ""


# doc builders + parse_day_number imported from kb_write_core (CASE-407).
# Thin wrappers at the top of this file inject add-to-kb's resolve_template_id
# + loader identity into the shared builders.


# ---------------------------------------------------------- KB state queries

# DOC_PATH_RE imported from kb_write_core (CASE-407). Matches optional
# repo-prefix + papers/<file>.md or docs/<subdir>/<file>.md. Conservative:
# refuses non-md extensions and trailing punctuation. CASE-346 §"Role split"
# row 2 names this as part of FRanC's loader work.


def document_paths_to_doc_ids() -> dict[str, str]:
    """For edge derivation: data.path → document_id for active DOCUMENT records.
    Identity is data.path (CASE-346 identity rule), so this is unique."""
    out: dict[str, str] = {}
    page = 1
    while True:
        status, body = http_request(
            "GET",
            f"/api/document-store/documents?namespace={NAMESPACE}&page={page}&page_size=200",
        )
        if status != 200:
            break
        items = body.get("items", [])
        for it in items:
            if it.get("status") != "active" or it.get("template_value") != "DOCUMENT":
                continue
            p = (it.get("data") or {}).get("path")
            if p:
                out[p] = it["document_id"]
        if len(items) < 200:
            break
        page += 1
    return out


def case_number_to_doc_ids() -> dict[int, list[str]]:
    """For edge derivation: case_number → list of active CASE_RECORD doc_ids.
    Post-CASE-318: case_number lives in `data.case_number`. Some
    case_numbers may legitimately have multiple files (e.g. CASE-02 has two
    historical entries).
    """
    out: dict[int, list[str]] = {}
    page = 1
    while True:
        status, body = http_request(
            "GET",
            f"/api/document-store/documents?namespace={NAMESPACE}&page={page}&page_size=200",
        )
        if status != 200:
            break
        items = body.get("items", [])
        for it in items:
            if it.get("status") != "active" or it.get("template_value") != "CASE_RECORD":
                continue
            cn = (it.get("data") or {}).get("case_number")
            if cn is not None:
                out.setdefault(int(cn), []).append(it["document_id"])
        if len(items) < 200:
            break
        page += 1
    return out


# ---------------------------------------------------------------- writers

def assert_bulk_success(response: dict, label: str) -> tuple[int, int]:
    results = response.get("results", response if isinstance(response, list) else [])
    if not isinstance(results, list):
        return 0, 0
    # `skipped` is a success state for upsert paths (REFERENCES with
    # identity_fields hits dedup on re-run). `unchanged` is success for
    # JSON Merge Patch when the patched data was already current (a true
    # idempotent no-op). `deleted` is success for the DELETE bulk path.
    OK_STATES = ("created", "updated", "skipped", "unchanged", "deleted")
    ok = sum(1 for r in results if r.get("status") in OK_STATES)
    fail = len(results) - ok
    if fail:
        for r in results:
            if r.get("status") not in OK_STATES:
                print(
                    f"  {label} FAIL idx={r.get('index')} status={r.get('status')} "
                    f"code={r.get('error_code')} err={r.get('error')}",
                    file=sys.stderr,
                )
    return ok, fail


def derive_and_post_supersedes_edges(
    target_doc_id: str, superseded_by_field: str, quiet: bool
) -> tuple[int, int]:
    """Per CASE-350: emit SUPERSEDES edges from frontmatter `superseded_by:`.

    Edge direction convention per CASE-350 §"Direction convention":
    newer → older — `CASE-310 SUPERSEDES CASE-309`. The frontmatter `superseded_by`
    lives on the OLDER doc and names the NEWER successor; the edge source is
    therefore the named successor, target is the current invocation.

    Two reference shapes supported:
      - `CASE-N` — looked up via `case_number_to_doc_ids()` (CASE_RECORD targets).
        Origin: CASE-309 → CASE-310.
      - path-shape (`REPO/sub/file.md`) — looked up via `document_paths_to_doc_ids()`
        (DOCUMENT targets). Origin: CASE-379 paper-supersession synthesis pass
        (FR-YAC/papers/wip-deployable-app-contract.md supersedes
        WIP-KB/papers/k8s-from-start-app-yac-recipe.md).
    Mixed values (e.g. `CASE-12, REPO/papers/foo.md`) are parsed independently.
    """
    if not superseded_by_field:
        return 0, 0
    edges = []
    # CASE-N references → CASE_RECORD targets
    nums = sorted({int(n) for n in re.findall(r"CASE-(\d+)", superseded_by_field)})
    if nums:
        case_map = case_number_to_doc_ids()
        for n in nums:
            for src in case_map.get(n, []):
                if src == target_doc_id:
                    continue
                edges.append({
                    "template_id": resolve_template_id(TPL_SUPERSEDES),
                    "namespace": NAMESPACE,
                    "created_by": "add-to-kb",
                    "data": {"source_ref": src, "target_ref": target_doc_id},
                    "metadata": {
                        "edge_kind": "SUPERSEDES",
                        "rationale": f"frontmatter superseded_by: CASE-{n}",
                        "loader": "add-to-kb.py",
                    },
                })
    # path-shape references → DOCUMENT targets
    # Strip CASE-N tokens first so they don't get re-matched as paths.
    path_field = re.sub(r"CASE-\d+", "", superseded_by_field)
    doc_paths = sorted({
        f"{m.group('repo') or ''}/{m.group('sub')}/{m.group('file')}".lstrip("/")
        for m in DOC_PATH_RE.finditer(path_field)
        if m.group("repo")  # require repo-prefixed path to avoid bare-name false positives
    })
    if doc_paths:
        doc_map = document_paths_to_doc_ids()
        for p in doc_paths:
            src = doc_map.get(p)
            if not src or src == target_doc_id:
                continue
            edges.append({
                "template_id": resolve_template_id(TPL_SUPERSEDES),
                "namespace": NAMESPACE,
                "created_by": "add-to-kb",
                "data": {"source_ref": src, "target_ref": target_doc_id},
                "metadata": {
                    "edge_kind": "SUPERSEDES",
                    "rationale": f"frontmatter superseded_by: {p}",
                    "loader": "add-to-kb.py",
                },
            })
    if not edges:
        return 0, 0
    status, body = http_request("POST", "/api/document-store/documents", edges)
    if status >= 400:
        print(f"  supersedes HTTP {status}: {str(body)[:200]}", file=sys.stderr)
        return 0, len(edges)
    ok, fail = assert_bulk_success(body, "supersedes")
    if not quiet:
        print(f"  edges: {ok} SUPERSEDES")
    return ok, fail


def derive_and_post_doc_references(
    source_doc_id: str, source_repo: str, text: str, quiet: bool
) -> tuple[int, int]:
    """Per CASE-346 §"Role split" row 2: scan body prose for path-shape
    DOCUMENT references and emit REFERENCES edges to matching active DOCUMENT
    records in kb. Skips paths that don't yet have a kb record (the typical
    case before bulk-sync lands).

    Repo disambiguation: if a body reference is bare (`papers/foo.md`), assume
    it lives in the source doc's same repo. If repo-prefixed
    (`World-in-a-Pie/docs/foo.md`), use as-is. Lookup is exact-match on
    DOCUMENT.data.path.
    """
    matches = []
    for m in DOC_PATH_RE.finditer(text):
        repo = m.group("repo") or source_repo
        sub = m.group("sub")
        fname = m.group("file")
        matches.append(f"{repo}/{sub}/{fname}")
    paths = sorted(set(matches))
    if not paths:
        return 0, 0
    doc_map = document_paths_to_doc_ids()
    edges = []
    seen_targets: set[str] = set()
    for p in paths:
        tgt = doc_map.get(p)
        if not tgt or tgt == source_doc_id or tgt in seen_targets:
            continue
        seen_targets.add(tgt)
        edges.append({
            "template_id": resolve_template_id(TPL_REFERENCES),
            "namespace": NAMESPACE,
            "created_by": "add-to-kb",
            "data": {"source_ref": source_doc_id, "target_ref": tgt},
            "metadata": {
                "edge_kind": "REFERENCES",
                "rationale": f"body mention: {p}",
                "loader": "add-to-kb.py",
            },
        })
    if not edges:
        return 0, 0
    status, body = http_request("POST", "/api/document-store/documents", edges)
    if status >= 400:
        print(f"  doc-refs HTTP {status}: {str(body)[:200]}", file=sys.stderr)
        return 0, len(edges)
    ok, fail = assert_bulk_success(body, "doc-refs")
    if not quiet:
        print(f"  edges: {ok} REFERENCES (DOCUMENT body-mentions)")
    return ok, fail


def session_id_to_doc_id(session_id: str) -> str | None:
    """Look up the kb document_id for an active SESSION record by data.session_id.
    Returns None if not found. Used for CONTINUES_FROM edge derivation."""
    status, body = http_request(
        "POST",
        f"/api/document-store/documents/query?namespace={NAMESPACE}",
        {
            "template_id": TPL_SESSION,
            "filters": [{"field": "data.session_id", "operator": "eq", "value": session_id}],
            "page": 1,
            "page_size": 2,
        },
    )
    if status != 200:
        return None
    items = body.get("items") or []
    return items[0].get("document_id") if items else None


def derive_and_post_continues_from_edge(source_doc_id: str, continues_from: str,
                                        quiet: bool) -> tuple[int, int]:
    """CASE-389 §D: emit one CONTINUES_FROM edge from this session (source) to
    the prior session named in `continues_from:` (target). Silently skips if
    the target session isn't in kb yet (per add-to-kb's edge-derivation
    contract — caller can re-run later)."""
    target_session = continues_from.strip()
    if not target_session:
        return (0, 0)
    target_doc_id = session_id_to_doc_id(target_session)
    if target_doc_id is None:
        if not quiet:
            print(f"  edges: CONTINUES_FROM target '{target_session}' not in kb yet — skipped",
                  file=sys.stderr)
        return (0, 0)
    edge = {
        "template_id": resolve_template_id(TPL_CONTINUES_FROM),
        "namespace": NAMESPACE,
        "created_by": "add-to-kb.py",
        "data": {
            "source_ref": source_doc_id,
            "target_ref": target_doc_id,
        },
        "metadata": {
            "edge_kind": "CONTINUES_FROM",
            "loader": "add-to-kb.py",
        },
    }
    status, body = http_request("POST", "/api/document-store/documents", [edge])
    ok, fail = assert_bulk_success(body, "CONTINUES_FROM")
    if not quiet:
        print(f"  edges: {ok} CONTINUES_FROM ({target_session} → {source_doc_id[:8]}…)")
    return (ok, fail)


def derive_and_post_edges(source_doc_id: str, related_field: str, quiet: bool) -> tuple[int, int]:
    """Parse CASE-N mentions in `related:` and emit REFERENCES edges to each
    matching active CASE_RECORD. Returns (created, failed)."""
    if not related_field:
        return 0, 0
    nums = sorted({int(n) for n in re.findall(r"CASE-(\d+)", related_field)})
    if not nums:
        return 0, 0
    case_map = case_number_to_doc_ids()
    edges = []
    for n in nums:
        for tgt in case_map.get(n, []):
            if tgt == source_doc_id:
                continue
            edges.append({
                "template_id": resolve_template_id(TPL_REFERENCES),
                "namespace": NAMESPACE,
                "created_by": "add-to-kb",
                "data": {"source_ref": source_doc_id, "target_ref": tgt},
                "metadata": {
                    "edge_kind": "REFERENCES",
                    "rationale": f"frontmatter related: cites CASE-{n}",
                    "loader": "add-to-kb.py",
                },
            })
    if not edges:
        return 0, 0
    status, body = http_request("POST", "/api/document-store/documents", edges)
    if status >= 400:
        print(f"  edges HTTP {status}: {str(body)[:200]}", file=sys.stderr)
        return 0, len(edges)
    ok, fail = assert_bulk_success(body, "edges")
    if not quiet:
        print(f"  edges: {ok} REFERENCES (idempotent — REFERENCES has identity dedup)")
    return ok, fail


# ------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("flat_file", help="path to flat file (CASE-*.md or WIP_Journey_Day*.md)")
    ap.add_argument("--check", action="store_true", help="dry run; report what would happen")
    ap.add_argument("--quiet", action="store_true", help="success silent; errors still print")
    args = ap.parse_args()

    path = Path(args.flat_file).resolve()
    if not path.exists():
        print(f"ERROR: {path} does not exist", file=sys.stderr)
        sys.exit(1)

    template_id = detect_template(path)
    if not template_id:
        print(f"ERROR: cannot detect KB template for {path}", file=sys.stderr)
        sys.exit(1)

    text = path.read_text()
    fm, _ = parse_frontmatter(text)

    if template_id not in (TPL_CASE, TPL_JOURNEY, TPL_DOCUMENT, TPL_SESSION):
        print(f"ERROR: template {template_id} not yet supported by add-to-kb", file=sys.stderr)
        sys.exit(1)

    if args.check:
        # Build only when --check needs `doc`; the write path rebuilds per-target
        # inside the dual-write loop, where per-target failures are tolerated.
        if template_id == TPL_CASE:
            doc = build_case_doc(path, text, fm)
        elif template_id == TPL_JOURNEY:
            doc = build_journey_doc(path, text, fm)
            if doc is None:
                print(f"ERROR: cannot parse day_number from {path.name}", file=sys.stderr)
                sys.exit(1)
        elif template_id == TPL_SESSION:
            doc = build_session_doc(path, text, fm)
            if doc is None:
                print(f"ERROR: cannot build SESSION from {path} (expected reports/<id>/session.md)",
                      file=sys.stderr)
                sys.exit(1)
        else:  # TPL_DOCUMENT
            doc = build_document_doc(path, text, fm)
            if doc is None:
                print(f"ERROR: cannot build DOCUMENT from {path}", file=sys.stderr)
                sys.exit(1)
        mirror = doc["metadata"]["flat_file_mirror"]
        tpl_name = {
            TPL_CASE: "CASE_RECORD",
            TPL_JOURNEY: "JOURNEY_ENTRY",
            TPL_DOCUMENT: "DOCUMENT",
            TPL_SESSION: "SESSION",
        }.get(template_id, template_id)
        print(f"DRY RUN: {path.name}")
        print(f"  template: {tpl_name}")
        print(f"  flat_file_mirror: {mirror}")
        if template_id == TPL_CASE:
            print(f"  data.case_number: {doc['data']['case_number']}  (platform identity)")
        elif template_id == TPL_JOURNEY:
            print(f"  data.title: {doc['data']['title']}  (platform identity)")
        elif template_id == TPL_SESSION:
            print(f"  data.session_id: {doc['data']['session_id']}  (platform identity)")
            print(f"  data.role: {doc['data']['role']}")
            print(f"  data.status: {doc['data']['status']}")
            if doc['data'].get('continues_from'):
                print(f"  data.continues_from: {doc['data']['continues_from']}  (will derive CONTINUES_FROM edge)")
        else:  # DOCUMENT
            print(f"  data.path: {doc['data']['path']}  (platform identity)")
            print(f"  data.kind: {doc['data']['kind']}")
            print(f"  data.repo_origin: {doc['data']['repo_origin']}")
        print(f"  action: POST — platform identity_hash decides create-vs-update")
        if template_id == TPL_CASE and fm.get("related"):
            cnums = sorted({int(n) for n in re.findall(r"CASE-(\d+)", fm.get("related", ""))})
            print(f"  edges: would derive REFERENCES from related: {cnums}")
        if fm.get("superseded_by"):
            snums = sorted({int(n) for n in re.findall(r"CASE-(\d+)", fm.get("superseded_by", ""))})
            print(f"  edges: would derive SUPERSEDES from superseded_by: {snums}")
        if template_id == TPL_DOCUMENT:
            preview_repo = doc["data"]["repo_origin"]
            preview_paths = sorted({
                f"{m.group('repo') or preview_repo}/{m.group('sub')}/{m.group('file')}"
                for m in DOC_PATH_RE.finditer(text)
            })
            if preview_paths:
                print(f"  edges: would scan body for {len(preview_paths)} DOCUMENT path-ref candidates: {preview_paths[:5]}{'...' if len(preview_paths) > 5 else ''}")
        return

    # Dual-write loop. Targets are tried in order; per-target failures are
    # caught and reported but do not abort the other target. Exit code:
    #   - 0 if at least one target succeeded
    #   - 1 if all targets failed
    # Stderr warning on partial success names the failing target(s).
    successes: list[str] = []
    failures: list[tuple[str, str]] = []
    global _active_target

    verify_from_env()  # no-skew handshake (skips unless KB_APP_URL is set)
    for target in TARGETS:
        _active_target = target
        prefix = f"[{target.name}]"
        try:
            # Re-build doc per-target — resolve_template_id is target-scoped
            # so the embedded template_id matches the destination kb.
            if template_id == TPL_CASE:
                tgt_doc = build_case_doc(path, text, fm)
            elif template_id == TPL_JOURNEY:
                tgt_doc = build_journey_doc(path, text, fm)
            elif template_id == TPL_DOCUMENT:
                tgt_doc = build_document_doc(path, text, fm)
            elif template_id == TPL_SESSION:
                tgt_doc = build_session_doc(path, text, fm)
            else:
                tgt_doc = None
            if tgt_doc is None:
                raise RuntimeError("doc builder returned None")

            if template_id == TPL_CASE:
                # v2 resolve-then-update (CASE-425/437): resolve the CASE-<n>
                # synonym → PATCH in place; else create. Safe under v1 and v2.
                status, body, doc_id, rstatus = upsert_case(tgt_doc)
            else:
                status, body = http_request("POST", "/api/document-store/documents", [tgt_doc])
                results = body.get("results", body if isinstance(body, list) else [])
                doc_id = results[0].get("document_id", "?") if results else "?"
                rstatus = results[0].get("status", "?") if results else "?"
            if status >= 400 or status == 0:
                raise RuntimeError(f"write HTTP {status}: {str(body)[:300]}")
            ok, fail = assert_bulk_success(body, f"{prefix} write")
            if fail:
                raise RuntimeError(f"bulk write reported {fail} failures")
            if doc_id == "?":
                raise RuntimeError("empty results from write")
            if not args.quiet:
                print(f"{prefix} {rstatus} kb document_id: {doc_id} ({path.name})")

            # Edge derivation runs per-target — edges live in each kb separately.
            if template_id == TPL_CASE and fm.get("related"):
                derive_and_post_edges(doc_id, fm.get("related", ""), args.quiet)
            if fm.get("superseded_by"):
                derive_and_post_supersedes_edges(doc_id, fm.get("superseded_by", ""), args.quiet)
            if template_id == TPL_DOCUMENT:
                derive_and_post_doc_references(doc_id, tgt_doc["data"]["repo_origin"], text, args.quiet)
            if template_id == TPL_SESSION and fm.get("continues_from"):
                derive_and_post_continues_from_edge(doc_id, fm["continues_from"], args.quiet)

            successes.append(target.name)
        except Exception as e:
            print(f"{prefix} FAILED: {e}", file=sys.stderr)
            failures.append((target.name, str(e)))

    if not successes:
        print(f"ERROR: dual-write failed on all targets ({', '.join(n for n, _ in failures)})", file=sys.stderr)
        sys.exit(1)
    if failures:
        print(
            f"WARN: dual-write mixed — succeeded on [{', '.join(successes)}], "
            f"failed on [{', '.join(n for n, _ in failures)}]",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
