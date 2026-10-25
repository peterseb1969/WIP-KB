"""Key-file resolution shared by the one-off tools in this directory.

API key files are per-installation configuration: they are issued when a project
is installed and their names differ between installs, so no tool guesses a path.
A tool takes its key from an explicit environment variable, or, when it runs
against the default sandbox target, from WIP_API_KEY_FILE in the repo's .env
(the local, untracked record of the sandbox key). Anything else exits with a
message instead of sending a wrong key.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


def _sandbox_key_file() -> str | None:
    try:
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("WIP_API_KEY_FILE="):
                return line.split("=", 1)[1].strip() or None
    except OSError:
        pass
    return None


def key_file(env_var: str, target_env_var: str | None = None) -> Path:
    """The key file for this run: $env_var, else the sandbox key from .env when
    the target was left at its sandbox default (target_env_var unset)."""
    val = os.environ.get(env_var)
    if not val and (target_env_var is None or not os.environ.get(target_env_var)):
        val = _sandbox_key_file()
    if not val:
        sys.exit(f"No API key file configured: set {env_var} to the key file issued "
                 f"for the target instance"
                 + (f" ({target_env_var} is overridden, so the sandbox key from .env "
                    f"is not used)" if target_env_var and os.environ.get(target_env_var) else "")
                 + ".")
    return Path(val).expanduser()


def read_key(env_var: str, target_env_var: str | None = None) -> str:
    return key_file(env_var, target_env_var).read_text().strip()
