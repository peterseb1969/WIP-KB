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
import json
import sys

from kb_client_core import gw_get, gw_post


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


def build_data(args: argparse.Namespace) -> dict:
    if args.json is not None:
        data = json.loads(args.json)
        if not isinstance(data, dict):
            raise SystemExit("ERROR: --json must be a JSON object")
    elif args.file is not None:
        text = sys.stdin.read() if args.file == "-" else open(args.file, encoding="utf-8").read()
        fm, body = parse_frontmatter(text)
        data = dict(fm)
        if body and "body" not in data:
            data["body"] = body
    else:
        raise SystemExit("ERROR: provide a file (or '-'), or --json")
    for kv in args.field or []:
        if "=" not in kv:
            raise SystemExit(f"ERROR: --field must be k=v (got {kv!r})")
        k, _, v = kv.partition("=")
        data[k.strip()] = _coerce(v)
    return data


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
    data = build_data(args)
    if not data:
        print("ERROR: empty data — nothing to write", file=sys.stderr)
        return 2
    body: dict = {"data": data}
    if args.metadata:
        md = json.loads(args.metadata)
        if not isinstance(md, dict):
            raise SystemExit("ERROR: --metadata must be a JSON object")
        body["metadata"] = md
    result = gw_post(f"/write/{type_}", body)
    if args.format == "json":
        sys.stdout.write(json.dumps(result, indent=2) + "\n")
    else:
        syn = result.get("synonym")
        tag = f" {syn}" if syn else ""
        sys.stdout.write(f"{result.get('result', '?')}{tag} "
                         f"({result.get('document_id', '')})\n")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="KB write client (gateway-only).")
    ap.add_argument("type", nargs="?", help="doc type (e.g. DESIGN_DECISION); omit with --list")
    ap.add_argument("file", nargs="?", help="markdown file with frontmatter, or '-' for stdin")
    ap.add_argument("--list", action="store_true", help="list writable doc types (GET /types)")
    ap.add_argument("--json", help="raw JSON data object instead of a file")
    ap.add_argument("--field", action="append", help="add/override a data field k=v (repeatable)")
    ap.add_argument("--metadata", help="JSON object merged into the write metadata")
    ap.add_argument("--format", choices=["text", "json"], default="text")
    args = ap.parse_args()

    try:
        if args.list:
            return cmd_list(args.format)
        if not args.type:
            ap.error("a doc TYPE is required (or use --list)")
        return cmd_write(args.type, args)
    except RuntimeError as e:
        print(f"ERROR: transport failure: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
