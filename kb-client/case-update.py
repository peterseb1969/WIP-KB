#!/usr/bin/env python3
"""
case-update.py — kb-direct write helper for case state transitions.

Per CASE-396 and papers/retrieval-layering.md: /case respond becomes a
pull-read-respond-push flow against wip-kb. This helper is the PUSH half.
case-fetch.py (CASE-393) is the PULL half.

Usage:
    echo "<full updated case body>" | case-update.py case <N> <verb>
    echo "<full updated journal body>" | case-update.py journey <day-number>

Verbs (first cut handles `respond`; comment / close / implement land in
follow-up cases per CASE-396):
    respond — status flips open → responded; new body has the appended
              `## Response — <sid> (<timestamp>)` section + analysis + fix.

The `journey` type (CASE-397) has no verb because journals don't carry
status transitions — they're append-during-the-active-day artifacts.
The push preserves the JOURNEY_ENTRY identity (data.title) and other
data.* fields, replacing only data.body.

Contract:
- Reads the COMPLETE new body from stdin (caller composes — verifies
  status in frontmatter matches the verb's implied target status).
- Dual-writes to local + remote kb (warn-and-continue per CASE-307;
  inherits the tolerance contract from CASE-391's fix to add-to-kb.py).
- Identity-hash dedup means the POST patches the existing case in place
  (new doc-version on the same canonical CASE_RECORD). Per PoNIF #2's
  corollary: template_id stable, identity stable, existing kb edges
  intact.
- Exit codes: 0 success, 1 case not found, 2 transport failure on
  remote (the final-attempted target).

Env vars (mirror case-fetch.py):
    KB_BASE_URL          default https://wip-kb.local (remote canonical)
    KB_API_KEY_FILE      default ~/.wip-deploy/wip-kb/secrets/api-key
    KB_LOCAL_URL         default https://localhost:8443
    KB_LOCAL_KEY_FILE    default ~/.wip-deploy/wip-dev-local/secrets/api-key
    KB_NAMESPACE         default kb
    KB_VERIFY_TLS        default false

Scope NOT in this first cut (deferred to follow-up cases or out of scope):
- Optional FS refresh after push (CASE-396 §"FS-update behaviour"); thin
  agents don't need it, local-dev workflow can re-run case-fetch into the
  flat file manually.
- Edge derivation from `related:` frontmatter; the existing kb doc's
  REFERENCES edges stay intact across the version bump (PoNIF #2
  corollary) so respond-time edge changes are rare. Add-to-kb.py is the
  surface for full edge re-derivation if needed.
- comment / close / implement verbs (per CASE-396 the pattern lands in
  separate follow-up cases once respond proves out).
"""
import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path


REMOTE_URL = os.environ.get("KB_BASE_URL", "https://wip-kb.local")
REMOTE_KEY = Path(os.environ.get(
    "KB_API_KEY_FILE",
    "/Users/peter/.wip-deploy/wip-kb/secrets/api-key",
))
LOCAL_URL = os.environ.get("KB_LOCAL_URL", "https://localhost:8443")
LOCAL_KEY = Path(os.environ.get(
    "KB_LOCAL_KEY_FILE",
    "/Users/peter/.wip-deploy/wip-dev-local/secrets/api-key",
))
NAMESPACE = os.environ.get("KB_NAMESPACE", "kb")

try:
    from kb_client_handshake import verify_from_env
except ImportError:  # handshake module not alongside — no-op
    def verify_from_env(api_key: str = "") -> None:  # type: ignore[misc]
        return None
VERIFY_TLS = os.environ.get("KB_VERIFY_TLS", "false").lower() == "true"


VERB_TO_STATUS: dict[str, str] = {
    "respond": "responded",
}


def _ssl_ctx() -> ssl.SSLContext | None:
    if VERIFY_TLS:
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _read_key(key_file: Path) -> str:
    return key_file.read_text().strip()


def _http(method: str, base_url: str, key_file: Path, path: str,
          body_obj: object | None = None) -> tuple[int, object]:
    """Send an HTTP request; return (status, parsed-json-or-raw-bytes)."""
    data = json.dumps(body_obj).encode("utf-8") if body_obj is not None else None
    headers = {"X-API-Key": _read_key(key_file)}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"{base_url}{path}", data=data, method=method, headers=headers,
    )
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx(), timeout=15)
    except urllib.error.HTTPError as e:
        snippet = e.read()[:300].decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {base_url}{path}: {snippet}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"{base_url} unreachable: {e}") from e
    raw = resp.read()
    try:
        return resp.status, json.loads(raw)
    except json.JSONDecodeError:
        return resp.status, raw


def _fetch_case_meta(base_url: str, key_file: Path, case_num: int) -> dict | None:
    """Pull just enough metadata (title, current data fields) to rebuild
    the doc payload. Returns the first matching item or None.
    """
    _, payload = _http(
        "POST", base_url, key_file,
        f"/api/document-store/documents/query?namespace={NAMESPACE}",
        {
            "template_id": "CASE_RECORD",
            "filters": [{"field": "data.case_number", "operator": "eq", "value": case_num}],
            "page": 1,
            "page_size": 2,
        },
    )
    items = payload.get("items") or []
    return items[0] if items else None


def _parse_frontmatter_status(body: str) -> str | None:
    """Return the frontmatter `status:` value, or None if not parseable."""
    if not body.startswith("---"):
        return None
    end = body.find("\n---", 3)
    if end < 0:
        return None
    fm_text = body[3:end]
    for line in fm_text.splitlines():
        line = line.strip()
        if line.startswith("status:"):
            return line.split(":", 1)[1].strip()
    return None


def _fetch_journey_meta(base_url: str, key_file: Path, day_num: float) -> dict | None:
    """Pull the existing JOURNEY_ENTRY by data.day_number (loader-populated
    float)."""
    _, payload = _http(
        "POST", base_url, key_file,
        f"/api/document-store/documents/query?namespace={NAMESPACE}",
        {
            "template_id": "JOURNEY_ENTRY",
            "filters": [{"field": "data.day_number", "operator": "eq", "value": day_num}],
            "page": 1,
            "page_size": 2,
        },
    )
    items = payload.get("items") or []
    return items[0] if items else None


def _build_doc(existing: dict, new_body: str, new_status: str) -> dict:
    """Construct the doc payload to POST. Preserves all existing data.*
    fields except body + tags (which change on respond)."""
    existing_data = existing.get("data") or {}
    # Carry forward everything we don't intend to change
    new_data = dict(existing_data)
    new_data["body"] = new_body
    # Rewrite tags: drop any status-* tag, add the new one. Keep other tags.
    other_tags = [t for t in (existing_data.get("tags") or []) if not t.startswith("status-")]
    new_data["tags"] = other_tags + [f"status-{new_status}"]
    return {
        "template_id": "CASE_RECORD",
        "namespace": NAMESPACE,
        "created_by": "case-update",
        "data": new_data,
        # metadata.custom mirror: update case_status so the side audit
        # field stays in sync with the tag. Other metadata.custom fields
        # are caller-attached audit context (per feedback_metadata_is_not_a_workaround)
        # and we deliberately don't fabricate or invalidate them here.
        "metadata": {
            "flat_file_mirror": (existing.get("metadata") or {}).get("flat_file_mirror", ""),
            "case_status": new_status,
            "loader": "case-update.py",
        },
    }


def _build_journey_doc(existing: dict, new_body: str) -> dict:
    """Construct the JOURNEY_ENTRY doc payload to POST. Preserves all existing
    data.* fields except body — identity (data.title) and journey_date /
    day_number / tags are carried forward unchanged."""
    existing_data = existing.get("data") or {}
    new_data = dict(existing_data)
    new_data["body"] = new_body
    return {
        "template_id": "JOURNEY_ENTRY",
        "namespace": NAMESPACE,
        "created_by": "case-update",
        "data": new_data,
        "metadata": {
            "flat_file_mirror": (existing.get("metadata") or {}).get("flat_file_mirror", ""),
            "loader": "case-update.py",
        },
    }


def _post_doc(base_url: str, key_file: Path, doc: dict) -> str:
    """POST the bulk-shaped payload. Returns the resulting status string
    ('created' / 'updated' / 'skipped') for telemetry."""
    _, payload = _http(
        "POST", base_url, key_file,
        "/api/document-store/documents", [doc],
    )
    results = payload.get("results") or (payload if isinstance(payload, list) else [])
    if not results:
        raise RuntimeError(f"empty results from POST to {base_url}")
    r = results[0]
    if r.get("error"):
        raise RuntimeError(f"bulk POST item error from {base_url}: {r.get('error')}")
    return r.get("status", "?")


def _build_case_patch(existing: dict, new_body: str, new_status: str) -> dict:
    """Minimal JSON Merge Patch for a CASE_RECORD respond/comment: body + the
    structured data.status (the field the UI filters on, CASE-404 / be2e90e) +
    the status-* tag. Deliberately omits case_number so the patch never touches
    the identity field — safe under v1 (case_number identity) and v2
    (identity_fields:[]). Supersedes the metadata.custom.case_status mirror
    (deprecated; the UI now reads data.status)."""
    ed = existing.get("data") or {}
    other_tags = [t for t in (ed.get("tags") or []) if not t.startswith("status-")]
    return {"body": new_body, "status": new_status, "tags": other_tags + [f"status-{new_status}"]}


def _patch_doc(base_url: str, key_file: Path, document_id: str, data_patch: dict) -> str:
    """PATCH a document's data in place (RFC 7396 merge). Returns result status."""
    _, payload = _http(
        "PATCH", base_url, key_file,
        f"/api/document-store/documents?namespace={NAMESPACE}",
        [{"document_id": document_id, "patch": data_patch}],
    )
    results = payload.get("results") or (payload if isinstance(payload, list) else [])
    if not results:
        raise RuntimeError(f"empty results from PATCH to {base_url}")
    r = results[0]
    if r.get("error"):
        raise RuntimeError(f"PATCH item error from {base_url}: {r.get('error')}")
    return r.get("status", "?")


def update_case(case_num: int, new_body: str, verb: str) -> int:
    """Pull → modify → push to the canonical target. Returns process exit code."""
    new_status = VERB_TO_STATUS[verb]
    verify_from_env()  # no-skew handshake (skips unless KB_APP_URL is set)

    # Sanity: the new body's frontmatter status should match the verb's target.
    body_status = _parse_frontmatter_status(new_body)
    if body_status and body_status != new_status:
        print(
            f"WARNING: stdin body frontmatter says 'status: {body_status}' "
            f"but verb '{verb}' implies '{new_status}'. Using {new_status} for tags; "
            "the body text is written verbatim — caller responsible for its frontmatter.",
            file=sys.stderr,
        )

    targets = [("canonical", REMOTE_URL, REMOTE_KEY)]  # dual-write retired (Peter 2026-06-01): single canonical instance

    # Discover existing case via local first (fast); fall through to remote.
    existing: dict | None = None
    last_error: Exception | None = None
    for name, url, key in targets:
        try:
            existing = _fetch_case_meta(url, key, case_num)
        except RuntimeError as e:
            last_error = e
            print(f"[case-update] {name} unreachable during pre-pull: {e}", file=sys.stderr)
            continue
        if existing:
            break
    if existing is None:
        if last_error:
            print(f"ERROR: transport failure during pre-pull: {last_error}", file=sys.stderr)
            return 2
        print(f"case {case_num} not found in kb", file=sys.stderr)
        return 1

    # v2 resolve-then-update (CASE-425/437): PATCH the existing case in place by
    # its document_id (the pre-pull resolved it). Minimal patch — body/status/tags
    # only — never touches case_number, so it's safe under v1 (case_number
    # identity) and v2 (identity_fields:[]), and it sets data.status (the field
    # the UI reads). Single canonical target (dual-write retired).
    patch = _build_case_patch(existing, new_body, new_status)
    doc_id = existing.get("document_id")
    if not doc_id:
        print(f"ERROR: case {case_num} has no document_id; cannot update", file=sys.stderr)
        return 2

    successes: list[tuple[str, str]] = []
    failures: list[tuple[str, str]] = []
    for name, url, key in targets:
        try:
            result_status = _patch_doc(url, key, doc_id, patch)
            successes.append((name, result_status))
            print(f"[{name}] {result_status} case {case_num}", file=sys.stderr)
        except RuntimeError as e:
            failures.append((name, str(e)))
            print(f"[{name}] FAILED: {e}", file=sys.stderr)

    if not successes:
        print(f"ERROR: dual-write failed on all targets ({', '.join(n for n, _ in failures)})",
              file=sys.stderr)
        return 2
    if failures:
        print(
            f"WARN: dual-write mixed — succeeded on [{', '.join(n for n, _ in successes)}], "
            f"failed on [{', '.join(n for n, _ in failures)}]",
            file=sys.stderr,
        )
    return 0


def update_journey(day_num: float, new_body: str) -> int:
    """Pull → modify → push the JOURNEY_ENTRY for `day_num`. No verb (journals
    don't have status transitions). Mirror of update_case minus the status flip.
    """
    targets = [("canonical", REMOTE_URL, REMOTE_KEY)]  # dual-write retired (Peter 2026-06-01): single canonical instance

    existing: dict | None = None
    last_error: Exception | None = None
    for name, url, key in targets:
        try:
            existing = _fetch_journey_meta(url, key, day_num)
        except RuntimeError as e:
            last_error = e
            print(f"[case-update] {name} unreachable during pre-pull: {e}", file=sys.stderr)
            continue
        if existing:
            break
    if existing is None:
        if last_error:
            print(f"ERROR: transport failure during pre-pull: {last_error}", file=sys.stderr)
            return 2
        print(f"journey day {day_num} not found in kb", file=sys.stderr)
        return 1

    doc = _build_journey_doc(existing, new_body)

    successes: list[tuple[str, str]] = []
    failures: list[tuple[str, str]] = []
    for name, url, key in targets:
        try:
            result_status = _post_doc(url, key, doc)
            successes.append((name, result_status))
            print(f"[{name}] {result_status} journey day {day_num}", file=sys.stderr)
        except RuntimeError as e:
            failures.append((name, str(e)))
            print(f"[{name}] FAILED: {e}", file=sys.stderr)

    if not successes:
        print(f"ERROR: dual-write failed on all targets ({', '.join(n for n, _ in failures)})",
              file=sys.stderr)
        return 2
    if failures:
        print(
            f"WARN: dual-write mixed — succeeded on [{', '.join(n for n, _ in successes)}], "
            f"failed on [{', '.join(n for n, _ in failures)}]",
            file=sys.stderr,
        )
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="type", required=True)
    case_sp = sub.add_parser("case", help="update a CASE_RECORD")
    case_sp.add_argument("identifier", help="case number")
    case_sp.add_argument("verb", choices=sorted(VERB_TO_STATUS.keys()),
                         help="state transition verb")

    journey_sp = sub.add_parser("journey", help="update a JOURNEY_ENTRY (no verb — journals have no status)")
    journey_sp.add_argument("identifier", help="day number (int or half-day like 4.5)")

    args = ap.parse_args()

    if args.type == "case":
        try:
            case_num = int(args.identifier)
        except ValueError:
            print(f"ERROR: case identifier must be an integer (got: {args.identifier!r})",
                  file=sys.stderr)
            sys.exit(2)
        new_body = sys.stdin.read()
        if not new_body.strip():
            print("ERROR: empty stdin — provide the full updated case body", file=sys.stderr)
            sys.exit(2)
        sys.exit(update_case(case_num, new_body, args.verb))

    if args.type == "journey":
        try:
            day_num = float(args.identifier)
        except ValueError:
            print(f"ERROR: journey identifier must be numeric (got: {args.identifier!r})",
                  file=sys.stderr)
            sys.exit(2)
        new_body = sys.stdin.read()
        if not new_body.strip():
            print("ERROR: empty stdin — provide the full updated journal body", file=sys.stderr)
            sys.exit(2)
        sys.exit(update_journey(day_num, new_body))


if __name__ == "__main__":
    main()
