/**
 * End-to-end check for the table tools, driving the server as a real MCP client.
 *
 * Usage: node scripts/table-smoke.mjs <storage-page-id>
 *
 * This writes a temporary row to table 0 and removes it again. The target must
 * contain the dedicated six-column test table documented in README.md.
 */
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [pageId] = process.argv.slice(2);
if (!pageId) {
  console.error("Usage: node scripts/table-smoke.mjs <storage-page-id>");
  process.exit(1);
}

const client = new Client({ name: "table-smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

const call = async (name, args) => {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) throw new Error(response.content?.[0]?.text ?? `Tool ${name} failed.`);
  return response.structuredContent;
};

try {
  const before = await call("confluence_get_page_tables", { page_id: pageId });
  assert.equal(before.tables.length, 1, "the table sandbox must contain exactly one table");
  const table = before.tables[0];
  assert.equal(table.columnCount, 6, "the table sandbox must have six columns");

  const marker = `CC-TABLE-SMOKE-${Date.now()}`;
  await call("confluence_insert_table_row", {
    page_id: pageId,
    expected_version: before.version,
    table_index: table.index,
    expected_headers: table.headers,
    insert_at_row: table.rows.length,
    cells: [
      "<p>2099-01-01</p>",
      "<p>Smoke test</p>",
      `<p>${marker}</p>`,
      "<p>None</p>",
      "<p>Temporary</p>",
      "<p>This row is removed by the smoke test.</p>",
    ],
    version_message: "Confluence Companion table smoke: insert temporary row",
  });

  const afterInsert = await call("confluence_get_page_tables", { page_id: pageId });
  const insertedTable = afterInsert.tables[table.index];
  const rowIndex = insertedTable.rows.find((row) => row.cells.includes(marker))?.index;
  assert.notEqual(rowIndex, undefined, "the temporary row must be readable after insertion");

  await call("confluence_delete_table_row", {
    page_id: pageId,
    expected_version: afterInsert.version,
    table_index: insertedTable.index,
    expected_headers: insertedTable.headers,
    row_index: rowIndex,
    version_message: "Confluence Companion table smoke: remove temporary row",
  });

  const afterDelete = await call("confluence_get_page_tables", { page_id: pageId });
  assert.equal(
    afterDelete.tables[table.index].rows.some((row) => row.cells.includes(marker)),
    false,
    "the temporary row must be gone after deletion",
  );
  console.log("all table checks passed");
} finally {
  await client.close();
}
