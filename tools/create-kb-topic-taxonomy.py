#!/usr/bin/env python3
"""create-kb-topic-taxonomy.py — seed the KB_TOPIC taxonomy (CASE-760 Phase 1).

Creates the subject-matter taxonomy the Topic search facet renders: one
terminology (KB_TOPIC) + 44 terms + 41 ontology relations (part_of for area
containment, is_a for kind-of). The tree was approved by Peter 2026-07-22 and
is already live on canonical kb.internal; this script exists so a fresh
instance (sandbox restore, new install) can be seeded identically.

Additive only — no deletes, no template changes. Idempotent: the terminology
POST uses on_conflict=validate (identical config → unchanged, returns the
existing id), bulk term creates skip duplicates, duplicate relations are
skipped. Bulk-first discipline: HTTP 200 does not mean success; every
per-item status is checked and any error aborts the run.

Env:
  KB_TARGET   base URL          (default https://localhost:8443 — the sandbox)
  KB_KEYFILE  admin API key file (default ~/.wip-deploy/default/secrets/api-key)

To target canonical: KB_TARGET=https://kb.internal \
                     KB_KEYFILE=~/.wip-deploy/kb/secrets/api-key
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
NS = os.environ.get("KB_NAMESPACE", "kb")
CTX = ssl._create_unverified_context()


def post(path, payload):
    req = urllib.request.Request(
        BASE + path, data=json.dumps(payload).encode(),
        headers={"X-API-Key": KEY, "Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, context=CTX, timeout=30) as r:
        return json.load(r)


def assert_ok(resp, what):
    results = resp.get("results", [])
    bad = [r for r in results if r.get("status") not in ("created", "updated", "unchanged", "skipped")]
    if bad or resp.get("failed", 0):
        sys.exit(f"ABORT {what}: {json.dumps(bad[:3], indent=1)}")
    print(f"OK {what}: {resp.get('succeeded', len(results))}/{resp.get('total', len(results))}")
    return results


TERMS = [
    # (value, label, description, sort_order, aliases)
    ("platform", "Platform", "WIP platform engine: services, identity, data lifecycle, tooling.", 10, None),
    ("platform-services", "Platform Services", "The individual backend services that make up WIP.", 11, None),
    ("document-store", "Document Store", "Document storage, validation, versioning, relationships, backup engine.", 12, None),
    ("template-store", "Template Store", "Template schemas, versioning, edge-type definitions.", 13, None),
    ("def-store", "Def Store", "Terminologies, terms, aliases, ontology relations.", 14, None),
    ("registry", "Registry", "Canonical IDs, composite keys, namespaces service, grants, API keys.", 15, None),
    ("reporting", "Reporting", "The PostgreSQL reporting layer as a whole.", 16, None),
    ("reporting-sync", "Reporting Sync", "MongoDB-to-PostgreSQL sync service, per-version tables, entity views.", 17, None),
    ("search-fts", "Search / FTS", "Full-text search: tsvector columns, ranked search endpoint, snippets, substring fallback.", 18, None),
    ("identity", "Identity", "Identity as a concept: canonical IDs, identity hashing, resolution.", 20, None),
    ("synonyms", "Synonyms", "Registry synonyms: external IDs, minted handles (CASE-n), resolution paths.", 21, None),
    ("namespaces", "Namespaces", "Namespace scoping, isolation modes, deletion modes, cross-namespace refs.", 22, None),
    ("identity-hashing", "Identity Hashing", "identity_fields, dedup hashing, upsert semantics, append-only templates.", 23, None),
    ("canonical-ids", "Canonical IDs", "Canonical identity: UUID7/prefixed ID formats, the Registry as identity authority, synonym-to-canonical resolution, entry merges.", 24, None),
    ("backup-restore", "Backup & Restore", "Data lifecycle: archives, restore modes, merge semantics.", 30, None),
    ("backup", "Backup", "Backup jobs, archive creation, export.", 31, None),
    ("restore", "Restore", "Restore operations of any mode.", 32, None),
    ("fresh-restore", "Fresh Restore", "Restore into a new namespace with re-minted IDs (import --mode fresh).", 33, None),
    ("merge-restore", "Merge Restore", "Restore that merges an archive into an existing populated namespace.", 34, None),
    ("archive-format", "Archive Format", "Archive layout, manifests, export collectors.", 35, None),
    ("plain-restore", "Plain Restore", "Restore with original IDs preserved (wip-toolkit import --mode restore) — disaster recovery into the same namespace identity.", 36, ["mode-restore", "original-id-restore"]),
    ("deployment", "Deployment", "Installing and operating WIP and its apps.", 40, None),
    ("wip-deploy", "wip-deploy", "The deployer: install targets, manifests, app-source hotwiring, secrets.", 41, None),
    ("containers", "Containers", "Images, Dockerfiles, healthchecks, registries, multi-arch builds.", 42, None),
    ("ci", "CI", "CI pipelines: gitea Actions, GitHub workflows, test gates.", 43, None),
    ("client-libs", "Client Libraries", "The TypeScript client libraries apps build on.", 50, None),
    ("wip-client", "@wip/client", "Typed TS client: services, bulk envelope, error hierarchy.", 51, None),
    ("wip-react", "@wip/react", "React hooks over the client (TanStack Query).", 52, None),
    ("wip-proxy", "@wip/proxy", "Express middleware: auth injection, API proxying, app-config.", 53, None),
    ("mcp", "MCP", "The MCP server: tools, resources, agent-facing API ingress.", 60, None),
    ("auth", "Auth", "OIDC, Dex, auth-gateway, API keys, session handling.", 61, None),
    ("scaffold", "Scaffold", "App generation: create-app-project, presets, gene-pool templates, refresh.", 62, None),
    ("testing", "Testing", "Test infrastructure: matrices, fixtures, golden tests, harnesses.", 63, None),
    ("apps", "Apps", "Applications built on WIP.", 70, None),
    ("kb-app", "KB App", "The Knowledge Base app: UI, gateway, bootstrap, served client.", 71, None),
    ("kb-client", "KB Client", "The served kb client bundle: kbc, case-fetch, kb-write, playbooks.", 72, None),
    ("react-console", "React Console", "The ReactConsole admin app.", 73, None),
    ("clintrial", "ClinTrial Explorer", "The Clinical Trials Explorer app.", 74, None),
    ("author-assist", "AuthorAssist", "The AuthorAssist app.", 75, None),
    ("agent-practice", "Agent Practice", "How YACs work: process, discipline, cross-agent workflow.", 80, None),
    ("sessions", "Sessions", "Session identity, wake/rollover, reports, continuity.", 81, None),
    ("case-workflow", "Case Workflow", "Cross-agent cases: filing, responding, implementing, status machine.", 82, None),
    ("verification", "Verification", "Verify-before-assert discipline, fabrication classes, evidence standards.", 83, None),
    ("documentation", "Documentation", "Docs as a practice: papers, playbooks, doc drift, parity guards.", 84, None),
]

RELATIONS = [  # (child, parent, type)
    ("platform-services", "platform", "part_of"), ("identity", "platform", "part_of"),
    ("backup-restore", "platform", "part_of"), ("deployment", "platform", "part_of"),
    ("client-libs", "platform", "part_of"), ("mcp", "platform", "part_of"),
    ("auth", "platform", "part_of"), ("scaffold", "platform", "part_of"),
    ("testing", "platform", "part_of"),
    ("document-store", "platform-services", "part_of"), ("template-store", "platform-services", "part_of"),
    ("def-store", "platform-services", "part_of"), ("registry", "platform-services", "part_of"),
    ("reporting", "platform-services", "part_of"),
    ("reporting-sync", "reporting", "part_of"), ("search-fts", "reporting", "part_of"),
    ("synonyms", "identity", "part_of"), ("namespaces", "identity", "part_of"),
    ("identity-hashing", "identity", "part_of"), ("canonical-ids", "identity", "part_of"),
    ("backup", "backup-restore", "part_of"), ("restore", "backup-restore", "part_of"),
    ("archive-format", "backup-restore", "part_of"),
    ("fresh-restore", "restore", "is_a"), ("merge-restore", "restore", "is_a"),
    ("plain-restore", "restore", "is_a"),
    ("wip-deploy", "deployment", "part_of"), ("containers", "deployment", "part_of"),
    ("ci", "deployment", "part_of"),
    ("wip-client", "client-libs", "part_of"), ("wip-react", "client-libs", "part_of"),
    ("wip-proxy", "client-libs", "part_of"),
    ("kb-app", "apps", "part_of"), ("react-console", "apps", "part_of"),
    ("clintrial", "apps", "part_of"), ("author-assist", "apps", "part_of"),
    ("kb-client", "kb-app", "part_of"),
    ("sessions", "agent-practice", "part_of"), ("case-workflow", "agent-practice", "part_of"),
    ("verification", "agent-practice", "part_of"), ("documentation", "agent-practice", "part_of"),
]
assert len(TERMS) == 44 and len(RELATIONS) == 41

print(f"target: {BASE}  namespace: {NS}")

# 1. Terminology. Immutable (deprecate-don't-delete per the CASE-760 ruling).
#    on_conflict=validate keeps re-runs idempotent: identical config returns
#    the existing id as 'unchanged'; a drifted config fails loudly.
tresp = post("/api/def-store/terminologies?on_conflict=validate", [{
    "value": "KB_TOPIC", "label": "KB Topic", "namespace": NS,
    "description": ("Subject-matter taxonomy for the KB corpus. Hierarchical via ontology "
                    "term-relations: part_of expresses area containment (reporting part_of "
                    "platform-services), is_a expresses kind-of (fresh-restore is_a restore). "
                    "Navigation is by topic across all doc types; a doc may carry multiple "
                    "topics. Curated vocabulary: immutable, deprecate-don't-delete."),
}])
res = assert_ok(tresp, "terminology KB_TOPIC")
tid = res[0]["id"]
print("terminology_id:", tid)

# 2. Terms (bulk create skips existing values, so re-runs are additive-safe)
payload = []
for value, label, desc, sort, aliases in TERMS:
    t = {"value": value, "label": label, "description": desc, "sort_order": sort}
    if aliases:
        t["aliases"] = aliases
    payload.append(t)
res = assert_ok(post(f"/api/def-store/terminologies/{tid}/terms", payload), "44 terms")
ids = {TERMS[i][0]: r["id"] for i, r in enumerate(res)}
if len(ids) != 44:
    sys.exit(f"ABORT: expected 44 term ids, got {len(ids)}")

# 3. Relations (duplicates are skipped; inactive duplicates are reactivated)
rel_payload = [{"source_term_id": ids[c], "target_term_id": ids[p], "relation_type": t}
               for c, p, t in RELATIONS]
assert_ok(post(f"/api/def-store/ontology/term-relations?namespace={NS}", rel_payload), "41 relations")
print(f"DONE — KB_TOPIC seeded on {BASE} ({NS})")
