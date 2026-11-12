#!/usr/bin/env python3
"""Offline test: kb-namespace.py exits 1 when the gateway refuses (403 not allowed,
409 not reserved or already exists) and 2 only on a transport failure. A refusal
used to exit 2, because the check looked for "HTTP 4" in a message that carries
only the gateway's own text.

No network — run: `python3 kb-client/test_namespace_exit.py`.
"""
import argparse
import contextlib
import importlib.util
import io
import os

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("kb_namespace", os.path.join(_here, "kb-namespace.py"))
kn = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kn)

_fails = []


def run(exc):
    def fake_post(*_a, **_k):
        raise exc
    kn.gw_post = fake_post
    with contextlib.redirect_stderr(io.StringIO()):
        return kn.cmd_create(argparse.Namespace(namespace="x", description=None, format="text"))


for name, exc, want in [
    ("403 not allowed", kn.GatewayRefusal("creating a knowledge base needs admin on 'kb'"), 1),
    ("409 not reserved", kn.GatewayRefusal("namespace 'x' is not reserved for the KB app"), 1),
    ("transport failure", RuntimeError("HTTP 502 from https://kb.example: bad gateway"), 2),
]:
    got = run(exc)
    if got != want:
        _fails.append(f"{name}: exit {got}, want {want}")

if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print("OK — a refusal exits 1, a transport failure 2")
