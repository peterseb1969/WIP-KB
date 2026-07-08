#!/usr/bin/env python3
"""Offline regression tests for kb-write.py's parse_frontmatter (CASE-565).

No network, no deps — run: `python3 kb-client/test_parse_frontmatter.py`.
Loads the hyphen-named module by path (can't `import kb-write`).
"""
import importlib.util
import os

_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("kb_write", os.path.join(_here, "kb-write.py"))
kb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(kb)
pf = kb.parse_frontmatter

_fails = []


def check(name, got, want):
    if got != want:
        _fails.append(f"{name}: got {got!r}, want {want!r}")


# 1. CASE-565 repro — multi-line YAML list must survive (was silently None).
fm, body = pf(
    "---\n"
    "slug: document-store-api\n"
    "release: wip-v1\n"
    "source_scope:\n"
    "  - schemas/document-store.json\n"
    "  - components/document-store/src\n"
    "tags:\n"
    "  - document-store\n"
    "  - rest-api\n"
    "---\n"
    "# Body\nprose\n"
)
check("multiline.source_scope", fm.get("source_scope"),
      ["schemas/document-store.json", "components/document-store/src"])
check("multiline.tags", fm.get("tags"), ["document-store", "rest-api"])
check("multiline.scalar", fm.get("slug"), "document-store-api")
check("multiline.body", body, "# Body\nprose")

# 2. Single-line bracket list still works (back-compat).
fm, _ = pf("---\ntags: [a, b, c]\n---\n")
check("bracket.tags", fm.get("tags"), ["a", "b", "c"])

# 3. Bare key with no items → None (pre-CASE-565 behaviour preserved).
fm, _ = pf("---\nroot:\ntitle: Foo\n---\n")
check("empty.root", fm.get("root"), None)
check("empty.title", fm.get("title"), "Foo")

# 4. Scalars / bool / null / int unchanged.
fm, _ = pf("---\ndo_not_edit: true\ncount: 5\nnote: ~\nname: Bar\n---\n")
check("scalar.bool", fm.get("do_not_edit"), True)
check("scalar.int", fm.get("count"), 5)
check("scalar.null", fm.get("note"), None)
check("scalar.str", fm.get("name"), "Bar")

# 5. Multi-line list immediately followed by another list (both flush cleanly).
fm, _ = pf("---\na:\n  - x\nb:\n  - y\n  - z\n---\n")
check("twolists.a", fm.get("a"), ["x"])
check("twolists.b", fm.get("b"), ["y", "z"])

# 6. List then a trailing scalar (flush on scalar key).
fm, _ = pf("---\ntags:\n  - one\nafter: done\n---\n")
check("listthenscalar.tags", fm.get("tags"), ["one"])
check("listthenscalar.after", fm.get("after"), "done")

# 7. CASE-631 repro — quoted scalars store WITHOUT the surrounding quotes.
#    `@`-leading values are not valid bare YAML, so a spec-correct generator
#    MUST quote them; the stored value must still be the unquoted string.
fm, _ = pf('---\ntitle: "@wip/client"\n---\n')
check("quoted.at_double", fm.get("title"), "@wip/client")
fm, _ = pf("---\ntitle: '@wip/client'\n---\n")
check("quoted.at_single", fm.get("title"), "@wip/client")
fm, _ = pf('---\ntitle: "Routing & Ingress (/api + /mcp)"\n---\n')
check("quoted.spaces", fm.get("title"), "Routing & Ingress (/api + /mcp)")

# 8. Quoting short-circuits coercion — a quoted scalar is always a STRING.
fm, _ = pf('---\ncount: "42"\nflag: "true"\nempty: ""\nnote: "~"\n---\n')
check("quoted.int_stays_str", fm.get("count"), "42")
check("quoted.bool_stays_str", fm.get("flag"), "true")
check("quoted.empty_is_str", fm.get("empty"), "")
check("quoted.null_stays_str", fm.get("note"), "~")

# 9. Mismatched / unpaired quotes are left untouched; a lone quote char too.
fm, _ = pf("---\na: \"unbalanced\nb: it's fine\nc: \"\n---\n")
check("quoted.unbalanced", fm.get("a"), '"unbalanced')
check("quoted.inner_apostrophe", fm.get("b"), "it's fine")
check("quoted.lone_quote", fm.get("c"), '"')

# 10. Quoted items inside a single-line bracket list get the same treatment.
fm, _ = pf('---\ntags: ["a", b, "42"]\n---\n')
check("quoted.list_items", fm.get("tags"), ["a", "b", "42"])

if _fails:
    print("FAIL:")
    for f in _fails:
        print("  -", f)
    raise SystemExit(1)
print("OK — all parse_frontmatter cases pass")
