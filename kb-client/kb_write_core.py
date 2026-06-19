"""
kb_write_core.py — instance + API-key resolution for the served KB client.

One rule for the whole bundle (CASE-444/471): resolve the target instance from
`.claude/kb.json` (the single source of truth) and the API-key file with a
pairing guard. Consumed by:
- case-fetch.py — case/journal reads
- stats-to-kb.py — git-stats computer (POSTs the /stats/snapshot gateway verb)

History: this module also held the build_*_doc / parse / detect helpers shared by
the write loaders (CASE-407). CASE-464 retired the loaders to the gateway verbs;
the loaders were deleted and those now-dead helpers slimmed out of this file.

Public surface:
- DEV_ROOT            (env: KB_DEV_ROOT, default ~/Development)
- CANONICAL_BASE_URL / LOCAL_BASE_URL
- resolve_key_file(base_url, base_url_default, default_profile, *env_vars) -> Path
- default_key_path(profile) -> Path
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

DEV_ROOT = Path(os.environ.get("KB_DEV_ROOT", str(Path.home() / "Development")))


# --- Canonical instance resolution (CASE-444 / CASE-471) --------------------
# Single source of truth: the calling repo's .claude/kb.json. When the env
# doesn't already pin the instance, inject kb_app_url + kb_api_key_file PAIRED
# into the environment — so the `os.environ.get("KB_BASE_URL", …)` reads below and
# resolve_key_file's `KB_API_KEY_FILE` lookup pick them up exactly like caller-set
# values (CASE-444's url/key guard stays intact). Mirrors the kb-client.sh wrapper;
# a hostname cutover is then one edit to kb.json. No-op when the wrapper already
# exported these, or when run outside a repo with a kb.json.
def _load_kbjson_into_env() -> None:
    import json
    try:
        with open(".claude/kb.json", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return
    if cfg.get("kb_app_url") and not os.environ.get("KB_BASE_URL"):
        os.environ["KB_BASE_URL"] = cfg["kb_app_url"]
    if cfg.get("kb_api_key_file") and not os.environ.get("KB_API_KEY_FILE"):
        os.environ["KB_API_KEY_FILE"] = cfg["kb_api_key_file"]


_load_kbjson_into_env()

CANONICAL_BASE_URL = "https://kb.internal"  # last-resort fallback (was wip-kb.local; CASE-471)
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
