# Task 001 — Remote-Hosting in Azure

Der Server wird zusätzlich über HTTP erreichbar, in Azure betrieben, mit
Confluence-Credentials, die der Client pro Request mitgibt.

## Intent

Confluence Companion soll von mehreren Personen und Clients über das Netz
nutzbar sein, ohne dass der Dienst selbst Confluence-Credentials hält und ohne
dass der bestehende lokale Betrieb sich ändert.

- Der argumentlose Aufruf startet weiterhin den stdio-Server. Jede bestehende
  Client-Registrierung bleibt gültig.
- Der gehostete Dienst speichert **keine** Confluence-Credentials. Sie kommen
  pro Request vom Client; die Autorenschaft in Confluence bleibt damit korrekt
  der aufrufenden Person zugeordnet.
- Zugang zum Dienst und Identität in Confluence sind zwei getrennte Dinge und
  werden über getrennte Header transportiert.
- Der Endpunkt ist nicht als offener Proxy missbrauchbar.
- Unit-Tests gehören zu jeder Etappe, und sie werden per Mutation geprüft, nicht
  weil sie grün sind, für gültig gehalten.

## Referenzen

- `README.md` — Installations- und Credential-Modell, Registrierungswege je Client
- `k-playbook-local/docs/manual/system.md` — Architektur, Auth-Befunde, Gateway-URL-Korrektur
- `k-playbook-local/docs/libs/modelcontextprotocol-sdk.md` — SDK-Pitfalls, v1→v2 ist Paket- *und* Protokollwechsel
- `src/index.ts` — Transport-Anbindung (Z. 406) und Client-Erzeugung beim Start (Z. 61–62)
- `src/confluence.ts` — `ConfluenceClient` nimmt `Config` im Konstruktor (Z. 77)
- `src/config.ts` — `loadConfig()`, bleibt ausschließlich stdio-Pfad

## Ziel

Ein zweiter Transportweg (`--http`) neben stdio, zustandslos, mit
Credential-Auflösung pro Request aus HTTP-Headern, zwei wahlweisen
Zugangsprüfungen (Gateway-Token, Entra), Rate-Limit und einem Deployment in
Azure Container Apps.

## Kontext

### Warum überhaupt direkte REST-Zugriffe

Rovo bleibt verbunden und behält seinen Umfang. Was dort fehlt, sind Werkzeuge
für die gezielte Teiländerung einer bestehenden Seite; der Weg über die
Ganzseiten-Operationen funktionierte nicht sauber. Die REST-API ist deshalb
kein Ersatz, sondern der einzige Weg zur Fähigkeit. Steht seit 2026-09-18 auch
in `manual/system.md` §Purpose.

### Ausgangslage im Code

- Der Server kennt nur `StdioServerTransport` (`src/index.ts:406`).
- `new ConfluenceClient(loadConfig())` läuft **einmal beim Start**
  (`src/index.ts:61-62`) — Credentials sind prozessweit. Genau das muss fallen.
- Günstig: `ConfluenceClient` nimmt bereits eine `Config` im Konstruktor und
  leitet Base-URL und Basic-Header daraus ab (`src/confluence.ts:77-80`). Die
  Klasse ist pro-Config gebaut, kein Singleton. Pro Request ist sie damit
  praktisch gratis.

### Das SDK bringt alles mit — kein Major-Upgrade

Geprüft an der installierten Version 1.30.0. Es braucht **keine neuen
Dependencies** und **kein** v1→v2-Upgrade (das wäre laut SDK-Referenz ein
Paket- und Protokollwechsel, kein Minor):

| Baustein | Modul |
|---|---|
| HTTP-Transport | `server/streamableHttp.js`, Stateless über `sessionIdGenerator: undefined` |
| `WWW-Authenticate` inkl. `resource_metadata` | `server/auth/middleware/bearerAuth.js` |
| `/.well-known/oauth-protected-resource` | `server/auth/handlers/metadata.js` |
| passende Metadata-URL bilden | `getOAuthProtectedResourceMetadataUrl()` in `server/auth/router.js` |
| JWT gegen JWKS prüfen | `jose` — bereits SDK-Dependency |
| Rate-Limit | `express-rate-limit` — bereits SDK-Dependency |

`handleRequest(req & { auth?: AuthInfo }, res)` nimmt Auth-Info aus einer
Middleware — das ist der vorgesehene Haken für Credentials pro Request.

### Stateless, nicht Session-basiert

Alle neun Tools sind Request/Response ohne Serverzustand. Stateless-Modus
bedeutet: keine Session-Affinität im Ingress, kein offener GET-SSE-Stream, und
damit keine Diskussion über Idle-Timeouts der Azure-Plattform.

### Header-Aufteilung

Zugang und Autorenschaft sind getrennt. `Authorization` trägt den Zugang, weil
dort sowohl das Entra-JWT als auch das Gateway-Token liegen:

```text
Authorization:     Bearer <entra-jwt>  |  Bearer <gateway-token>
X-Atlassian-Site:  https://<site>.atlassian.net
X-Atlassian-Email: <account-email>
X-Atlassian-Token: <normal api token>
```

Der Server baut den Basic-Header selbst aus Site, E-Mail und Token zusammen.
Ein früher erwogenes Durchreichen des `Authorization`-Headers an Confluence
entfällt damit — der Slot ist belegt.

Die Credentials gehören in die **Client-Konfiguration als Header**, nicht in
Tool-Parameter. Als Parameter landeten sie im Modellkontext, im Transcript und
in jedem Tool-Call-Log. Clientseitig liegen sie damit im Klartext in
`~/.claude.json` bzw. `opencode.jsonc`; das ist der bewusst akzeptierte Preis.

### Auth gehört in den Server, nicht davor

Easy Auth / Container Apps Built-in Authentication ist für MCP der falsche
Platz und bleibt **aus**. Auf einen Request ohne Token antwortet sie mit
Redirect auf eine HTML-Loginseite oder mit nacktem 401 — in beiden Fällen ohne
den Header, über den ein MCP-Client erfährt, wo er sich anmelden soll:

```text
WWW-Authenticate: Bearer resource_metadata="https://…/.well-known/oauth-protected-resource"
```

Ein Browser kommt damit klar, ein MCP-Client nicht. Stattdessen übernimmt der
Server die Rolle **Resource Server** aus der MCP-Spec, Entra ist
**Authorization Server**. Der Client entdeckt das selbst und führt den Flow
gegen Entra; der Server verifiziert das JWT.

### Entra-Zuschnitt: Gruppe, nicht E-Mail-Domain

Ein Filter auf das E-Mail-Suffix der Unternehmensdomain wäre unzuverlässig: der
`email`-Claim ist optional, UPN ≠ Mail, und B2B-Gäste im Tenant tragen fremde
Domains. Robust ist stattdessen:

- **Single-Tenant**-App-Registrierung — nur Identitäten des eigenen Tenants
  bekommen überhaupt ein Token.
- **„User assignment required"** an der Enterprise-App plus eine
  Entra-Sicherheitsgruppe. Onboarding und Offboarding regelt dann die Gruppe,
  nicht Code und kein Deployment.
- Der Server prüft `iss`, `aud` (die App-ID-URI), `tid` und den Gruppen- bzw.
  Rollen-Claim.

### Die eine offene Unbekannte

**Entra unterstützt keine Dynamic Client Registration (RFC 7591).**
MCP-Clients nutzen DCR gern zur Selbstregistrierung. Ohne DCR braucht der
Client eine vorab registrierte `client_id` aus dem Tenant. Zu verifizieren ist
also nicht „geht Entra überhaupt", sondern „akzeptiert der jeweilige Client eine
vorgegebene `client_id`". Deshalb ist das Gateway-Token nicht bloß der
einfachere, sondern der zuerst tragfähige Weg.

### Sicherheit

- **Offener-Proxy-Risiko.** Ein Endpunkt, der beliebige Credentials an eine
  beliebige Site weiterreicht, ist zum Durchprobieren fremder Tokens aus
  fremder IP missbrauchbar. Gegenmittel: **Allowlist erlaubter Site-Hosts** in
  der Server-Konfiguration.
- **Kein Header-Logging.** Weder Fehlerpfade noch Ingress dürfen
  `Authorization` oder `X-Atlassian-Token` protokollieren.
- **Rate-Limit pro Auth-Subjekt**, nicht pro IP — sonst landen alle hinter
  einem NAT im selben Topf.
- **TLS-Pflicht.** Ohne HTTPS wandert bei jedem Request ein persönliches
  Confluence-Schreibtoken im Klartext. Kein HTTP-Listener nach außen.
- **Gateway-Token** serverseitig nur als **Hash** ablegen, Vergleich
  konstantzeitig, pro Person ein eigenes Token, damit einzeln widerrufbar.

### Azure-Zuschnitt

| Dienst | Bewertung |
|---|---|
| **Container Apps** | **Gewählt.** Scale-to-zero, TLS im Ingress, Secret-Referenzen, Managed Identity. Built-in Auth bleibt aus. |
| App Service (Linux, Node 20) | Alternative ohne Image-Bau. 230 s Idle-Timeout — im Stateless-Modus irrelevant. |
| Azure Functions | Verworfen. Die MCP-Extension verlangt ein Neuschreiben der Tools gegen das Binding-Modell; SDK-Wiring, Zod-Schemata und Fehlerübersetzung wären weg. |
| AKS | Überdimensioniert für ein ~1,3-MB-Artefakt. |
| API Management davor | Nur bei Zugriff außerhalb des Tenants oder bei Bedarf an Token-Store. |

Kein Key Vault für Confluence-Credentials — der Dienst hält keine. Key Vault
bzw. Container-Apps-Secret nur für die Gateway-Token-Hashes.

Netz: Confluence Cloud ist öffentlich, reines Egress. VNet nur bei
Policy-Zwang; NAT Gateway, falls Atlassian eine IP-Allowlist verlangt.

Kosten grob: Container Apps mit Scale-to-zero im einstelligen Euro-Bereich pro
Monat; App Service B1 etwa 12 €/Monat.

### Schon erledigt (2026-09-18, nicht Teil dieser Task)

- `manual/system.md` §Purpose um den Abschnitt *Why the REST API directly*
  ergänzt.
- `.gitignore` um `k-playbook-local/docs/manual/` ergänzt. Die Datei war
  untracked, aber nicht ignoriert, und enthält Site-URL, Cloud-ID und
  Account-Adresse — bei öffentlichem Repo ein `git add -A` von der
  Veröffentlichung entfernt.

## Offene Entscheidungen

- `AGENTS.md` und `k-playbook-local/docs/README.md` sind getrackt und verweisen
  auf `manual/*.md`, die jetzt ignoriert sind: ein frischer Clone findet sie
  nicht. Entweder damit leben, oder `system.md` von Site-URL, Cloud-ID und
  Account bereinigen und doch tracken. Vor Etappe 5 zu klären.
- Ob Etappe 3 (Entra) überhaupt gebaut wird, hängt am Verifikationsschritt zu
  Beginn dieser Etappe.

## Zu bauen

### Etappe 1 — HTTP-Transport und Credentials pro Request

- `src/cli.ts`: Flags `--http` und `--port` parsen. Der argumentlose Aufruf und
  `mcp` bleiben unverändert stdio.
- `src/http.ts` (neu): `StreamableHTTPServerTransport` im Stateless-Modus,
  `/healthz` für den Azure-Probe, DNS-Rebinding-Schutz bzw. Origin-Allowlist.
- `src/config.ts`: Funktion, die aus `X-Atlassian-Site`, `X-Atlassian-Email`
  und `X-Atlassian-Token` eine `Config` baut. `loadConfig()` bleibt der
  stdio-Pfad und wird nicht angefasst.
- Allowlist erlaubter Site-Hosts, konfigurierbar über Umgebungsvariable.
- `src/index.ts`: die neun `registerTool`-Handler beziehen den
  `ConfluenceClient` aus dem Request-Kontext statt aus der Start-Closure.
- Fehlende oder unvollständige Header ergeben einen sauberen MCP-Tool-Fehler,
  keinen HTTP-500.
- Tests: Header→`Config`, fehlende Header, Site nicht auf der Allowlist,
  Transportauswahl im CLI-Parsing, und dass der stdio-Pfad unverändert
  `loadConfig()` nutzt.

### Etappe 2 — Gateway-Token und Rate-Limit

- Auth-Middleware vor dem Transport: `Authorization: Bearer <token>` gegen
  hinterlegte Hashes prüfen, konstantzeitig.
- Mehrere Token nebeneinander, jedes einzeln widerrufbar.
- `AUTH_MODE=gateway|entra|both` als Schalter; beide Prüfer hängen am selben
  Header.
- Rate-Limit über `express-rate-limit`, Schlüssel ist das Auth-Subjekt.
- Sicherstellen, dass kein Pfad `Authorization` oder `X-Atlassian-Token` loggt.
- Tests: gültiges Token, ungültiges Token, fehlender Header, Rate-Limit greift,
  Hash-Vergleich akzeptiert kein Präfix.

### Etappe 3 — Entra als Resource Server

- **Zuerst verifizieren**, ob der Ziel-Client eine vorgegebene `client_id`
  akzeptiert, da Entra keine DCR bietet. Ergebnis im Task festhalten; fällt es
  negativ aus, endet die Etappe hier und Variante `gateway` bleibt der Weg.
- App-Registrierung: Single-Tenant, API mit App-ID-URI und Scope, „User
  assignment required", Sicherheitsgruppe.
- `metadataHandler` für `/.well-known/oauth-protected-resource`, URL über
  `getOAuthProtectedResourceMetadataUrl()`.
- `requireBearerAuth` mit `resourceMetadataUrl`, damit der 401 den Client zur
  richtigen Stelle schickt.
- JWT-Verifikation mit `jose` gegen Entras JWKS: `iss`, `aud`, `tid`, Gruppen-
  bzw. Rollen-Claim, Ablauf.
- Tests: gültiges Token, falsche Audience, falscher Tenant, fehlender
  Gruppen-Claim, abgelaufenes Token, und dass der 401 den
  `resource_metadata`-Hinweis trägt.

### Etappe 4 — Container und Deployment

- `Dockerfile`: `node:20-alpine`, Bundle über `npm run bundle` bzw.
  `bin/install`, eine Datei ins Image, non-root,
  `CMD ["confluence-companion","--http"]`.
- Container App: Ingress mit TLS, Scale-to-zero, Built-in Auth **aus**,
  `/healthz` als Probe, Gateway-Token-Hashes als Secret-Referenz.
- Prüfen, dass Site-Allowlist und `AUTH_MODE` über Umgebungsvariablen gesetzt
  sind und das Image keine Geheimnisse enthält.

### Etappe 5 — Dokumentation

- `README.md`: Abschnitt zur HTTP-Variante — Registrierung in Claude Code
  (`claude mcp add --transport http` mit Headern) und OpenCode
  (`"type": "remote"` mit `headers`), Header-Tabelle, Hinweis auf den
  Klartext-Preis in der Client-Konfiguration.
- `k-playbook-local/docs/manual/system.md`: Abschnitt zum Remote-Betrieb —
  gewählte Auth-Modelle mit Begründung, warum Auth im Server statt vorgelagert
  liegt, und das Verifikationsergebnis aus Etappe 3.
- `k-playbook-local/docs/README.md`: Stichwort-Index um die neuen Abschnitte
  ergänzen.
