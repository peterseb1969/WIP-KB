#!/usr/bin/env python3
"""kb-reload.py — radical-reload migration of a KB backup onto the (A) templates.

Context: CASE-490/491. Rather than in-place template surgery (which stranded 133
docs on canonical — see CASE-490), we EXPORT (a WIP backup zip) and RE-REGISTER
every record into a FRESH namespace shaped by the current (A) seed templates,
through the KB gateway single-write-path (CASE-482). Iterate on localhost with a
throwaway namespace per attempt until green; the canonical cutover is a separate,
one-shot Phase-2 step.

Case numbers are sparse (1..492, 99 gaps) and referenced everywhere, so they must
be preserved EXACTLY — the gateway mint path renumbers, so cases are loaded while
the CASE_RECORD WRITE_POLICY is absent (gateway writes them 'natural', preserving
case_number), their CASE-<n> synonyms are backfilled, then the policy is restored
(minting resumes at max+1). DOCUMENT/FIRESIDE have no historical number, so they
ARE minted (their identity IS the minted number). Edges resolve by the target
type's identity_fields[0] — no document_id remap.

Phases (--phase, default 'all'): bootstrap entities edges synonyms policy verify
Plus: teardown (delete the namespace).

localhost ONLY. Refuses namespace 'kb' or any non-localhost target.

Usage:
  tools/kb-reload.py --backup backup-files/kb_*.zip --namespace kb-mig-1 --phase all
  tools/kb-reload.py --namespace kb-mig-1 --phase teardown
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SEED = REPO / "server" / "seed"
BASE_URL = "https://localhost:8443"
KEY_FILE = Path.home() / ".wip-deploy" / "wip-local" / "secrets" / "api-key"
GW = "/apps/kb/server-api/kb"
ENTITY_TYPE = "documents"


# --- transport (localhost-pinned) -------------------------------------------
def _ctx() -> ssl.SSLContext:
    c = ssl.create_default_context()
    c.check_hostname = False
    c.verify_mode = ssl.CERT_NONE
    return c


def _req(method: str, path: str, body: object | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"X-API-Key": KEY_FILE.read_text().strip()}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(f"{BASE_URL}{path}", data=data, method=method, headers=headers)
    try:
        resp = urllib.request.urlopen(req, context=_ctx(), timeout=30)
    except urllib.error.HTTPError as e:
        snippet = e.read()[:400].decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} {method} {path}: {snippet}") from e
    raw = resp.read()
    return json.loads(raw) if raw else {}


def gw_write(ns: str, type_: str, data: dict, edges: list | None = None) -> dict:
    body: dict = {"data": data}
    if edges:
        body["edges"] = edges
    return _req("POST", f"{GW}/write/{type_}?namespace={ns}", body)


def dq(ns: str, template_value: str, filters: list | None = None, page_size: int = 100) -> list:
    """Paginated document-store query → all items."""
    out, page = [], 1
    while True:
        r = _req("POST", f"/api/document-store/documents/query?namespace={ns}",
                 {"template_id": template_value, "filters": filters or [], "page": page, "page_size": page_size})
        items = r.get("items") or []
        out.extend(items)
        if page >= (r.get("pages") or 1) or not items:
            return out
        page += 1


# --- seed metadata (new templates / policies) -------------------------------
def load_seed_meta() -> tuple[dict, dict]:
    """(idf0 per type, mint cfg per type) from the seed."""
    idf0 = {}
    for f in glob.glob(str(SEED / "templates" / "*.json")):
        d = json.load(open(f))
        idf = d.get("identity_fields") or []
        idf0[d["value"]] = idf[0] if idf else None
    mint = {}
    for p in json.load(open(SEED / "write-policies.json")):
        if p.get("write_mode") == "mint":
            mint[p["doc_type"]] = p
    return idf0, mint


# --- backup parsing ---------------------------------------------------------
def load_backup(zip_path: str) -> tuple[list, list, set]:
    """Return (entities, edges, edge_type_set) — latest version per document_id."""
    with zipfile.ZipFile(zip_path) as z:
        tpls = [json.loads(l) for l in z.read("templates.jsonl").decode().splitlines() if l.strip()]
        docs = [json.loads(l) for l in z.read("documents.jsonl").decode().splitlines() if l.strip()]
    edge_types = {t["value"] for t in tpls if t.get("usage") == "relationship"}
    latest: dict[str, dict] = {}
    for d in docs:
        k = d["document_id"]
        if k not in latest or d["version"] > latest[k]["version"]:
            latest[k] = d
    ents = [d for d in latest.values() if d["template_value"] not in edge_types]
    edges = [d for d in latest.values() if d["template_value"] in edge_types]
    return ents, edges, edge_types


# --- phases -----------------------------------------------------------------
def find_case_policy(ns: str) -> str | None:
    for it in dq(ns, "WRITE_POLICY"):
        if (it.get("data") or {}).get("doc_type") == "CASE_RECORD":
            return it["document_id"]
    return None


def phase_bootstrap(ns: str, dry: bool) -> None:
    print(f"[bootstrap] running real bootstrap for {ns} ...")
    if dry:
        print("  (dry-run) would run tools/bootstrap-ns.ts + archive CASE_RECORD WRITE_POLICY")
        return
    env = {**os.environ, "WIP_BASE_URL": BASE_URL, "WIP_API_KEY": KEY_FILE.read_text().strip(),
           "NODE_TLS_REJECT_UNAUTHORIZED": "0", "KB_BOOTSTRAP_NAMESPACE": ns}
    r = subprocess.run(["npx", "tsx", "tools/bootstrap-ns.ts"], cwd=REPO, env=env)
    if r.returncode != 0:
        raise SystemExit(f"bootstrap failed (rc={r.returncode})")
    # Turn case-numbering OFF: archive the CASE_RECORD WRITE_POLICY doc so the
    # gateway writes cases 'natural' (case_number preserved, not minted). Safe
    # because bootstrap uses WIP REST — it never populated the gateway's policy
    # cache for this ns, so the first gateway write below reads the archived state.
    pid = find_case_policy(ns)
    if pid:
        _req("DELETE", f"/api/document-store/documents?namespace={ns}",
             [{"id": pid, "updated_by": "kb-reload"}])
        print(f"  deleted CASE_RECORD WRITE_POLICY ({pid}) — case minting OFF")
    else:
        print("  no CASE_RECORD WRITE_POLICY found (already off)")


def edge_key_value(type_: str, data: dict, result: dict, idf0: dict, mint: dict) -> object:
    """The value resolveRef matches on for this doc as an edge target:
    identity_fields[0]. For a type actually minted on this load the value comes
    back on the write result; CASE_RECORD is in the seed mint set but is written
    'natural' during migration (no minted number) so its case_number in data
    wins — hence: prefer the returned number, else the data value."""
    field = idf0.get(type_)
    if not field:
        return None
    if type_ in mint and field == mint[type_]["number_field"] and result.get("number") is not None:
        return result["number"]
    return data.get(field)


# BOOTSTRAP_RECORD is the bootstrap's own audit doc — the fresh namespace writes
# its own at bootstrap, so the historical ones are not migrated (they'd double up
# and misrepresent when THIS namespace was provisioned).
SKIP_TYPES = {"BOOTSTRAP_RECORD"}

# Data fixes the export can't carry, applied at load time (transformation is the
# app's job, per Vision.md / the template-version-lifecycle fireside).
#   JOURNEY_ENTRY identity moved title -> day_number in the (A) design, but two
#   real Day-61 entries (both 2026-05-21, FRanC) existed under the old
#   title-identity. Renumber the later-created one to 61.5 (the journey
#   'intermezzo' convention) so both survive the new single-day identity.
#   Keyed by source document_id; flip the target id here to pick the other one.
DAY_NUMBER_OVERRIDES = {
    "019e5009-a7bd-74c2-b17f-5537a6e70082": 61.5,  # "Day 61: One canonical home..." (later of the two)
}


def phase_entities(ns: str, ents: list, idf0: dict, mint: dict, dry: bool) -> dict:
    """Write every entity (no edges). Returns backup_doc_id -> {type, key, data} for edges."""
    keymap: dict[str, dict] = {}
    by_type = defaultdict(list)
    for d in ents:
        if d["template_value"] in SKIP_TYPES:
            continue
        by_type[d["template_value"]].append(d)
    status = Counter()
    for tv in sorted(by_type):
        for d in by_type[tv]:
            if dry:
                status[(tv, "dry")] += 1
                continue
            data = d["data"]
            if d["document_id"] in DAY_NUMBER_OVERRIDES:
                data = {**data, "day_number": DAY_NUMBER_OVERRIDES[d["document_id"]]}
            try:
                r = gw_write(ns, tv, data)
            except RuntimeError as e:
                status[(tv, "ERROR")] += 1
                print(f"  ERROR {tv} {d['document_id']}: {e}", file=sys.stderr)
                continue
            status[(tv, r.get("result", "?"))] += 1
            keymap[d["document_id"]] = {"type": tv, "key": edge_key_value(tv, data, r, idf0, mint), "data": data}
        print(f"  {tv}: " + ", ".join(f"{k[1]}={v}" for k, v in status.items() if k[0] == tv))
    return keymap


def phase_edges(ns: str, edges: list, keymap: dict, dry: bool) -> None:
    """Re-POST each edge-source (its data carried in keymap) with edge-intents;
    the gateway resolves each target by the target type's identity_fields[0].
    Idempotent: re-running re-links the same edges."""
    by_source: dict[str, list] = defaultdict(list)
    dropped = 0
    for e in edges:
        s, t = e["data"].get("source_ref"), e["data"].get("target_ref")
        if s not in keymap or t not in keymap or keymap[t]["key"] is None:
            dropped += 1
            continue
        by_source[s].append({"type": e["template_value"], "target_type": keymap[t]["type"], "target_key": keymap[t]["key"]})
    if dropped:
        print(f"  WARNING: {dropped} edges dropped (endpoint not an in-scope entity / no key)", file=sys.stderr)
    status = Counter()
    for s, intents in by_source.items():
        info = keymap[s]
        if dry:
            status["dry"] += len(intents)
            continue
        try:
            r = gw_write(ns, info["type"], info["data"], intents)
        except RuntimeError as ex:
            status["ERROR"] += len(intents)
            print(f"  ERROR edges from {info['type']}:{info['key']}: {ex}", file=sys.stderr)
            continue
        for eg in r.get("edges") or []:
            status[eg.get("status", "?")] += 1
    print("  edges: " + ", ".join(f"{k}={v}" for k, v in status.items()))


def phase_synonyms(ns: str, dry: bool) -> None:
    cases = dq(ns, "CASE_RECORD")
    print(f"[synonyms] {len(cases)} CASE_RECORD docs")
    if dry:
        print(f"  (dry-run) would claim {len(cases)} CASE-<n> synonyms")
        return
    status = Counter()
    for it in cases:
        n = (it.get("data") or {}).get("case_number")
        if n is None:
            status["no_number"] += 1
            continue
        r = _req("POST", "/api/registry/synonyms/add", [{
            "target_id": it["document_id"], "synonym_namespace": ns,
            "synonym_entity_type": ENTITY_TYPE, "synonym_composite_key": {"value": f"CASE-{n}"}}])
        res = (r.get("results") or [r])[0]
        status[res.get("status", res.get("error_code", "?"))] += 1
    print("  " + ", ".join(f"{k}={v}" for k, v in status.items()))


def phase_policy(ns: str, dry: bool) -> None:
    """Re-create the CASE_RECORD WRITE_POLICY doc — minting back on (max+1)."""
    if find_case_policy(ns):
        print("[policy] CASE_RECORD WRITE_POLICY already present")
        return
    pol = next(p for p in json.load(open(SEED / "write-policies.json")) if p["doc_type"] == "CASE_RECORD")
    print(f"[policy] re-creating CASE_RECORD WRITE_POLICY: {pol}")
    if dry:
        return
    tpl = _req("GET", f"/api/template-store/templates/by-value/WRITE_POLICY?namespace={ns}")
    tid = tpl["template_id"]
    r = _req("POST", "/api/document-store/documents",
             [{"template_id": tid, "namespace": ns, "created_by": "kb-reload", "data": pol}])
    res = (r.get("results") or [{}])[0]
    print(f"  {res.get('status')} ({res.get('document_id', '')})")


def phase_verify(ns: str, ents: list, edges: list, dry: bool) -> None:
    print("[verify]")
    want = Counter(d["template_value"] for d in ents if d["template_value"] not in SKIP_TYPES)
    for tv in sorted(want):
        got = len(dq(ns, tv))
        flag = "OK" if got == want[tv] else "MISMATCH"
        print(f"  {tv:20} backup={want[tv]:4} loaded={got:4}  {flag}")
    # sample case + synonym resolve
    try:
        sample = _req("GET", f"{GW}/cases/457?namespace={ns}")
        print(f"  GET /cases/457 -> {sample.get('case', sample.get('document_id', 'n/a'))} (synonym resolves)")
    except RuntimeError as e:
        print(f"  GET /cases/457 -> {e}")


def phase_teardown(ns: str, dry: bool) -> None:
    if dry:
        print(f"[teardown] (dry-run) would delete namespace {ns}")
        return
    # Namespaces are created deletion_mode='retain' (the bootstrap PUT default);
    # flip to 'full' (PUT upsert, confirm required) before the hard delete.
    _req("PUT", f"/api/registry/namespaces/{ns}",
         {"deletion_mode": "full", "confirm_enable_deletion": True})
    _req("DELETE", f"/api/registry/namespaces/{ns}")
    print(f"[teardown] deleted namespace {ns}")


PHASES = ["bootstrap", "entities", "edges", "synonyms", "policy", "verify"]


def main() -> int:
    ap = argparse.ArgumentParser(description="KB radical-reload migration (localhost only).")
    ap.add_argument("--backup", help="backup zip (glob ok)")
    ap.add_argument("--namespace", required=True)
    ap.add_argument("--phase", default="all", choices=["all", "teardown", *PHASES])
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ns = args.namespace
    if ns == "kb":
        sys.exit("REFUSE: namespace 'kb' is canonical. Use a throwaway (e.g. kb-mig-1).")
    if "localhost" not in BASE_URL:
        sys.exit("REFUSE: target must be localhost.")

    if args.phase == "teardown":
        phase_teardown(ns, args.dry_run)
        return 0

    need_backup = args.phase in ("all", "entities", "edges", "verify")
    ents = edges = []
    if need_backup:
        if not args.backup:
            sys.exit("--backup is required for this phase")
        zp = sorted(glob.glob(args.backup))[-1]
        print(f"backup: {zp}")
        ents, edges, _ = load_backup(zp)
        print(f"  {len(ents)} entities, {len(edges)} edges (latest-collapsed)")

    idf0, mint = load_seed_meta()
    run = PHASES if args.phase == "all" else [args.phase]
    keymap: dict = {}
    for ph in run:
        if ph == "bootstrap":
            phase_bootstrap(ns, args.dry_run)
        elif ph == "entities":
            keymap = phase_entities(ns, ents, idf0, mint, args.dry_run)
        elif ph == "edges":
            if not keymap and not args.dry_run:
                # standalone edge phase: rebuild keymap from what's loaded
                keymap = _rebuild_keymap(ns, ents, idf0, mint)
            phase_edges(ns, edges, keymap, args.dry_run)
        elif ph == "synonyms":
            phase_synonyms(ns, args.dry_run)
        elif ph == "policy":
            phase_policy(ns, args.dry_run)
        elif ph == "verify":
            phase_verify(ns, ents, edges, args.dry_run)
    return 0


def _rebuild_keymap(ns: str, ents: list, idf0: dict, mint: dict) -> dict:
    """For a standalone --phase edges run: map backup doc_id -> {type,key} by
    re-reading the loaded docs' identities (paper_number for minted DOCUMENTs)."""
    km: dict = {}
    # index loaded docs by their natural identity to recover minted numbers
    for d in ents:
        tv = d["template_value"]
        if tv in SKIP_TYPES:
            continue
        field = idf0.get(tv)
        # A type minted on load (CASE_RECORD excluded — written natural) carries
        # its key as the minted number; recover it via the search_key lookup.
        if tv in mint and field == mint[tv]["number_field"] and tv != "CASE_RECORD":
            sk = mint[tv]["search_key"]
            filt = [{"field": f"data.{k}", "operator": "eq", "value": d["data"].get(k)} for k in sk]
            got = dq(ns, tv, filt, page_size=1)
            key = got[0]["data"].get(field) if got else None
        else:
            key = d["data"].get(field) if field else None
        km[d["document_id"]] = {"type": tv, "key": key, "data": d["data"]}
    return km


if __name__ == "__main__":
    sys.exit(main())
