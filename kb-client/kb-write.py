#!/usr/bin/env python3
"""
kb-write.py — the write side of the unified KB client (CASE-482).

One generic write surface over the gateway's `POST /write/:type`: the gateway
derives mint-vs-natural-identity behaviour from the template's
metadata.custom.write, so this client needs no per-type logic and no hand-kept
type list — adding a doc type to the KB makes it writable here automatically.

Like the read side, every call goes through the KB **gateway** (kb_client_core),
never the document-store backend.

Usage:
    kb-write.py --list                       # the doc-type manifest (GET /types)
    kb-write.py <TYPE> <file.md>             # frontmatter -> data, body -> data.body
    kb-write.py <TYPE> -                     # read the markdown doc from stdin
    kb-write.py <TYPE> --json '{"title":…}'  # raw data object instead of a file
  options:
    --field k=v        add/override a data field (repeatable; light type coercion)
    --metadata '{…}'   JSON object merged into the write's metadata
    --format text|json output shape (default text)

Doc body convention: the markdown after the frontmatter fence becomes data.body
(unless the frontmatter already sets `body`).

Env: see kb_client_core (KB_BASE_URL / KB_API_KEY_FILE / KB_PREFER_LOCAL / …).
Exit codes: 0 ok · 1 validation/not-found from the gateway · 2 transport/usage.
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys

from kb_client_core import DEV_ROOT, gw_get, gw_post


def _coerce(v: str) -> object:
    """Light scalar coercion for frontmatter / --field values: true|false ->
    bool, ints/floats -> number, [a, b] -> list, else the raw string."""
    s = v.strip()
    low = s.lower()
    if low in ("true", "false"):
        return low == "true"
    if low in ("null", "~", ""):
        return None
    for cast in (int, float):
        try:
            return cast(s)
        except ValueError:
            pass
    if s.startswith("[") and s.endswith("]"):
        inner = s[1:-1].strip()
        return [_coerce(p) for p in inner.split(",")] if inner else []
    return s


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split a markdown doc into (frontmatter dict, body). Frontmatter is the
    block between a leading '---' fence and the next '---'. Simple `key: value`
    lines only (the doc types are flat); body is everything after the fence."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}, text
    fm: dict[str, object] = {}
    i = 1
    while i < len(lines) and lines[i].strip() != "---":
        line = lines[i]
        if line.strip() and not line.lstrip().startswith("#") and ":" in line:
            k, _, v = line.partition(":")
            fm[k.strip()] = _coerce(v)
        i += 1
    body = "\n".join(lines[i + 1:]).lstrip("\n") if i < len(lines) else ""
    return fm, body


def _first_h1(text: str) -> str:
    m = re.search(r"^#\s+(.+)$", text, re.M)
    return m.group(1).strip() if m else ""


# --- per-type extractors: (frontmatter, body, fields, filename) -> data --------
# Each maps a source doc to the template's fields, raising ValueError on an
# unresolvable required field (rejected before the wire). These mirror the
# domain conventions that used to live in the gateway mirror endpoints (CASE-482
# — extraction is the client's job; the gateway is pure persistence). Types not
# listed here use the generic frontmatter->fields mapping.

_MONTHS = ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"]
_JOURNEY_DAY_ONE = datetime.date(2026, 3, 14)  # journey day 1


def _ex_fireside(fm: dict, body: str, fields: dict, filename: str) -> dict:
    title = str(fields.get("title") or fm.get("title") or fm.get("topic") or _first_h1(body) or "").strip()
    if not title:
        raise ValueError("FIRESIDE: title unresolved (frontmatter title/topic, or an H1)")
    authored_by = str(fields.get("authored_by") or fm.get("participants") or fm.get("session") or "").strip()
    if not authored_by:
        raise ValueError("FIRESIDE: authored_by unresolved (frontmatter participants/session)")
    data = {"title": title, "body": body, "authored_by": authored_by,
            "doc_status": str(fields.get("doc_status") or fm.get("doc_status") or "published")}
    if fm.get("topic"):
        data["topic"] = str(fm["topic"])
    chat = str(fm.get("time") or fm.get("chat_date") or "")[:10]
    if re.match(r"^\d{4}-\d{2}-\d{2}$", chat):
        data["chat_date"] = chat
    return data


def _ex_document(fm: dict, body: str, fields: dict, filename: str) -> dict:
    path = str(fields.get("path") or "").strip()
    repo = str(fields.get("repo_origin") or "").strip()
    kind = str(fields.get("kind") or "").strip()
    if not (path and repo and kind):
        raise ValueError("DOCUMENT: --field path=, repo_origin=, kind= are all required")
    title = str(fields.get("title") or fm.get("title") or _first_h1(body)
                or os.path.basename(path).removesuffix(".md")).strip()
    data = {"path": path, "repo_origin": repo, "kind": kind, "title": title,
            "body": body, "doc_status": "published"}
    if fm.get("authored_by"):
        data["authored_by"] = str(fm["authored_by"])
    return data


def _ex_journey(fm: dict, body: str, fields: dict, filename: str) -> dict:
    day = fields.get("day_number")
    if day is None:
        m = re.match(r"WIP_Journey_Day(\d+)_Intermezzo\.md$", filename)
        if m:
            day = float(m.group(1)) + 0.5
        else:
            m = re.match(r"WIP_Journey_Day(\d+(?:\.\d+)?)\.md$", filename)
            if m:
                day = float(m.group(1))
    if day is None:
        raise ValueError("JOURNEY_ENTRY: day_number unresolved (use a WIP_Journey_DayN.md file, or --field day_number=)")
    day = float(day)
    daystr = str(int(day)) if day == int(day) else str(day)
    title = f"Day {daystr}"
    tm = re.search(r"^#[^\n]*?Day\s+\S+:\s*(.+)$", body, re.M)
    if tm:
        title = f"Day {daystr}: {tm.group(1).strip()}"
    # journey_date: a **Date:** header (Month D + a 20xx year) wins; else DAY_ONE+N-1.
    journey_date = (_JOURNEY_DAY_ONE + datetime.timedelta(days=int(day) - 1)).isoformat()
    head = body[:1500]
    dm = re.search(r"\*\*Date:\*\*[^\n]*?\b(" + "|".join(_MONTHS) + r")\b\s+(\d{1,2})", head)
    line = re.search(r"\*\*Date:\*\*([^\n]+)", head)
    year = re.search(r"\b(20\d{2})\b", line.group(1)) if line else None
    if dm and year:
        journey_date = f"{year.group(1)}-{_MONTHS.index(dm.group(1)) + 1:02d}-{int(dm.group(2)):02d}"
    return {"day_number": int(day) if day == int(day) else day, "title": title,
            "body": body, "authored_by": str(fields.get("authored_by") or "FRanC"),
            "journey_date": journey_date, "doc_status": "published"}


EXTRACTORS = {"FIRESIDE": _ex_fireside, "DOCUMENT": _ex_document, "JOURNEY_ENTRY": _ex_journey}


def _parse_fields(field_args: list | None) -> dict:
    out: dict = {}
    for kv in field_args or []:
        if "=" not in kv:
            raise SystemExit(f"ERROR: --field must be k=v (got {kv!r})")
        k, _, v = kv.partition("=")
        out[k.strip()] = _coerce(v)
    return out


def _parse_edges(edge_args: list | None) -> list:
    out = []
    for e in edge_args or []:
        parts = e.split(":")
        if len(parts) != 3:
            raise SystemExit(f"ERROR: --edge must be TYPE:target_type:target_key (got {e!r})")
        out.append({"type": parts[0], "target_type": parts[1], "target_key": _coerce(parts[2])})
    return out


_EDITOR_BACKUP = re.compile(r"(~|\.bak|\.swp|\.orig)$")


def _norm_iso(s: str) -> str:
    """Strip a trailing timezone to the naive YYYY-MM-DDTHH:MM[:SS] the SESSION
    datetime fields expect (mirrors the gateway's normalizeIsoDt)."""
    t = (s or "").strip()
    m = re.match(r"^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?)(?:[Zz]|[+-]\d{2}:?\d{2})?$", t)
    return m.group(1).replace(" ", "T") if m else t


def _session_records(dirpath: str, fields: dict) -> tuple[dict, list]:
    """A reports/<session-id>/ dir → SESSION data + CONTINUES_FROM edge intent.
    session.md frontmatter carries the fields; the *.md siblings bundle into the
    body. Replaces the gateway-side parsing in /sessions/mirror (CASE-482 (A))."""
    names = sorted(n for n in os.listdir(dirpath)
                   if n.endswith(".md") and not _EDITOR_BACKUP.search(n))
    if "session.md" not in names:
        raise ValueError(f"SESSION: {dirpath} has no session.md")
    contents = {n: open(os.path.join(dirpath, n), encoding="utf-8").read() for n in names}
    fm, _ = parse_frontmatter(contents["session.md"])
    session_id = str(fields.get("session_id") or fm.get("session_id") or os.path.basename(dirpath.rstrip("/")))
    role = str(fields.get("role") or fm.get("role") or "")
    if not role:
        m = re.match(r"^([A-Z][A-Z-]+?)-\d{8}", session_id)
        role = m.group(1) if m else ""
    if not role:
        raise ValueError("SESSION: role unresolved (frontmatter role, or a ROLE-YYYYMMDD session_id)")
    started_at = str(fm.get("started_at") or "")
    if not started_at:
        m = re.search(r"(\d{8})-(\d{4,6})$", session_id)
        if m:
            d, t = m.group(1), m.group(2).ljust(6, "0")
            started_at = f"{d[:4]}-{d[4:6]}-{d[6:8]}T{t[:2]}:{t[2:4]}:{t[4:6]}"
    ordered = ["session.md"] + [n for n in names if n != "session.md"]
    body = "\n\n".join(f"## {n}\n\n{contents[n]}" for n in ordered)
    data = {"session_id": session_id, "role": role, "status": str(fm.get("status") or "active"),
            "started_at": _norm_iso(started_at), "body": body}
    if fm.get("continues_from"):
        data["continues_from"] = str(fm["continues_from"]).strip()
    if fm.get("ended_at"):
        data["ended_at"] = _norm_iso(str(fm["ended_at"]))
    edges = []
    if data.get("continues_from"):
        edges.append({"type": "CONTINUES_FROM", "target_type": "SESSION", "target_key": data["continues_from"]})
    return data, edges


def build_records(type_: str, args: argparse.Namespace) -> tuple[dict, list]:
    """Produce (data, edges) for a write. A per-type extractor maps the source to
    fields (validating); --field overrides win; edges come from --edge plus the
    continues_from / responds_to frontmatter conventions."""
    fields = _parse_fields(args.field)
    edges = _parse_edges(args.edge)
    # A directory source = a session report dir → SESSION (only SESSION bundles a
    # dir). A SESSION *file* arg pointing at session.md resolves to its parent dir
    # so the harness's file-path convention (`reports/<id>/session.md`, used by
    # /wip-wake, /wip-setup, /wip-report) routes through _session_records too —
    # otherwise a frontmatter-only session.md hits the generic path with an empty
    # body and the gateway rejects "Field 'body' is required" (CASE-503).
    src = args.file
    if src and src != "-":
        sess_dir = None
        if os.path.isdir(src):
            if type_ != "SESSION":
                raise SystemExit(f"ERROR: a directory source is only valid for SESSION (got {type_})")
            sess_dir = src
        elif type_ == "SESSION" and os.path.basename(src) == "session.md":
            sess_dir = os.path.dirname(src) or "."
        if sess_dir is not None:
            data, dedges = _session_records(sess_dir, fields)
            data.update(fields)
            return data, edges + dedges
    if args.json is not None:
        data = json.loads(args.json)
        if not isinstance(data, dict):
            raise SystemExit("ERROR: --json must be a JSON object")
        data.update(fields)
        return data, edges
    if args.file is None:
        raise SystemExit("ERROR: provide a file (or '-'), or --json")
    text = sys.stdin.read() if args.file == "-" else open(args.file, encoding="utf-8").read()
    fm, body = parse_frontmatter(text)
    filename = "" if args.file == "-" else os.path.basename(args.file)
    extractor = EXTRACTORS.get(type_)
    if extractor:
        data = extractor(fm, body, fields, filename)
    else:
        data = dict(fm)
        if body and "body" not in data:
            data["body"] = body
    data.update(fields)  # explicit --field always wins
    if fm.get("continues_from"):
        edges.append({"type": "CONTINUES_FROM", "target_type": "SESSION", "target_key": str(fm["continues_from"]).strip()})
    if fm.get("responds_to"):
        edges.append({"type": "RESPONDS_TO", "target_type": "CASE_RECORD", "target_key": fm["responds_to"]})
    return data, edges


def _post_write(type_: str, data: dict, edges: list, metadata: dict | None, fmt: str) -> int:
    """The single write call: { data, edges?, metadata? } → POST /write/:type."""
    body: dict = {"data": data}
    if edges:
        body["edges"] = edges
    if metadata:
        body["metadata"] = metadata
    result = gw_post(f"/write/{type_}", body)
    if fmt == "json":
        sys.stdout.write(json.dumps(result, indent=2) + "\n")
    else:
        syn = result.get("synonym")
        tag = f" {syn}" if syn else ""
        eg = result.get("edges") or []
        egtxt = "  edges: " + ", ".join(f"{e['type']}→{e['target_key']}={e['status']}" for e in eg) if eg else ""
        sys.stdout.write(f"{result.get('result', '?')}{tag} ({result.get('document_id', '')}){egtxt}\n")
    return 0


# --- GIT_STATS_SNAPSHOT source: computed from git, not a file ------------------
# Git lives on this machine, so computing the per-day stats is this type's
# "extractor"; the WRITE still goes through the one path (_post_write). This is
# why there is no separate stats writer — git-stats is just another type the one
# client handles (CASE-482 (A)).
REPOS: dict[str, object] = {
    "World-in-a-Pie": DEV_ROOT / "World-in-a-Pie",
    "FR-YAC":         DEV_ROOT / "FR-YAC",
    "KB":             DEV_ROOT / "WIP-KB",
    "ClinTrial":      DEV_ROOT / "WIP-ClinTrial",
    "DnD":            DEV_ROOT / "WIP-DnD",
    "AuthorAssist":   DEV_ROOT / "WIP-AA",
    "Song":           DEV_ROOT / "WIP-Song",
    "Validator":      DEV_ROOT / "WIP-VAL",
    "ReactConsole":   DEV_ROOT / "WIP-ReactConsole",
}


def _gather_git_stats(repo_path, day: datetime.date) -> dict | None:
    """Per-day commit/line/file/contributor counts for one repo. None if not a
    git repo; zero-filled if the repo exists but had no commits that day."""
    if not (repo_path / ".git").exists():
        return None
    since = f"{day.isoformat()} 00:00:00"  # explicit time — git's bare date is "now-of-day"
    until = f"{(day + datetime.timedelta(days=1)).isoformat()} 00:00:00"
    out = subprocess.run(["git", "log", f"--since={since}", f"--until={until}",
                          "--shortstat", "--no-merges", "--pretty=format:%H"],
                         cwd=repo_path, capture_output=True, text=True, check=False)
    if out.returncode != 0:
        return {"commits": 0, "lines_added": 0, "lines_removed": 0, "files_changed": 0, "contributors": 0}
    commits = added = removed = files = 0
    for line in out.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        if len(line) == 40 and all(c in "0123456789abcdef" for c in line):
            commits += 1
            continue
        for tok in line.split(","):
            parts = tok.strip().split()
            if not parts:
                continue
            try:
                n = int(parts[0])
            except ValueError:
                continue
            if "file" in tok:
                files += n
            elif "insertion" in tok:
                added += n
            elif "deletion" in tok:
                removed += n
    sl = subprocess.run(["git", "shortlog", "-sn", f"--since={since}", f"--until={until}", "--no-merges", "HEAD"],
                        cwd=repo_path, capture_output=True, text=True, check=False)
    contributors = len([ln for ln in sl.stdout.splitlines() if ln.strip()]) if sl.returncode == 0 else 0
    return {"commits": commits, "lines_added": added, "lines_removed": removed,
            "files_changed": files, "contributors": contributors}


def cmd_gitstats(args: argparse.Namespace) -> int:
    """Compute git stats and write each (repo, date) snapshot through the one
    write path. --git-repo <name|all>, --git-date YYYY-MM-DD, --git-backfill N."""
    if args.git_list_repos:
        for name, path in REPOS.items():
            print(f"  {'✓' if (path / '.git').exists() else '✗'} {name:18}  {path}")
        return 0
    if args.git_repo and args.git_repo != "all" and args.git_repo not in REPOS:
        print(f"ERROR: unknown repo {args.git_repo!r}. Known: {', '.join(REPOS)}", file=sys.stderr)
        return 2
    repos = list(REPOS.items()) if (args.git_repo in (None, "all")) else [(args.git_repo, REPOS[args.git_repo])]
    if args.git_backfill:
        today = datetime.date.today()
        dates = [today - datetime.timedelta(days=i) for i in range(args.git_backfill)]
    elif args.git_date:
        try:
            dates = [datetime.date.fromisoformat(args.git_date)]
        except ValueError:
            print(f"ERROR: --git-date must be YYYY-MM-DD (got {args.git_date!r})", file=sys.stderr)
            return 2
    else:
        dates = [datetime.date.today()]
    failures = 0
    for d in dates:
        ds = d.isoformat()
        for name, path in repos:
            s = _gather_git_stats(path, d)
            if s is None:
                print(f"[skip] {name}: not a git repo at {path}", file=sys.stderr)
                continue
            data = {"repo": name, "snapshot_date": ds, **s,
                    "title": f"{name} — {ds}", "authored_by": "FRanC", "doc_status": "published",
                    "root": False, "tags": ["git-stats", f"repo-{name}", f"date-{ds}"]}
            try:
                _post_write("GIT_STATS_SNAPSHOT", data, [], {"loader": "kb-client"}, args.format)
            except RuntimeError as e:
                print(f"[gateway] {name} {ds}: {e}", file=sys.stderr)
                failures += 1
    return 0 if failures == 0 else 2


def cmd_list(fmt: str) -> int:
    payload = gw_get("/types") or {}
    types = payload.get("types") or []
    if fmt == "json":
        sys.stdout.write(json.dumps(types, indent=2) + "\n")
        return 0
    out = ["| Type | Write mode | Synonym | Identity fields |", "|---|---|---|---|"]
    for t in types:
        out.append(
            f"| {t.get('type')} | {t.get('write_mode')} | {t.get('synonym_prefix') or ''} | "
            f"{', '.join(t.get('identity_fields') or [])} |"
        )
    sys.stdout.write("\n".join(out) + "\n")
    return 0


def cmd_write(type_: str, args: argparse.Namespace) -> int:
    try:
        data, edges = build_records(type_, args)
    except ValueError as e:
        print(f"ERROR: rejected — {e}", file=sys.stderr)  # client-side validation
        return 1
    if not data:
        print("ERROR: empty data — nothing to write", file=sys.stderr)
        return 2
    md = json.loads(args.metadata) if args.metadata else None
    if md is not None and not isinstance(md, dict):
        raise SystemExit("ERROR: --metadata must be a JSON object")
    return _post_write(type_, data, edges, md, args.format)


def cmd_patch(type_: str, args: argparse.Namespace) -> int:
    """Partial update of an existing doc: --patch k=v (repeatable) located by
    --match k=v. Posts { patch, match } to /write/:type (e.g. a case status change)."""
    patch = _parse_fields(args.patch)
    match = _parse_fields([args.match]) if args.match else {}
    if not patch or not match:
        print("ERROR: --patch k=v and --match k=v are both required", file=sys.stderr)
        return 2
    result = gw_post(f"/write/{type_}", {"patch": patch, "match": match})
    if args.format == "json":
        sys.stdout.write(json.dumps(result, indent=2) + "\n")
    else:
        sys.stdout.write(f"{result.get('result', '?')} ({result.get('document_id', '')})\n")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="KB write client (gateway-only).")
    ap.add_argument("type", nargs="?", help="doc type (e.g. DESIGN_DECISION); omit with --list")
    ap.add_argument("file", nargs="?", help="markdown file with frontmatter, or '-' for stdin")
    ap.add_argument("--list", action="store_true", help="list writable doc types (GET /types)")
    ap.add_argument("--json", help="raw JSON data object instead of a file")
    ap.add_argument("--field", action="append", help="add/override a data field k=v (repeatable)")
    ap.add_argument("--edge", action="append", help="edge intent TYPE:target_type:target_key (repeatable)")
    ap.add_argument("--metadata", help="JSON object merged into the write metadata")
    ap.add_argument("--patch", action="append", help="partial-update field k=v (repeatable; with --match)")
    ap.add_argument("--match", help="locate the doc to patch by k=v")
    # GIT_STATS_SNAPSHOT source (computed from git, not a file)
    ap.add_argument("--git-repo", help="git-stats: canonical repo name, or 'all'")
    ap.add_argument("--git-date", help="git-stats: snapshot date YYYY-MM-DD (default today)")
    ap.add_argument("--git-backfill", type=int, metavar="N", help="git-stats: last N days")
    ap.add_argument("--git-list-repos", action="store_true", help="git-stats: print the known repo set")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    args = ap.parse_args()

    try:
        if args.list:
            return cmd_list(args.format)
        if args.git_list_repos or args.git_repo or args.git_backfill:
            return cmd_gitstats(args)
        if not args.type:
            ap.error("a doc TYPE is required (or use --list)")
        if args.patch:
            return cmd_patch(args.type, args)
        return cmd_write(args.type, args)
    except RuntimeError as e:
        print(f"ERROR: transport failure: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
