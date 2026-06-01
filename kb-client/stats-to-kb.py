#!/usr/bin/env python3
"""
stats-to-kb.py — write per-day GIT_STATS_SNAPSHOT records to wip-kb.

Closes CASE-412. The GIT_STATS_SNAPSHOT template was seeded at kb
bootstrap (identity_fields=["snapshot_date","repo"]) but no writer
existed. This script is the writer.

Architecture:
- /stats slash-command stays a presentation surface (renders a table
  for day reports); this script is the discipline-callable writer.
- Identity is (snapshot_date, repo) so re-runs are idempotent — the
  platform's identity-hash dedup skips byte-identical writes and
  patches changed ones in place.

Usage:
    stats-to-kb.py --date 2026-05-23 --repo World-in-a-Pie
    stats-to-kb.py --date 2026-05-23 --all          # all known repos
    stats-to-kb.py --backfill 7                     # last 7 days, all repos
    stats-to-kb.py --backfill 7 --repo FR-YAC       # last 7 days, one repo

Env vars (mirror add-to-kb.py):
    KB_LOCAL_BASE_URL    default https://localhost:8443
    KB_LOCAL_KEY_FILE    default ~/.wip-deploy/wip-dev-local/secrets/api-key
    KB_REMOTE_BASE_URL   default https://wip-kb.local
    KB_REMOTE_KEY_FILE   default ~/.wip-deploy/wip-kb/secrets/api-key
    KB_NAMESPACE         default kb
"""
import argparse
import json
import os
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path


# Canonical repo name → filesystem path. Names use the same canonical form as
# kb_write_core.APP_ALIASES where they overlap (e.g. "KB" not "wip-kb") so
# joins between GIT_STATS_SNAPSHOT.repo and CASE_RECORD.data.app work.
REPOS: dict[str, Path] = {
    "World-in-a-Pie": Path("/Users/peter/Development/World-in-a-Pie"),
    "FR-YAC":         Path("/Users/peter/Development/FR-YAC"),
    "KB":             Path("/Users/peter/Development/WIP-KB"),
    "ClinTrial":      Path("/Users/peter/Development/WIP-ClinTrial"),
    "DnD":            Path("/Users/peter/Development/WIP-DnD"),
    "AuthorAssist":   Path("/Users/peter/Development/WIP-AA"),
}


NAMESPACE = os.environ.get("KB_NAMESPACE", "kb")


@dataclass
class Target:
    name: str
    base_url: str
    key_file: Path


LOCAL_TARGET = Target(
    name="local",
    base_url=os.environ.get("KB_LOCAL_BASE_URL", "https://localhost:8443").rstrip("/"),
    key_file=Path(os.environ.get(
        "KB_LOCAL_KEY_FILE",
        "/Users/peter/.wip-deploy/wip-dev-local/secrets/api-key",
    )),
)
REMOTE_TARGET = Target(
    name="remote",
    base_url=os.environ.get("KB_REMOTE_BASE_URL", "https://wip-kb.local").rstrip("/"),
    key_file=Path(os.environ.get(
        "KB_REMOTE_KEY_FILE",
        "/Users/peter/.wip-deploy/wip-kb/secrets/api-key",
    )),
)
TARGETS: list[Target] = [LOCAL_TARGET, REMOTE_TARGET]


ssl_ctx = ssl.create_default_context()
ssl_ctx.check_hostname = False
ssl_ctx.verify_mode = ssl.CERT_NONE


# ---------------------------------------------------------------- git plumbing

@dataclass
class DayStats:
    commits: int
    lines_added: int
    lines_removed: int
    files_changed: int
    contributors: int


def gather_stats(repo_path: Path, snapshot_date: date) -> DayStats | None:
    """Run git commands inside repo_path to compute per-day stats.
    Returns None if repo_path isn't a git repo. Returns a zero-filled
    DayStats if the repo exists but had no commits that day."""
    if not (repo_path / ".git").exists():
        return None

    # Explicit 00:00:00 — git's --since=YYYY-MM-DD without a time interprets
    # the date "AT THE CURRENT TIME OF DAY," silently excluding earlier-today
    # commits. Always pass full ISO datetimes.
    since = f"{snapshot_date.isoformat()} 00:00:00"
    until = f"{(snapshot_date + timedelta(days=1)).isoformat()} 00:00:00"

    # --shortstat gives summary lines like "3 files changed, 47 insertions(+), 12 deletions(-)"
    # interleaved with commit headers. --pretty=format:%H one per commit.
    out = subprocess.run(
        ["git", "log", f"--since={since}", f"--until={until}",
         "--shortstat", "--no-merges", "--pretty=format:%H"],
        cwd=repo_path, capture_output=True, text=True, check=False,
    )
    if out.returncode != 0:
        # empty repo, broken HEAD, etc. — treat as no-activity rather than fatal
        return DayStats(0, 0, 0, 0, 0)

    commits = 0
    added = removed = files = 0
    for line in out.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        if len(line) == 40 and all(c in "0123456789abcdef" for c in line):
            commits += 1
            continue
        # Summary line: parse files/insertions/deletions tokens.
        # Format examples:
        #   " 3 files changed, 47 insertions(+), 12 deletions(-)"
        #   " 1 file changed, 5 insertions(+)"
        #   " 2 files changed, 8 deletions(-)"
        tokens = line.split(",")
        for tok in tokens:
            tok = tok.strip()
            parts = tok.split()
            if not parts:
                continue
            try:
                n = int(parts[0])
            except ValueError:
                continue
            if "file" in tok:
                files += n
            elif "insertion" in tok:
                added += n
            elif "deletion" in tok:
                removed += n

    # Contributors: shortlog count
    sl = subprocess.run(
        ["git", "shortlog", "-sn", f"--since={since}", f"--until={until}", "--no-merges", "HEAD"],
        cwd=repo_path, capture_output=True, text=True, check=False,
    )
    contributors = len([ln for ln in sl.stdout.splitlines() if ln.strip()]) if sl.returncode == 0 else 0

    return DayStats(commits, added, removed, files, contributors)


# ------------------------------------------------------------------ http + kb

def _http(method: str, target: Target, path: str, body: object | None = None) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    headers = {"X-API-Key": target.key_file.read_text().strip()}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(
        f"{target.base_url}{path}", data=data, headers=headers, method=method,
    )
    try:
        with urllib.request.urlopen(req, context=ssl_ctx, timeout=15) as resp:
            return resp.status, json.loads(resp.read() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or "{}")
        except Exception:
            return e.code, {}


# Per-target template UUID cache. Resolved on first need; reused for the run.
_template_id_cache: dict[str, str] = {}


def resolve_template_id(target: Target) -> str:
    cache_key = f"{target.name}:GIT_STATS_SNAPSHOT"
    if cache_key in _template_id_cache:
        return _template_id_cache[cache_key]
    status, body = _http(
        "GET", target,
        f"/api/template-store/templates/by-value/GIT_STATS_SNAPSHOT?namespace={NAMESPACE}",
    )
    if status != 200 or not body.get("template_id"):
        raise RuntimeError(
            f"cannot resolve GIT_STATS_SNAPSHOT template on {target.name} "
            f"(HTTP {status}). Was the kb namespace seeded?"
        )
    _template_id_cache[cache_key] = body["template_id"]
    return body["template_id"]


def build_git_stats_doc(target: Target, repo_name: str, snapshot_date: date,
                        stats: DayStats) -> dict:
    return {
        "template_id": resolve_template_id(target),
        "namespace": NAMESPACE,
        "created_by": "stats-to-kb.py",
        "data": {
            "title": f"{repo_name} — {snapshot_date.isoformat()}",
            "authored_by": "FRanC",
            "doc_status": "published",
            "tags": ["git-stats", f"repo-{repo_name}", f"date-{snapshot_date.isoformat()}"],
            "root": False,
            "snapshot_date": snapshot_date.isoformat(),
            "repo": repo_name,
            "commits": stats.commits,
            "lines_added": stats.lines_added,
            "lines_removed": stats.lines_removed,
            "files_changed": stats.files_changed,
            "contributors": stats.contributors,
        },
        "metadata": {
            "loader": "stats-to-kb.py",
        },
    }


def post_doc(target: Target, doc: dict) -> str:
    status, payload = _http("POST", target, "/api/document-store/documents", [doc])
    if status >= 400:
        raise RuntimeError(f"HTTP {status}: {str(payload)[:300]}")
    results = payload.get("results") or (payload if isinstance(payload, list) else [])
    if not results:
        raise RuntimeError(f"empty results from POST to {target.name}")
    r = results[0]
    if r.get("error"):
        raise RuntimeError(f"bulk POST item error from {target.name}: {r.get('error')}")
    return r.get("status", "?")


def write_snapshot(repo_name: str, repo_path: Path, snapshot_date: date) -> int:
    """Compute + dual-write one (repo, date) snapshot. Return 0 if at least
    one target succeeded; 1 if repo isn't git; 2 if both targets failed."""
    stats = gather_stats(repo_path, snapshot_date)
    if stats is None:
        print(f"[skip] {repo_name}: not a git repo at {repo_path}", file=sys.stderr)
        return 1

    successes: list[tuple[str, str]] = []
    failures: list[tuple[str, str]] = []
    for target in TARGETS:
        try:
            doc = build_git_stats_doc(target, repo_name, snapshot_date, stats)
            result = post_doc(target, doc)
            successes.append((target.name, result))
        except RuntimeError as e:
            failures.append((target.name, str(e)))
            print(f"[{target.name}] FAILED: {e}", file=sys.stderr)

    if successes:
        verbs = " / ".join(f"{n}:{r}" for n, r in successes)
        print(
            f"[stats-to-kb] {repo_name} {snapshot_date.isoformat()}: "
            f"commits={stats.commits} +{stats.lines_added}/-{stats.lines_removed} "
            f"files={stats.files_changed} contrib={stats.contributors} → {verbs}",
            file=sys.stderr,
        )
    if not successes:
        return 2
    return 0


# ---------------------------------------------------------------- CLI

def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--date", help="YYYY-MM-DD (default: today)")
    ap.add_argument("--repo", help="canonical repo name (default with --all: every known repo)")
    ap.add_argument("--all", action="store_true", help="snapshot every known repo for the date")
    ap.add_argument("--backfill", type=int, metavar="N",
                    help="snapshot the last N days (today minus 0..N-1) for the chosen repo(s)")
    ap.add_argument("--list-repos", action="store_true", help="print the known repo set and exit")
    args = ap.parse_args()

    if args.list_repos:
        for name, path in REPOS.items():
            marker = "✓" if (path / ".git").exists() else "✗"
            print(f"  {marker} {name:18}  {path}")
        return

    # Pick the date(s)
    if args.backfill:
        today = date.today()
        dates = [today - timedelta(days=i) for i in range(args.backfill)]
    else:
        if args.date:
            try:
                target_date = date.fromisoformat(args.date)
            except ValueError:
                print(f"ERROR: --date must be YYYY-MM-DD (got {args.date!r})", file=sys.stderr)
                sys.exit(2)
        else:
            target_date = date.today()
        dates = [target_date]

    # Pick the repo(s)
    if args.all or args.backfill:
        repos = list(REPOS.items())
    elif args.repo:
        if args.repo not in REPOS:
            print(f"ERROR: unknown repo {args.repo!r}. Known: {', '.join(REPOS)}",
                  file=sys.stderr)
            sys.exit(2)
        repos = [(args.repo, REPOS[args.repo])]
    else:
        print("ERROR: pass --repo NAME, --all, or --backfill N", file=sys.stderr)
        sys.exit(2)

    failures = 0
    for d in dates:
        for name, path in repos:
            rc = write_snapshot(name, path, d)
            if rc == 2:
                failures += 1

    sys.exit(0 if failures == 0 else 2)


if __name__ == "__main__":
    main()
