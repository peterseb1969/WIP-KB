#!/usr/bin/env python3
"""
case-fetch.py — read-side commands for the KB client (cases, journeys, list, firesides).

Every read goes through the KB **gateway** API (`{BASE_PATH}/server-api/kb/…`) via
kb_client_core — the app-specific layer that owns projection, namespace discipline,
and identity. Clients never reach past it into the document-store backend (CASE-482;
the "straight to MongoDB" anti-pattern). Transport, target config, and local→remote
failover all live in the core; this file is thin command handlers + output shaping.

(The filename is historical — it now serves journeys, list, and firesides too.)

Exit codes:
    0 = success (body / table printed to stdout)
    1 = not found
    2 = transport failure on the final-attempted target

Usage:
    case-fetch.py case <N>
    case-fetch.py journey <N>            # N may be fractional, e.g. 7.5
    case-fetch.py list [--status …] [--filed-by …] [--severity …] [--type …]
                       [--component …] [--app …] [--limit N] [--format table|json]
    case-fetch.py fireside list [--topic …] [--author …] [--limit N] [--format …]
    case-fetch.py fireside <document_id>

Env: see kb_client_core (KB_BASE_URL / KB_API_KEY_FILE / KB_PREFER_LOCAL / …).
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.parse

from kb_client_core import gw_get


# ----------------------------------------------------------------------------
# case + journey (single-record body fetch)
# ----------------------------------------------------------------------------

def fetch_case_payload(case_num: int, view: str = "both", response: str | None = None) -> dict | None:
    """GET /cases/:n?view=…[&response=…] (resolves the CASE-<n> synonym server-side).
    Returns the payload dict, or None on 404 (case absent, or explicit seq miss)."""
    q = f"/cases/{case_num}?view={view}"
    if response is not None:
        q += "&response=" + urllib.parse.quote(response)
    return gw_get(q)


def render_case(payload: dict, view: str) -> str:
    """Render the gateway payload to markdown: body, the response thread, or both."""
    parts: list[str] = []
    if view in ("case", "both"):
        parts.append((payload.get("body") or "").rstrip("\n"))
    if view in ("responses", "both"):
        responses = payload.get("responses") or []
        if responses:
            if view == "both":
                parts.append("")
            parts.append(f"## Responses ({len(responses)})\n")
            for r in responses:
                seq, kind = r.get("seq"), r.get("kind") or "respond"
                author, when = r.get("author") or "unknown", (r.get("created_at") or "")[:19]
                head = f"### #{seq} · {kind} · {author}" + (f" · {when}" if when else "")
                parts.append(head + "\n")
                parts.append((r.get("body") or "(no content)").rstrip("\n"))
                parts.append("")
        elif view == "responses":
            parts.append("_(no responses)_")
    return "\n".join(parts).rstrip("\n") + "\n"


def _day_path(day_num: float) -> str:
    """Integer days as '7', fractional as '7.5' — the gateway parseFloats either."""
    return str(int(day_num)) if day_num == int(day_num) else str(day_num)


def fetch_journey(day_num: float) -> str | None:
    """GET /journeys/:day. Body or None."""
    payload = gw_get(f"/journeys/{_day_path(day_num)}")
    return payload.get("body") if payload is not None else None


# ----------------------------------------------------------------------------
# list mode — server-side faceted filtering (CASE-403 / CASE-482)
# ----------------------------------------------------------------------------

_LIST_FACETS = ("status", "filed_by", "severity", "type", "component", "app")


def list_cases(args: argparse.Namespace, limit: int) -> list[dict]:
    """GET /cases?<facets>. Returns the gateway's projected rows, re-shaped for
    the table (case_number + a slug derived from the title)."""
    params: dict[str, str] = {"page_size": str(min(limit, 100))}
    if args.status:
        params["status"] = args.status            # comma list ok — gateway splits
    if args.filed_by:
        params["filed_by"] = args.filed_by
    if args.severity:
        params["severity"] = args.severity
    if args.type_:
        params["type"] = args.type_
    if args.component:
        params["component"] = args.component
    if args.app:
        params["app"] = args.app
    payload = gw_get("/cases?" + urllib.parse.urlencode(params)) or {}
    rows = []
    for it in payload.get("items") or []:
        title = it.get("title") or ""
        slug = title.split(":", 1)[1].strip() if ":" in title else title
        rows.append({
            "case_number": it.get("case"),
            "status": it.get("status") or "",
            "severity": it.get("severity") or "",
            "type": it.get("type") or "",
            "component": it.get("component") or "",
            "filed_by": it.get("filed_by") or "",
            "app": it.get("app") or "",
            "slug": slug,
        })
    return rows


def _format_case_table(rows: list[dict]) -> str:
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


# ----------------------------------------------------------------------------
# fireside mode (CASE-479) — list by facets, fetch one body by document_id
# ----------------------------------------------------------------------------

def list_firesides(topic: str | None, author: str | None, limit: int) -> list[dict]:
    params: dict[str, str] = {"page_size": str(min(limit, 100))}
    if topic:
        params["topic"] = topic
    if author:
        params["author"] = author
    payload = gw_get("/firesides?" + urllib.parse.urlencode(params)) or {}
    return payload.get("items") or []


def fetch_fireside(doc_id: str) -> str | None:
    payload = gw_get(f"/firesides/{doc_id}")
    return payload.get("body") if payload is not None else None


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
            f"| {r.get('chat_date') or ''} | {r.get('topic') or ''} | "
            f"{r.get('authored_by') or ''} | {r.get('title') or ''} | "
            f"{r.get('document_id') or ''} |"
        )
    return "\n".join(out) + "\n"


# ----------------------------------------------------------------------------

def _emit_body(body: str | None, what: str) -> None:
    if body is None:
        print(f"{what} not found in kb", file=sys.stderr)
        sys.exit(1)
    sys.stdout.write(body)
    if not body.endswith("\n"):
        sys.stdout.write("\n")
    sys.exit(0)


def _emit_rows(rows: list[dict], fmt: str, table: str) -> None:
    if fmt == "json":
        sys.stdout.write(json.dumps(rows, indent=2) + "\n")
    else:
        sys.stdout.write(table)
    sys.exit(0)


def main() -> None:
    ap = argparse.ArgumentParser(description="KB read client (gateway-only).")
    sub = ap.add_subparsers(dest="mode", required=True)

    case_sp = sub.add_parser("case", help="fetch a case: body, response thread, or both")
    case_sp.add_argument("identifier", help="case number")
    case_sp.add_argument("--view", choices=["case", "responses", "both"], default="both",
                         help="case body, the response thread, or both (default: both)")
    case_sp.add_argument("--response", help="narrow responses to one: a seq number or 'latest'")
    case_sp.add_argument("--format", choices=["text", "json"], default="text",
                         help="rendered markdown (default) or the raw JSON payload")

    journey_sp = sub.add_parser("journey", help="fetch a journal entry body by day number")
    journey_sp.add_argument("identifier", help="day number (int or half-day like 4.5)")

    list_sp = sub.add_parser("list", help="list cases with server-side facet filters")
    list_sp.add_argument("--status", help="comma-separated: open,responded,closed,implemented")
    list_sp.add_argument("--filed-by", dest="filed_by", help="filter by filer (data.filed_by)")
    list_sp.add_argument("--severity", help="blocks-me|annoying|fyi|needs-update")
    list_sp.add_argument("--type", dest="type_", help="case type")
    list_sp.add_argument("--component", help="component label (e.g. scaffold)")
    list_sp.add_argument("--app", help="filter by app (e.g. backend, cross-agent)")
    list_sp.add_argument("--limit", type=int, default=50, help="max rows (default 50, cap 100)")
    list_sp.add_argument("--format", choices=["table", "json"], default="table")

    fireside_sp = sub.add_parser("fireside", help="list firesides, or fetch one by document_id")
    fireside_sp.add_argument("target", help="'list', or a fireside document_id")
    fireside_sp.add_argument("--topic", help="filter list by exact topic (data.topic)")
    fireside_sp.add_argument("--author", help="filter list by exact author (data.authored_by)")
    fireside_sp.add_argument("--limit", type=int, default=50, help="max rows (default 50, cap 100)")
    fireside_sp.add_argument("--format", choices=["table", "json"], default="table")

    args = ap.parse_args()

    try:
        if args.mode == "case":
            try:
                case_num = int(args.identifier)
            except ValueError:
                print(f"ERROR: case identifier must be an integer (got: {args.identifier!r})", file=sys.stderr)
                sys.exit(2)
            payload = fetch_case_payload(case_num, args.view, args.response)
            if payload is None:
                what = f"case {case_num}" + (f" response {args.response}" if args.response else "")
                print(f"{what} not found in kb", file=sys.stderr)
                sys.exit(1)
            if args.format == "json":
                sys.stdout.write(json.dumps(payload, indent=2) + "\n")
            else:
                sys.stdout.write(render_case(payload, args.view))
            sys.exit(0)

        elif args.mode == "journey":
            try:
                day_num = float(args.identifier)
            except ValueError:
                print(f"ERROR: journey identifier must be numeric (got: {args.identifier!r})", file=sys.stderr)
                sys.exit(2)
            _emit_body(fetch_journey(day_num), f"journey day {day_num}")

        elif args.mode == "list":
            rows = list_cases(args, args.limit)
            rows.sort(key=lambda r: (r.get("case_number") or 0), reverse=True)
            _emit_rows(rows, args.format, _format_case_table(rows))

        elif args.mode == "fireside":
            if args.target == "list":
                rows = list_firesides(args.topic, args.author, args.limit)
                rows.sort(key=lambda r: r.get("chat_date") or "", reverse=True)
                _emit_rows(rows, args.format, _format_fireside_table(rows))
            else:
                _emit_body(fetch_fireside(args.target), f"fireside {args.target}")
    except RuntimeError as e:
        print(f"ERROR: transport failure: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
