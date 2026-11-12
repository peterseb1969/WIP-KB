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

Creating a knowledge base takes two steps:
  1. An operator reserves the namespace for the KB app. For a KB deployed by
     wip-deploy, on the install's host:
         wip-deploy app-namespace add wip-kb <namespace> --name <install>
     For an attached KB: widen the KB's API key with `reserve` on the namespace
     in the Console.
  2. Run this script with a key holding admin on the main knowledge base (kb).

The KB seeds the namespace with its OWN key, so the app can always see what it
created; your key only decides whether you may ask. Run before step 1, the
gateway refuses with 409 not_reserved (naming step 1) and creates nothing; a key
with only write on kb is refused with 403.

Never copy another key into the app's key file (secrets/app-wip-kb-api-key):
the next apply re-issues that file as the app's key, and two keys sharing one
value resolve inconsistently across WIP services.

An existing namespace with content is never re-seeded — the gateway answers 409
and leaves it as it is. An existing EMPTY namespace (what a failed earlier
attempt leaves behind) is seeded, so a retry after a failure just works; the
error of a failed attempt says whether it left a namespace behind.

Env: see kb_client_core (KB_BASE_URL / KB_API_KEY_FILE / KB_PREFER_LOCAL / …).
Exit codes: 0 created · 1 refused by the gateway (exists, invalid, forbidden) · 2 transport/usage.
"""
from __future__ import annotations

import argparse
import json
import sys

from kb_client_core import GatewayRefusal, gw_post

# Seeding is ~30 sequential WIP writes plus a template-cache settle; well past the
# 20s that suits every other gateway call.
SEED_TIMEOUT_S = 180


def cmd_create(args: argparse.Namespace) -> int:
    body = {"namespace": args.namespace}
    if args.description:
        body["description"] = args.description
    try:
        out = gw_post("/namespaces", body, timeout=SEED_TIMEOUT_S)
    except GatewayRefusal as e:
        # The gateway answered and said no (not allowed, not reserved, exists):
        # the caller's to fix, so exit 1, never the transport code a retry loop
        # would read as "try again".
        print(f"ERROR: {e}", file=sys.stderr)
        return 1
    except RuntimeError as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return 2
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
    ap = argparse.ArgumentParser(
        description="Create a new KB knowledge domain (namespace).",
        epilog="First an operator reserves the namespace for the KB app (deployed: wip-deploy "
               "app-namespace add wip-kb <namespace> --name <install>; attached: reserve it for "
               "the KB's key in the Console). Then run this with a key holding admin on kb.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create", help="create and seed a new namespace")
    c.add_argument("namespace", help="lowercase slug: a-z, 0-9, '-', starting with a letter")
    c.add_argument("--description", help="namespace description")
    c.add_argument("--format", choices=["text", "json"], default="text")
    args = ap.parse_args()
    return cmd_create(args)


if __name__ == "__main__":
    sys.exit(main())
