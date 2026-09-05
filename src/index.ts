#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  ADF,
  appendPageContent,
  ContentValidationError,
  deletePageContent,
  insertPageContent,
  prependPageContent,
  STORAGE,
  SUPPORTED_REPRESENTATIONS,
} from "./append.js";
import { parseArgs, runCommand } from "./cli.js";
import { ConfigError, loadConfig, loadConfigSources } from "./config.js";
import { ConfluenceApiError, ConfluenceClient, VersionConflictError } from "./confluence.js";
import {
  deleteTableRow,
  getPageTables,
  insertTableRow,
  insertTableColumn,
  TableValidationError,
  updateTableCell,
} from "./tables.js";
import { VERSION } from "./version.js";

/** Turns an internal error into a message that is actionable for the caller. */
function toToolError(error: unknown): string {
  if (error instanceof VersionConflictError) {
    return (
      `${error.message}\n\n` +
      `The page was NOT modified. Someone else edited it after this tool read it. ` +
      `Re-read the page, confirm the append is still appropriate, and call the tool again.`
    );
  }
  if (error instanceof ContentValidationError) return `Invalid content: ${error.message}`;
  if (error instanceof TableValidationError) return `Invalid table operation: ${error.message}`;
  if (error instanceof ConfluenceApiError) {
    if (error.status === 404) {
      return `${error.message}\n\nThe page does not exist, or the configured account cannot see it.`;
    }
    if (error.status === 401 || error.status === 403) {
      return (
        `${error.message}\n\nCheck ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN, and confirm the ` +
        `account has edit permission on this page. Use a normal API token, not a scoped one.`
      );
    }
    if (error.status === 400) {
      return (
        `${error.message}\n\nConfluence rejected the request body. The supplied content is ` +
        `most likely not valid Confluence Storage format.`
      );
    }
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

async function startMcpServer(): Promise<void> {
  loadConfigSources();
  const client = new ConfluenceClient(loadConfig());

  const server = new McpServer(
    { name: "confluence-companion", version: VERSION },
    {
      instructions:
        "Direct Confluence Cloud REST operations that complement the Atlassian Rovo MCP " +
        "server. Use Rovo for search and standard operations; use this server to append " +
        "content to an existing page without rewriting it.",
    },
  );

  server.registerTool(
    "confluence_append_page_content",
    {
      title: "Append content to a Confluence page",
      description:
        "Appends content to the end of an existing Confluence page body, preserving everything " +
        "already on the page. Performs a read-modify-write: it reads the current body and " +
        "version, appends, and writes the full body back at the next version number. If the " +
        "page changed in the meantime the update is rejected with a conflict and the page is " +
        "left untouched.\n\n" +
        `Prefer '${STORAGE}'. Use '${ADF}' only for a page you know was authored in ` +
        "Atlassian Document Format: the API cannot report a page's native format, and " +
        `writing a storage-authored page through '${ADF}' normalizes untouched markup, ` +
        "for example wrapping table cells in paragraphs.",
      inputSchema: {
        page_id: z
          .string()
          .regex(/^\d+$/, "page_id must be the numeric Confluence page ID")
          .describe("Numeric ID of the page to append to, e.g. 123456789."),
        content: z
          .string()
          .min(1)
          .describe(
            "Confluence Storage format markup to append, e.g. '<p>Text</p>'. Appended verbatim " +
              "after the existing body.",
          ),
        representation: z
          .enum(SUPPORTED_REPRESENTATIONS)
          .optional()
          .describe(
            `Body representation of the supplied content, '${STORAGE}' by default. For ` +
              `'${STORAGE}' pass Confluence Storage XHTML; for '${ADF}' pass JSON, either a ` +
              "whole doc, an array of nodes, or a single node.",
          ),
        version_message: z
          .string()
          .optional()
          .describe("Optional message recorded in the page's version history."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ page_id, content, representation, version_message }) => {
      try {
        const result = await appendPageContent(client, {
          pageId: page_id,
          content,
          representation,
          versionMessage: version_message,
        });
        return {
          content: [
            {
              type: "text",
              text:
                `Appended ${
                  result.appendedNodes === undefined
                    ? `${result.appendedChars} characters`
                    : `${result.appendedNodes} node(s)`
                } to "${result.page.title}".\n` +
                `Page ID: ${result.page.id}\n` +
                `Version: ${result.previousVersion} -> ${result.page.version}\n` +
                `URL: ${result.page.webUrl}`,
            },
          ],
          structuredContent: {
            page_id: result.page.id,
            title: result.page.title,
            previous_version: result.previousVersion,
            version: result.page.version,
            url: result.page.webUrl,
            appended_chars: result.appendedChars,
            appended_nodes: result.appendedNodes ?? null,
            representation: result.page.representation,
          },
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: toToolError(error) }] };
      }
    },
  );

  const pageId = z.string().regex(/^\d+$/, "page_id must be the numeric Confluence page ID");
  const storageContent = z
    .string()
    .min(1)
    .describe("Well-formed Confluence Storage XHTML, for example '<p>Text</p>'.");

  server.registerTool(
    "confluence_prepend_page_content",
    {
      title: "Prepend content to a Confluence page",
      description:
        "Inserts Storage XHTML at the beginning of an existing page body. The existing body is otherwise preserved. " +
        "The operation reads the page and writes the next version; concurrent edits are rejected as conflicts.",
      inputSchema: { page_id: pageId, content: storageContent, version_message: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ page_id, content, version_message }) => {
      try {
        const result = await prependPageContent(client, { pageId: page_id, content, versionMessage: version_message });
        return { content: [{ type: "text", text: `Prepended content to "${result.page.title}".\nVersion: ${result.previousVersion} -> ${result.page.version}\nURL: ${result.page.webUrl}` }], structuredContent: { page_id: result.page.id, previous_version: result.previousVersion, version: result.page.version, url: result.page.webUrl } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: toToolError(error) }] };
      }
    },
  );

  server.registerTool(
    "confluence_insert_page_content",
    {
      title: "Insert content next to a unique page fragment",
      description:
        "Inserts Storage XHTML immediately before or after one exact Storage-XHTML anchor. The anchor must occur exactly once; " +
        "zero or multiple matches are rejected without modifying the page. Copy the anchor verbatim from the stored page body, " +
        "not from content written earlier: Confluence stores non-ASCII characters as named entities, so text sent as " +
        "\"angehängt\" is stored as \"angeh&auml;ngt\".",
      inputSchema: {
        page_id: pageId,
        content: storageContent.describe("Storage XHTML to insert."),
        anchor_content: storageContent.describe("Exact existing Storage-XHTML fragment that must occur exactly once."),
        position: z.enum(["before", "after"]).describe("Whether to insert before or after anchor_content."),
        version_message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ page_id, content, anchor_content, position, version_message }) => {
      try {
        const result = await insertPageContent(client, { pageId: page_id, content, anchorContent: anchor_content, position, versionMessage: version_message });
        return { content: [{ type: "text", text: `Inserted content ${position} the unique anchor on "${result.page.title}".\nVersion: ${result.previousVersion} -> ${result.page.version}\nURL: ${result.page.webUrl}` }], structuredContent: { page_id: result.page.id, position, previous_version: result.previousVersion, version: result.page.version, url: result.page.webUrl } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: toToolError(error) }] };
      }
    },
  );

  server.registerTool(
    "confluence_delete_page_content",
    {
      title: "Delete one unique page fragment",
      description:
        "Deletes one exact Storage-XHTML fragment from a page. The target must occur exactly once; zero or multiple matches are " +
        "rejected without modifying the page. Copy the target verbatim from the stored page body, not from content written " +
        "earlier: Confluence stores non-ASCII characters as named entities, so text sent as \"angehängt\" is stored as " +
        "\"angeh&auml;ngt\".",
      inputSchema: { page_id: pageId, target_content: storageContent.describe("Exact existing Storage-XHTML fragment to delete."), version_message: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ page_id, target_content, version_message }) => {
      try {
        const result = await deletePageContent(client, { pageId: page_id, targetContent: target_content, versionMessage: version_message });
        return { content: [{ type: "text", text: `Deleted the unique target fragment from "${result.page.title}".\nVersion: ${result.previousVersion} -> ${result.page.version}\nURL: ${result.page.webUrl}` }], structuredContent: { page_id: result.page.id, previous_version: result.previousVersion, version: result.page.version, url: result.page.webUrl } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: toToolError(error) }] };
      }
    },
  );

  const tableIdentity = {
    table_index: z.number().int().min(0).describe("Zero-based table index returned by confluence_get_page_tables."),
    expected_headers: z
      .array(z.string())
      .describe("Headers returned by confluence_get_page_tables. The write is rejected if they changed."),
  };
  server.registerTool(
    "confluence_get_page_tables",
    {
      title: "Read tables from a Confluence page",
      description:
        "Reads every Storage-format table on a page without modifying it. Returns each table's zero-based index, " +
        "headers, column count, and zero-based rows as plain text. Call this before a table write so the table and target row " +
        "can be addressed safely.",
      inputSchema: { page_id: pageId },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ page_id }) => {
      try {
        const result = await getPageTables(client, page_id);
        return {
          content: [{ type: "text", text: `Found ${result.tables.length} table(s) on "${result.page.title}".\nPage ID: ${result.page.id}\nURL: ${result.page.webUrl}` }],
          structuredContent: { page_id: result.page.id, title: result.page.title, version: result.page.version, url: result.page.webUrl, tables: result.tables },
        };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: toToolError(error) }] };
      }
    },
  );

  server.registerTool(
    "confluence_insert_table_row",
    {
      title: "Insert a row into a Confluence table",
      description:
        "Inserts one Storage-XHTML row before the zero-based insert_at_row position. Use 0 for the first row and row_count " +
        "for the end. Read the tables first and pass the returned version, table index, and headers. Each cell is Storage XHTML " +
        "and the number of cells must equal the table's columns.",
      inputSchema: {
        page_id: pageId,
        expected_version: z.number().int().min(1).describe("Page version returned by confluence_get_page_tables."),
        ...tableIdentity,
        insert_at_row: z.number().int().min(0).describe("Zero-based position before which to insert; row_count appends."),
        cells: z.array(z.string()).min(1),
        version_message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ page_id, expected_version, table_index, expected_headers, insert_at_row, cells, version_message }) => {
      try {
        const result = await insertTableRow(client, {
          pageId: page_id,
          expectedVersion: expected_version,
          tableIndex: table_index,
          expectedHeaders: expected_headers,
          insertAtRow: insert_at_row,
          cells,
          ...(version_message === undefined ? {} : { versionMessage: version_message }),
        });
        return { content: [{ type: "text", text: `Inserted a row into table ${table_index} on "${result.page.title}".\nVersion: ${result.previousVersion} -> ${result.page.version}\nURL: ${result.page.webUrl}` }], structuredContent: { page_id: result.page.id, table_index, previous_version: result.previousVersion, version: result.page.version, url: result.page.webUrl } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: toToolError(error) }] };
      }
    },
  );

  server.registerTool(
    "confluence_insert_table_column",
    {
      title: "Insert a column into a Confluence table",
      description:
        "Inserts a complete column before the zero-based insert_at_column position across the header and every data row. " +
        "Use 0 for the first column and column_count for the end. Read the table first and pass one Storage-XHTML cell for " +
        "each current data row.",
      inputSchema: {
        page_id: pageId,
        expected_version: z.number().int().min(1).describe("Page version returned by confluence_get_page_tables."),
        ...tableIdentity,
        insert_at_column: z.number().int().min(0).describe("Zero-based position before which to insert; column_count appends."),
        header: z.string().min(1).describe("New header-cell content as well-formed Confluence Storage XHTML."),
        cells: z.array(z.string()).describe("New Storage-XHTML cells, in current data-row order; one value for every row."),
        version_message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ page_id, expected_version, table_index, expected_headers, insert_at_column, header, cells, version_message }) => {
      try {
        const result = await insertTableColumn(client, {
          pageId: page_id,
          expectedVersion: expected_version,
          tableIndex: table_index,
          expectedHeaders: expected_headers,
          insertAtColumn: insert_at_column,
          header,
          cells,
          ...(version_message === undefined ? {} : { versionMessage: version_message }),
        });
        return { content: [{ type: "text", text: `Inserted a column into table ${table_index} on "${result.page.title}".\nVersion: ${result.previousVersion} -> ${result.page.version}\nURL: ${result.page.webUrl}` }], structuredContent: { page_id: result.page.id, table_index, previous_version: result.previousVersion, version: result.page.version, url: result.page.webUrl } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: toToolError(error) }] };
      }
    },
  );

  server.registerTool(
    "confluence_update_table_cell",
    {
      title: "Update one cell in a Confluence table",
      description:
        "Replaces the Storage-XHTML content of one cell while preserving its existing cell element and attributes, such as " +
        "column width. Read the tables first and pass the returned version, table index, headers, row index, and column index.",
      inputSchema: {
        page_id: pageId,
        expected_version: z.number().int().min(1).describe("Page version returned by confluence_get_page_tables."),
        ...tableIdentity,
        row_index: z.number().int().min(0).describe("Zero-based data-row index returned by confluence_get_page_tables."),
        column_index: z.number().int().min(0).describe("Zero-based column index returned by confluence_get_page_tables."),
        content: z.string().min(1).describe("Replacement cell content as well-formed Confluence Storage XHTML."),
        version_message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ page_id, expected_version, table_index, expected_headers, row_index, column_index, content, version_message }) => {
      try {
        const result = await updateTableCell(client, {
          pageId: page_id,
          expectedVersion: expected_version,
          tableIndex: table_index,
          expectedHeaders: expected_headers,
          rowIndex: row_index,
          columnIndex: column_index,
          content,
          ...(version_message === undefined ? {} : { versionMessage: version_message }),
        });
        return { content: [{ type: "text", text: `Updated cell ${column_index} in row ${row_index} of table ${table_index} on "${result.page.title}".\nVersion: ${result.previousVersion} -> ${result.page.version}\nURL: ${result.page.webUrl}` }], structuredContent: { page_id: result.page.id, table_index, row_index, column_index, previous_version: result.previousVersion, version: result.page.version, url: result.page.webUrl } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: toToolError(error) }] };
      }
    },
  );

  server.registerTool(
    "confluence_delete_table_row",
    {
      title: "Delete one row from a Confluence table",
      description:
        "Deletes exactly one zero-based row from a Storage-format table. Read the tables first and pass the returned version, " +
        "table index, and headers. The operation is rejected if the page version or table headers changed.",
      inputSchema: {
        page_id: pageId,
        expected_version: z.number().int().min(1).describe("Page version returned by confluence_get_page_tables."),
        ...tableIdentity,
        row_index: z.number().int().min(0).describe("Zero-based data-row index returned by confluence_get_page_tables."),
        version_message: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ page_id, expected_version, table_index, expected_headers, row_index, version_message }) => {
      try {
        const result = await deleteTableRow(client, {
          pageId: page_id,
          expectedVersion: expected_version,
          tableIndex: table_index,
          expectedHeaders: expected_headers,
          rowIndex: row_index,
          ...(version_message === undefined ? {} : { versionMessage: version_message }),
        });
        return { content: [{ type: "text", text: `Deleted one row from table ${table_index} on "${result.page.title}".\nVersion: ${result.previousVersion} -> ${result.page.version}\nURL: ${result.page.webUrl}` }], structuredContent: { page_id: result.page.id, table_index, previous_version: result.previousVersion, version: result.page.version, url: result.page.webUrl } };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: toToolError(error) }] };
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

// Diagnostics go to stderr throughout: on the server path stdout carries the
// MCP protocol, and a stray line there breaks the client's parser.
runCommand(parseArgs(process.argv.slice(2)), {
  out: (message) => process.stdout.write(`${message}\n`),
  err: (message) => process.stderr.write(`${message}\n`),
  env: process.env,
  isInteractive: process.stdin.isTTY === true,
  startMcpServer,
})
  .then((code) => {
    // The server path resolves only when stdio closes; setting the code rather
    // than exiting lets it shut down on its own.
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof ConfigError ? error.message : String(error);
    process.stderr.write(`confluence-companion failed to start: ${message}\n`);
    process.exit(1);
  });
