"""
kb_client_core.py — the shared core for the served KB client bundle.

One module owns everything the command scripts need to talk to the KB gateway:
- instance + API-key resolution from `.claude/kb.json` (CASE-444/471), the single
  source of truth, with the url/key pairing guard;
- target config (canonical "remote" + optional dev "local") resolved once at import;
- the transport layer — `gw_get` / `gw_post` against the KB gateway, with
  local→remote failover for reads.

The Golden Rule for clients (CASE-482): every call goes through the KB **gateway**
API (`{BASE_PATH}/server-api/kb/…`) — the app-specific layer that owns projection,
namespace discipline, and identity. Clients never reach past it into the
document-store backend (the "straight to MongoDB" anti-pattern).

History: this module was `kb_write_core.py` and once held build/parse helpers for
the write loaders (CASE-407). CASE-464 retired the loaders to the gateway verbs;
CASE-482 retired the raw document-store reads and folded the per-script transport
boilerplate in here, and renamed the module to what it actually is — the client
core, not a write core.

Consumed by: case-fetch.py (reads) and kb-write.py (all writes, incl. git-stats).
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

DEV_ROOT = Path(os.environ.get("KB_DEV_ROOT", str(Path.home() / "Development")))


# --- Canonical instance resolution (CASE-444 / CASE-471) --------------------
# Single source of truth: the calling repo's .claude/kb.json. When the env
# doesn't already pin the instance, inject kb_app_url + kb_api_key_file PAIRED
# into the environment — so the reads below and resolve_key_file's
# KB_API_KEY_FILE lookup pick them up exactly like caller-set values (CASE-444's
# url/key guard stays intact). Mirrors the kb-client.sh wrapper; a hostname
# cutover is then one edit to kb.json. No-op when the wrapper already exported
# these, or when run outside a repo with a kb.json.
def _load_kbjson_into_env() -> None:
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

CANONICAL_BASE_URL = "https://kb.internal"   # last-resort fallback (CASE-471 cutover from wip-kb.local)
LOCAL_BASE_URL = "https://localhost:8443"


def default_key_path(profile: str) -> Path:
    """$HOME-derived key path for a wip-deploy profile (e.g. 'kb')."""
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


# --- Target config (resolved once at import) --------------------------------
# REMOTE = the canonical KB instance (kb.json / KB_BASE_URL). LOCAL = an optional
# dev instance, tried first only when KB_PREFER_LOCAL=1.
REMOTE_URL = os.environ.get("KB_BASE_URL") or os.environ.get("KB_APP_URL") or CANONICAL_BASE_URL
REMOTE_KEY = resolve_key_file(REMOTE_URL, CANONICAL_BASE_URL, "kb",
                              "KB_API_KEY_FILE", "KB_KEY_FILE")
LOCAL_URL = os.environ.get("KB_LOCAL_URL", LOCAL_BASE_URL)
LOCAL_KEY = resolve_key_file(LOCAL_URL, LOCAL_BASE_URL, "wip-local",
                             "KB_LOCAL_KEY_FILE")
NAMESPACE = os.environ.get("KB_NAMESPACE", "kb")
GW_BASE_PATH = os.environ.get("KB_APP_BASE_PATH", "/apps/kb")  # KB gateway mount
PREFER_LOCAL = os.environ.get("KB_PREFER_LOCAL") == "1"
VERIFY_TLS = os.environ.get("KB_VERIFY_TLS", "false").lower() == "true"


def _ssl_ctx() -> ssl.SSLContext | None:
    if VERIFY_TLS:
        return None
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    return ctx


def read_key(key_file: Path) -> str:
    return key_file.read_text().strip()


def targets() -> list[tuple[str, str, Path]]:
    """(name, base_url, key_file) in priority order: local first iff
    KB_PREFER_LOCAL=1, then the canonical remote (always last)."""
    out: list[tuple[str, str, Path]] = []
    if PREFER_LOCAL:
        out.append(("local", LOCAL_URL, LOCAL_KEY))
    out.append(("remote", REMOTE_URL, REMOTE_KEY))
    return out


def _gw_url(base_url: str, path: str) -> str:
    # Pin every call to the configured namespace. In prod KB_NAMESPACE is 'kb'
    # (== the gateway default, so a no-op); set it to a dev namespace (e.g.
    # kb-redesign) to point the whole client there. The gateway treats
    # ?namespace as the explicit override.
    sep = "&" if "?" in path else "?"
    path = f"{path}{sep}namespace={urllib.parse.quote(NAMESPACE)}"
    return f"{base_url}{GW_BASE_PATH}/server-api/kb{path}"


def _request(base_url: str, key_file: Path, path: str,
             method: str, body: dict | None) -> dict | None:
    """One gateway HTTP call. Returns parsed JSON (None on 404). Raises
    RuntimeError on transport / non-404 HTTP error (so callers can fail over)."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"X-API-Key": read_key(key_file)}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(_gw_url(base_url, path), data=data,
                                 method=method, headers=headers)
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx(), timeout=20)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        snippet = e.read()[:300].decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {base_url}: {snippet}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"{base_url} unreachable: {e}") from e
    raw = resp.read()
    return json.loads(raw) if raw else {}


def gw_get(path: str) -> dict | None:
    """GET a gateway endpoint (path relative to /server-api/kb, e.g. '/cases/5'),
    with local→remote failover. Returns parsed JSON, or None if the final
    (remote) target reports 404. Raises RuntimeError if every target is
    unreachable / errors."""
    last_error: Exception | None = None
    for name, url, key in targets():
        try:
            return _request(url, key, path, "GET", None)
        except RuntimeError as e:
            last_error = e
            if name != "remote":
                print(f"[kb-client] {name} unreachable, falling through to remote: {e}",
                      file=sys.stderr)
                continue
            raise
    if last_error:
        raise last_error
    return None


def gw_post(path: str, body: dict) -> dict:
    """POST a gateway endpoint. A write lands on ONE authority — the primary
    target (local iff KB_PREFER_LOCAL, else the canonical remote) — with no
    failover, so a write is never double-applied across instances. Raises
    RuntimeError on transport / HTTP error."""
    name, url, key = targets()[0]
    result = _request(url, key, path, "POST", body)
    return result or {}
