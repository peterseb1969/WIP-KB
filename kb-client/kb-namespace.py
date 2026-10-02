#!/usr/bin/env python3
"""
kb-namespace.py — create a new knowledge domain: a namespace seeded with the full
KB corpus model (vocabularies, templates, edge types, write policies) plus a
bootstrap record, through the gateway's `POST /namespaces`.

A namespace is a knowledge domain, walled off from the others: its own numbering
(its CASE-1 is not kb's CASE-1), its own vocabularies, and no relationships to
documents in other namespaces. A project that should share cases and edges with
the rest of the constellation does NOT need one — it is a KB_APP term inside an
existing namespace.

Usage:
    kb-namespace.py create <namespace> [--description TEXT]

The call runs with your API key, so WIP decides whether you may create
namespaces. An existing namespace with content is never re-seeded — the gateway
answers 409 and leaves it as it is. An existing EMPTY namespace (what a failed
earlier attempt leaves behind) is seeded, so a retry after a failure just works;
the error of a failed attempt says whether it left a namespace behind.

Env: see kb_client_core (KB_BASE_URL / KB_API_KEY_FILE / KB_PREFER_LOCAL / …).
Exit codes: 0 created · 1 refused by the gateway (exists, invalid, forbidden) · 2 transport/usage.
"""
from __future__ import annotations

import argparse
import json
import sys

from kb_client_core import gw_post

# Seeding is ~30 sequential WIP writes plus a template-cache settle; well past the
# 20s that suits every other gateway call.
SEED_TIMEOUT_S = 180


def cmd_create(args: argparse.Namespace) -> int:
    body = {"namespace": args.namespace}
    if args.description:
        body["description"] = args.description
    try:
        out = gw_post("/namespaces", body, timeout=SEED_TIMEOUT_S)
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 1 if "HTTP 4" in str(e) else 2
    if "namespace" not in out:
        print("ERROR: this KB instance has no POST /namespaces (gateway older than this client)",
              file=sys.stderr)
        return 2
    if args.format == "json":
        print(json.dumps(out, indent=2))
        return 0
    print(f"created namespace {out['namespace']}: "
          f"{len(out.get('terminologiesCreated', []))} terminologies, "
          f"{len(out.get('templatesCreated', []))} templates, "
          f"{len(out.get('edgeTypesCreated', []))} edge types"
          + (" (resumed into the existing empty namespace)" if out.get("resumed") else "")
          + ("" if out.get("auditWritten") else " (bootstrap record NOT written)"))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Create a new KB knowledge domain (namespace).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create", help="create and seed a new namespace")
    c.add_argument("namespace", help="lowercase slug: a-z, 0-9, '-', starting with a letter")
    c.add_argument("--description", help="namespace description")
    c.add_argument("--format", choices=["text", "json"], default="text")
    args = ap.parse_args()
    return cmd_create(args)


if __name__ == "__main__":
    sys.exit(main())
