"""
kb_write_core.py — shared canonical doc builders for FR-YAC's kb-write tools.

CASE-407: extracted from the previously-duplicated `build_*_doc` + parsing +
detection logic that lived in both `tools/add-to-kb.py` and
`tools/kb-bulk-mirror.py`. The drift the consolidation fixes was caught at
CASE-404 step 2 acceptance-test time — the schema-extension landed in
add-to-kb.py but bulk-mirror's separate copy still wrote the old shape.

Used by:
- tools/add-to-kb.py — single-record dual-write
- tools/kb-bulk-mirror.py — bulk reconciliation

Public surface:
- Constants:
    TPL_CASE / TPL_JOURNEY / TPL_DOCUMENT / TPL_REFERENCES / TPL_SUPERSEDES
    VALID_TARGETS
    NAMESPACE        (env: KB_NAMESPACE, default "kb")
    DEV_ROOT         (env: KB_DEV_ROOT, default ~/Development)
    DOC_PATH_RE      (regex for DOCUMENT path detection per CASE-346)
- Pure helpers (no I/O beyond what the builders need):
    parse_frontmatter(text) -> (dict, str)
    normalize_target(s) -> str
    parse_journal_date(text, day_num) -> str
    parse_day_number(fname) -> float | None
    detect_document_meta(path) -> (repo_origin, repo_relative_path, kind) | None
- Builders (take pre-parsed inputs + caller-injected template_id + loader name):
    build_case_doc(path, text, fm, *, template_id, loader) -> dict
    build_journey_doc(path, text, fm, *, template_id, loader) -> dict | None
    build_document_doc(path, text, fm, *, template_id, loader) -> dict | None

Discipline (anchors):
- No HTTP. No target switching. Each caller owns its own HTTP + target model
  (add-to-kb's dual-target loop vs kb-bulk-mirror's single-target env-var
  driven shape). Builders take a pre-resolved `template_id` kwarg.
- metadata.custom is audit/loader context ONLY (per
  feedback_metadata_is_not_a_workaround). Post-CASE-404, the
  type/severity/component/case_status duplicates were removed — those fields
  live in `data.*` now. metadata.custom keeps flat_file_mirror / filed_at /
  implemented_at / related / loader / kind (per template; only DOCUMENT
  records keep `kind` in metadata too because it's a useful audit trace).
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any


# Template values (caller resolves to UUIDs at write time)
TPL_CASE = "CASE_RECORD"
TPL_JOURNEY = "JOURNEY_ENTRY"
TPL_DOCUMENT = "DOCUMENT"
TPL_SESSION = "SESSION"
TPL_REFERENCES = "REFERENCES"
TPL_SUPERSEDES = "SUPERSEDES"
TPL_CONTINUES_FROM = "CONTINUES_FROM"

NAMESPACE = os.environ.get("KB_NAMESPACE", "kb")
DEV_ROOT = Path(os.environ.get("KB_DEV_ROOT", str(Path.home() / "Development")))

# --- API-key resolution (CASE-444) -----------------------------------------
# One rule for the whole served bundle. Before this, the write scripts read
# KB_KEY_FILE while the read scripts and the FR-YAC wrapper used
# KB_API_KEY_FILE, and the fallback baked one machine's homedir + one
# instance's key into served code.
CANONICAL_BASE_URL = "https://wip-kb.local"
LOCAL_BASE_URL = "https://localhost:8443"


def default_key_path(profile: str) -> Path:
    """$HOME-derived key path for a wip-deploy profile (e.g. 'wip-kb')."""
    return Path.home() / ".wip-deploy" / profile / "secrets" / "api-key"


def resolve_key_file(base_url: str, base_url_default: str,
                     default_profile: str, *env_vars: str) -> Path:
    """Resolve the API-key file for a target (CASE-444).

    env_vars are checked in order; first set one wins. KB_KEY_FILE is accepted
    anywhere in the list as a deprecated alias (stderr warning). If no env var
    is set AND the target's base URL was overridden away from its default,
    fail loud rather than silently pair the default profile's key with a
    different instance (the silent wrong-key 401 class).
    """
    for var in env_vars:
        val = os.environ.get(var)
        if val:
            if var == "KB_KEY_FILE":
                print("[kb-client] KB_KEY_FILE is deprecated; use "
                      "KB_API_KEY_FILE (CASE-444)", file=sys.stderr)
            return Path(val).expanduser()
    if base_url.rstrip("/") != base_url_default.rstrip("/"):
        raise SystemExit(
            f"[kb-client] base URL overridden to {base_url} but none of "
            f"{'/'.join(env_vars)} is set — refusing to fall back to the "
            f"default '{default_profile}' key for a different instance. "
            f"Set {env_vars[0]} to that instance's key file. (CASE-444)")
    return default_key_path(default_profile)

# Valid KB_TARGET_YAC term values.
VALID_TARGETS = {"USER1", "BE-YAC", "APP-RC", "APP-CT", "APP-KB", "BUG-YAC", "FRanC", "any"}

# CASE-411: alias map for CASE_RECORD.data.app normalization. The frontmatter
# `app:` field arrives with operator-typed spellings (17 distinct values for
# ~6 apps in the May 2026 corpus); this map collapses them to a canonical
# set so downstream consumers can filter without client-side alias tables.
# Lookup is case-insensitive; unknown values pass through unchanged with a
# stderr warn (defensive — new apps bubble up rather than getting dropped).
APP_ALIASES = {
    "kb": "KB",
    "wip-kb": "KB",
    "wip ractconsole": "ReactConsole",  # historic typo seen in corpus
    "wip reactconsole": "ReactConsole",
    "rc-console": "ReactConsole",
    "rc-console (wip reactconsole)": "ReactConsole",
    "react-console": "ReactConsole",
    "reactconsole": "ReactConsole",
    "authorassist": "AuthorAssist",
    "wip-aa": "AuthorAssist",
    "aa": "AuthorAssist",
    "clintrial explorer": "ClinTrial",
    "clintrial": "ClinTrial",
    "clintrial-explorer": "ClinTrial",
    "wip-clintrial": "ClinTrial",
    "ct": "ClinTrial",
    "dnd-compendium": "DnD",
    "dnd": "DnD",
    "wip-dnd": "DnD",
    "validator": "Validator",
    "app-val": "Validator",
    "wip-val": "Validator",
    "val": "Validator",
    "backend": "backend",
    "platform": "backend",
    "wip-backend": "backend",
    "cross-agent": "cross-agent",
    "multi-app": "cross-agent",
    "all-yacs": "cross-agent",
    "wip-deploy": "wip-deploy",
    "deploy": "wip-deploy",
    "all-apps": "all-apps",
    "every-app": "all-apps",
    "all": "all-apps",
}

# DOCUMENT path detection (CASE-346): <repo>/(papers|docs[/<subdir>])/<file>.md
DOC_PATH_RE = re.compile(
    r"\b(?:(?P<repo>FR-YAC|World-in-a-Pie|WIP-KB|WIP-ReactConsole|WIP-ClinTrial|WIP-AA|WIP-DnD)/)?"
    r"(?P<sub>papers|docs(?:/[a-zA-Z0-9_-]+)?)/"
    r"(?P<file>[a-zA-Z0-9_-]+\.md)"
)


# --------------------------------------------------------------------- parsing

def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    m = re.match(r"^---\n(.*?)\n---\s*\n?(.*)$", text, re.DOTALL)
    if not m:
        return {}, text
    fm: dict[str, str] = {}
    for line in m.group(1).split("\n"):
        line = line.rstrip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        k, v = line.split(":", 1)
        fm[k.strip()] = v.strip()
    return fm, m.group(2)


DAY_ONE = __import__("datetime").date(2026, 3, 14)


def normalize_app(s: str | None) -> str:
    """CASE-411: collapse operator-typed app: frontmatter values to a canonical
    set via APP_ALIASES. Empty string passes through (acceptable null state per
    the case's "empty fields not a problem" framing). Unknown values pass
    through unchanged with a stderr warn so new apps surface visibly."""
    if not s:
        return ""
    raw = s.strip()
    if not raw:
        return ""
    canonical = APP_ALIASES.get(raw.lower())
    if canonical is not None:
        return canonical
    # Unknown: pass through + warn (defensive — see case body, acceptance #4).
    import sys
    print(f"[kb_write_core] WARN: unknown app value {raw!r} — passing through unchanged (CASE-411). "
          f"Add to APP_ALIASES if this is a new canonical app.", file=sys.stderr)
    return raw


def normalize_target(s: str | None) -> str:
    if not s:
        return "any"
    tok = re.split(r"[\s,(]", s.strip(), maxsplit=1)[0]
    if tok in VALID_TARGETS:
        return tok
    if tok == "APP-KB-YAC":
        return "APP-KB"
    if tok.lower() == "peter":
        return "USER1"
    return "any"


def parse_journal_date(text: str, day_num: float) -> str:
    """Parse Date header from journal body. Handles 'Month D, YYYY' and ranges
    ('Month D-D, YYYY', 'Day-Day, Month D-D, YYYY'). CASE-309 fix.
    """
    from datetime import datetime, timedelta
    fallback = (DAY_ONE + timedelta(days=int(day_num) - 1)).isoformat()

    # Try the simple shape first: ...Month D, YYYY
    m = re.search(
        r"\*\*Date:\*\*[^\n]*?\b(January|February|March|April|May|June|July|August|September|October|November|December)\b\s+(\d{1,2})[–\-,]?",
        text[:1500],
    )
    if not m:
        return fallback

    month, day = m.group(1), m.group(2)

    # Find the trailing year somewhere on the same line — the year is always
    # there, just may be separated by ranges. Look at the rest of the line:
    line_match = re.search(r"\*\*Date:\*\*([^\n]+)", text[:1500])
    line = line_match.group(1) if line_match else ""
    year_match = re.search(r"\b(20\d{2})\b", line)
    if not year_match:
        return fallback

    try:
        d = datetime.strptime(f"{month} {day} {year_match.group(1)}", "%B %d %Y").date()
        return d.isoformat()
    except ValueError:
        return fallback


def parse_day_number(fname: str) -> float | None:
    """Extract day_number from a journey filename. Handles integer (Day19),
    fractional-via-suffix (Day4_Intermezzo → 4.5), and explicit float
    (Day4.5). CASE-309 fix.
    """
    m = re.match(r"WIP_Journey_Day(\d+)_Intermezzo\.md", fname)
    if m:
        return float(m.group(1)) + 0.5
    m = re.match(r"WIP_Journey_Day(\d+(?:\.\d+)?)\.md", fname)
    if m:
        return float(m.group(1))
    return None


# ------------------------------------------------------------- template detect

def detect_document_meta(path: Path) -> tuple[str, str, str] | None:
    """For DOCUMENT-shaped paths, return (repo_origin, repo_relative_path, kind).
    Returns None if the path doesn't match a DOCUMENT pattern.

    Patterns (relative to DEV_ROOT):
      <repo>/papers/...               → kind=paper
      <repo>/docs/playbooks/...       → kind=playbook
      <repo>/docs/...   (any other)   → kind=guide

    KB_DOC_KIND live terminology only carries {paper, playbook, guide} as of
    CASE-346 seed; docs/design/* falls under `guide` for v1. If APP-KB later
    adds `design_decision` or `fireside_paper` terms, this dispatch can grow.
    """
    try:
        rel = path.resolve().relative_to(DEV_ROOT)
    except ValueError:
        return None
    parts = rel.parts
    if len(parts) < 3:
        return None
    repo_origin = parts[0]
    sub = parts[1]
    if sub == "papers":
        kind = "paper"
    elif sub == "docs":
        if len(parts) >= 4 and parts[2] == "playbooks":
            kind = "playbook"
        else:
            kind = "guide"
    else:
        return None
    return repo_origin, str(rel), kind


# -------------------------------------------------------------- doc builders

def build_case_doc(
    path: Path,
    text: str,
    fm: dict[str, str],
    *,
    template_id: str,
    loader: str,
) -> dict:
    """Build a CASE_RECORD doc. Caller passes the resolved template_id and
    a loader identifier (e.g. 'add-to-kb.py') for audit context."""
    fname = path.name
    m = re.match(r"CASE-(\d+)-([a-z]+)-(.+)\.md", fname)
    case_num = int(m.group(1)) if m else 0
    case_status = m.group(2) if m else fm.get("status", "unknown")
    slug = m.group(3).replace("-", " ") if m else fname
    filed_by = fm.get("filed_by", "unknown")
    return {
        "template_id": template_id,
        "namespace": NAMESPACE,
        "created_by": loader,
        "data": {
            "title": f"CASE-{case_num}: {slug}",
            "body": text,
            # case_number is the platform-declared identity field per CASE-318.
            # Top-level data; identity_hash is derived from this.
            "case_number": case_num,
            "authored_by": filed_by,
            "doc_status": "published",
            "tags": ["case-mirror", f"status-{case_status}"],
            "root": True,
            "source_yac": filed_by,
            "target_yac": normalize_target(fm.get("target")),
            # CASE-404 schema-extension fields (status / severity / type /
            # component / filed_by / app surfaced as queryable data.* — see
            # PoNIF #2 corollary for the safe-update mechanism).
            "status": case_status,
            "severity": fm.get("severity", ""),
            "type": fm.get("type", ""),
            "component": fm.get("component", ""),
            "filed_by": filed_by,
            "app": normalize_app(fm.get("app", "")),
        },
        # metadata.custom: audit/loader context ONLY. Post-CASE-407 the
        # type/severity/component/case_status duplicates here were removed
        # (those fields live in data.* per CASE-404; keeping them here was
        # the pre-CASE-404 workaround that violated
        # feedback_metadata_is_not_a_workaround).
        "metadata": {
            "flat_file_mirror": f"yac-discussions/{fname}",
            "filed_at": fm.get("filed", ""),
            "implemented_at": fm.get("implemented", ""),
            "related": fm.get("related", ""),
            "loader": loader,
        },
        # CASE-425/437 v2: register CASE-<n> as a Registry synonym — the human
        # handle + uniqueness carrier once identity moves off case_number to the
        # document_id (UUID). Forward-compatible under v1 (it just also registers
        # the synonym; self-claim on re-mirror is a no-op, CASE-427). The synonym
        # claim is atomic + fails loudly on a real cross-case collision (CASE-436).
        "synonyms": [{"value": f"CASE-{case_num}"}] if case_num else [],
    }


def build_document_doc(
    path: Path,
    text: str,
    fm: dict[str, str],
    *,
    template_id: str,
    loader: str,
) -> dict | None:
    """Build a DOCUMENT record per CASE-346. Identity is data.path (repo-relative).
    Body has YAML frontmatter stripped if present.
    Returns None if the path doesn't match a DOCUMENT pattern."""
    meta = detect_document_meta(path)
    if meta is None:
        return None
    repo_origin, repo_relative_path, kind = meta

    # Title: frontmatter `title:` wins; else first H1; else filename stem.
    title = fm.get("title", "").strip()
    if not title:
        h1 = re.search(r"^#\s+(.+)$", text, re.MULTILINE)
        title = h1.group(1).strip() if h1 else path.stem

    # Body: strip frontmatter if present.
    _, body_after_frontmatter = parse_frontmatter(text)
    body = body_after_frontmatter if body_after_frontmatter.strip() else text

    data: dict = {
        "path": repo_relative_path,
        "repo_origin": repo_origin,
        "title": title,
        "body": body,
        "kind": kind,
        "doc_status": "published",
    }
    if fm.get("authored_by"):
        data["authored_by"] = fm["authored_by"]
    if fm.get("tags"):
        # Frontmatter tags may be a comma-separated list. Trim + drop empties.
        tags = [t.strip() for t in fm["tags"].split(",") if t.strip()]
        if tags:
            data["tags"] = tags

    return {
        "template_id": template_id,
        "namespace": NAMESPACE,
        "created_by": loader,
        "data": data,
        # metadata.custom: kind is a useful audit trace (which doc-classification
        # the loader chose at write time). All other fields here are pure audit.
        "metadata": {
            "flat_file_mirror": repo_relative_path,
            "kind": kind,
            "loader": loader,
        },
    }


# Editor-backup filename patterns the SESSION body-composition step
# skips (CASE-389 §E). Tightened to avoid eating legitimate files; if a
# new pattern shows up in practice, add it here.
EDITOR_BACKUP_RE = re.compile(r"(\.bak$|\.orig$|~$|^\.#|^#.*#$|\.sw[op]$)")


def _normalize_iso_dt(s: str) -> str:
    """Coerce an agent-supplied datetime to the form WIP's validator accepts: NAIVE.

    Empirically (CASE-389 live test, 2026-05-24): WIP's SESSION datetime validator
    accepts a naive ISO 8601 datetime (e.g. ``2026-05-24T14:27:03``) but rejects
    ANY UTC offset — basic (``+0200``) AND extended (``+02:00``). Session IDs are
    local-naive wall-clock anyway, so strip the offset (keeping the wall-clock
    time) and emit a naive isoformat. Agents improvise the frontmatter format, so
    normalize here instead of trusting it verbatim. Unparseable input passes
    through so the platform still rejects genuinely-malformed values loudly.
    """
    from datetime import datetime

    s = (s or "").strip()
    if not s:
        return s
    try:
        return datetime.fromisoformat(s).replace(tzinfo=None).isoformat()
    except ValueError:
        # Defensive: strip a trailing offset (basic/extended) or Z if the parser choked.
        return re.sub(r"([+-]\d{2}:?\d{2}|Z)$", "", s)


def build_session_doc(
    path: Path,
    text: str,
    fm: dict[str, str],
    *,
    template_id: str,
    loader: str,
) -> dict | None:
    """Build a SESSION doc (CASE-389). `path` is the session.md inside
    reports/<session-id>/; the body is composed from every *.md sibling
    in that directory (session.md first, then alphabetical), each prefixed
    with `## <filename>` per §E. Editor backups are filtered.

    Returns None if the path doesn't sit under reports/<id>/ — caller
    treats that as "not a SESSION" and falls back to other dispatch arms.
    """
    session_dir = path.parent
    if session_dir.parent.name != "reports" or path.name != "session.md":
        return None
    session_id = session_dir.name  # the reports/<id>/ directory name

    # Determine role from the id's prefix (BE-YAC-... / APP-RC-... / etc.).
    # Falls back to frontmatter `role:` if the id doesn't follow the convention.
    role = fm.get("role", "")
    if not role:
        m = re.match(r"([A-Z][A-Z-]+?)-\d{8}", session_id)
        if m:
            role = m.group(1)

    # Compose body: session.md first, then siblings alphabetically.
    files = [p for p in sorted(session_dir.glob("*.md"))
             if not EDITOR_BACKUP_RE.search(p.name)]
    if path in files:
        files = [path] + [p for p in files if p != path]
    body_parts: list[str] = []
    for p in files:
        try:
            content = p.read_text()
        except OSError as e:
            content = f"_(could not read {p.name}: {e})_"
        body_parts.append(f"## {p.name}\n\n{content}")
    body = "\n\n".join(body_parts)

    # started_at derived from session_id's YYYYMMDD-HHMMSS suffix; fall back
    # to frontmatter or empty string.
    started_at = fm.get("started_at", "")
    if not started_at:
        m = re.search(r"(\d{8})-(\d{4,6})$", session_id)
        if m:
            d, t = m.group(1), m.group(2)
            tt = t.ljust(6, "0")  # pad HHMM → HHMM00
            started_at = (
                f"{d[:4]}-{d[4:6]}-{d[6:8]}T{tt[:2]}:{tt[2:4]}:{tt[4:6]}"
            )

    data = {
        "session_id": session_id,
        "role": role,
        "started_at": _normalize_iso_dt(started_at),
        "status": fm.get("status", "active"),
        "body": body,
    }
    if fm.get("continues_from"):
        data["continues_from"] = fm["continues_from"].strip()
    if fm.get("ended_at"):
        data["ended_at"] = _normalize_iso_dt(fm["ended_at"])

    return {
        "template_id": template_id,
        "namespace": NAMESPACE,
        "created_by": loader,
        "data": data,
        "metadata": {
            "flat_file_mirror": f"reports/{session_id}/session.md",
            "loader": loader,
        },
    }


def build_journey_doc(
    path: Path,
    text: str,
    fm: dict[str, str],
    *,
    template_id: str,
    loader: str,
) -> dict | None:
    fname = path.name
    day_num = parse_day_number(fname)
    if day_num is None:
        return None
    title_num = day_num if day_num != int(day_num) else int(day_num)
    title = f"Day {title_num}"
    tm = re.search(r"^#[^\n]*?Day\s+\S+:\s*(.+)$", text, re.MULTILINE)
    if tm:
        title = f"Day {title_num}: {tm.group(1).strip()}"
    return {
        "template_id": template_id,
        "namespace": NAMESPACE,
        "created_by": loader,
        "data": {
            # title is the platform-declared identity field per CASE-310 +
            # CASE-318. Day-N prefix convention guarantees uniqueness.
            "title": title,
            "body": text,
            "authored_by": "FRanC",
            "doc_status": "published",
            "tags": ["journey-mirror", f"day-{day_num}"],
            "root": True,
            "journey_date": parse_journal_date(text, day_num),
            "day_number": day_num,
        },
        # metadata.custom: audit/loader context only.
        "metadata": {
            "flat_file_mirror": f"dayJournals/{fname}",
            "loader": loader,
        },
    }
