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
| `representation` | no | Only `storage` is accepted. |
| `version_message` | no | Message recorded in the page version history. |

The tool reads the current body and version, appends, and writes the full body
back at `version + 1`. Concurrent edits are detected by the API's optimistic
locking and reported as a conflict; the page is left untouched.

Content is validated as well-formed XHTML before any write. This is not
cosmetic: Confluence accepts malformed storage markup with HTTP 200 and
silently rewrites it, so invalid input would otherwise corrupt the page.

Only Confluence Storage format is supported. Atlassian Document Format is not
yet verified and is therefore not offered.

## Status

Working append tool with tests against a live page. Architecture decisions, research, and verified API details are
kept in local working notes that are not part of this repository, because they
contain site-specific configuration.

Copy `.env.example` to `.env` and fill in your own site URL, account email, and
Atlassian API token. `.env` is gitignored and should be kept at mode `600`.
