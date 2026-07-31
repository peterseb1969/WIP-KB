#!/usr/bin/env python3
"""
case-fetch.py — read-side commands for the KB client (cases, journeys, list, firesides, library,
and the generic typed read for any writable type).

Every read goes through the KB **gateway** API (`{BASE_PATH}/server-api/kb/…`) via
kb_client_core — the app-specific layer that owns projection, namespace discipline,
and identity. Clients never reach past it into the document-store backend (CASE-482;
the "straight to MongoDB" anti-pattern). Transport, target config, and local→remote
failover all live in the core; this file is thin command handlers + output shaping.

(The filename is historical — it now serves journeys, list, firesides, library, and a
generic `read <TYPE>` too.)

Exit codes:
    0 = success (body / table printed to stdout)
    1 = not found
    2 = transport failure on the final-attempted target
    3 = search only: the --type filter matched no reporting table, so the empty
        result is a bad/retired type name rather than a genuine zero-result

Usage:
    case-fetch.py case <N>
    case-fetch.py journey <N>            # N may be fractional, e.g. 7.5
    case-fetch.py list [--status …] [--filed-by …] [--severity …] [--type …]
                       [--component …] [--app …] [--limit N] [--format table|json]
    case-fetch.py fireside list [--topic …] [--author …] [--limit N] [--format …]
    case-fetch.py fireside <n>           # 12 or FIRESIDE-12, or a document_id
    case-fetch.py library list [--release …] [--category …] [--audience …] [--limit N] [--format …]
    case-fetch.py library <slug> --release <release>
    case-fetch.py search "<terms>" [--type TYPE] [--mode auto|fts|substring] [--limit N] [--format …]
    case-fetch.py read <TYPE> [--filter KEY=VALUE …] [--namespace …] [--page N] [--page-size N] [--format …]

Env: see kb_client_core (KB_BASE_URL / KB_API_KEY_FILE / KB_PREFER_LOCAL / …).
"""
from __future__ import annotations

import argparse
import json
import re
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


def _overlay_status(body: str, live: str | None) -> str:
    """Make the rendered case body reflect the LIVE structured status (CASE-690).

    A CASE_RECORD stores status twice: the structured `data.status` (what --patch
    updates and `list` filters on) and the filed markdown body. Older case bodies
    open with a frontmatter block whose `status:` line is frozen at filing time, so
    the default rendered view showed a stale value (e.g. `open`) for any case that
    had since been responded/closed/implemented. Overlay the live value at RENDER
    time only — the stored body stays the immutable filed artifact:
      - body with a frontmatter `status:` line → rewrite it, annotating a
        divergence (`status: implemented (live; filed as open)`);
      - body without one (gateway-filed, no frontmatter) → prepend a live-status
        line so every rendered case shows its current status.
    """
    if not live:
        return body
    fm = re.match(r"---\n.*?\n---\n", body, re.S)
    if fm:
        def _sub(m: re.Match) -> str:
            filed = m.group(2).strip()
            repl = live if filed == live else f"{live} (live; filed as {filed})"
            return f"{m.group(1)}{repl}"
        new_block, n = re.subn(
            r"^(status:[ \t]*)(.+?)[ \t]*$", _sub, fm.group(0), count=1, flags=re.M
        )
        if n:
            return new_block + body[fm.end():]
    return f"> **status:** {live}\n\n{body}"


def render_case(payload: dict, view: str) -> str:
    """Render the gateway payload to markdown: body, the response thread, or both."""
    parts: list[str] = []
    if view in ("case", "both"):
        body = _overlay_status(payload.get("body") or "", payload.get("status"))
        parts.append(body.rstrip("\n"))
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
    the table (case_number + a slug derived from the title).

    `target_yac` is filtered CLIENT-SIDE: the gateway returns it per item but does
    not facet on it, so we fetch the other facets server-side and narrow here. When
    a target filter is set we fetch the full page (cap 100) so matches aren't lost
    below the pre-filter --limit; comma-separated values are OR-ed (e.g.
    `--target-yac APP-KB,any` for "mine + unassigned")."""
    targets = {t.strip() for t in (args.target_yac or "").split(",") if t.strip()}
    page_size = 100 if targets else min(limit, 100)
    params: dict[str, str] = {"page_size": str(page_size)}
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
        if targets and (it.get("target_yac") or "") not in targets:
            continue
        title = it.get("title") or ""
        slug = title.split(":", 1)[1].strip() if ":" in title else title
        rows.append({
            "case_number": it.get("case"),
            "status": it.get("status") or "",
            "severity": it.get("severity") or "",
            "type": it.get("type") or "",
            "component": it.get("component") or "",
            "filed_by": it.get("filed_by") or "",
            "target_yac": it.get("target_yac") or "",
            "app": it.get("app") or "",
            "slug": slug,
        })
    return rows


def _format_case_table(rows: list[dict]) -> str:
    header = (
        "| # | Status | Severity | Type | Component | Target | Filed by | Slug |\n"
        "|---|---|---|---|---|---|---|---|"
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
            f"{r.get('target_yac') or ''} | {r['filed_by'] or ''} | {r['slug'] or ''} |"
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
    # `#` is the fireside_number — the handle `fireside <n>` takes. Without it in the
    # listing there is no way to discover N short of --format json.
    header = (
        "| # | Chat date | Topic | Authored by | Title | Document ID |\n"
        "|---|---|---|---|---|---|"
    )
    if not rows:
        return f"{header}\n_(no matches)_\n"
    out = [header]
    for r in rows:
        n = r.get("fireside_number")
        out.append(
            f"| {'' if n is None else n} | {r.get('chat_date') or ''} | {r.get('topic') or ''} | "
            f"{r.get('authored_by') or ''} | {r.get('title') or ''} | "
            f"{r.get('document_id') or ''} |"
        )
    return "\n".join(out) + "\n"


# ----------------------------------------------------------------------------
# library mode (CASE-616) — list published LIBRARY_DOCs, fetch one body by slug
# ----------------------------------------------------------------------------

def list_library_docs(release: str | None, category: str | None,
                      audience: str | None, limit: int) -> list[dict]:
    """GET /library-docs?<facets>. Published docs only (the gateway enforces it);
    bodies omitted. Returns the gateway's projected rows."""
    params: dict[str, str] = {"page_size": str(min(limit, 100))}
    if release:
        params["release"] = release
    if category:
        params["category"] = category
    if audience:
        params["audience"] = audience
    payload = gw_get("/library-docs?" + urllib.parse.urlencode(params)) or {}
    return payload.get("items") or []


def fetch_library_doc(slug: str, release: str) -> str | None:
    """GET /library-docs/:slug?release= — the doc body, or None if absent.
    Identity is [slug, release], so release is required to disambiguate."""
    q = f"/library-docs/{urllib.parse.quote(slug)}?release={urllib.parse.quote(release)}"
    payload = gw_get(q)
    return payload.get("body") if payload is not None else None


def _format_library_table(rows: list[dict]) -> str:
    header = (
        "| Slug | Release | Category | Audience | Title |\n"
        "|---|---|---|---|---|"
    )
    if not rows:
        return f"{header}\n_(no matches)_\n"
    out = [header]
    for r in rows:
        out.append(
            f"| {r.get('slug') or ''} | {r.get('release') or ''} | "
            f"{r.get('category') or ''} | {r.get('audience') or ''} | "
            f"{r.get('title') or ''} |"
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


def read_type(type_: str, filters: list[str], namespace: str | None,
              page: int, page_size: int) -> dict | None:
    """GET /read/:type — the generic typed read, symmetric to kb-write.py's
    /write/:type (CASE-683). Every `--filter k=v` becomes an eq-match on data.k, so
    a type's identity fields filter for free. Returns the gateway payload, or None
    if the type/route is absent."""
    params: dict[str, str] = {"page": str(page), "page_size": str(min(page_size, 100))}
    if namespace:
        params["namespace"] = namespace
    for f in filters or []:
        if "=" not in f:
            print(f"ERROR: --filter must be key=value (got: {f!r})", file=sys.stderr)
            sys.exit(2)
        k, v = f.split("=", 1)
        params[k.strip()] = v
    return gw_get(f"/read/{urllib.parse.quote(type_, safe='')}?" + urllib.parse.urlencode(params))


def search_docs(q: str, type_: str | None, mode: str, limit: int) -> dict | None:
    """GET /search — full-text search across the whole corpus (kb + library), the
    content-search counterpart to the structured verbs (CASE-707)."""
    params = {"q": q, "mode": mode, "limit": str(limit)}
    if type_:
        params["type"] = type_
    return gw_get("/search?" + urllib.parse.urlencode(params))


def fetch_topics(type_: str, namespace: str | None) -> dict | None:
    """GET /topics — the vocabulary the `topics:` frontmatter field must draw from.

    The field is validated on write and rejects unknown values, but until this verb
    existed the only way to see the domain was the Topic facet in the browser — no
    use to an agent filing through this client, whose only remaining option was
    guess-and-retry against a live gateway."""
    params = {"type": type_}
    if namespace:
        params["namespace"] = namespace
    return gw_get("/topics?" + urllib.parse.urlencode(params))


def _format_topics(payload: dict) -> str:
    topics = payload.get("topics") or []
    head = (f"{payload.get('terminology')} — {payload.get('total', len(topics))} topic(s) "
            f"for {payload.get('type')} [{payload.get('namespace')}]")
    lines = [head, "=" * len(head), ""]
    for t in topics:
        # Indent by depth so the flat list reads as the tree it is: a writer
        # choosing between a parent and its child is making a real choice, since
        # tagging a leaf also surfaces the doc under its ancestors.
        bullet = "  " * int(t.get("depth") or 0) + "- " + str(t.get("value"))
        notes = []
        if t.get("label") and t["label"] != t.get("value"):
            notes.append(str(t["label"]))
        if t.get("aliases"):
            notes.append("aka " + ", ".join(str(a) for a in t["aliases"]))
        if t.get("orphaned"):
            notes.append("!! unreachable from any root — still a legal tag")
        lines.append(bullet + (f"   ({'; '.join(notes)})" if notes else ""))
    lines.append("")
    lines.append("Pick 1-4 that describe what the document is ABOUT — not which "
                 "component it was filed against.")
    return "\n".join(lines) + "\n"


_TAG_RE = re.compile(r"<[^>]+>")


def _clean_snippet(s: str | None, width: int = 100) -> str:
    """Snippets arrive with the platform's <b> highlight markup and embedded
    newlines. A terminal renders neither, and a raw newline or pipe would break the
    markdown row — so strip tags, collapse whitespace, escape pipes, then clip."""
    if not s:
        return ""
    text = " ".join(_TAG_RE.sub("", s).split()).replace("|", r"\|")
    return text[:width] + "…" if len(text) > width else text


def _format_search_table(payload: dict) -> str:
    items = payload.get("items") or []
    head = (f"{payload.get('query')!r} — {payload.get('returned', len(items))} hit(s) "
            f"[{', '.join(payload.get('namespaces') or [])}] mode={payload.get('mode')}"
            + ("  (truncated — raise --limit for more)" if payload.get("truncated") else ""))
    # An unmatched --type must not read as a legitimate zero-result. That silence
    # is what let CASE-810 run unnoticed on two live instances: a type-filtered
    # search returned nothing and was taken as "the corpus has nothing" rather
    # than "your type name matched no reporting table" (CASE-811).
    unmatched = payload.get("unmatched_template")
    if unmatched:
        return (f"{head}\n"
                f"!! --type {unmatched!r} matched no reporting table in "
                f"{', '.join(payload.get('namespaces') or [])} — this is NOT a zero-result.\n"
                f"   The type name may be wrong or retired, or its documents may not be "
                f"synced to reporting.\n"
                f"   Re-run without --type to search every type.\n")
    if not items:
        return f"{head}\n_(no matches)_\n"
    out = [head, "", "| Type | Score | Title | Snippet | Document ID |", "|---|---|---|---|---|"]
    for it in items:
        score = it.get("score")
        out.append(
            f"| {it.get('template_value') or ''} | {'' if score is None else f'{score:.2f}'} | "
            f"{(it.get('title') or '').replace('|', chr(92) + '|')[:60]} | "
            f"{_clean_snippet(it.get('snippet'))} | {it.get('document_id') or ''} |"
        )
    return "\n".join(out) + "\n"


def _format_read_table(payload: dict) -> str:
    items = payload.get("items") or []
    head = (f"{payload.get('type')} — {payload.get('total', len(items))} doc(s) "
            f"[{payload.get('namespace')}] · page {payload.get('page')}/{payload.get('pages')}\n")
    # Salient identity-ish fields first; fall back to a compact data dump.
    salient = ("title", "name", "owner", "mem_key", "slug", "snapshot_date", "repo",
               "day_number", "authored_by", "doc_status")
    lines = [head]
    for it in items:
        d = it.get("data") or {}
        keys = [k for k in salient if k in d]
        summ = " · ".join(f"{k}={d[k]}" for k in keys) if keys else json.dumps(d)[:100]
        lines.append(f"  {it.get('document_id')}  {summ}")
    return "\n".join(lines) + "\n"


def main() -> None:
    ap = argparse.ArgumentParser(description="KB read client (gateway-only).")
    sub = ap.add_subparsers(dest="mode", required=True)

    case_sp = sub.add_parser("case", help="fetch a case: body, response thread, or both")
    case_sp.add_argument("identifier", help="case number")
    case_sp.add_argument("--view", choices=["case", "responses", "both"], default=None,
                         help="case body, the response thread, or both "
                              "(default: both, or responses when --response is given)")
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
    list_sp.add_argument("--target-yac", dest="target_yac",
                         help="filter by assigned YAC, comma-separated (e.g. APP-KB or APP-KB,any). "
                              "Client-side: the gateway returns target_yac but does not facet on it.")
    list_sp.add_argument("--limit", type=int, default=50, help="max rows (default 50, cap 100)")
    list_sp.add_argument("--format", choices=["table", "json"], default="table")

    fireside_sp = sub.add_parser("fireside", help="list firesides, or fetch one by document_id")
    fireside_sp.add_argument("target",
                             help="'list', a fireside number (12 or FIRESIDE-12), or a document_id")
    fireside_sp.add_argument("--topic", help="filter list by exact topic (data.topic)")
    fireside_sp.add_argument("--author", help="filter list by exact author (data.authored_by)")
    fireside_sp.add_argument("--limit", type=int, default=50, help="max rows (default 50, cap 100)")
    fireside_sp.add_argument("--format", choices=["table", "json"], default="table")

    library_sp = sub.add_parser("library", help="list published LIBRARY_DOCs, or fetch one body by slug")
    library_sp.add_argument("target", help="'list', or a LIBRARY_DOC slug")
    library_sp.add_argument("--release", help="release line (e.g. wip-v1); REQUIRED when fetching a slug")
    library_sp.add_argument("--category", help="filter list by exact category")
    library_sp.add_argument("--audience", help="filter list by exact audience")
    library_sp.add_argument("--limit", type=int, default=50, help="max rows (default 50, cap 100)")
    library_sp.add_argument("--format", choices=["table", "json"], default="table")

    edges_sp = sub.add_parser("edges", help="every edge touching a doc (CASE-630)")
    edges_sp.add_argument("handle", help="Registry synonym (CASE-627, CASE-629#1, …) or document_id")
    edges_sp.add_argument("--namespace", help="namespace override (default: gateway corpus)")
    edges_sp.add_argument("--format", choices=["text", "json"], default="text")

    flags_sp = sub.add_parser("flags", help="flag-for-YAC queue: FLAG_RECORDs joined to their target")
    flags_sp.add_argument("--target-yac", dest="target_yac", help="only flags aimed at this YAC")
    flags_sp.add_argument("--doc-status", dest="doc_status", default="published",
                          help="published (default = pending dispatch) | dispatched | all | …")
    flags_sp.add_argument("--target-type", dest="target_type", help="filter by target doc type, e.g. CASE_RECORD")
    flags_sp.add_argument("--limit", type=int, default=50, help="max rows (default 50, cap 100)")
    flags_sp.add_argument("--format", choices=["table", "json"], default="table")

    search_sp = sub.add_parser("search", help="full-text search across the whole corpus "
                                             "(kb + library) — content search, not field filters")
    search_sp.add_argument("q", metavar="TERMS", help="search terms")
    search_sp.add_argument("--type", dest="type_", metavar="TYPE",
                           help="restrict to one doc type, e.g. CASE_RECORD, FIRESIDE")
    # dest=mode_ : the subparser dest is already "mode" (the verb name) — reusing it
    # here would clobber the selected subcommand.
    search_sp.add_argument("--mode", dest="mode_", choices=["auto", "fts", "substring"],
                           default="auto",
                           help="auto (default) falls back to substring when FTS finds nothing")
    search_sp.add_argument("--limit", type=int, default=25, help="max hits (default 25, cap 100)")
    search_sp.add_argument("--format", choices=["table", "json"], default="table")

    topics_sp = sub.add_parser("topics", help="the KB_TOPIC vocabulary the `topics:` "
                                              "frontmatter field must be drawn from")
    topics_sp.add_argument("--type", dest="type_", default="CASE_RECORD",
                           help="which type's topic vocabulary (default CASE_RECORD)")
    topics_sp.add_argument("--namespace", help="namespace override (default: gateway corpus)")
    topics_sp.add_argument("--format", choices=["tree", "json"], default="tree")

    read_sp = sub.add_parser("read", help="generic typed read (CASE-683) — every type "
                                          "kb-write.py can write is readable here, via GET /read/:type")
    read_sp.add_argument("type_", metavar="TYPE",
                         help="doc type value, e.g. YAC_MEMORY, LESSON, DESIGN_DECISION, DOCUMENT")
    read_sp.add_argument("--filter", action="append", metavar="KEY=VALUE",
                         help="eq-filter on data.KEY, repeatable — identity fields work for free "
                              "(e.g. --filter owner=FRanC, --filter snapshot_date=2026-07-18 --filter repo=WIP-KB)")
    read_sp.add_argument("--namespace", help="namespace override (default: the type's home namespace)")
    read_sp.add_argument("--page", type=int, default=1, help="page number (default 1)")
    read_sp.add_argument("--page-size", dest="page_size", type=int, default=50,
                         help="rows per page (default 50, cap 100)")
    read_sp.add_argument("--format", choices=["table", "json"], default="table")

    args = ap.parse_args()

    try:
        if args.mode == "case":
            try:
                case_num = int(args.identifier)
            except ValueError:
                print(f"ERROR: case identifier must be an integer (got: {args.identifier!r})", file=sys.stderr)
                sys.exit(2)
            # --response implies responses-only unless --view is set explicitly,
            # so `case <n> --response latest` returns the response, not the body.
            view = args.view or ("responses" if args.response else "both")
            payload = fetch_case_payload(case_num, view, args.response)
            if payload is None:
                what = f"case {case_num}" + (f" response {args.response}" if args.response else "")
                print(f"{what} not found in kb", file=sys.stderr)
                sys.exit(1)
            if args.format == "json":
                sys.stdout.write(json.dumps(payload, indent=2) + "\n")
            else:
                sys.stdout.write(render_case(payload, view))
            sys.exit(0)

        elif args.mode == "topics":
            payload = fetch_topics(args.type_, args.namespace)
            if payload is None:
                print(f"no topic vocabulary for {args.type_} on this instance "
                      "(older gateway, or the type carries no topics field)", file=sys.stderr)
                sys.exit(1)
            if args.format == "json":
                sys.stdout.write(json.dumps(payload, indent=2) + "\n")
            else:
                sys.stdout.write(_format_topics(payload))
            sys.exit(0)

        elif args.mode == "search":
            payload = search_docs(args.q, args.type_, args.mode_, args.limit)
            if payload is None:
                print("search unavailable on this instance (no /search route)", file=sys.stderr)
                sys.exit(1)
            if args.format == "json":
                sys.stdout.write(json.dumps(payload, indent=2) + "\n")
            else:
                sys.stdout.write(_format_search_table(payload))
            # Exit 3 = the --type filter matched nothing that exists, which is a
            # different fact from "no document matched" (exit 1). Collapsing the
            # two is what made CASE-810 invisible; a caller branching on 1 must
            # not silently absorb a bad type name (CASE-811).
            if payload.get("unmatched_template"):
                print(f"search: --type {payload['unmatched_template']!r} matched no reporting "
                      f"table — not a zero-result", file=sys.stderr)
                sys.exit(3)
            sys.exit(0 if payload.get("items") else 1)

        elif args.mode == "read":
            payload = read_type(args.type_, args.filter, args.namespace, args.page, args.page_size)
            if payload is None:
                print(f"type {args.type_!r} not readable in kb (unknown type or no route)", file=sys.stderr)
                sys.exit(1)
            if args.format == "json":
                sys.stdout.write(json.dumps(payload, indent=2) + "\n")
            else:
                sys.stdout.write(_format_read_table(payload))
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

        elif args.mode == "library":
            if args.target == "list":
                rows = list_library_docs(args.release, args.category, args.audience, args.limit)
                rows.sort(key=lambda r: (r.get("release") or "", r.get("slug") or ""))
                _emit_rows(rows, args.format, _format_library_table(rows))
            else:
                if not args.release:
                    print("ERROR: --release is required to fetch a LIBRARY_DOC "
                          "(identity is [slug, release])", file=sys.stderr)
                    sys.exit(2)
                _emit_body(fetch_library_doc(args.target, args.release),
                           f"library doc {args.target!r} (release {args.release})")

        elif args.mode == "edges":
            q = f"/edges/{urllib.parse.quote(args.handle, safe='')}"
            if args.namespace:
                q += f"?namespace={args.namespace}"
            payload = gw_get(q)
            if payload is None:
                print(f"{args.handle} not found in kb", file=sys.stderr)
                sys.exit(1)
            if args.format == "json":
                sys.stdout.write(json.dumps(payload, indent=2) + "\n")
            else:
                rels = payload.get("relationships")
                items = rels.get("items") or rels.get("relationships") if isinstance(rels, dict) else rels
                items = items if isinstance(items, list) else ([rels] if rels else [])
                doc_id = payload.get("document_id", "")
                sys.stdout.write(f"{args.handle} ({doc_id}) — {len(items)} edge(s)\n")
                for r in items:
                    if not isinstance(r, dict):
                        sys.stdout.write(f"  {json.dumps(r)}\n")
                        continue
                    et = r.get("template_value") or r.get("edge_kind") or "?"
                    src = (r.get("data") or {}).get("source_ref") or r.get("source_ref") or "?"
                    tgt = (r.get("data") or {}).get("target_ref") or r.get("target_ref") or "?"
                    # label the far end with its resolved doc type when present
                    other = tgt if src == doc_id else src
                    kind = next((x.get("resolved", {}).get("template_value")
                                 for x in (r.get("references") or [])
                                 if x.get("resolved", {}).get("document_id") == other), "")
                    marker = "->" if src == doc_id else "<-"
                    sys.stdout.write(f"  {et} {marker} {kind + ' ' if kind else ''}{other}\n")

        elif args.mode == "flags":
            params = {"page_size": min(max(args.limit, 1), 100), "doc_status": args.doc_status}
            if args.target_yac:
                params["target_yac"] = args.target_yac
            if args.target_type:
                params["target_type"] = args.target_type
            payload = gw_get("/flags?" + urllib.parse.urlencode(params)) or {}
            rows = payload.get("items") or []
            if args.format == "json":
                sys.stdout.write(json.dumps(payload, indent=2) + "\n")
            else:
                out = ["| Flag id | Type | Target YAC | Status | Target | Title |", "|---|---|---|---|---|---|"]
                for r in rows:
                    t = r.get("target") or {}
                    tgt = f"CASE-{t['case_number']}" if t.get("case_number") else \
                          f"{t.get('template_value') or '?'} {str(t.get('document_id') or '')[:13]}…"
                    out.append(f"| {r.get('flag_id')} | {r.get('flag_type') or ''} | {r.get('target_yac') or ''} "
                               f"| {r.get('doc_status') or ''} | {tgt} | {r.get('title') or ''} |")
                sys.stdout.write("\n".join(out) + "\n")
    except RuntimeError as e:
        print(f"ERROR: transport failure: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
