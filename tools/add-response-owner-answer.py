#!/usr/bin/env python3
"""add-response-owner-answer.py — add `owner_answer` to CASE_RESPONSE.

A case whose responses ask the project owner questions waits for the owner's
answer. A response written in the browser is a person's by its author; an answer
the owner gives in a chat or a terminal is written down by a session, so it says
so itself with the optional boolean `owner_answer` (kb-write.py --owner-answer).
This script brings an existing namespace along; a fresh bootstrap gets the field
from the seed (server/seed/templates/12b_CASE_RESPONSE.json).

One idempotent step: re-post the full current declaration with the field added,
merging it into reporting.cross_version_view so the entity view
`doc_case_response` carries the column. The structured diff must be exactly that
one added field, or it aborts. Skipped when the field exists. Nothing is
backfilled: no stored response can be shown to be the owner's answer, and the
waiting rule reads the field from the stored data, so absent means "no".

Before applying on an install, check that the CASE_RESPONSE version tables agree
on column types (integer vs bigint): the entity view keeps only the columns every
version types alike, so a mismatch drops case_number from it.

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
VALUE = "CASE_RESPONSE"
FIELD = {"name": "owner_answer", "label": "Owner's Answer", "type": "boolean", "mandatory": False}
FIELD_KEYS = ["name", "label", "type", "mandatory", "default_value", "terminology_ref",
              "template_ref", "template_ref_version", "reference_type", "target_templates",
              "include_subtypes", "target_terminologies", "version_strategy", "file_config",
              "array_item_type", "array_terminology_ref", "array_template_ref",
              "array_template_ref_version", "array_file_config", "validation",
              "semantic_type", "full_text_indexed"]


def req(method, path, payload=None):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=60) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"ABORT {method} {path}: HTTP {e.code} {e.read().decode()[:400]}")


print(f"target: {BASE}  namespace: {NS}{'  (APPLY)' if APPLY else '  (dry run)'}")

# --- 1. template ---------------------------------------------------------------
cur = req("GET", f"/api/template-store/templates/by-value/{VALUE}?namespace={NS}")
if any(f["name"] == FIELD["name"] for f in cur["fields"]):
    print(f"template: SKIP, `{FIELD['name']}` present (v{cur['version']})")
    version = cur["version"]
else:
    # A new version table is created with today's column types; the entity view keeps
    # only columns every version types alike, so older tables of another type
    # (integer where today's are bigint) would drop those columns from the view.
    types = req("POST", "/api/reporting-sync/query", {
        "namespace": NS, "max_rows": 1000,
        "sql": "SELECT column_name, array_agg(DISTINCT data_type) AS types"
               " FROM information_schema.columns WHERE table_schema = current_schema()"
               " AND table_name LIKE 'doc\\_case\\_response\\_\\_v%'"
               " GROUP BY column_name HAVING count(DISTINCT data_type) > 1",
    })["rows"]
    if types:
        sys.exit(f"ABORT: CASE_RESPONSE version tables disagree on column types {types}; "
                 f"a new version would drop those columns from the entity view")
    rep = dict(cur.get("reporting") or {})
    rep["sync_enabled"] = True
    cvv = rep.get("cross_version_view") or {}
    cols = dict(cvv.get("columns") or {})
    cols.setdefault(FIELD["name"], {})
    rep["cross_version_view"] = {"versions": cvv.get("versions", "all"), "columns": cols}
    print(f"template: v{cur['version']} + {FIELD['name']}; cross_version_view.columns "
          f"{sorted((cvv.get('columns') or {}).keys())} -> {sorted(cols)}")
    if not APPLY:
        version = None
    else:
        fields = [{k: f[k] for k in FIELD_KEYS if f.get(k) is not None} for f in cur["fields"]]
        item = req("POST", "/api/template-store/templates", [{
            "value": cur["value"], "label": cur["label"], "namespace": NS,
            "description": cur.get("description") or "", "usage": cur.get("usage") or "entity",
            "identity_fields": cur.get("identity_fields") or [],
            "header_fields": cur.get("header_fields") or [],
            "fields": fields + [FIELD], "rules": cur.get("rules") or [],
            "metadata": cur.get("metadata") or {}, "reporting": rep,
        }])["results"][0]
        d = item.get("details") or {}
        if item["status"] != "updated" or sorted(d.get("added_optional") or []) != [FIELD["name"]] or any(
                d.get(k) for k in ("removed", "changed_type", "made_required", "modified_existing", "added_required")):
            sys.exit(f"ABORT template: status={item['status']} error={item.get('error')} details={json.dumps(d)[:400]}")
        version = item["version"]
        print(f"template: OK v{cur['version']} -> v{version}")

if not APPLY:
    print("dry run only — re-run with APPLY=1 to write")
print("DONE")
