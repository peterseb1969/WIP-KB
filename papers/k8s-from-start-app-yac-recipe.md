---
title: "k8s-from-start — APP-YAC integration recipe (superseded)"
kind: paper
superseded_by: FR-YAC/papers/wip-deployable-app-contract.md
---

# k8s-from-start (superseded)

This paper has been superseded by [`FR-YAC/papers/wip-deployable-app-contract.md`](../../FR-YAC/papers/wip-deployable-app-contract.md) (2026-05-14, CASE-379 synthesis pass).

**Why the rename.** The original framing ("k8s-from-start") was retrofit-driven and implied k8s as the relevant target. The contract it described is actually deployment-target-agnostic — compose installs and apps-only installs satisfy the same contract. Title and scope generalized to reflect that.

**What changed in the new version.**
- Reframed top: "what makes an app wip-deployable" instead of "how to be k8s-ready from day 1".
- Added a "what breaks when you skip step N" annex with concrete failure-mode signatures from the 2026-05-14 cross-host validation arc (CASE-375 / CASE-377 / CASE-378).
- Added a "platform invariants you can rely on" section naming the CASE-374 / CASE-377 / CASE-378 guarantees apps now count on.
- Updated scaffold-gaps table with today's findings (proxy port, `server.host: '0.0.0.0'`).
- Forward-pointer to CASE-373's bootstrap-bundle UX as the layer above this contract.

**KB-YAC:** safe to delete this stub once the SUPERSEDES edge has propagated in kb and any in-flight links to the old path have been audited. The original paper's content lives in git history (`WIP-KB/papers/k8s-from-start-app-yac-recipe.md` at commit `7e18551`) if any specific section needs to be referenced later.

**Anyone landing here from an old link:** read [the new paper](../../FR-YAC/papers/wip-deployable-app-contract.md).
