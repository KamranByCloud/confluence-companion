# Confluence Companion

Confluence Companion is a small MCP server that complements Atlassian Rovo
with targeted Confluence Cloud capabilities that require direct use of the
Confluence REST API.

The project does not replace the official Atlassian Rovo MCP server. Rovo
continues to provide search, Jira, Teamwork Graph, and its standard Confluence
tools. Confluence Companion focuses on safe, precise operations that are not
adequately covered there, starting with incremental page updates.

## Initial goal

Provide an MCP tool that safely appends content to an existing Confluence page:

1. Read the current page body and version through the Confluence REST API.
2. Append validated content in the requested representation.
3. Update the page with the next version number.
4. Handle version conflicts without silently overwriting concurrent edits.

## Authentication

The initial local setup uses a normal Atlassian API token via Basic
Authentication. The token must not be committed. A future shared or remote
deployment can use OAuth instead.

## Requirements

Node.js 20 or newer.

## Setup

```bash
npm install
npm run build
cp .env.example .env   # then fill in site URL, email, and API token
```

Use a **normal** Atlassian API token, not a scoped one. Scoped tokens address
the Atlassian API gateway and fail with `401 scope does not match` against the
site REST API.

## MCP client configuration

Credentials are read from the `.env` next to the installed package, resolved
from the server module rather than the working directory. A client can start the
server from anywhere without the token being written into client configuration.

For Claude Code:

```bash
claude mcp add -s user confluence-companion -- node /absolute/path/to/confluence-companion/dist/index.js
```

Any client that supports stdio servers can be configured directly. Environment
variables, if given, take precedence over the `.env`:

```json
{
  "mcpServers": {
    "confluence-companion": {
      "command": "node",
      "args": ["/absolute/path/to/confluence-companion/dist/index.js"],
      "env": {
        "ATLASSIAN_SITE_URL": "https://your-site.atlassian.net",
        "ATLASSIAN_EMAIL": "you@example.com",
        "ATLASSIAN_API_TOKEN": "your-token"
      }
    }
  }
}
```

## Tool: `confluence_append_page_content`

| Parameter | Required | Description |
| --- | --- | --- |
| `page_id` | yes | Numeric page ID. |
| `content` | yes | Confluence Storage format markup to append. |
| `representation` | no | `storage` (default) or `atlas_doc_format`. |
| `version_message` | no | Message recorded in the page version history. |

The tool reads the current body and version, appends, and writes the full body
back at `version + 1`. Concurrent edits are detected by the API's optimistic
locking and reported as a conflict; the page is left untouched.

Content is validated as well-formed XHTML before any write. This is not
cosmetic: Confluence accepts malformed storage markup with HTTP 200 and
silently rewrites it, so invalid input would otherwise corrupt the page.

### Choosing a representation

Prefer `storage`, and pass Confluence Storage XHTML as `content`.

`atlas_doc_format` is supported: pass JSON, either a whole `doc`, an array of
nodes, or a single node. The tool appends the nodes to the document's `content`
array and leaves every other document field alone.

The page is always read and written in the same representation, because
crossing formats rewrites parts of the page nobody asked to change. Measured on
a page authored in storage format:

| Write path | Effect on untouched markup |
| --- | --- |
| storage, unchanged content | byte identical |
| through `atlas_doc_format` | table cells wrapped in `<p>`, `data-layout` added |

The Confluence API does not report which representation a page was authored in,
so the tool cannot pick for you. Use `atlas_doc_format` only for a page you know
was authored that way.

One further effect is unavoidable even without crossing formats: macros that
map onto native ADF nodes, such as the info panel, get a fresh `ac:macro-id` on
every ADF write, because the ADF node carries no macro ID. Macros represented as
ADF extensions, such as `toc`, keep theirs.

## Tests

```bash
npm test          # builds, then runs the unit tests
```

The unit tests use the built-in Node test runner and make no network calls;
HTTP is stubbed. They cover storage validation, the append read-modify-write,
request shaping, error mapping, version-conflict translation, and configuration
loading.

`npm run smoke -- <page-id>` is a separate end-to-end check that drives the
server as a real MCP client. It writes to the page you give it, so point it at
a scratch page, never at a real one.

The server runs from `dist/`, so run `npm run build` after changing the source
for a client to pick the change up.

## Status

Working append tool, registered and connected as a stdio MCP server, with unit
tests and live checks. Packaging and distribution are not addressed yet: the
server currently runs from a local checkout. Architecture decisions, research, and verified API details are
kept in local working notes that are not part of this repository, because they
contain site-specific configuration.

Copy `.env.example` to `.env` and fill in your own site URL, account email, and
Atlassian API token. `.env` is gitignored and should be kept at mode `600`.
