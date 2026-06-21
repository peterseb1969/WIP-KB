#!/usr/bin/env python3
"""
stats-to-kb.py — write per-day GIT_STATS_SNAPSHOT records to the KB.

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

Connection env is resolved by kb_client_core (KB_BASE_URL / KB_API_KEY_FILE from
.claude/kb.json — canonical kb.internal; KB_PREFER_LOCAL for a dev instance):
    KB_DEV_ROOT          default ~/Development (repo roots for REPOS)
"""
import argparse
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, timedelta
from pathlib import Path


from kb_client_core import DEV_ROOT, gw_post

# Canonical repo name → filesystem path (under DEV_ROOT, env: KB_DEV_ROOT).
# Names are the canonical app form (e.g. "KB" not "wip-kb") so joins between
# GIT_STATS_SNAPSHOT.repo and CASE_RECORD.data.app line up.
REPOS: dict[str, Path] = {
    "World-in-a-Pie": DEV_ROOT / "World-in-a-Pie",
    "FR-YAC":         DEV_ROOT / "FR-YAC",
    "KB":             DEV_ROOT / "WIP-KB",
    "ClinTrial":      DEV_ROOT / "WIP-ClinTrial",
    "DnD":            DEV_ROOT / "WIP-DnD",
    "AuthorAssist":   DEV_ROOT / "WIP-AA",
    # CASE-453: the roster lagged the constellation — keep in step with
    # APP_ALIASES canonical names when new apps spawn.
    "Song":           DEV_ROOT / "WIP-Song",
    "Validator":      DEV_ROOT / "WIP-VAL",
    "ReactConsole":   DEV_ROOT / "WIP-ReactConsole",
}


# Computation stays here (git lives on this machine); the WRITE goes through the
# KB gateway verb via core.gw_post. The gateway composes title/tags/shape
# server-side (the CASE-453 roster class).


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

def write_snapshot(repo_name: str, repo_path: Path, snapshot_date: date) -> int:
    """Compute one (repo, date) snapshot and POST it to the gateway verb.
    Return 0 on success; 1 if repo isn't git; 2 on write failure."""
    stats = gather_stats(repo_path, snapshot_date)
    if stats is None:
        print(f"[skip] {repo_name}: not a git repo at {repo_path}", file=sys.stderr)
        return 1
    # Compose the full GIT_STATS_SNAPSHOT record client-side (the roster shape,
    # CASE-453) and persist via the one generic write path (CASE-482 (A) — the
    # gateway no longer composes; it just persists). Natural upsert by
    # [snapshot_date, repo], so re-runs are idempotent.
    date = snapshot_date.isoformat()
    data = {
        "repo": repo_name, "snapshot_date": date,
        "commits": stats.commits, "lines_added": stats.lines_added,
        "lines_removed": stats.lines_removed, "files_changed": stats.files_changed,
        "contributors": stats.contributors,
        "title": f"{repo_name} — {date}", "authored_by": "FRanC",
        "doc_status": "published", "root": False,
        "tags": ["git-stats", f"repo-{repo_name}", f"date-{date}"],
    }
    try:
        result = gw_post("/write/GIT_STATS_SNAPSHOT",
                         {"data": data, "metadata": {"loader": "kb-client"}}).get("result", "?")
    except RuntimeError as e:
        print(f"[gateway] {e}", file=sys.stderr)
        return 2
    print(
        f"[stats-to-kb] {repo_name} {snapshot_date.isoformat()}: "
        f"commits={stats.commits} +{stats.lines_added}/-{stats.lines_removed} "
        f"files={stats.files_changed} contrib={stats.contributors} -> gateway:{result}",
        file=sys.stderr,
    )
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
