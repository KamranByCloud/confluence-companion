---
type: Tool Reference
title: Model Context Protocol TypeScript SDK
description: Projektrelevante Pitfalls und Idiome fuer @modelcontextprotocol/sdk.
tags: [library, node, modelcontextprotocol-sdk]
status: stable
generated: { by: k-docs-tools, at: 2026-09-06T18:31:23+02:00 }
lib: modelcontextprotocol-sdk
version: "^1.31.0"
version-pin: range
severity: high
last-reviewed: 2026-10-12
sources:
  - resource: https://github.com/modelcontextprotocol/typescript-sdk
    title: MCP TypeScript SDK repository and v1 documentation notice
  - resource: https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.0
    title: SDK 1.30.0 release notes
  - resource: https://github.com/modelcontextprotocol/typescript-sdk/issues/1175
    title: listTools schema-reference regression report
---

# Model Context Protocol TypeScript SDK

## Rolle im Projekt

Der SDK ist die Server-Laufzeit dieses Projekts. `src/index.ts:65` erzeugt einen
`McpServer`, registriert die neun schmalen Confluence-Werkzeuge ab
`src/index.ts:75` und verbindet ihn in `src/index.ts:406` ueber
`StdioServerTransport` mit dem MCP-Client. Die Werkzeugschemas kommen aus Zod;
der SDK erzeugt daraus den MCP-kompatiblen Tool-Vertrag.

Der Server ist absichtlich ein lokaler stdio-Prozess. Die Tool-Handler kapseln
alle Fehler in MCP-Tool-Ergebnisse, statt dass Fehler den Prozess oder die
JSON-RPC-Verbindung beenden (`src/index.ts:116-152`).

## Version & Migration

- Aktuell: `^1.31.0` (range)
- Die 1.x-Reihe erhaelt noch mindestens sechs Monate nach der v2-Veroeffentlichung
  Bug- und Security-Fixes. Die aktuelle Hauptlinie teilt das Monopaket in
  `@modelcontextprotocol/server` und `@modelcontextprotocol/client` auf.
- Ein Upgrade auf v2 ist keine normale Dependency-Aktualisierung: Imports,
  Paketname und die MCP-Spezifikationsrevision muessen zusammen migriert werden.
  Vor einem Upgrade gegen die v1- und v2-Migrationsanleitung sowie den
  installierten MCP-Client testen.

## Pitfalls (projektrelevant)

- **stdout ist das Protokoll, nicht das Log** - Bei `StdioServerTransport`
  beschaedigt jede Diagnosezeile auf stdout die JSON-RPC-Kommunikation. Das
  Projekt leitet Diagnosen deshalb in `src/index.ts:409-414` nach stderr. Diese
  Trennung bei neuen Log-Ausgaben und in Abhaengigkeits-Callbacks beibehalten.
- **Tool-Schema ist eine externe Schnittstelle** - Aenderungen an Namen,
  `inputSchema`, Beschreibungen oder Annotationen in `src/index.ts:75-404`
  veraendern, was MCP-Clients entdecken und aufrufen. Besonders bei schreibenden
  Werkzeugen keine optionalen Sicherheitsdaten stillschweigend machen und die
  `readOnlyHint`-/`destructiveHint`-Annotationen mit der realen Wirkung
  abgleichen.
- **v1 zu v2 ist ein Paket- und Protokollwechsel** - Die offizielle Hauptdoku
  beschreibt v2 mit den getrennten Paketen; dieser Server importiert noch die
  v1-Pfade `@modelcontextprotocol/sdk/server/mcp.js` und
  `@modelcontextprotocol/sdk/server/stdio.js` (`src/index.ts:2-3`). Ein
  unkoordiniertes Major-Upgrade kann deshalb bereits beim Import oder beim
  Handshake brechen.
- **Client-Kompatibilitaet muss integrativ getestet werden** - Die SDK-1.30.0-
  Release ergaenzte unter anderem einen stdio-Puffergrenzwert. Das ist ein
  Hinweis darauf, dass Transportverhalten nicht allein durch Typpruefung
  abgesichert ist. Nach SDK-Upgrades den gebuendelten, installierten Befehl mit
  einem echten MCP-Initialize und mindestens einem Tool-Aufruf pruefen.

## Empfohlene Idiome

- Einen `McpServer` pro stdio-Prozess erzeugen und genau einmal mit einem
  `StdioServerTransport` verbinden.
- Eingaben an der Tool-Grenze mit Zod beschreiben und fachliche Validierung vor
  Netzwerkzugriffen ausfuehren.
- Erwartete Fehler innerhalb des Tool-Handlers in `{ isError: true, content }`
  umsetzen, damit der Client einen aufrufbezogenen Fehler statt eines
  Verbindungsabbruchs erhaelt.
- Tool-Titel, Beschreibungen und Annotationen als Teil des Sicherheitsvertrags
  behandeln: Sie steuern die Auswahl und Risikoeinschaetzung durch MCP-Clients.

## Anti-Patterns

- `console.log` oder andere Protokoll-fremde Ausgaben im MCP-Prozess verwenden.
- Einen v2-Paketwechsel als austauschbaren Minor- oder Patch-Upgrade behandeln.
- Rohfehler aus Confluence bis aus dem Handler werfen lassen, wenn sie in einen
  klaren aufrufbezogenen Tool-Fehler uebersetzt werden koennen.
