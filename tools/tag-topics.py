#!/usr/bin/env python3
"""tag-topics.py — assisted topic-tagging pass over CASE_RECORD + FIRESIDE (CASE-760/764).

Backfills `topics` tags onto the existing corpus after add-topics-field.py has
versioned the templates. Three steps:

1. Migrate all docs pinned to the pre-topics template version to the topics
   version (dry-run first, abort on any failure). This must precede tagging:
   PATCH validates against each doc's PINNED version, and only the newer
   version knows `topics`.
2. Derive topics per doc: structured component/app maps (deterministic)
   + precision-first title regexes. Parents are dropped when a child matched —
   the hierarchy provides rollup in the UI facet; stored tags stay specific.
3. Bulk PATCH topics as term VALUES (validation resolves them to term_ids),
   checking per-item results (bulk-first: HTTP 200 does not mean success).

Default is a dry-run: the version migrate runs dry_run only and the tagging
plan is printed but not written. Pass --apply to migrate and PATCH for real.

The title rules are assistive, not authoritative — expect and accept some
mis-tags; the facet is a navigation aid, not a classification of record.

Env:
  KB_TARGET      base URL          (default https://localhost:8443 — the sandbox)
  KB_KEYFILE     admin API key file (default ~/.wip-deploy/default/secrets/api-key)
  KB_FROM_VERSION / KB_TO_VERSION   template versions to migrate between
                                    (default 1 -> 2)
"""
import argparse
import json
import os
import re
import ssl
import sys
import urllib.request
from collections import Counter
from pathlib import Path

BASE = os.environ.get("KB_TARGET", "https://localhost:8443")
KEY = Path(os.environ.get(
    "KB_KEYFILE", str(Path.home() / ".wip-deploy/default/secrets/api-key")
)).expanduser().read_text().strip()
CTX = ssl._create_unverified_context()
FROM_V = int(os.environ.get("KB_FROM_VERSION", "1"))
TO_V = int(os.environ.get("KB_TO_VERSION", "2"))


def req(method, path, payload=None):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(r, context=CTX, timeout=60) as resp:
        return json.load(resp)


def report(sql):
    return req("POST", "/api/reporting-sync/query?namespace=kb",
               {"namespace": "kb", "sql": sql, "max_rows": 5000})["rows"]


COMPONENT_MAP = {
    "document-store": ["document-store"], "template-store": ["template-store"],
    "def-store": ["def-store"], "registry": ["registry"],
    "reporting-sync": ["reporting-sync"], "mcp-server": ["mcp"],
    "wip-client": ["wip-client"], "wip-react": ["wip-react"], "wip-proxy": ["wip-proxy"],
    "wip-auth": ["auth"], "auth-gateway": ["auth"],
    "deployer": ["wip-deploy"], "wip-deploy": ["wip-deploy"],
    "scaffold": ["scaffold"], "wip-toolkit": ["backup-restore"],
    "kb-client": ["kb-client"], "docs": ["documentation"], "react-console": ["react-console"],
}
APP_MAP = {
    "kb": "kb-app", "wip-kb": "kb-app",
    "reactconsole": "react-console", "react-console": "react-console",
    "clintrial": "clintrial", "authorassist": "author-assist",
}
TITLE_RULES = [  # (topic, regex) — checked case-insensitively against title
    ("fresh-restore", r"fresh[- ]restore"),
    ("plain-restore", r"plain[- ]restore"),
    ("merge-restore", r"merge[- ]restore|restore.*\bmerge\b|\bmerge\b.*restore"),
    ("backup", r"\bbackups?\b"),
    ("restore", r"\brestor(e|ed|ing|es)\b"),
    ("archive-format", r"\barchive|\bmanifest"),
    ("namespaces", r"\bnamespace"),
    ("synonyms", r"\bsynonym"),
    ("identity-hashing", r"identity[_ -]?(hash|field)|append[- ]only"),
    # "canonical" alone is ambiguous — it usually names the canonical INSTANCE
    # (kb.internal), not canonical identity. Require the id sense explicitly.
    ("canonical-ids", r"canonical[- _]?id|\buuid"),
    ("identity", r"\bidentity\b"),
    ("sessions", r"\bsession"),
    ("case-workflow", r"case[- ]?(workflow|fetch|write|number)|/wip-case|CASE_RECORD|CASE_RESPONSE"),
    ("verification", r"\bverif|fabricat|hallucinat"),
    ("documentation", r"playbook|readme|doc[- ]drift|documentation|\bpaper\b"),
    ("ci", r"\bci\b|gitea|github (action|workflow)"),
    ("containers", r"\bcontainer|docker|podman|healthcheck|\bimage\b"),
    ("wip-deploy", r"wip-deploy|\bdeploy"),
    ("mcp", r"\bmcp\b"),
    ("auth", r"\bauth\b|\boidc\b|\bdex\b|api[- ]?key"),
    ("scaffold", r"\bscaffold|create-app-project|gene[- ]pool"),
    ("testing", r"\btests?\b|\btest[- ]|fixture|golden"),
    ("search-fts", r"\bsearch\b|\bfts\b|tsvector|full[- ]text"),
    ("reporting-sync", r"reporting[- ]sync"),
    ("reporting", r"\breporting\b"),
    ("document-store", r"document[- ]store"),
    ("template-store", r"template[- ]store|\btemplate versioning"),
    ("def-store", r"def[- ]store|terminolog"),
    ("registry", r"\bregistry\b"),
    ("kb-client", r"kb-client|\bkbc\b|case-fetch|kb-write"),
    ("kb-app", r"bootstrapgate|kb gateway|askbar"),
    ("wip-client", r"@wip/client|wip-client"),
    ("wip-react", r"@wip/react|wip-react"),
    ("wip-proxy", r"@wip/proxy|wip-proxy"),
]
# specific child present -> drop the generic parent tag
DROP_PARENT_IF_CHILD = {
    "identity": {"synonyms", "namespaces", "identity-hashing", "canonical-ids"},
    "reporting": {"reporting-sync", "search-fts"},
    "restore": {"fresh-restore", "merge-restore", "plain-restore"},
    "backup-restore": {"backup", "restore", "archive-format", "fresh-restore", "merge-restore", "plain-restore"},
    "wip-deploy": set(),  # leaf
}
MAX_TOPICS = 6


def topics_for(title, component=None, app=None):
    out = []
    for c in (component or "").split(","):
        out += COMPONENT_MAP.get(c.strip().lower(), [])
    a = APP_MAP.get((app or "").strip().lower())
    if a:
        out.append(a)
    t = title or ""
    for topic, rx in TITLE_RULES:
        if re.search(rx, t, re.IGNORECASE):
            out.append(topic)
    uniq = list(dict.fromkeys(out))
    keep = [x for x in uniq if not (x in DROP_PARENT_IF_CHILD and DROP_PARENT_IF_CHILD[x] & set(uniq))]
    return keep[:MAX_TOPICS]


def migrate(template, frm, to, apply):
    dry = req("POST", "/api/document-store/documents/migrate?namespace=kb",
              {"template_id": template, "from_version": frm, "to_version": to, "dry_run": True})
    print(f"migrate {template} v{frm}->v{to} DRY: total={dry.get('total')} ready={dry.get('ready')} failed={dry.get('failed')}")
    if dry.get("failed"):
        fails = [r for r in dry.get("results", []) if r.get("status") not in ("ready", "migrated", "ok")][:3]
        sys.exit(f"ABORT migrate {template}: failures {json.dumps(fails)[:500]}")
    if not dry.get("total") or not apply:
        return
    res = req("POST", "/api/document-store/documents/migrate?namespace=kb",
              {"template_id": template, "from_version": frm, "to_version": to, "dry_run": False})
    print(f"migrate {template} APPLY: total={res.get('total')} migrated={res.get('migrated', res.get('succeeded'))} failed={res.get('failed')}")
    if res.get("failed"):
        sys.exit(f"ABORT migrate apply {template}")


def main():
    ap = argparse.ArgumentParser(description="CASE-760/764 topic-tag backfill")
    ap.add_argument("--apply", action="store_true", help="migrate and PATCH for real (default: dry-run)")
    args = ap.parse_args()
    print(f"target: {BASE}  mode: {'APPLY' if args.apply else 'DRY-RUN'}")

    # ---- 1. migrate cohorts to the topics-bearing version ----
    migrate("CASE_RECORD", FROM_V, TO_V, args.apply)
    migrate("FIRESIDE", FROM_V, TO_V, args.apply)

    # ---- 2. derive tags ----
    cases = report("SELECT document_id, title, component, app FROM doc_case_record WHERE status = 'active'")
    fires = report("SELECT document_id, title FROM doc_fireside WHERE status = 'active'")
    plan = {}
    for r in cases:
        tps = topics_for(r["title"], r.get("component"), r.get("app"))
        if tps:
            plan[r["document_id"]] = tps
    n_cases = len(plan)
    for r in fires:
        tps = topics_for(r["title"])
        if tps:
            plan[r["document_id"]] = tps
    print(f"tagging plan: {n_cases}/{len(cases)} cases, {len(plan) - n_cases}/{len(fires)} firesides")
    cnt = Counter(t for tps in plan.values() for t in tps)
    print("top topics:", cnt.most_common(12))

    if not args.apply:
        print("(dry-run: no writes — re-run with --apply to migrate and PATCH)")
        return

    # ---- 3. bulk PATCH in batches ----
    ids = list(plan.items())
    patched = failed = 0
    for i in range(0, len(ids), 100):
        batch = [{"document_id": did, "patch": {"topics": tps}} for did, tps in ids[i:i + 100]]
        resp = req("PATCH", "/api/document-store/documents?namespace=kb", batch)
        for r in resp.get("results", []):
            if r.get("status") in ("updated", "unchanged"):
                patched += 1
            else:
                failed += 1
                if failed <= 3:
                    print("PATCH FAIL:", json.dumps(r)[:300])
    print(f"patched={patched} failed={failed}")
    if failed:
        sys.exit(1)
    print("DONE")


if __name__ == "__main__":
    main()
