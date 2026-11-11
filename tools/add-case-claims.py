#!/usr/bin/env python3
"""add-case-claims.py — add the case-claim model to an existing KB namespace.

A claim records that an agent is working on a case (respond, implement, fix,
review…), so the review queue and attended YACs see each other's work and a
parked implementation keeps its case. Design approved by Peter 2026-11-11.

The model, declared in the seed files a fresh bootstrap uses too:

  CLAIM_KIND    terminology: respond | implement | fix | review  (a new kind = a term)
  CLAIM_STATE   terminology: active | parked | released
  CASE_CLAIM    template, identity [case_number, claim_kind, holder]: one document
                per holder's claim; acquire/renew/park/release are its versions
  CLAIM_RULE    template, identity [claim_kind]: per-kind config (max_holders,
                excludes, lease_minutes), read by the gateway at every acquire

Only additions: two new terminologies and two new templates. No existing
template or document changes, so there is no migration step. Each step is
idempotent (on_conflict=validate for terminologies, bulk term creates skip
duplicates, template create is an upsert that answers `unchanged` for an
identical re-post) and any failure aborts before the next.

Dry run by default: it prints what exists and what it would create. APPLY=1
writes. A template that exists but differs from the seed is reported and NOT
re-posted (that would version it): reconcile by hand.

Env:
  KB_TARGET   base URL           (default https://localhost:8443 — the sandbox)
  KB_KEYFILE  API key file with admin on the namespace (default: WIP_API_KEY_FILE
              from .env, sandbox target only)
  KB_NS       namespace          (default kb)
  APPLY=1     write; without it, report only
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _keyfile import read_key  # noqa: E402

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = read_key("KB_KEYFILE", "KB_TARGET")
NS = os.environ.get("KB_NS", "kb")
APPLY = os.environ.get("APPLY") == "1"
CTX = ssl._create_unverified_context()
SEED = Path(__file__).resolve().parent.parent / "server" / "seed"
TERMINOLOGIES = ["CLAIM_KIND", "CLAIM_STATE"]
TEMPLATES = ["19f_CASE_CLAIM.json", "19g_CLAIM_RULE.json"]


def req(method, path, payload=None, timeout=120, allow_404=False):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        if allow_404 and e.code == 404:
            return None
        sys.exit(f"ABORT {method} {path}: HTTP {e.code} {e.read().decode()[:400]}")


def bulk_ok(resp, what, ok=("created", "updated", "unchanged", "skipped")):
    bad = [r for r in resp.get("results", []) if r.get("status") not in ok]
    if bad:
        sys.exit(f"ABORT {what}: {json.dumps(bad)[:600]}")
    return resp["results"]


print(f"target: {BASE}  namespace: {NS}{'  (APPLY)' if APPLY else '  (dry run)'}")

# --- 1. terminologies + terms ------------------------------------------------
for value in TERMINOLOGIES:
    seed = json.loads((SEED / "terminologies" / f"{value}.json").read_text())
    have = req("GET", f"/api/def-store/terminologies/by-value/{value}?namespace={NS}", allow_404=True)
    if not APPLY:
        print(f"{'exists ' if have else 'would create'} terminology {value} ({len(seed['terms'])} terms in the seed)")
        continue
    res = bulk_ok(req("POST", "/api/def-store/terminologies?on_conflict=validate", [{
        "value": seed["value"], "label": seed["label"],
        "description": seed.get("description", ""), "namespace": NS,
        **({"mutable": True} if seed.get("mutable") else {}),
    }]), f"terminology {value}")[0]
    tid = res["id"]
    terms = bulk_ok(req("POST", f"/api/def-store/terminologies/{tid}/terms", seed["terms"]),
                    f"terms of {value}")
    counts = {}
    for t in terms:
        counts[t["status"]] = counts.get(t["status"], 0) + 1
    print(f"OK {value}: terminology {res['status']} ({tid}), terms {counts}")

# --- 2. templates ------------------------------------------------------------
for fname in TEMPLATES:
    seed = json.loads((SEED / "templates" / fname).read_text())
    value = seed["value"]
    have = req("GET", f"/api/template-store/templates/by-value/{value}?namespace={NS}", allow_404=True)
    if have:
        same_identity = (have.get("identity_fields") or []) == seed["identity_fields"]
        same_fields = sorted(f["name"] for f in have.get("fields") or []) == sorted(f["name"] for f in seed["fields"])
        if same_identity and same_fields:
            print(f"exists  template {value} v{have.get('version')} (matches the seed's identity and fields)")
        else:
            print(f"DIFFERS template {value} v{have.get('version')} from the seed — not re-posted; reconcile by hand")
        continue
    if not APPLY:
        print(f"would create template {value} (identity {seed['identity_fields']})")
        continue
    item = req("POST", "/api/template-store/templates", [{**seed, "namespace": NS}])["results"][0]
    if item.get("status") != "created":
        sys.exit(f"ABORT template {value}: status={item.get('status')} error={item.get('error')} "
                 f"details={json.dumps(item.get('details'))[:400]}")
    print(f"OK template {value}: created v{item.get('version')} ({item.get('id')})")

print("done" if APPLY else "dry run only — re-run with APPLY=1 to write")
