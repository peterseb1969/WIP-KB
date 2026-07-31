#!/usr/bin/env python3
"""add-write-policy-fallback.py — declare `search_key_fallback` on WRITE_POLICY.

The gateway already READS `p.search_key_fallback` (kb-gateway.routes.ts:440) and
branches on it at :581, but the template never declared the field — so no policy
could carry one and the fallback branch was unreachable. Its own comment states
the stakes: without it, a write missing any search_key component filters on
undefined, matches nothing, and MINTS a duplicate — "the CASE-825 failure
re-created by the fix meant to prevent it".

That makes this a prerequisite for phase 4, not a tidy-up. Switching DOCUMENT's
search_key to (repo_id, path_tail) while no fallback can be declared means any
writer not sending repo_id forks the corpus.

Two steps, because one is not enough and the second is the one that gets skipped:

  1. add the field                 -> template v1 -> v2
  2. migrate the WRITE_POLICY docs -> v1 -> v2

All six policy documents are pinned at v1. A write carrying `search_key_fallback`
to a v1-pinned document is rejected "Unknown field" however current the template
is — the same trap that made the topic picker offer a control that 422'd on every
save, and the same one that took DOCUMENT three steps this afternoon. Adding a
field to a template does not make existing documents able to hold it.

WRITE_POLICY has reporting.sync_enabled off, so there is no cross_version_view
declaration to merge here — the failure that removed `topics` from the DOCUMENT
projection has no analogue on this template.

Idempotent: if the field is already present the template is untouched, and the
migrate is skipped when every document already sits on the target version.

Env:
  KB_TARGET    base URL           (default https://localhost:8443 — the sandbox)
  KB_KEYFILE   admin API key file (default ~/.wip-deploy/default/secrets/api-key)
"""
import json
import os
import ssl
import sys
import urllib.request
from pathlib import Path

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = Path(os.environ.get(
    "KB_KEYFILE", str(Path.home() / ".wip-deploy/default/secrets/api-key")
)).expanduser().read_text().strip()
CTX = ssl._create_unverified_context()

NS, VALUE = "kb", "WRITE_POLICY"
NEW_FIELD = {"name": "search_key_fallback", "label": "Search Key Fallback",
             "type": "array", "array_item_type": "string", "mandatory": False}
# Same allowlist add-document-fields.py uses, for the same reason: re-post the
# existing fields verbatim and let the diff checker prove nothing else moved.
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
    with urllib.request.urlopen(r, context=CTX, timeout=60) as resp:
        return json.load(resp)


def main():
    print(f"target: {BASE}")
    cur = req("GET", f"/api/template-store/templates/by-value/{VALUE}?namespace={NS}")
    have = {f["name"] for f in cur["fields"]}

    if NEW_FIELD["name"] in have:
        print(f"SKIP template: {NEW_FIELD['name']} already declared (v{cur['version']})")
        to_v = cur["version"]
    else:
        fields = [{k: f[k] for k in FIELD_KEYS if f.get(k) is not None} for f in cur["fields"]]
        fields.append(NEW_FIELD)
        body = {
            "value": cur["value"], "label": cur["label"], "namespace": NS,
            "description": cur.get("description") or "",
            "identity_fields": cur.get("identity_fields") or [],
            "header_fields": cur.get("header_fields") or [],
            "fields": fields,
            "rules": cur.get("rules") or [],
        }
        if cur.get("reporting"):
            body["reporting"] = cur["reporting"]
        item = req("POST", "/api/template-store/templates", [body])["results"][0]
        if item["status"] != "updated":
            sys.exit(f"ABORT: status={item['status']} error={item.get('error')}")
        d = item.get("details") or {}
        added = sorted(d.get("added_optional") or [])
        print(f"OK template: v{cur['version']} -> v{item['version']}  added_optional={added}")
        if added != [NEW_FIELD["name"]]:
            sys.exit(f"ABORT: expected ['{NEW_FIELD['name']}'], got {added}")
        # The check that was missed on DOCUMENT this afternoon: verify what the
        # change REMOVED, not only what it added.
        if (d.get("removed") or d.get("changed_type") or d.get("made_required")
                or d.get("modified_existing") or d.get("added_required")):
            sys.exit(f"ABORT: diff wider than the field added: {json.dumps(d)}")
        to_v = item["version"]

    # Step 2 — the documents. Skipped above only if the template already had the
    # field; the cohort may still be behind, so this runs unconditionally.
    docs = req("POST", f"/api/document-store/documents/query?namespace={NS}",
               {"template_id": VALUE, "page": 1, "page_size": 200}).get("items") or []
    behind = sorted({d["template_version"] for d in docs if d["template_version"] != to_v})
    print(f"documents: {len(docs)}  target v{to_v}  behind: {behind or 'none'}")
    for v in behind:
        dry = req("POST", f"/api/document-store/documents/migrate?namespace={NS}",
                  {"template_id": VALUE, "from_version": v, "to_version": to_v, "dry_run": True})
        print(f"  migrate v{v}->v{to_v} DRY: total={dry.get('total')} failed={dry.get('failed')}")
        if dry.get("failed"):
            sys.exit(f"ABORT: {json.dumps(dry.get('results', [])[:3])[:400]}")
        res = req("POST", f"/api/document-store/documents/migrate?namespace={NS}",
                  {"template_id": VALUE, "from_version": v, "to_version": to_v, "dry_run": False})
        print(f"  migrate v{v}->v{to_v} APPLY: succeeded={res.get('succeeded')} failed={res.get('failed')}")
        if res.get("failed"):
            sys.exit("ABORT: migrate failed")

    after = req("POST", f"/api/document-store/documents/query?namespace={NS}",
                {"template_id": VALUE, "page": 1, "page_size": 200}).get("items") or []
    vers = sorted({d["template_version"] for d in after})
    print(f"VERIFY: {len(after)} documents on template versions {vers}")
    for d in after:
        print(f"   {d['data'].get('doc_type'):16s} search_key={d['data'].get('search_key')} "
              f"fallback={d['data'].get('search_key_fallback')}")
    if vers != [to_v]:
        sys.exit(f"ABORT: documents not all on v{to_v}")
    print("DONE")


if __name__ == "__main__":
    main()
