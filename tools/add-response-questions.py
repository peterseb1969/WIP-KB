#!/usr/bin/env python3
"""add-response-questions.py — add `questions` to CASE_RESPONSE and backfill it.

A response may end with a `## Questions` section, put to the project owner. The
KB lists the cases whose questions still wait for an answer, which needs the
count as data: kb-write.py derives it at write time (as it does the file list),
and this script brings an existing namespace along. A fresh bootstrap gets the
field from the seed (server/seed/templates/12b_CASE_RESPONSE.json).

Two steps, each idempotent:

 1. Template: re-post the full current declaration with the optional integer
    `questions` added, merging it into reporting.cross_version_view so the entity
    view `doc_case_response` carries the column. The structured diff must be
    exactly that one added field, or it aborts. Skipped when the field exists.

 2. Backfill: every active response whose body has a `## Questions` section and
    no `questions` value is re-posted with its data unchanged plus the count,
    pinned to the template version that has the field. Its identity
    (case_number, response_seq) is unchanged, so WIP records it as a new version
    of the same response. A PATCH would not do: it validates against the version
    the response is pinned to, which lacks the field. Only these responses move;
    a whole-version migrate would version every response in the namespace. The
    count comes from kb-write.py's own parser, so both agree.

Dry run by default: prints what would change. APPLY=1 writes.

Env:
  KB_TARGET   base URL           (default https://localhost:8443 — the sandbox)
  KB_KEYFILE  API key file with admin on the namespace (default: WIP_API_KEY_FILE
              from .env, sandbox target only)
  KB_NS       namespace          (default kb)
  APPLY=1     write; without it, report only
"""
import importlib.util
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

# kb-write.py imports its transport core at load; that core reads kb.json and the
# environment but makes no call, so loading it here is side-effect free.
sys.path.insert(0, str(HERE.parent / "kb-client"))
_spec = importlib.util.spec_from_file_location("kb_write", HERE.parent / "kb-client" / "kb-write.py")
kb_write = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kb_write)

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = read_key("KB_KEYFILE", "KB_TARGET")
NS = os.environ.get("KB_NS", "kb")
APPLY = os.environ.get("APPLY") == "1"
CTX = ssl._create_unverified_context()
VALUE = "CASE_RESPONSE"
FIELD = {"name": "questions", "label": "Questions", "type": "integer", "mandatory": False}
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
    print(f"template: SKIP, `questions` present (v{cur['version']})")
    version = cur["version"]
else:
    rep = dict(cur.get("reporting") or {})
    rep["sync_enabled"] = True
    cvv = rep.get("cross_version_view") or {}
    cols = dict(cvv.get("columns") or {})
    cols.setdefault(FIELD["name"], {})
    rep["cross_version_view"] = {"versions": cvv.get("versions", "all"), "columns": cols}
    print(f"template: v{cur['version']} + questions; cross_version_view.columns "
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
        if item["status"] != "updated" or sorted(d.get("added_optional") or []) != ["questions"] or any(
                d.get(k) for k in ("removed", "changed_type", "made_required", "modified_existing", "added_required")):
            sys.exit(f"ABORT template: status={item['status']} error={item.get('error')} details={json.dumps(d)[:400]}")
        version = item["version"]
        print(f"template: OK v{cur['version']} -> v{version}")

# --- 2. backfill ---------------------------------------------------------------
rows = req("POST", "/api/reporting-sync/query", {
    "namespace": NS, "max_rows": 50000,
    "sql": "SELECT document_id, case_number, response_seq FROM doc_case_response"
           " WHERE status = 'active' AND body ~* '(^|\\n)##\\s+questions'"
           " AND (data_json->>'questions') IS NULL ORDER BY case_number, response_seq",
})["rows"]
todo = []
for r in rows:
    doc = req("GET", f"/api/document-store/documents/{r['document_id']}?namespace={NS}")
    n = kb_write.parse_questions(doc["data"].get("body") or "")
    if n:
        todo.append((doc, n))
    print(f"  CASE-{r['case_number']}#{r['response_seq']}: questions={n}"
          + ("" if n else "  (empty section, left alone)"))
print(f"backfill: {len(todo)} response(s)")
if not APPLY:
    print("dry run only — re-run with APPLY=1 to write")
    sys.exit(0)
if version is None:
    sys.exit("ABORT: no template version with `questions`")
bad = 0
for doc, n in todo:
    data = {**doc["data"], "questions": n}
    res = req("POST", "/api/document-store/documents", [{
        "template_id": cur.get("template_id") or cur.get("id"), "template_version": version,
        "namespace": NS, "data": data,
    }])["results"][0]
    ok = res.get("status") == "updated" and res.get("document_id") == doc["document_id"]
    bad += not ok
    print(f"  CASE-{doc['data']['case_number']}#{doc['data']['response_seq']}: {res.get('status')}"
          + ("" if ok else f"  ERROR {res.get('error') or res.get('document_id')}"))
if bad:
    sys.exit(f"ABORT: {bad} response(s) not updated in place")
print("DONE")
