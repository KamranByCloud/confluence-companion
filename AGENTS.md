# AGENTS.md

Orientation for an agent session working in this repository.

## Read these first, in this order

1. **[README.md](README.md)** — always, before changing anything. It is the
   authoritative description of what this server is, how it is installed, how
   credentials are resolved, and which tools it exposes. The installation and
   configuration model is deliberate and is not obvious from the source alone.

2. **`.priv/system.md`** — private working notes on the system: architecture and
   the deliberate split from Atlassian Rovo, authentication and what was
   verified about Atlassian API tokens, the Confluence REST endpoints in use,
   the configuration chain, the CLI, installation and distribution, client
   registration, and the repository's own CI and security setup.

3. **`.priv/functions.md`** — private working notes on the capabilities: the
   append tool, the content formats, what was measured about Confluence's
   handling of Storage format and Atlassian Document Format, and the real
   Confluence pages kept for live testing.

The two `.priv` files carry the reasoning and the measured evidence behind the
decisions in the code. When something looks arbitrary, the answer is usually
there — several choices exist because a measurement contradicted the obvious
assumption. Read them before proposing a redesign.

They are gitignored and may be absent in a fresh clone; the code and the README
stand on their own without them. They stay out of the repository because they
contain the site URL, the cloud ID, account details, and the IDs of real
Confluence pages.

## Rules

- **This repository is public.** Never put the site URL, the cloud ID, account
  addresses, real page IDs, or anything from `.priv/` into a tracked file.
  Tests use `example.atlassian.net` and `user@example.com`.
- **Never commit secrets.** `.env`, `.priv/` and `NOTES.md` are gitignored.
  Keep them that way.
- **Unit tests ship with every implementation**, without being asked. Do not
  trust a green suite: check that it fails when the behaviour it covers is
  removed.
- **Node 20 is the declared minimum** and CI enforces it. Something that only
  works on a newer runtime is a bug, not a preference.
- Working notes belong in `.priv/`, never in a tracked file.

## Conventions

- `npm test` builds first and runs against `dist/`, so the tests exercise the
  artifact that actually ships.
- After changing source, `make dev-install` replaces the installed command, so
  an MCP client picks the change up. The client runs the installed file, not
  the checkout.
- Installation logic lives in `bin/install` as POSIX sh; the `Makefile` only
  calls it, so the steps stay usable without make.
- Comments explain why a thing is the way it is, not what the line does. The
  measured traps in this codebase are commented for that reason.
- `scripts/smoke.mjs` creates real Confluence pages, writes to them through
  every tool, and deletes them again. It is run by hand, never from CI, and it
  needs `SMOKE_SPACE_KEY` or `SMOKE_SPACE_ID` in the environment - the space is
  never hard-coded, because a space or page id identifies the site it belongs
  to and this repository is public.

## Layout

```text
src/config.ts      credential resolution, the per-user file, permissions
src/cli.ts         argument parsing, init, config; the MCP server is argumentless
src/confluence.ts  REST client, error and version-conflict mapping
src/append.ts      storage and ADF validation, the read-modify-write append
src/tables.ts      table reading and row operations
src/index.ts       MCP server wiring and caller-facing error messages
bin/install        builds the single-file bundle and installs it
```

<!-- k-playbook:anstoss -->
## k-playbook

Für dieses Projekt gilt k-playbook. Rufe zu Beginn

    k-playbook context

auf und lies die Dateien aus `instructions` in der angegebenen Reihenfolge,
bevor du arbeitest. Die Ausgabe nennt außerdem die aufgelösten Verzeichnisse und
die effektiven Kataloge für Regeln, Reviews und Checks.

<!-- k-playbook:session-memory -->
## Projektwissen zuerst

Die autoritative Projektdokumentation beginnt bei
`k-playbook-local/docs/README.md`. Lies diesen Index zuerst, bevor du den
Code analysierst. Erst wenn die Dokumentation fehlt, nicht passt oder ein
konkreter Fix den aktuellen Code verlangt, ist eine Code-Recherche nötig.
