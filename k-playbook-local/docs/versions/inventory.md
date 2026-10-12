---
type: Version Inventory
title: Versionsinventar
description: Vollständige Übersicht der deklarierten Versionen dieses Projekts, nach Umgebung getrennt und mit Herkunft je Zeile.
tags: [versions, inventory, dependencies]
status: stable
generated: { by: k-doc-inventory, at: 2026-10-12T20:22:34+02:00 }
inventory:
  sources-configured: 0
  sources-read: 5
  entries: 23
  deviations: 1
  rejected: 0
  sources-excluded: 19
  sources-unevaluable: 0
---

# Versionsinventar

Erzeugt von `k-doc-inventory` am 2026-10-12T20:22:34+02:00. Diese Datei wird bei jedem Lauf neu erzeugt;
Änderungen von Hand gehen dabei verloren. Sie führt die **deklarierten**
Versionen aus den Quellen des Projekts — nicht das, was zur Laufzeit aktiv ist.

## Übersicht

- Einträge: 23
- Ausgewertete Quellen: 5
- Konfigurierte Zusatzquellen: 0
- Abweichungen: 1
- Abgelehnte Quellen: 0
- Nicht durchsuchte Quellen: 19
- Nicht auswertbare Quellen: 0
- Hinweise: 0

## lokal

| Gegenstand | Art | Version | Pin | Scope | Herkunft |
|---|---|---|---|---|---|
| `node/@modelcontextprotocol/sdk` | package | `1.31.0` | exact | main | `package-lock.json:483` · `packages.node_modules/@modelcontextprotocol/sdk` |
| `node/@modelcontextprotocol/sdk` | package | `^1.31.0` | range | main | `package.json:28` · `dependencies.@modelcontextprotocol/sdk` |
| `node/@opencode-ai/plugin` | package | `1.18.29` | exact | main | `.opencode/package-lock.json:101` · `packages.node_modules/@opencode-ai/plugin` |
| `node/@opencode-ai/plugin` | package | `1.18.29` | exact | main | `.opencode/package.json:3` · `dependencies.@opencode-ai/plugin` |
| `node/@types/node` | package | `26.5.0` | exact | dev | `package-lock.json:535` · `packages.node_modules/@types/node` |
| `node/@types/node` | package | `^26.5.0` | range | dev | `package.json:34` · `devDependencies.@types/node` |
| `node/entities` | package | `8.1.0` | exact | main | `package-lock.json:1144` · `packages.node_modules/entities` |
| `node/entities` | package | `^8.1.0` | range | main | `package.json:29` · `dependencies.entities` |
| `node/esbuild` | package | `0.28.2` | exact | dev | `package-lock.json:1186` · `packages.node_modules/esbuild` |
| `node/esbuild` | package | `^0.28.2` | range | dev | `package.json:35` · `devDependencies.esbuild` |
| `node/fast-xml-parser` | package | `5.11.2` | exact | main | `package-lock.json:1364` · `packages.node_modules/fast-xml-parser` |
| `node/fast-xml-parser` | package | `^5.11.2` | range | main | `package.json:30` · `dependencies.fast-xml-parser` |
| `node/typescript` | package | `7.0.2` | exact | dev | `package-lock.json:2110` · `packages.node_modules/typescript` |
| `node/typescript` | package | `^7.0.2` | range | dev | `package.json:36` · `devDependencies.typescript` |
| `node/zod` | package | `4.6.5` | exact | main | `package-lock.json:2206` · `packages.node_modules/zod` |
| `node/zod` | package | `^4.6.5` | range | main | `package.json:31` · `dependencies.zod` |
| `runtime/node` | runtime | `>=20` | range | — | `package.json:15` · `engines.node` |

## ci

| Gegenstand | Art | Version | Pin | Scope | Herkunft |
|---|---|---|---|---|---|
| `ci/actions/checkout` | action | `v7` | exact | — | `.github/workflows/ci.yml:22` · `jobs.test.steps[0].uses` |
| `ci/actions/checkout` | action | `v7` | exact | — | `.github/workflows/ci.yml:35` · `jobs.install.steps[0].uses` |
| `ci/actions/setup-node` | action | `v7` | exact | — | `.github/workflows/ci.yml:23` · `jobs.test.steps[1].uses` |
| `ci/actions/setup-node` | action | `v7` | exact | — | `.github/workflows/ci.yml:36` · `jobs.install.steps[1].uses` |
| `runtime/node` | runtime | `${{ matrix.node }}` | unknown | — | `.github/workflows/ci.yml:25` · `jobs.test.steps[1].with.node-version` · Wert aus Variable, nicht auflösbar: ${{ matrix.node }} |
| `runtime/node` | runtime | `20` | exact | — | `.github/workflows/ci.yml:38` · `jobs.install.steps[1].with.node-version` |

## Abweichungen

Eine Abweichung wird ausgewiesen, nicht aufgelöst: `widersprüchlich` heißt,
dass dieselbe Umgebung Verschiedenes sagt, `umgebungsbedingt`, dass verschiedene
Umgebungen es tun. Gezählt werden Gruppen, nicht Zeilen.

### widersprüchlich — `runtime/node`

| Version | Pin | Kontext | Herkunft |
|---|---|---|---|
| `>=20` | range | lokal | `package.json:15` · `engines.node` |
| `${{ matrix.node }}` | unknown | ci | `.github/workflows/ci.yml:25` · `jobs.test.steps[1].with.node-version` · Wert aus Variable, nicht auflösbar: ${{ matrix.node }} |
| `20` | exact | ci | `.github/workflows/ci.yml:38` · `jobs.install.steps[1].with.node-version` |

## Ausgewertete Quellen

| Datei | Quellart | Label | Einträge | Zustand | Note |
|---|---|---|---|---|---|
| `.github/workflows/ci.yml` | ci | ci | 6 | ausgewertet | — |
| `.opencode/package-lock.json` | node | lokal | 1 | ausgewertet | — |
| `.opencode/package.json` | node | lokal | 1 | ausgewertet | — |
| `package-lock.json` | node | lokal | 7 | ausgewertet | — |
| `package.json` | node | lokal | 8 | ausgewertet | — |

## Nicht durchsuchte Bereiche

Diese Bereiche liegen im Projekt, werden aber von der Standarderkennung nicht
gesucht. Sie sind nicht gesperrt: eine Quelle daraus kommt ins Inventar, sobald
sie in `sources:` der Quellenkonfiguration steht.

| Muster | Herkunft | Übergangene Quellen | Grund |
|---|---|---|---|
| `k-playbook/**` | installation | 19 | Clone des Werkzeugs; wird bei jedem Update ersetzt und sagt nichts über dieses Projekt |

## Abgelehnte Quellen und Hinweise

Keine.
