#!/usr/bin/env python3
"""
case-fetch.py — REST-canonical retrieval helper for kb records.

Per papers/retrieval-layering.md and CASE-393:
- REST is canonical. FS is an opportunistic env-gated fast-path (transitional;
  removable in one commit when the kb-only horizon completes).
- Body is never cached. template_id may be process-cacheable (one-shot here,
  so the lifetime is the call).
- Exit codes:
    0 = success (body printed to stdout)
    1 = not found in any tried target
    2 = transport failure on the final-attempted target

Usage:
    case-fetch.py case <N>
    case-fetch.py journey <N>
    case-fetch.py paper <slug>   # future

Env vars (all optional):
    KB_BASE_URL          default https://wip-kb.local   (remote canonical)
    KB_API_KEY_FILE      default ~/.wip-deploy/wip-kb/secrets/api-key
                         (KB_KEY_FILE accepted as deprecated alias — CASE-444)
    KB_LOCAL_URL         default https://localhost:8443 (used when KB_PREFER_LOCAL=1)
    KB_LOCAL_KEY_FILE    default ~/.wip-deploy/wip-dev-local/secrets/api-key
    KB_NAMESPACE         default kb
    KB_PREFER_LOCAL      unset = off; =1 tries local kb before remote
    KB_PREFER_FS         unset = off; =1 tries filesystem before remote (and before
                                       local kb if both are set); transitional.
    KB_VERIFY_TLS        default false (self-signed certs)
"""
import argparse
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


from kb_write_core import CANONICAL_BASE_URL, LOCAL_BASE_URL, resolve_key_file

REMOTE_URL = os.environ.get("KB_BASE_URL", CANONICAL_BASE_URL)
REMOTE_KEY = resolve_key_file(REMOTE_URL, CANONICAL_BASE_URL, "wip-kb",
                              "KB_API_KEY_FILE", "KB_KEY_FILE")
LOCAL_URL = os.environ.get("KB_LOCAL_URL", LOCAL_BASE_URL)
LOCAL_KEY = resolve_key_file(LOCAL_URL, LOCAL_BASE_URL, "wip-dev-local",
                             "KB_LOCAL_KEY_FILE")
NAMESPACE = os.environ.get("KB_NAMESPACE", "kb")
GW_BASE_PATH = os.environ.get("KB_APP_BASE_PATH", "/apps/kb")  # KB gateway mount
PREFER_LOCAL = os.environ.get("KB_PREFER_LOCAL") == "1"
PREFER_FS = os.environ.get("KB_PREFER_FS") == "1"
VERIFY_TLS = os.environ.get("KB_VERIFY_TLS", "false").lower() == "true"

FR_YAC_ROOT = Path(__file__).resolve().parent.parent


def _ssl_ctx() -> ssl.SSLContext | None:
    if VERIFY_TLS:
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def _read_key(key_file: Path) -> str:
    return key_file.read_text().strip()


def _query_kb(base_url: str, key_file: Path, template_value: str,
              field: str, value: object) -> list[dict]:
    """POST a query, return list of matching active documents. Raises on transport error."""
    body = json.dumps({
        "template_id": template_value,
        "filters": [{"field": field, "operator": "eq", "value": value}],
        "page": 1,
        "page_size": 10,
    }).encode("utf-8")
    url = f"{base_url}/api/document-store/documents/query?namespace={NAMESPACE}"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-API-Key": _read_key(key_file),
        },
    )
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx(), timeout=10)
    except urllib.error.HTTPError as e:
        snippet = e.read()[:200].decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {base_url}: {snippet}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"{base_url} unreachable: {e}") from e
    payload = json.loads(resp.read())
    return payload.get("items") or []


def _fetch_case_kb(case_num: int) -> str | None:
    """REST path with optional local-fast-fallthrough. Returns body or None.
    Raises RuntimeError if the remote (last fallback) fails.
    """
    targets: list[tuple[str, str, Path]] = []
    if PREFER_LOCAL:
        targets.append(("local", LOCAL_URL, LOCAL_KEY))
    targets.append(("remote", REMOTE_URL, REMOTE_KEY))

    last_kb_error: Exception | None = None
    for name, url, key in targets:
        try:
            docs = _query_kb(url, key, "CASE_RECORD", "data.case_number", case_num)
        except RuntimeError as e:
            last_kb_error = e
            if name != "remote":
                print(f"[case-fetch] {name} unreachable, falling through to remote: {e}",
                      file=sys.stderr)
                continue
            raise
        if docs:
            return (docs[0].get("data") or {}).get("body")
        if name != "remote":
            print(f"[case-fetch] case {case_num} not found on {name}, trying remote",
                  file=sys.stderr)
            continue
        return None  # remote found nothing
    if last_kb_error:
        raise last_kb_error
    return None


def _fetch_case_fs(case_num: int) -> str | None:
    """FS opportunistic fast-path. Returns body or None. Never raises — failures
    silently fall through so the kb path runs. Transitional per the kb-only horizon.
    """
    cases_dir = FR_YAC_ROOT / "yac-discussions"
    if not cases_dir.is_dir():
        return None
    nn = f"{case_num:02d}" if case_num < 10 else str(case_num)
    matches = list(cases_dir.glob(f"CASE-{nn}-*.md"))
    if not matches:
        return None
    if len(matches) > 1:
        # Known multi-file collisions (e.g. CASE-02) — pick the first deterministically
        # so behaviour is reproducible; the kb path resolves the canonical record.
        matches.sort()
    try:
        return matches[0].read_text()
    except OSError:
        return None


def fetch_case(case_num: int) -> str | None:
    if PREFER_FS:
        body = _fetch_case_fs(case_num)
        if body is not None:
            return body
    return _fetch_case_kb(case_num)


# ----------------------------------------------------------------------------
# journey mode (CASE-397)
# ----------------------------------------------------------------------------
# JOURNEY_ENTRY identity_fields = ["title"] but we query by data.day_number
# (loader-populated float, see kb_write_core.build_journey_doc) — title
# matching would require regex against the H1 line, day_number is exact.


def _fetch_journey_kb(day_num: float) -> str | None:
    targets: list[tuple[str, str, Path]] = []
    if PREFER_LOCAL:
        targets.append(("local", LOCAL_URL, LOCAL_KEY))
    targets.append(("remote", REMOTE_URL, REMOTE_KEY))

    last_kb_error: Exception | None = None
    for name, url, key in targets:
        try:
            docs = _query_kb(url, key, "JOURNEY_ENTRY", "data.day_number", day_num)
        except RuntimeError as e:
            last_kb_error = e
            if name != "remote":
                print(f"[case-fetch] {name} unreachable, falling through to remote: {e}",
                      file=sys.stderr)
                continue
            raise
        if docs:
            return (docs[0].get("data") or {}).get("body")
        if name != "remote":
            print(f"[case-fetch] journey day {day_num} not found on {name}, trying remote",
                  file=sys.stderr)
            continue
        return None
    if last_kb_error:
        raise last_kb_error
    return None


def _fetch_journey_fs(day_num: float) -> str | None:
    journals_dir = FR_YAC_ROOT / "dayJournals"
    if not journals_dir.is_dir():
        return None
    # Integer days: WIP_Journey_DayN.md. Half-days: WIP_Journey_DayN_Intermezzo.md
    # (per parse_day_number in kb_write_core).
    if day_num == int(day_num):
        candidate = journals_dir / f"WIP_Journey_Day{int(day_num)}.md"
    else:
        # half-day Intermezzo
        candidate = journals_dir / f"WIP_Journey_Day{int(day_num)}_Intermezzo.md"
    if not candidate.is_file():
        return None
    try:
        return candidate.read_text()
    except OSError:
        return None


def fetch_journey(day_num: float) -> str | None:
    if PREFER_FS:
        body = _fetch_journey_fs(day_num)
        if body is not None:
            return body
    return _fetch_journey_kb(day_num)


# ----------------------------------------------------------------------------
# fireside mode (CASE-479)
# ----------------------------------------------------------------------------
# FIRESIDE identity_fields = ["title"] — no number/synonym, so a single fireside
# is fetched by document_id (discover ids via `fireside list`).
#
# These reads go through the KB gateway API (GET /firesides, /firesides/:id) —
# the app-specific layer that owns the FIRESIDE projection, namespace
# discipline, and identity. Clients must NOT reach past it into the
# document-store backend directly (that is the "straight to MongoDB"
# anti-pattern; the gateway is the contract). Same local->remote fallthrough as
# cases/journeys; no FS fast-path — firesides live only in kb.


def _gw_get(base_url: str, key_file: Path, path: str) -> dict | None:
    """GET a KB gateway endpoint (path relative to /server-api/kb, e.g.
    '/firesides'). Returns the parsed JSON object, or None on 404. Raises
    RuntimeError on transport / non-404 HTTP error."""
    url = f"{base_url}{GW_BASE_PATH}/server-api/kb{path}"
    req = urllib.request.Request(
        url,
        method="GET",
        headers={"X-API-Key": _read_key(key_file)},
    )
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx(), timeout=10)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        snippet = e.read()[:200].decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {base_url}: {snippet}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"{base_url} unreachable: {e}") from e
    return json.loads(resp.read())


def _gw_targets() -> list[tuple[str, str, Path]]:
    targets: list[tuple[str, str, Path]] = []
    if PREFER_LOCAL:
        targets.append(("local", LOCAL_URL, LOCAL_KEY))
    targets.append(("remote", REMOTE_URL, REMOTE_KEY))
    return targets


def list_firesides(topic: str | None, author: str | None, limit: int) -> list[dict]:
    """GET /firesides via the gateway. Returns the gateway's projected rows
    (title, topic, authored_by, chat_date, document_id, …); bodies omitted."""
    params: dict[str, str] = {"page_size": str(min(limit, 100))}
    if topic:
        params["topic"] = topic
    if author:
        params["author"] = author
    path = "/firesides?" + urllib.parse.urlencode(params)

    last_error: Exception | None = None
    for name, url, key in _gw_targets():
        try:
            payload = _gw_get(url, key, path)
        except RuntimeError as e:
            last_error = e
            if name != "remote":
                print(f"[case-fetch] {name} unreachable, falling through to remote: {e}",
                      file=sys.stderr)
                continue
            raise
        return (payload or {}).get("items") or []
    if last_error:
        raise last_error
    return []


def fetch_fireside(doc_id: str) -> str | None:
    """GET /firesides/:id via the gateway. Returns the body, or None if the
    gateway reports the fireside not found on the remote (last) target."""
    last_error: Exception | None = None
    for name, url, key in _gw_targets():
        try:
            payload = _gw_get(url, key, f"/firesides/{doc_id}")
        except RuntimeError as e:
            last_error = e
            if name != "remote":
                print(f"[case-fetch] {name} unreachable, falling through to remote: {e}",
                      file=sys.stderr)
                continue
            raise
        if payload is not None:
            return payload.get("body")
        if name != "remote":
            print(f"[case-fetch] fireside {doc_id} not found on {name}, trying remote",
                  file=sys.stderr)
            continue
        return None  # remote (gateway) returned 404
    if last_error:
        raise last_error
    return None


def _format_fireside_table(rows: list[dict]) -> str:
    header = (
        "| Chat date | Topic | Authored by | Title | Document ID |\n"
        "|---|---|---|---|---|"
    )
    if not rows:
        return f"{header}\n_(no matches)_\n"
    out = [header]
    for r in rows:
        out.append(
            f"| {r['chat_date'] or ''} | {r['topic'] or ''} | "
            f"{r['authored_by'] or ''} | {r['title'] or ''} | {r['document_id'] or ''} |"
        )
    return "\n".join(out) + "\n"


# ----------------------------------------------------------------------------
# list mode (CASE-403)
# ----------------------------------------------------------------------------
# REST-only by design — the per-file frontmatter parse IS the latency problem
# the FS fast-path would re-introduce. No KB_PREFER_FS branch here.


def _query_list(base_url: str, key_file: Path, filters: list[dict],
                limit: int) -> list[dict]:
    """POST a query, return list items (no body filtering — caller drops body)."""
    body = json.dumps({
        "template_id": "CASE_RECORD",
        "filters": filters,
        "page": 1,
        "page_size": min(limit, 100),
        "sort_by": "created_at",
        "sort_order": "desc",
    }).encode("utf-8")
    url = f"{base_url}/api/document-store/documents/query?namespace={NAMESPACE}"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-API-Key": _read_key(key_file),
        },
    )
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx(), timeout=10)
    except urllib.error.HTTPError as e:
        snippet = e.read()[:200].decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {base_url}: {snippet}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"{base_url} unreachable: {e}") from e
    payload = json.loads(resp.read())
    return payload.get("items") or []


def list_cases(filters: list[dict], limit: int) -> list[dict]:
    """REST-only. Returns list-rows (case_number, status, severity, type,
    component, filed_by, slug). Body field is dropped client-side.
    """
    targets: list[tuple[str, str, Path]] = []
    if PREFER_LOCAL:
        targets.append(("local", LOCAL_URL, LOCAL_KEY))
    targets.append(("remote", REMOTE_URL, REMOTE_KEY))

    last_error: Exception | None = None
    for name, url, key in targets:
        try:
            items = _query_list(url, key, filters, limit)
        except RuntimeError as e:
            last_error = e
            if name != "remote":
                print(f"[case-fetch] {name} unreachable, falling through to remote: {e}",
                      file=sys.stderr)
                continue
            raise
        # Strip body, project the queryable CASE_RECORD fields.
        # Post-CASE-404: data.status / severity / type / component / filed_by /
        # app are now first-class queryable fields populated by the loader.
        # tags-membership for status + data.authored_by stay as legacy aliases
        # (fallback path if data.status is empty on a stale doc).
        rows = []
        for it in items:
            d = it.get("data") or {}
            title = d.get("title") or ""
            slug = title.split(":", 1)[1].strip() if ":" in title else title
            # Prefer data.status; fall back to tags-membership for any stale docs.
            status = d.get("status") or ""
            if not status:
                for tag in d.get("tags") or []:
                    if tag.startswith("status-"):
                        status = tag[len("status-"):]
                        break
            rows.append({
                "case_number": d.get("case_number"),
                "status": status,
                "severity": d.get("severity") or "",
                "type": d.get("type") or "",
                "component": d.get("component") or "",
                "filed_by": d.get("filed_by") or d.get("authored_by") or "",
                "app": d.get("app") or "",
                "slug": slug,
            })
        return rows
    if last_error:
        raise last_error
    return []


def _build_filters(args: argparse.Namespace) -> list[dict]:
    filters: list[dict] = []
    if args.status:
        # Post-CASE-404: data.status is now a first-class field. Multi-value
        # uses `in`; single value uses `eq` for cleaner query semantics.
        vals = [s.strip() for s in args.status.split(",") if s.strip()]
        if len(vals) == 1:
            filters.append({"field": "data.status", "operator": "eq", "value": vals[0]})
        else:
            filters.append({"field": "data.status", "operator": "in", "value": vals})
    if args.filed_by:
        filters.append({"field": "data.filed_by", "operator": "eq", "value": args.filed_by})
    if args.severity:
        filters.append({"field": "data.severity", "operator": "eq", "value": args.severity})
    if args.type_:
        filters.append({"field": "data.type", "operator": "eq", "value": args.type_})
    if args.component:
        filters.append({"field": "data.component", "operator": "eq", "value": args.component})
    if args.app:
        filters.append({"field": "data.app", "operator": "eq", "value": args.app})
    return filters


def _format_table(rows: list[dict]) -> str:
    header = (
        "| # | Status | Severity | Type | Component | Filed by | Slug |\n"
        "|---|---|---|---|---|---|---|"
    )
    if not rows:
        return f"{header}\n_(no matches)_\n"
    out = [header]
    for r in rows:
        cn = r["case_number"]
        cn_str = f"{cn:03d}" if isinstance(cn, int) else str(cn)
        out.append(
            f"| {cn_str} | {r['status'] or ''} | {r['severity'] or ''} | "
            f"{r['type'] or ''} | {r['component'] or ''} | "
            f"{r['filed_by'] or ''} | {r['slug'] or ''} |"
        )
    return "\n".join(out) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = ap.add_subparsers(dest="mode", required=True)

    fetch_sp = sub.add_parser("case", help="fetch a single case body by number")
    fetch_sp.add_argument("identifier", help="case number")

    journey_sp = sub.add_parser("journey", help="fetch a journal entry body by day number")
    journey_sp.add_argument("identifier", help="day number (int or half-day like 4.5)")

    # Reserved: paper (future case)
    # fetch_paper_sp = sub.add_parser("paper", help="fetch a paper by slug")

    list_sp = sub.add_parser("list", help="list cases with filters (CASE-403 + CASE-404)")
    list_sp.add_argument("--status", help="comma-separated: open,responded,closed,implemented")
    list_sp.add_argument("--filed-by", dest="filed_by", help="filter by filer (data.filed_by)")
    list_sp.add_argument("--severity", help="blocks-me|annoying|fyi|needs-update")
    list_sp.add_argument("--type", dest="type_",
                         help="bug|request|question|platform-gap|refactor|doc-audit|audit|…")
    list_sp.add_argument("--component", help="component label (e.g. scaffold)")
    list_sp.add_argument("--app", help="filter by app (e.g. backend, cross-agent)")
    list_sp.add_argument("--limit", type=int, default=50, help="max rows (default 50, cap 100)")
    list_sp.add_argument("--format", choices=["table", "json"], default="table")

    fireside_sp = sub.add_parser("fireside",
                                 help="list firesides, or fetch one by document_id (CASE-479)")
    fireside_sp.add_argument("target", help="'list', or a fireside document_id")
    fireside_sp.add_argument("--topic", help="filter list by exact topic (data.topic)")
    fireside_sp.add_argument("--author", help="filter list by exact author (data.authored_by)")
    fireside_sp.add_argument("--limit", type=int, default=50, help="max rows (default 50, cap 100)")
    fireside_sp.add_argument("--format", choices=["table", "json"], default="table")

    args = ap.parse_args()

    if args.mode == "case":
        try:
            case_num = int(args.identifier)
        except ValueError:
            print(f"ERROR: case identifier must be an integer (got: {args.identifier!r})",
                  file=sys.stderr)
            sys.exit(2)
        try:
            body = fetch_case(case_num)
        except RuntimeError as e:
            print(f"ERROR: transport failure: {e}", file=sys.stderr)
            sys.exit(2)
        if body is None:
            print(f"case {case_num} not found in kb", file=sys.stderr)
            sys.exit(1)
        sys.stdout.write(body)
        if not body.endswith("\n"):
            sys.stdout.write("\n")
        sys.exit(0)

    if args.mode == "journey":
        try:
            day_num = float(args.identifier)
        except ValueError:
            print(f"ERROR: journey identifier must be numeric (got: {args.identifier!r})",
                  file=sys.stderr)
            sys.exit(2)
        try:
            body = fetch_journey(day_num)
        except RuntimeError as e:
            print(f"ERROR: transport failure: {e}", file=sys.stderr)
            sys.exit(2)
        if body is None:
            print(f"journey day {day_num} not found in kb", file=sys.stderr)
            sys.exit(1)
        sys.stdout.write(body)
        if not body.endswith("\n"):
            sys.stdout.write("\n")
        sys.exit(0)

    if args.mode == "list":
        filters = _build_filters(args)
        try:
            rows = list_cases(filters, args.limit)
        except RuntimeError as e:
            print(f"ERROR: transport failure: {e}", file=sys.stderr)
            sys.exit(2)
        # Sort by case_number descending (newest first) for stable, readable output
        rows.sort(key=lambda r: (r.get("case_number") or 0), reverse=True)
        if args.format == "json":
            sys.stdout.write(json.dumps(rows, indent=2))
            sys.stdout.write("\n")
        else:
            sys.stdout.write(_format_table(rows))
        sys.exit(0)

    if args.mode == "fireside":
        if args.target == "list":
            try:
                rows = list_firesides(args.topic, args.author, args.limit)
            except RuntimeError as e:
                print(f"ERROR: transport failure: {e}", file=sys.stderr)
                sys.exit(2)
            # newest chat first; docs without chat_date sort last
            rows.sort(key=lambda r: r.get("chat_date") or "", reverse=True)
            if args.format == "json":
                sys.stdout.write(json.dumps(rows, indent=2))
                sys.stdout.write("\n")
            else:
                sys.stdout.write(_format_fireside_table(rows))
            sys.exit(0)
        # target is a document_id
        try:
            body = fetch_fireside(args.target)
        except RuntimeError as e:
            print(f"ERROR: transport failure: {e}", file=sys.stderr)
            sys.exit(2)
        if body is None:
            print(f"fireside {args.target} not found in kb", file=sys.stderr)
            sys.exit(1)
        sys.stdout.write(body)
        if not body.endswith("\n"):
            sys.stdout.write("\n")
        sys.exit(0)


if __name__ == "__main__":
    main()
