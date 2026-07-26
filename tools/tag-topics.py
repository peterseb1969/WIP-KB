#!/usr/bin/env python3
"""tag-topics.py — assisted topic-tagging pass over the tagged corpus (CASE-760/764).

Covers CASE_RECORD, FIRESIDE and LESSON in the corpus namespace and LIBRARY_DOC
in the Library namespace. The last two matter most: neither carries `component`
or `app`, so the gateway's write-time fallback can never tag them and this sweep
is the ONLY thing that will.

Signals differ by type, strongest first: CASE_RECORD has component/app;
LIBRARY_DOC has source_scope (the source paths it was generated from, whose
segments the topic vocabulary already names); FIRESIDE and LESSON have the title
alone. source_scope is resolved THROUGH the vocabulary's values and aliases
rather than a map kept here, so it agrees with the gateway by construction.

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
NS_LIBRARY = os.environ.get("KB_LIBRARY_NAMESPACE", "library")


def req(method, path, payload=None):
    r = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode() if payload is not None else None,
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method=method)
    with urllib.request.urlopen(r, context=CTX, timeout=60) as resp:
        return json.load(resp)


def report(sql, ns="kb"):
    return req("POST", f"/api/reporting-sync/query?namespace={ns}",
               {"namespace": ns, "sql": sql, "max_rows": 5000})["rows"]


def vocabulary(ns="kb"):
    """lowercased term value OR alias -> canonical term value, from KB_TOPIC.

    The same resolution the gateway does on write. Reading the vocabulary
    instead of restating it here means an added alias teaches this sweep and
    the write path at once — the two cannot drift into disagreeing about what
    'mcp-server' means.
    """
    t = req("GET", f"/api/def-store/terminologies/by-value/KB_TOPIC?namespace={ns}")
    tid = t.get("terminology_id") or t.get("id")
    d = req("GET", f"/api/def-store/terminologies/{tid}/terms?namespace={ns}&page_size=1000")
    m = {}
    for term in d.get("items", []):
        v = term["value"]
        m[v.lower()] = v
        for a in term.get("aliases") or []:
            m[a.lower()] = v
    if not m:
        sys.exit(f"ABORT: KB_TOPIC resolved to 0 terms in {ns}")
    return m


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


def topics_from_scope(scope, vocab):
    """LIBRARY_DOC's source_scope paths -> topics, resolved through the vocabulary.

    A library doc records which source it was generated from
    ("components/mcp-server/...", "libs/wip-react", "deployer/src"), and those
    path segments are already the names the topic vocabulary knows — directly
    as term values, or via the aliases that also let the gateway turn a case's
    component into a topic. So the strongest signal this type has needs no map
    of its own: split the path and ask the vocabulary.

    Deterministic, unlike the title rules — a path segment naming a component
    IS what the doc is about, where a word in a title only suggests it.
    """
    # The reporting layer hands array columns back as a JSON STRING, not a list.
    # Iterating one directly walks it character by character and matches nothing
    # — no error, just no tags, which reads exactly like "this doc had no usable
    # scope". Parse before trusting the shape.
    if isinstance(scope, str):
        try:
            scope = json.loads(scope)
        except ValueError:
            scope = [scope]
    if not isinstance(scope, (list, tuple)):
        return []
    out = []
    for path in scope:
        for seg in re.split(r"[/\\.]", str(path)):
            hit = vocab.get(seg.strip().lower())
            if hit:
                out.append(hit)
    return out


def topics_for(title, component=None, app=None, scope=None, vocab=None):
    out = []
    for c in (component or "").split(","):
        out += COMPONENT_MAP.get(c.strip().lower(), [])
    a = APP_MAP.get((app or "").strip().lower())
    if a:
        out.append(a)
    if scope and vocab:
        out += topics_from_scope(scope, vocab)
    t = title or ""
    for topic, rx in TITLE_RULES:
        if re.search(rx, t, re.IGNORECASE):
            out.append(topic)
    uniq = list(dict.fromkeys(out))
    keep = [x for x in uniq if not (x in DROP_PARENT_IF_CHILD and DROP_PARENT_IF_CHILD[x] & set(uniq))]
    return keep[:MAX_TOPICS]


def migrate(template, frm, to, apply, ns="kb"):
    dry = req("POST", f"/api/document-store/documents/migrate?namespace={ns}",
              {"template_id": template, "from_version": frm, "to_version": to, "dry_run": True})
    print(f"migrate {template} v{frm}->v{to} DRY: total={dry.get('total')} ready={dry.get('ready')} failed={dry.get('failed')}")
    if dry.get("failed"):
        fails = [r for r in dry.get("results", []) if r.get("status") not in ("ready", "migrated", "ok")][:3]
        sys.exit(f"ABORT migrate {template}: failures {json.dumps(fails)[:500]}")
    if not dry.get("total") or not apply:
        return
    res = req("POST", f"/api/document-store/documents/migrate?namespace={ns}",
              {"template_id": template, "from_version": frm, "to_version": to, "dry_run": False})
    print(f"migrate {template} APPLY: total={res.get('total')} migrated={res.get('migrated', res.get('succeeded'))} failed={res.get('failed')}")
    if res.get("failed"):
        sys.exit(f"ABORT migrate apply {template}")


def main():
    ap = argparse.ArgumentParser(description="CASE-760/764 topic-tag backfill")
    ap.add_argument("--apply", action="store_true", help="migrate and PATCH for real (default: dry-run)")
    ap.add_argument("--retag", action="store_true",
                    help="also re-derive documents that ALREADY have topics, overwriting them. "
                         "Off by default because it destroys human tagging; use only after a "
                         "deliberate rules change, and preferably dry-run it first.")
    args = ap.parse_args()
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"target: {BASE}  mode: {mode}{'  RETAG (overwrites existing topics)' if args.retag else ''}")

    vocab = vocabulary()

    # ---- 1. migrate cohorts to the topics-bearing version ----
    # A cohort already on the topics version reports total=0 and is a no-op, so
    # this stays correct on an instance where some types were migrated by hand.
    for tpl, ns in (("CASE_RECORD", "kb"), ("FIRESIDE", "kb"),
                    ("LESSON", "kb"), ("LIBRARY_DOC", NS_LIBRARY)):
        migrate(tpl, FROM_V, TO_V, args.apply, ns)

    # ---- 2. derive tags ----
    # Plans are per-namespace because the PATCH endpoint is namespace-scoped:
    # LIBRARY_DOC lives in the Library namespace, the other three in the corpus.
    plans = {"kb": {}, NS_LIBRARY: {}}
    coverage = []

    def add(ns, rows, label, fn):
        hit = held = 0
        for r in rows:
            # Never overwrite an existing tag set. A document with topics has
            # been tagged by SOMEONE — a person who read it, or an earlier run —
            # and replacing that with a fresh derivation would silently delete a
            # human judgement the rules cannot reproduce. Only empty documents
            # are candidates; --retag is the explicit way to say otherwise.
            if r.get("topics") and not args.retag:
                held += 1
                continue
            tps = fn(r)
            if tps:
                plans[ns][r["document_id"]] = tps
                hit += 1
        note = f" ({held} already tagged, left alone)" if held else ""
        coverage.append(f"{label} {hit}/{len(rows)}{note}")

    add("kb", report("SELECT document_id, title, component, app, topics FROM doc_case_record WHERE status = 'active'"),
        "cases", lambda r: topics_for(r["title"], r.get("component"), r.get("app")))
    add("kb", report("SELECT document_id, title, topics FROM doc_fireside WHERE status = 'active'"),
        "firesides", lambda r: topics_for(r["title"]))
    # LESSON and LIBRARY_DOC carry neither component nor app, so the gateway's
    # write-time fallback can never reach them — this sweep is their only path
    # to a tag. LIBRARY_DOC at least has source_scope, which is deterministic;
    # LESSON has the title alone.
    add("kb", report("SELECT document_id, title, topics FROM doc_lesson WHERE status = 'active'"),
        "lessons", lambda r: topics_for(r["title"]))
    add(NS_LIBRARY, report(
        f"SELECT document_id, title, source_scope, topics FROM {NS_LIBRARY}.doc_library_doc WHERE status = 'active'",
        NS_LIBRARY),
        "library docs", lambda r: topics_for(r["title"], scope=r.get("source_scope"), vocab=vocab))

    print("tagging plan: " + ", ".join(coverage))
    cnt = Counter(t for p in plans.values() for tps in p.values() for t in tps)
    print("top topics:", cnt.most_common(12))

    if not args.apply:
        print("(dry-run: no writes — re-run with --apply to migrate and PATCH)")
        return

    # ---- 3. bulk PATCH in batches, per namespace ----
    patched = failed = 0
    for ns, plan in plans.items():
        ids = list(plan.items())
        for i in range(0, len(ids), 100):
            batch = [{"document_id": did, "patch": {"topics": tps}} for did, tps in ids[i:i + 100]]
            resp = req("PATCH", f"/api/document-store/documents?namespace={ns}", batch)
            for r in resp.get("results", []):
                if r.get("status") in ("updated", "unchanged"):
                    patched += 1
                else:
                    failed += 1
                    if failed <= 3:
                        print(f"PATCH FAIL [{ns}]:", json.dumps(r)[:300])
    print(f"patched={patched} failed={failed}")
    if failed:
        sys.exit(1)
    print("DONE")


if __name__ == "__main__":
    main()
