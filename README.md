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
node dist/index.js init   # asks for site URL, email, and API token
```

`init` stores the credentials in `~/.config/confluence-companion/config.env` at
mode 600, outside every project, and verifies them against the site before
writing. The token is entered once per machine and never appears in a
repository or in a client configuration.

Use a **normal** Atlassian API token, not a scoped one. Scoped tokens address
the Atlassian API gateway and fail with `401 scope does not match` against the
site REST API.

## Configuration

Settings are resolved from three sources, in descending precedence:

| Source | Purpose |
| --- | --- |
| `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` | Environment; how a dev container or CI passes credentials in without a file |
| `${XDG_CONFIG_HOME:-~/.config}/confluence-companion/config.env` | The per-user file written by `init` |
| `.env` next to the package | Transitional, for a checkout that is also the install |

Environment variables always win, and a file never overrides a value that is
already set. `confluence-companion config` prints which source supplied each
setting; it reports the token's length but never the token itself.

In a dev container no file is needed at all: pass the three variables through
`remoteEnv`, or run `init` with them set and no terminal attached, and it
stores them without prompting.

## Command line

An argumentless call starts the MCP server on stdio, which is what a client
runs. Everything else is a subcommand:

```bash
confluence-companion            # start the MCP server (what a client runs)
confluence-companion mcp        # the same, stated explicitly
confluence-companion init       # store this machine's credentials
confluence-companion config     # show where each setting is resolved from
confluence-companion help
confluence-companion version
```

`init --force` replaces an existing configuration file without asking.

## MCP client configuration

Credentials are resolved by the server itself, from the environment and from
the per-user file described above. A client can start the server from anywhere
without the token being written into client configuration.

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

## Table tools

The table tools operate only on Storage-format tables. They preserve the rest
of the page and use the same read-modify-write and optimistic-locking rules as
the append tool.

1. `confluence_get_page_tables` reads all tables from a page. It returns the
   page version, zero-based table and data-row indexes, headers, column count,
   and plain-text cell values.
2. `confluence_insert_table_row` inserts a complete row. `insert_at_row: 0`
   inserts before the first data row; `insert_at_row: row_count` appends after
   the last one; every value in between inserts before that zero-based row.
3. `confluence_delete_table_row` deletes one zero-based data row.

Read a table immediately before changing it. Both write tools require the
returned `expected_version`, `table_index`, and `expected_headers`. A changed
page version or table schema is rejected before the write, so an old row index
cannot silently target a different row. New cells must be well-formed
Confluence Storage XHTML and their count must exactly match the table's columns.

Changing an individual cell and atomically replacing a whole row are deliberately
out of scope for this first table release. Replacing a row can be performed as a
delete followed by an insert after re-reading the table.

## Tests

```bash
npm test          # builds, then runs the unit tests
```

The unit tests use the built-in Node test runner and make no network calls;
HTTP is stubbed. They cover storage validation, the append read-modify-write,
request shaping, error mapping, version-conflict translation, command-line
parsing, the `init` flow, and configuration resolution including its precedence
order and file permissions.

`npm run smoke -- <page-id>` is a separate end-to-end check that drives the
server as a real MCP client. It writes to the page you give it, so point it at
a scratch page, never at a real one.

`npm run smoke:tables -- <page-id>` checks the table tools through MCP. Its
target must be a scratch Storage page with exactly one six-column table. It
inserts a uniquely marked final row and deletes it again, so the table rows are
left unchanged while the page version increases twice.

The server runs from `dist/`, so run `npm run build` after changing the source
for a client to pick the change up.

## Status

Working append tool, registered and connected as a stdio MCP server, with unit
tests and live checks. Credentials are per user and outside the project, and the
command has a subcommand interface. Still missing for an install on another
machine: a bundled artifact on `PATH`, registration of the server with each
assistant, and an update path. Architecture decisions, research, and verified
API details are kept in local working notes that are not part of this
repository, because they contain site-specific configuration.

The `.env` in the checkout still works as the last fallback, but
`confluence-companion init` is the supported way to store credentials. Both
files are gitignored and must stay at mode `600`.
