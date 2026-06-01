"""kb-client schema handshake (CASE-437).

The no-skew guarantee made concrete: a client MUST call verify_schema() against
the instance it is about to write to and refuse on mismatch. A stale client
(fetched from an earlier deploy) carries an old schema_version and will not write
against an instance whose schema has moved — it must re-fetch from the instance.

The served bundle and the running app ship together, so the manifest.json bundled
with a client *is* that instance's schema_version at download time; this just
re-checks it at write time in case the instance was redeployed since.

Wired into the entry scripts in CASE-437 Phase 2 (the v2 cutover).
"""
from __future__ import annotations

import json
import ssl
import urllib.request
from pathlib import Path


def local_schema_version() -> str | None:
    return json.loads((Path(__file__).parent / "manifest.json").read_text()).get("schema_version")


def instance_schema_version(base_url: str, api_key: str = "", verify_tls: bool = False,
                            base_path: str = "") -> str | None:
    ctx = None
    if not verify_tls:
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
    url = f"{base_url}{base_path}/server-api/kb-client/manifest"
    req = urllib.request.Request(url, headers={"X-API-Key": api_key} if api_key else {})
    with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
        return json.loads(r.read()).get("schema_version")


def verify_schema(base_url: str, api_key: str = "", verify_tls: bool = False,
                  base_path: str = "") -> str:
    """Raise SystemExit if the local client's schema_version != the instance's."""
    local = local_schema_version()
    remote = instance_schema_version(base_url, api_key, verify_tls, base_path)
    if local != remote:
        raise SystemExit(
            f"kb-client schema mismatch: client={local} instance={remote}. "
            f"Re-fetch the client from {base_url}{base_path}/server-api/kb-client/download"
        )
    return local
