# Confluence Companion - Dokumentation

Confluence Companion ist ein lokaler MCP-Server fuer gezielte, sichere
Teilaktualisierungen von Confluence-Cloud-Seiten. Diese Dokumentation erfasst
die verifizierte Systemarchitektur und Tool-Semantik, das Versionsinventar und
kuratierte Referenzen fuer zentrale Abhaengigkeiten.

> **Fuer AI-Sessions:** Diese Docs sind **autoritativ**. Nutze sie zuerst,
> bevor du Code liest. Siehe [`AGENTS.md`](../../AGENTS.md) im Projekt-Root.

## Uebersicht der Dokumente

### Versionen (`versions/`) - erzeugt von `/k-doc-inventory`

| Datei | Inhalt | Erhoben |
|-------|--------|---------|
| [`versions/inventory.md`](versions/inventory.md) | Deklarierte Abhaengigkeits-, Runtime- und CI-Versionen mit Herkunft und Abweichungen. | 2026-09-06 |

### Handgepflegt (`manual/`)

| Datei | Inhalt |
|-------|--------|
| [`manual/functions.md`](manual/functions.md) | MCP-Tools, Storage- und ADF-Verhalten sowie Live-Smoke-Test-Abdeckung. |
| [`manual/system.md`](manual/system.md) | Architektur, Authentifizierung, Installation, Distribution, CLI sowie CI- und Security-Setup. |

## Libs & Stack

Kuratierte Referenz zu Libraries und Tools. Fokus: Pitfalls, nicht Tutorials.
Erzeugt von `/k-docs-tools`.

| Lib | Version | Severity | Letzter Review |
|-----|---------|----------|----------------|
| [modelcontextprotocol-sdk](libs/modelcontextprotocol-sdk.md) | ^1.30.0 | high | 2026-09-06 |

## Stichwort-Index

Alphabetisch. Format: **Begriff** -> `datei.md` §Abschnitt.

### A

- **Atlassian Document Format (ADF)** -> `manual/functions.md` §Atlassian Document Format, verified 2026-09-04
- **Atlassian Rovo** -> `manual/system.md` §Purpose

### C

- **Confluence REST API v2** -> `manual/system.md` §Relevant Confluence REST API v2 endpoints
- **Confluence Storage XHTML** -> `manual/functions.md` §Storage tables (2026-09-05)

### M

- **MCP (Model Context Protocol)** -> `libs/modelcontextprotocol-sdk.md` §Rolle im Projekt
- **McpServer** -> `libs/modelcontextprotocol-sdk.md` §Empfohlene Idiome

### O

- **Optimistic locking** -> `manual/functions.md` §Content and concurrency risks

### S

- **StdioServerTransport** -> `libs/modelcontextprotocol-sdk.md` §Pitfalls (projektrelevant)
- **Storage format** -> `manual/functions.md` §Append implementation findings (2026-09-04)

### V

- **Versionsinventar** -> `versions/inventory.md` §Uebersicht

## Haeufige Fragen -> direkter Sprung

| Frage | Datei |
|-------|-------|
| Was macht das System insgesamt und warum ergaenzt es Rovo? | [`manual/system.md`](manual/system.md) |
| Wie verhalten sich die neun MCP-Tools und die Content-Formate? | [`manual/functions.md`](manual/functions.md) |
| Welche Versionen sind fuer Abhaengigkeiten, Node und CI deklariert? | [`versions/inventory.md`](versions/inventory.md) |
| Welche Stolperfallen gelten beim Erweitern des MCP-Servers? | [`libs/modelcontextprotocol-sdk.md`](libs/modelcontextprotocol-sdk.md) |
