# Browser tests

Playwright tests that drive the KB app in a real browser, through the gateway's
login, against an installed instance. They **only read**: nothing is written to
WIP, so any rung of the ladder (sandbox, dev-test, prod-test, canonical) is safe
to point them at.

```bash
npm run test:e2e                         # the localhost sandbox
KB_E2E_URL=https://kb.dev-test.internal/ \
KB_E2E_PASSWORD_FILE=~/.wip-deploy/dev-test/secrets/dex-password-e2e \
  npm run test:e2e                       # another instance, once it has an e2e user
```

The KB is served at the root of its own origin, `https://kb.<hostname>/` — for
the sandbox `https://kb.wip.localhost:8443/`, the default. Nothing answers under
`/apps/kb/` any more, on either origin. An app origin needs a hostname with a dot,
so the sandbox is installed as `wip.localhost`, not `localhost`.
Logging in bounces through WIP's own origin and back; the login step waits until
the browser is back under `KB_E2E_URL`.

The e2e user exists on the sandbox (`~/.wip-deploy/default`) and on dev-test
(`~/.wip-deploy/dev-test`). On an instance where the app sees a single corpus,
the three corpus tests skip.

| Variable | Default | Meaning |
|---|---|---|
| `KB_E2E_URL` | `https://kb.wip.localhost:8443/` | The app under test (the sandbox, installed as `wip.localhost` with an origin per app). |
| `KB_E2E_LOGIN` | `e2e@wip.local` | The Dex user to log in as. |
| `KB_E2E_PASSWORD_FILE` | `~/.wip-deploy/default/secrets/dex-password-e2e` | File holding that user's password. |
| `KB_E2E_CHANNEL` | `chrome` | Browser. `chrome` uses the installed Google Chrome; elsewhere run `npx playwright install chromium` and set `chromium`. |

The login user is a dedicated one, never `admin` or `editor`. An install that
lacks it gets one from its owner:
`wip-deploy user add e2e --email e2e@wip.local --group wip-editors --name <install>`.

## What is covered

- **smoke** — health, app-config and the WIP proxy answer; an unknown API route
  is a JSON 404; home, search, client and settings load with no failed request to
  the app and no console error.
- **doc** — a case (the first `CASE_RECORD` the corpus returns) opens by its
  document ID, its identity strip stays visible when scrolled, a search for words
  of its title lists it, and a search with no hits says so.
- **facets** — the search page's Severity facet lists only `CASE_SEVERITY` terms
  (older spellings are folded into the term they alias), worst first. Skipped on
  a corpus that does not have the vocabulary yet.
- **corpora** — with more than one knowledge base visible to the app: the
  switcher lists them all with the deployment's corpus first and moves between
  them, a deep link into another corpus opens its document, and that document is
  found by its own corpus's search and not by the main corpus's. Skipped when
  only one corpus is visible.

The tests find their documents from the data, so they need no fixtures — but a
corpus with no cases skips the doc tests rather than failing them.

## Not covered

Anything that writes (flag-for-YAC, vocabulary settings, the askBar's runtime key)
and the askBar itself, which needs an Anthropic key and answers
non-deterministically.

They are not part of `npm test` or CI, which run without an instance.
