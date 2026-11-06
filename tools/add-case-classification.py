#!/usr/bin/env python3
"""add-case-classification.py — case type and severity become controlled vocabularies.

CASE_RECORD.type and .severity were free strings. Over time the corpus collected
27 spellings of type and 17 of severity, and the official severity scale
(blocks-me | annoying | fyi) put nearly every case on `annoying`. This makes
both fields terms of two curated vocabularies, approved by Peter 2026-11-06:

  CASE_TYPE      bug | gap | docs | design | process | chore | question
  CASE_SEVERITY  security | blocks-me | wrong-result | degraded | annoying | cosmetic | fyi

Every spelling used before is an ALIAS of the term it meant, so existing cases
keep their recorded text (WIP stores the submitted value and the resolved
term_id side by side) and still resolve; nothing is rewritten.

Steps, each idempotent, in order; any failure aborts before the next:

1. Create the two terminologies and their terms from the seed files
   (server/seed/terminologies/CASE_TYPE.json, CASE_SEVERITY.json), so the live
   vocabulary and the one a fresh bootstrap seeds are the same declaration.
   on_conflict=validate: an identical terminology is `unchanged`; bulk term
   creates skip duplicates.
2. Pre-flight: every type and severity value stored on an active case must
   resolve to a term of its vocabulary. A value that does not would fail the
   migration in step 4, so the run stops here and names it — add it as an
   alias in the seed and re-run.
3. Version CASE_RECORD: `type` and `severity` become term fields, and
   `type_term_id` / `severity_term_id` are MERGED into
   reporting.cross_version_view.columns (a column absent from that declaration
   is absent from the entity view, which the UI's severity facet reads). The
   structured diff must touch exactly those two fields, else the script aborts
   rather than version a drifted template. Skipped when both are already terms.
4. Migrate every active case on an older version to the new one: dry run
   first, per source version; the apply runs only with APPLY=1 and only when
   the dry run reports 0 failures. The old versions stay active (deactivating
   a doc-bearing version has wedged archive restores before).

Env:
  KB_TARGET   base URL           (default https://localhost:8443 — the sandbox)
  KB_KEYFILE  API key file with admin on the namespace (default: WIP_API_KEY_FILE
              from .env, sandbox target only)
  KB_NS       namespace          (default kb)
  APPLY=1     run the migration (step 4) after a clean dry run; without it,
              steps 1-3 run and step 4 only reports
"""
import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _keyfile import read_key  # noqa: E402

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = read_key("KB_KEYFILE", "KB_TARGET")
NS = os.environ.get("KB_NS", "kb")
APPLY = os.environ.get("APPLY") == "1"
CTX = ssl._create_unverified_context()
SEED = Path(__file__).resolve().parent.parent / "server" / "seed" / "terminologies"

# field name -> terminology value
FIELDS = {"type": "CASE_TYPE", "severity": "CASE_SEVERITY"}

FIELD_KEYS = ["name", "label", "type", "mandatory", "default_value", "terminology_ref",
              "template_ref", "template_ref_version", "reference_type", "target_templates",
              "include_subtypes", "target_terminologies", "version_strategy", "file_config",
              "array_item_type", "array_terminology_ref", "array_template_ref",
              "array_template_ref_version", "array_file_config", "validation",
              "semantic_type", "full_text_indexed"]


def req(method, path, payload=None, timeout=120):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(r, context=CTX, timeout=timeout) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:
        sys.exit(f"ABORT {method} {path}: HTTP {e.code} {e.read().decode()[:400]}")


def bulk_ok(resp, what, ok=("created", "updated", "unchanged", "skipped")):
    bad = [r for r in resp.get("results", []) if r.get("status") not in ok]
    if bad:
        sys.exit(f"ABORT {what}: {json.dumps(bad)[:600]}")
    return resp["results"]


print(f"target: {BASE}  namespace: {NS}{'  (APPLY)' if APPLY else ''}")

# --- 1. terminologies + terms ------------------------------------------------
term_ids = {}
for field, value in FIELDS.items():
    seed = json.loads((SEED / f"{value}.json").read_text())
    res = bulk_ok(req("POST", "/api/def-store/terminologies?on_conflict=validate", [{
        "value": seed["value"], "label": seed["label"],
        "description": seed.get("description", ""), "namespace": NS,
    }]), f"terminology {value}")[0]
    tid = res["id"]
    term_ids[value] = tid
    terms = bulk_ok(req("POST", f"/api/def-store/terminologies/{tid}/terms", seed["terms"]),
                    f"terms of {value}")
    counts = {}
    for t in terms:
        counts[t["status"]] = counts.get(t["status"], 0) + 1
    print(f"OK {value}: terminology {res['status']} ({tid}), terms {counts}")

# --- 2. pre-flight: every stored value resolves ------------------------------
cases, page = [], 1
while True:
    d = req("POST", f"/api/document-store/documents/query?namespace={NS}",
            {"template_id": "CASE_RECORD", "filters": [], "page": page, "page_size": 1000})
    cases += d.get("items") or []
    if page >= (d.get("pages") or 1):
        break
    page += 1
unresolved = []
for field, value in FIELDS.items():
    seen = sorted({c["data"].get(field) for c in cases if c["data"].get(field)})
    for v in seen:
        r = req("POST", "/api/def-store/validate", {"terminology_id": term_ids[value], "value": v})
        if not (r.get("valid") and r.get("matched_term")):
            unresolved.append((field, v))
    print(f"OK pre-flight {field}: {len(seen)} distinct values across {len(cases)} cases")
if unresolved:
    sys.exit("ABORT: values that resolve to no term (add them as aliases in the seed): "
             + ", ".join(f"{f}={v!r}" for f, v in unresolved))

# --- 3. template version -----------------------------------------------------
cur = req("GET", f"/api/template-store/templates/by-value/CASE_RECORD?namespace={NS}")
by_name = {f["name"]: f for f in cur["fields"]}
todo = [f for f in FIELDS if by_name.get(f, {}).get("type") != "term"]
if not todo:
    print(f"SKIP CASE_RECORD: type and severity are already terms (v{cur['version']})")
    target = cur["version"]
else:
    fields = []
    for f in cur["fields"]:
        decl = {k: f[k] for k in FIELD_KEYS if f.get(k) is not None}
        if f["name"] in FIELDS:
            decl = {"name": f["name"], "label": f.get("label") or f["name"].title(),
                    "type": "term", "mandatory": bool(f.get("mandatory")),
                    "reference_type": "term", "terminology_ref": FIELDS[f["name"]]}
        fields.append(decl)
    rep = dict(cur.get("reporting") or {})
    cvv = dict(rep.get("cross_version_view") or {})
    cvv["versions"] = cvv.get("versions") or "all"
    cvv["columns"] = {**(cvv.get("columns") or {}),
                      **{f"{f}_term_id": {} for f in FIELDS}, **{f: {} for f in FIELDS}}
    rep["cross_version_view"] = cvv
    payload = {
        "value": cur["value"], "label": cur["label"], "namespace": NS,
        "description": cur.get("description") or "",
        "usage": cur.get("usage") or "entity",
        "identity_fields": cur.get("identity_fields") or [],
        "header_fields": cur.get("header_fields") or [],
        "fields": fields, "rules": cur.get("rules") or [], "reporting": rep,
    }
    if cur.get("metadata"):
        payload["metadata"] = cur["metadata"]
    item = req("POST", "/api/template-store/templates", [payload])["results"][0]
    if item["status"] != "updated":
        sys.exit(f"ABORT CASE_RECORD: status={item['status']} error={item.get('error')} "
                 f"details={json.dumps(item.get('details'))[:400]}")
    d = item.get("details") or {}

    def names(entries):
        # Diff entries are field names, or objects naming the field.
        return {e if isinstance(e, str) else (e.get("field") or e.get("name")) for e in entries or []}

    touched = names(d.get("changed_type")) | names(d.get("modified_existing"))
    extra = {k: d.get(k) for k in ("added_optional", "added_required", "removed", "made_required")
             if d.get(k)}
    target = item.get("version")
    print(f"OK CASE_RECORD: v{cur['version']} -> v{target}  diff={json.dumps(d)}")
    if touched != set(FIELDS) or extra:
        sys.exit(f"ERROR CASE_RECORD: diff touches {sorted(touched)} {extra}, expected exactly "
                 f"{sorted(FIELDS)} — inspect v{target} before migrating")

# --- 4. migrate --------------------------------------------------------------
cases = []
page = 1
while True:
    d = req("POST", f"/api/document-store/documents/query?namespace={NS}",
            {"template_id": "CASE_RECORD", "filters": [], "page": page, "page_size": 1000})
    cases += d.get("items") or []
    if page >= (d.get("pages") or 1):
        break
    page += 1
cohorts = sorted({c["template_version"] for c in cases if c.get("template_version") != target})
if not cohorts:
    print(f"SKIP migrate: all {len(cases)} cases on v{target}")
for v in cohorts:
    body = {"template_id": "CASE_RECORD", "from_version": v, "to_version": target}
    dry = req("POST", f"/api/document-store/documents/migrate?namespace={NS}", {**body, "dry_run": True}, timeout=1800)
    print(f"DRY v{v} -> v{target}: total {dry['total']}, ok {dry['succeeded']}, failed {dry['failed']}")
    if dry["failed"]:
        bad = [r for r in dry["results"] if r.get("status") not in ("ready", "migrated", "ok", "success")]
        sys.exit(f"ABORT migrate v{v}: {json.dumps(bad[:5])[:800]}")
    if not APPLY:
        continue
    done = req("POST", f"/api/document-store/documents/migrate?namespace={NS}", {**body, "dry_run": False}, timeout=1800)
    print(f"OK v{v} -> v{target}: total {done['total']}, ok {done['succeeded']}, failed {done['failed']}")
    if done["failed"]:
        sys.exit(f"ERROR migrate v{v}: {done['failed']} failed")
if cohorts and not APPLY:
    print("dry run only — re-run with APPLY=1 to migrate")
print("DONE")
