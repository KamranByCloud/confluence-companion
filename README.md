# Confluence Companion

[![CI](https://github.com/KamranByCloud/confluence-companion/actions/workflows/ci.yml/badge.svg)](https://github.com/KamranByCloud/confluence-companion/actions/workflows/ci.yml)

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

A normal Atlassian API token over Basic Authentication, one per user. The token
is never committed and never written into a client configuration; see
[Installation](#installation). A shared or remote deployment would use OAuth
instead, which changes only the base URL and the authorization header.

## Installation

### Requirements

Node.js 20 or newer on `PATH`, and git. `make` is optional; every step also
works by calling `bin/install` directly.

An Atlassian API token is needed, and it must be a **normal** one, not a scoped
one. Scoped tokens address the Atlassian API gateway and fail against the site
REST API with `401 scope does not match`. Create one at
<https://id.atlassian.com/manage-profile/security/api-tokens>.

### 1. Install the command

```bash
git clone https://github.com/KamranByCloud/confluence-companion.git
cd confluence-companion
make install          # or: bin/install
```

This bundles the server and all its dependencies into a single file and copies
it to `~/.local/bin/confluence-companion`. Set `PREFIX` to install elsewhere:

```bash
PREFIX=/usr/local make install
```

The file is copied rather than linked, so the checkout is only a build tool.
Moving or deleting it afterwards does not break the installed command, but keep
it if you want to update in place.

If the installer warns that the target directory is not on your `PATH`, add it
to your shell profile and open a new shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### 2. Store your credentials

```bash
confluence-companion init
```

`init` asks for the site URL, your account email, and the API token, hiding the
token as you type it. It verifies the three against the live site **before**
writing them, so a wrong token fails at the prompt rather than at the first
tool call. They are stored in `~/.config/confluence-companion/config.env` at
mode 600, outside every project.

Each person uses their own token. Confluence then attributes every change
correctly, and no write permission is ever handed out that would have to be
revoked.

### 3. Register the server with your assistant

For Claude Code, once per machine:

```bash
claude mcp add -s user confluence-companion -- confluence-companion
```

For other clients, see [MCP client configuration](#mcp-client-configuration)
below. Registering the server automatically for every installed assistant is
not implemented yet.

### Verify

```bash
confluence-companion config
```

It prints which source supplied each setting. It reports the token's length,
never the token itself.

A finished installation is two files:

```text
~/.local/bin/confluence-companion            the program, ~1.3 MB
~/.config/confluence-companion/config.env    the credentials, mode 600
```

Two rather than one on purpose: they have different lifetimes and different
permissions. The bundle carries the application code but not the JavaScript
runtime, which is why Node must be installed.

### Updating and removing

```bash
make update      # git pull --ff-only, then reinstall
make uninstall   # remove the command; the credentials are kept
```

`make uninstall` leaves `~/.config/confluence-companion/config.env` in place.
Delete that file to remove the stored token as well.

### Dev containers

Inside a container no configuration file is needed. Pass the three variables
through `remoteEnv`, since environment variables take precedence over the file:

```json
"remoteEnv": {
  "ATLASSIAN_SITE_URL": "${localEnv:ATLASSIAN_SITE_URL}",
  "ATLASSIAN_EMAIL": "${localEnv:ATLASSIAN_EMAIL}",
  "ATLASSIAN_API_TOKEN": "${localEnv:ATLASSIAN_API_TOKEN}"
}
```

Alternatively mount `~/.config/confluence-companion/config.env` read-only. For
the command itself, either mount `~/.local/bin` or run `bin/install` from
`postCreateCommand`; both are straightforward for a single file with no
dependencies. With the variables set and no terminal attached, `init` stores
them without prompting, which is the provisioning path.

## Configuration

Settings are resolved from two sources, in descending precedence:

| Source | Purpose |
| --- | --- |
| `ATLASSIAN_SITE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` | Environment; how a dev container or CI passes credentials in without a file |
| `${XDG_CONFIG_HOME:-~/.config}/confluence-companion/config.env` | The per-user file written by `init` |

Environment variables always win, and the file never overrides a value that is
already set. A `.env` inside the checkout is **not** read: it only ever worked
for a checkout that was also the install, and it was the one mechanism that
could carry a token to another machine by accident.

`confluence-companion config` prints which source supplied each setting. It
reports the token's length but never the token itself, so its output can be
pasted into a bug report.

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
claude mcp add -s user confluence-companion -- confluence-companion
```

Any client that supports stdio servers can be configured directly. The bare
command name is deliberate: it carries no machine-specific path, so the same
configuration works on another machine and inside a dev container, where the
name may resolve to a different file.

Environment variables, if given, take precedence over the configuration file,
but they are not needed when `init` has run:

```json
{
  "mcpServers": {
    "confluence-companion": {
      "command": "confluence-companion",
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
4. `confluence_update_table_cell` replaces one cell's content at a zero-based
   row and column index. It preserves the existing `td` or `th` element and its
   attributes, including `data-colwidth`.
5. `confluence_insert_table_column` inserts a complete column. It requires a
   header cell and exactly one new cell for every existing data row.

Read a table immediately before changing it. Both write tools require the
returned `expected_version`, `table_index`, and `expected_headers`. A changed
page version or table schema is rejected before the write, so an old row index
cannot silently target a different row. New cells must be well-formed
Confluence Storage XHTML and their count must exactly match the table's columns.

Atomically replacing a whole row is deliberately out of scope. It can be
performed as a delete followed by an insert after re-reading the table.

## Tests

```bash
npm test          # builds, then runs the unit tests
```

The unit tests use the built-in Node test runner and make no network calls;
HTTP is stubbed. They cover storage validation, the append read-modify-write,
request shaping, error mapping, version-conflict translation, command-line
parsing, the `init` flow, and configuration resolution including its precedence
order and file permissions.

`npm run smoke -- <storage-page-id> [adf-page-id] [table-page-id] [column-page-id]` is a
separate end-to-end check that drives the server as a real MCP client. Every
target is written to, so use scratch pages only. When a table page is supplied,
it must contain exactly one six-column Storage table; the test inserts a uniquely
marked final row and deletes it again, leaving its table rows unchanged while
increasing the page version twice. When a column page is supplied, it must
start with one two-column table and one data row; the test inserts a top row,
adds a column, then inserts a row in the middle.

After changing the source, run `make dev-install` so a client picks the change
up. It rebuilds the bundle and replaces the installed file without reinstalling
dependencies.

## Status

Working append and table tools, installable as a single file on `PATH`, with
per-user credentials, a subcommand interface, unit tests, and live checks.
Updating is `make update`.

Still open: registering the server with each assistant automatically. Claude
Code, OpenCode, Cursor, and Codex each keep their MCP configuration in a
different place, so `confluence-companion install` is planned to detect what is
present and write the entries after confirmation. Until then, register the
command by hand as shown above.

Architecture decisions, research, and verified API details are kept in local
working notes that are not part of this repository, because they contain
site-specific configuration.

## License

MIT. See [LICENSE](LICENSE).
