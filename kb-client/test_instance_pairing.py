#!/usr/bin/env python3
"""Offline regression tests for instance resolution: the URL and the key come
from one source as a pair (CASE-950).

A key file set in the environment used to be paired with .claude/kb.json's URL
(the canonical instance), and a URL set in the environment with kb.json's key,
so a call meant for one instance reached another, or carried another
instance's key. Both layers enforce the pairing: the kb-client.sh wrapper and
kb_client_core (for direct `python kb-write.py` runs). Each case runs in a
subprocess from a temporary directory with a scrubbed environment.

The wrapper's good paths point at an unreachable local port, so its
"cannot reach manifest at <url>" line shows which instance it chose. No call
leaves the machine.

Run: `python3 kb-client/test_instance_pairing.py`.
"""
import json
import os
import subprocess
import tempfile

_here = os.path.dirname(os.path.abspath(__file__))
_fails = []

ENV_URL = "https://127.0.0.1:9"          # refuses connections immediately
KBJ_URL = "https://127.0.0.2:9"
tmp = tempfile.mkdtemp()
key = os.path.join(tmp, "key")
with open(key, "w") as f:
    f.write("not-a-real-key")


def check(name, got, want):
    if got != want:
        _fails.append(f"{name}: got {got!r}, want {want!r}")


def project(kbjson):
    """A project dir holding .claude/kb.json (None = no kb.json)."""
    d = tempfile.mkdtemp(dir=tmp)
    if kbjson is not None:
        os.makedirs(os.path.join(d, ".claude"))
        with open(os.path.join(d, ".claude", "kb.json"), "w") as f:
            f.write(kbjson if isinstance(kbjson, str) else json.dumps(kbjson))
    return d


def env(**extra):
    e = {k: v for k, v in os.environ.items()
         if not k.startswith("KB_") and k != "CLAUDE_PROJECT_DIR"}
    e["KB_CLIENT_CACHE"] = os.path.join(tmp, "cache")
    e["KBC_BIN_DIR"] = os.path.join(tmp, "bin")
    e.update(extra)
    return e


def core(cwd, **extra):
    """(exit code, 'url|key' or stderr) from importing kb_client_core."""
    r = subprocess.run(
        ["python3", "-c", "import kb_client_core as c; print(f'{c.REMOTE_URL}|{c.REMOTE_KEY}')"],
        cwd=cwd, env=env(PYTHONPATH=_here, **extra), capture_output=True, text=True)
    return r.returncode, (r.stdout.strip() if r.returncode == 0 else r.stderr)


def wrapper(cwd, **extra):
    r = subprocess.run(["bash", os.path.join(_here, "kb-client.sh"), "case-fetch.py"],
                       cwd=cwd, env=env(**extra), capture_output=True, text=True, timeout=60)
    return r.returncode, r.stderr


full = project({"kb_app_url": KBJ_URL, "kb_api_key_file": key})
nokey = project({"kb_app_url": KBJ_URL})
empty = project("{}")
none = project(None)

# --- core ---------------------------------------------------------------
check("core.kbjson", core(full), (0, f"{KBJ_URL}|{key}"))
check("core.no_kbjson", core(none), (0, "https://kb.internal|None"))
rc, out = core(nokey)
check("core.kbjson_without_key.rc", rc, 2)
check("core.kbjson_without_key.msg", "does not name both" in out, True)
check("core.kbjson_empty.rc", core(empty)[0], 2)
rc, out = core(full, KB_API_KEY_FILE=key)
check("core.env_key_only.rc", rc, 2)
check("core.env_key_only.msg", "KB_APP_URL is not" in out, True)
rc, out = core(full, KB_APP_URL=ENV_URL)
check("core.env_url_only.rc", rc, 2)
check("core.env_url_only.msg", "KB_API_KEY_FILE is not set" in out, True)
check("core.env_key_only.no_kbjson.rc", core(none, KB_API_KEY_FILE=key)[0], 2)
check("core.env_pair", core(full, KB_APP_URL=ENV_URL, KB_API_KEY_FILE=key), (0, f"{ENV_URL}|{key}"))
check("core.env_base_url_alias", core(full, KB_BASE_URL=ENV_URL, KB_API_KEY_FILE=key),
      (0, f"{ENV_URL}|{key}"))
check("core.base_and_app_agree",
      core(full, KB_APP_URL=ENV_URL, KB_BASE_URL=ENV_URL, KB_API_KEY_FILE=key)[0], 0)
rc, out = core(full, KB_APP_URL=ENV_URL, KB_BASE_URL=KBJ_URL, KB_API_KEY_FILE=key)
check("core.base_and_app_disagree.rc", rc, 2)
check("core.base_and_app_disagree.msg", "disagree" in out, True)
# The project dir's kb.json governs over the cwd's, as in the wrapper.
check("core.claude_project_dir", core(none, CLAUDE_PROJECT_DIR=full), (0, f"{KBJ_URL}|{key}"))

# --- wrapper ------------------------------------------------------------
rc, err = wrapper(full)
check("wrapper.kbjson.rc", rc, 2)
check("wrapper.kbjson.target", f"cannot reach manifest at {KBJ_URL}" in err, True)
rc, err = wrapper(none)
check("wrapper.no_kbjson_no_key.rc", rc, 2)
check("wrapper.no_kbjson_no_key.msg", "no KB API key file configured" in err, True)
rc, err = wrapper(nokey)
check("wrapper.kbjson_without_key.msg", "does not name both" in err, True)
rc, err = wrapper(full, KB_API_KEY_FILE=key)
check("wrapper.env_key_only.msg", "KB_APP_URL is not" in err, True)
check("wrapper.env_key_only.no_call", "cannot reach manifest" in err, False)
rc, err = wrapper(full, KB_APP_URL=ENV_URL)
check("wrapper.env_url_only.msg", "KB_API_KEY_FILE is not set" in err, True)
check("wrapper.env_url_only.no_call", "cannot reach manifest" in err, False)
rc, err = wrapper(full, KB_APP_URL=ENV_URL, KB_API_KEY_FILE=key)
check("wrapper.env_pair.announced", f"target {ENV_URL} (from the environment)" in err, True)
check("wrapper.env_pair.target", f"cannot reach manifest at {ENV_URL}" in err, True)
rc, err = wrapper(full, KB_BASE_URL=ENV_URL, KB_API_KEY_FILE=key)
check("wrapper.env_base_url_alias.target", f"cannot reach manifest at {ENV_URL}" in err, True)
rc, err = wrapper(full, KB_APP_URL=ENV_URL, KB_BASE_URL=KBJ_URL, KB_API_KEY_FILE=key)
check("wrapper.base_and_app_disagree.msg", "disagree" in err, True)
check("wrapper.base_and_app_disagree.no_call", "cannot reach manifest" in err, False)

# --- install.sh (the curl | sh bootstrap) --------------------------------
def install(cwd, **extra):
    r = subprocess.run(["sh", os.path.join(_here, "install.sh")], cwd=cwd, env=env(**extra),
                       capture_output=True, text=True, timeout=60)
    return r.returncode, r.stderr


rc, err = install(full, KB_API_KEY_FILE=key)
check("install.env_key_only.rc", rc, 2)
check("install.env_key_only.msg", "together" in err, True)
rc, err = install(none, KB_APP_URL=ENV_URL)
check("install.env_url_only.rc", rc, 2)
rc, err = install(nokey)
check("install.kbjson_without_key.msg", "does not name both" in err, True)
rc, err = install(full, KB_APP_URL=ENV_URL, KB_API_KEY_FILE=key)
check("install.env_pair.target", ENV_URL in err and KBJ_URL not in err, True)

if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print("OK — URL and key resolve as one pair in both layers")
