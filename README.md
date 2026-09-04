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

## Status

Planning only. Architecture decisions, research, and verified API details are
kept in local working notes that are not part of this repository, because they
contain site-specific configuration.

Copy `.env.example` to `.env` and fill in your own site URL, account email, and
Atlassian API token. `.env` is gitignored and should be kept at mode `600`.
