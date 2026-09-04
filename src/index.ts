#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  ADF,
  appendPageContent,
  ContentValidationError,
  STORAGE,
  SUPPORTED_REPRESENTATIONS,
} from "./append.js";
import { ConfigError, loadConfig, loadDotEnvIfPresent } from "./config.js";
import { ConfluenceApiError, ConfluenceClient, VersionConflictError } from "./confluence.js";

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

async function main(): Promise<void> {
  loadDotEnvIfPresent();
  const client = new ConfluenceClient(loadConfig());

  const server = new McpServer(
    { name: "confluence-companion", version: "0.1.0" },
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

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // stdout carries the MCP protocol, so diagnostics must go to stderr.
  const message = error instanceof ConfigError ? error.message : String(error);
  process.stderr.write(`confluence-companion failed to start: ${message}\n`);
  process.exit(1);
});
