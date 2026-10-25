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
import re
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
    # Optional: the knowledge domain this repo works in (DECISION-1). Becomes the
    # client's namespace exactly as if KB_NAMESPACE had been set; env still wins.
    if cfg.get("namespace") and not os.environ.get("KB_NAMESPACE"):
        os.environ["KB_NAMESPACE"] = cfg["namespace"]
    # Optional: the project (a KB_APP term) this repo is. Writes send it so the
    # gateway tags documents whose type has an `app` field; env still wins.
    if cfg.get("project") and not os.environ.get("KB_PROJECT"):
        os.environ["KB_PROJECT"] = cfg["project"]


_load_kbjson_into_env()

CANONICAL_BASE_URL = "https://kb.internal"   # last-resort fallback (CASE-471 cutover from wip-kb.local)
LOCAL_BASE_URL = "https://localhost:8443"


def resolve_key_file(*env_vars: str) -> Path | None:
    """Resolve the API-key file for a target (CASE-444).

    env_vars are checked in order; first set one wins. KB_KEY_FILE is accepted
    anywhere in the list as a deprecated alias (stderr warning). The key file
    is per-installation configuration (issued when the project is installed),
    so there is no guessed default: None means "not configured", and read_key
    fails loud when that target is actually used.
    """
    for var in env_vars:
        val = os.environ.get(var)
        if val:
            if var == "KB_KEY_FILE":
                print("[kb-client] KB_KEY_FILE is deprecated; use "
                      "KB_API_KEY_FILE (CASE-444)", file=sys.stderr)
            return Path(val).expanduser()
    return None


# --- Target config (resolved once at import) --------------------------------
# REMOTE = the canonical KB instance (kb.json / KB_BASE_URL). LOCAL = an optional
# dev instance, tried first only when KB_PREFER_LOCAL=1.
REMOTE_URL = os.environ.get("KB_BASE_URL") or os.environ.get("KB_APP_URL") or CANONICAL_BASE_URL
REMOTE_KEY = resolve_key_file("KB_API_KEY_FILE", "KB_KEY_FILE")
LOCAL_URL = os.environ.get("KB_LOCAL_URL", LOCAL_BASE_URL)
LOCAL_KEY = resolve_key_file("KB_LOCAL_KEY_FILE")
NAMESPACE = os.environ.get("KB_NAMESPACE", "kb")
# Whether the caller CHOSE that namespace, as opposed to inheriting the default.
# The distinction matters only for cross-namespace endpoints — see _gw_url.
NAMESPACE_EXPLICIT = "KB_NAMESPACE" in os.environ
# The project this repo is (kb.json `project` / KB_PROJECT), or "" for none.
PROJECT = os.environ.get("KB_PROJECT", "").strip()
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


def read_key(key_file: Path | None) -> str:
    if key_file is None:
        raise SystemExit(
            "[kb-client] no KB API key file configured. Set kb_api_key_file in "
            ".claude/kb.json, or KB_API_KEY_FILE (KB_LOCAL_KEY_FILE for the local "
            "instance), to the key file issued when this project was installed.")
    return key_file.read_text().strip()


def targets() -> list[tuple[str, str, Path | None]]:
    """(name, base_url, key_file) in priority order: local first iff
    KB_PREFER_LOCAL=1, then the canonical remote (always last)."""
    out: list[tuple[str, str, Path | None]] = []
    if PREFER_LOCAL:
        out.append(("local", LOCAL_URL, LOCAL_KEY))
    out.append(("remote", REMOTE_URL, REMOTE_KEY))
    return out


# Endpoints whose UNSCOPED behaviour spans every namespace. For these, sending
# `?namespace=kb` is NOT the no-op it is everywhere else — it narrows the answer.
# /types is the discovery manifest: with no param the gateway enumerates the corpus
# AND the library namespace; pinned to kb it silently drops LIBRARY_DOC, so the tool
# that writes a type denies the type exists (CASE-701).
_CROSS_NS_PATHS = frozenset({"/types"})


def _gw_url(base_url: str, path: str) -> str:
    # Pin every call to the configured namespace: set KB_NAMESPACE to a dev
    # namespace (e.g. kb-redesign) to point the whole client there. The gateway
    # treats ?namespace as the explicit override.
    #
    # Two exceptions, so the pin can't narrow an answer the caller didn't ask to
    # narrow:
    #   1. The caller already supplied a namespace in the path — theirs wins, and
    #      appending would send the parameter twice.
    #   2. A cross-namespace endpoint AND KB_NAMESPACE was merely inherited, not
    #      chosen. An explicit KB_NAMESPACE still scopes these (the dev-namespace
    #      workflow keeps working); the bare default no longer does.
    endpoint = path.split("?", 1)[0]
    already_scoped = "namespace=" in path
    inherit_only = endpoint in _CROSS_NS_PATHS and not NAMESPACE_EXPLICIT
    if not already_scoped and not inherit_only:
        sep = "&" if "?" in path else "?"
        path = f"{path}{sep}namespace={urllib.parse.quote(NAMESPACE)}"
    return f"{base_url}{GW_BASE_PATH}/server-api/kb{path}"


def _request(base_url: str, key_file: Path, path: str,
             method: str, body: dict | None, timeout: float = 20) -> dict | None:
    """One gateway HTTP call. Returns parsed JSON, or None when the route is not
    present on this instance. Raises RuntimeError on transport / real HTTP error
    (so callers can fail over).

    "Not present" is TWO shapes, and the second is the common one. A gateway route
    that does not exist is not answered with 404: the Express SPA fallback catches
    the path and serves `index.html` with 200, so the client receives a page of
    HTML where it expected JSON. Parsing that raised an uncaught JSONDecodeError
    and every caller's "unavailable on this instance" branch was unreachable —
    dead code behind a traceback. A client newer than the gateway it is pointed at
    is the normal state during a rollout, so this path has to degrade rather than
    crash."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"X-API-Key": read_key(key_file)}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(_gw_url(base_url, path), data=data,
                                 method=method, headers=headers)
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx(), timeout=timeout)
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None
        snippet = e.read()[:300].decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} from {base_url}: {snippet}") from e
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"{base_url} unreachable: {e}") from e
    raw = resp.read()
    if not raw:
        return {}
    # The SPA fallback answering instead of the gateway. Decided on content-type,
    # not on a parse failure: malformed JSON from a route that DOES exist is a real
    # error and must stay loud, not be flattened into "route missing".
    ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
    if ctype and not (ctype == "application/json" or ctype.endswith("+json")):
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"{base_url} returned unparseable JSON for {path} "
            f"(content-type {ctype or 'unset'}): {raw[:200].decode('utf-8', 'replace')}") from e


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


def gw_get_bytes(path: str, timeout: float = 60) -> tuple[bytes, str | None] | None:
    """GET a gateway endpoint that answers with a file rather than JSON. Returns
    (content, filename from Content-Disposition), or None when the gateway says
    404 or the route is absent (the SPA fallback's HTML page). A JSON body is an
    error envelope, never file content. Same local→remote failover as gw_get."""
    last_error: Exception | None = None
    for name, url, key in targets():
        req = urllib.request.Request(_gw_url(url, path), method="GET",
                                     headers={"X-API-Key": read_key(key)})
        try:
            resp = urllib.request.urlopen(req, context=_ssl_ctx(), timeout=timeout)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            snippet = e.read()[:300].decode("utf-8", errors="replace")
            last_error = RuntimeError(f"HTTP {e.code} from {url}: {snippet}")
        except (urllib.error.URLError, OSError) as e:
            last_error = RuntimeError(f"{url} unreachable: {e}")
        else:
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            if ctype == "text/html":
                return None
            if ctype == "application/json":
                raise RuntimeError(f"{url} answered JSON, not a file: "
                                   f"{resp.read()[:300].decode('utf-8', 'replace')}")
            disp = resp.headers.get("Content-Disposition") or ""
            m = re.search(r'filename="?([^";]+)"?', disp)
            return resp.read(), (m.group(1) if m else None)
        if name != "remote":
            print(f"[kb-client] {name} unreachable, falling through to remote: {last_error}",
                  file=sys.stderr)
    if last_error:
        raise last_error
    return None


def gw_post(path: str, body: dict, timeout: float = 20) -> dict:
    """POST a gateway endpoint. A write lands on ONE authority — the primary
    target (local iff KB_PREFER_LOCAL, else the canonical remote) — with no
    failover, so a write is never double-applied across instances. Raises
    RuntimeError on transport / HTTP error. `timeout` is for the rare long write
    (seeding a whole namespace); everything else keeps the 20s default."""
    name, url, key = targets()[0]
    result = _request(url, key, path, "POST", body, timeout)
    return result or {}


class GatewayRefusal(RuntimeError):
    """The gateway answered and said no (a 4xx with its reason) — the caller's to fix,
    unlike a transport failure."""


def gw_post_bytes(path: str, content: bytes, content_type: str, filename: str,
                  timeout: float = 300) -> dict:
    """POST a file as the raw request body (its name in X-Filename, percent-encoded),
    to the primary target only, like gw_post. Returns the parsed JSON answer.

    Unlike _request, a 404 is not read as "route absent": an upload route answers
    404 for its own reasons (no such project, no profile), and that message is what
    the caller needs. A route that really is absent answers either the SPA's HTML or
    the server's bare {"error": "not_found", "path": …}; both raise as such."""
    _name, url, key = targets()[0]
    req = urllib.request.Request(
        _gw_url(url, path), data=content, method="POST",
        headers={"X-API-Key": read_key(key), "Content-Type": content_type,
                 "X-Filename": urllib.parse.quote(filename, safe="")})
    try:
        resp = urllib.request.urlopen(req, context=_ssl_ctx(), timeout=timeout)
        status, raw, ctype = resp.status, resp.read(), resp.headers.get("Content-Type") or ""
    except urllib.error.HTTPError as e:
        status, raw, ctype = e.code, e.read(), e.headers.get("Content-Type") or ""
    except (urllib.error.URLError, OSError) as e:
        raise RuntimeError(f"{url} unreachable: {e}") from e
    absent = RuntimeError(f"{url} has no {path.split('?', 1)[0]} route — the KB there predates this client")
    if ctype.split(";")[0].strip().lower() != "application/json":
        if status >= 400:
            raise RuntimeError(f"HTTP {status} from {url}: {raw[:300].decode('utf-8', 'replace')}")
        raise absent
    body = json.loads(raw) if raw else {}
    if status == 404 and body.get("error") == "not_found" and "path" in body:
        raise absent
    if 400 <= status < 500:
        raise GatewayRefusal(str(body.get("error") or body))
    if status >= 400:
        raise RuntimeError(f"HTTP {status} from {url}: {body.get('error') or body}")
    return body
