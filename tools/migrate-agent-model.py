#!/usr/bin/env python3
"""migrate-agent-model.py — the three-axis flag model on an existing namespace.

A flag says what to do (the kind of work), whose code it concerns (the owner)
and, optionally, which purpose-built worker should do it. A fresh bootstrap gets
this from the seeds; this script brings an existing namespace along. Each step
is idempotent:

 1. FLAG_RECORD: add `kind` (a CLAIM_KIND term, the same value as flag_type,
    which as an identity string cannot itself become a term) and `worker` (a
    reference to an AGENT_IDENTITY). Both optional.
 2. AGENT_IDENTITY: add `performs` (CLAIM_KIND terms), `serves` (KB_TARGET_YAC
    terms), `active` and `runs`. All optional.
    Each template step re-posts the full current declaration with the fields
    added, merged into reporting.cross_version_view; the structured diff must
    be exactly those added fields, or it aborts. Before it, the version tables
    must agree on column types, or a new version would drop columns from the
    entity view.
 3. KB_TARGET_YAC gains every SESSION_ROLE owner it lacks (from the seed), so
    the two lists agree.
 4. BUG-YAC (in both lists) and DOC-YAC (a session role) are deprecated: no
    case, session or response on the canonical KB uses them. Deprecated terms
    keep resolving for any existing reference.

Nothing is backfilled: existing flags keep flag_type, which every reader still
uses; `kind` is set on flags created from now on. Worker records are data,
written with `kbc kb-write.py AGENT_IDENTITY`.

Dry run by default: prints what would change. APPLY=1 writes.

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
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from _keyfile import read_key  # noqa: E402

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = read_key("KB_KEYFILE", "KB_TARGET")
NS = os.environ.get("KB_NS", "kb")
APPLY = os.environ.get("APPLY") == "1"
CTX = ssl._create_unverified_context()
SEED = HERE.parent / "server" / "seed"
FIELD_KEYS = ["name", "label", "type", "mandatory", "default_value", "terminology_ref",
              "template_ref", "template_ref_version", "reference_type", "target_templates",
              "include_subtypes", "target_terminologies", "version_strategy", "file_config",
              "array_item_type", "array_terminology_ref", "array_template_ref",
              "array_template_ref_version", "array_file_config", "validation",
              "semantic_type", "full_text_indexed"]
DEPRECATE = {
    "KB_TARGET_YAC": {"BUG-YAC": "no case, flag or session names it; not an owner"},
    "SESSION_ROLE": {"BUG-YAC": "no session uses it", "DOC-YAC": "no session uses it"},
}


def req(method, path, payload=None):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"ABORT {method} {path}: HTTP {e.code} {e.read().decode()[:400]}")


def seed_fields(filename, names):
    fields = json.loads((SEED / "templates" / filename).read_text())["fields"]
    picked = [f for f in fields if f["name"] in names]
    if [f["name"] for f in picked] != list(names):
        sys.exit(f"ABORT: seed {filename} lacks {names}")
    return picked


def check_types(value):
    table = "doc_" + value.lower()
    rows = req("POST", "/api/reporting-sync/query", {
        "namespace": NS, "max_rows": 1000,
        "sql": "SELECT column_name, array_agg(DISTINCT data_type) AS types"
               " FROM information_schema.columns WHERE table_schema = current_schema()"
               f" AND table_name LIKE '{table.replace('_', chr(92) + '_')}\\_\\_v%'"
               " GROUP BY column_name HAVING count(DISTINCT data_type) > 1",
    })["rows"]
    if rows:
        sys.exit(f"ABORT: {value} version tables disagree on column types {rows}; "
                 f"a new version would drop those columns from the entity view")


def add_fields(value, new_fields):
    cur = req("GET", f"/api/template-store/templates/by-value/{value}?namespace={NS}")
    have = {f["name"] for f in cur["fields"]}
    missing = [f for f in new_fields if f["name"] not in have]
    if not missing:
        print(f"{value}: SKIP, fields present (v{cur['version']})")
        return
    names = [f["name"] for f in missing]
    check_types(value)
    rep = dict(cur.get("reporting") or {})
    rep["sync_enabled"] = True
    cvv = rep.get("cross_version_view") or {}
    cols = dict(cvv.get("columns") or {})
    for n in names:
        cols.setdefault(n, {})
    rep["cross_version_view"] = {"versions": cvv.get("versions", "all"), "columns": cols}
    print(f"{value}: v{cur['version']} + {names}")
    if not APPLY:
        return
    fields = [{k: f[k] for k in FIELD_KEYS if f.get(k) is not None} for f in cur["fields"]]
    item = req("POST", "/api/template-store/templates", [{
        "value": cur["value"], "label": cur["label"], "namespace": NS,
        "description": cur.get("description") or "", "usage": cur.get("usage") or "entity",
        "identity_fields": cur.get("identity_fields") or [],
        "header_fields": cur.get("header_fields") or [],
        "fields": fields + missing, "rules": cur.get("rules") or [],
        "metadata": cur.get("metadata") or {}, "reporting": rep,
    }])["results"][0]
    d = item.get("details") or {}
    if item["status"] != "updated" or sorted(d.get("added_optional") or []) != sorted(names) or any(
            d.get(k) for k in ("removed", "changed_type", "made_required", "modified_existing", "added_required")):
        sys.exit(f"ABORT {value}: status={item['status']} error={item.get('error')} details={json.dumps(d)[:400]}")
    print(f"{value}: OK v{cur['version']} -> v{item['version']}")


def terms(terminology):
    t = req("GET", f"/api/def-store/terminologies/by-value/{terminology}?namespace={NS}")
    out, page = {}, 1
    while True:
        d = req("GET", f"/api/def-store/terminologies/{t['terminology_id']}/terms"
                       f"?namespace={NS}&page_size=100&page={page}")
        for x in d.get("items") or []:
            out[x["value"]] = x
        if page >= (d.get("pages") or 1):
            return t["terminology_id"], out
        page += 1


print(f"target: {BASE}  namespace: {NS}{'  (APPLY)' if APPLY else '  (dry run)'}")

# --- 1, 2. templates -----------------------------------------------------------
add_fields("FLAG_RECORD", seed_fields("19c_FLAG_RECORD.json", ["kind", "worker"]))
add_fields("AGENT_IDENTITY", seed_fields("10_AGENT_IDENTITY.json", ["performs", "serves", "active", "runs"]))

# --- 3. owners ------------------------------------------------------------------
tid, live = terms("KB_TARGET_YAC")
seed = json.loads((SEED / "terminologies" / "KB_TARGET_YAC.json").read_text())["terms"]
add = [t for t in seed if t["value"] not in live]
print(f"KB_TARGET_YAC: add {[t['value'] for t in add] or 'nothing'}")
if APPLY and add:
    res = req("POST", f"/api/def-store/terminologies/{tid}/terms?namespace={NS}", add)
    bad = [r for r in res.get("results") or [] if r.get("status") not in ("created", "skipped", "unchanged")]
    if bad:
        sys.exit(f"ABORT KB_TARGET_YAC terms: {bad}")

# --- 4. deprecations ------------------------------------------------------------
for terminology, values in DEPRECATE.items():
    _, live = terms(terminology)
    todo = [(v, why) for v, why in values.items()
            if v in live and live[v].get("status", "active") == "active"]
    print(f"{terminology}: deprecate {[v for v, _ in todo] or 'nothing'}")
    if APPLY and todo:
        res = req("POST", f"/api/def-store/terms/deprecate?namespace={NS}",
                  [{"term_id": live[v]["term_id"], "reason": why} for v, why in todo])
        bad = [r for r in res.get("results") or [] if r.get("status") == "error"]
        if bad:
            sys.exit(f"ABORT {terminology} deprecate: {bad}")

if not APPLY:
    print("dry run only — re-run with APPLY=1 to write")
print("DONE")
