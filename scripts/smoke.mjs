/**
 * End-to-end check driving the server as a real MCP client.
 *
 * Usage: node scripts/smoke.mjs <storage-page-id> [adf-page-id] [table-page-id] [column-page-id]
 *
 * This WRITES to the pages you name. Point it at scratch pages only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [storagePage, adfPage, tablePage, columnPage] = process.argv.slice(2);
if (!storagePage) {
  console.error("Usage: node scripts/smoke.mjs <storage-page-id> [adf-page-id] [table-page-id] [column-page-id]");
  process.exit(1);
}

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

let failures = 0;
const call = async (expect, label, args) => {
  const r = await client
    .callTool({ name: "confluence_append_page_content", arguments: args })
    .catch((e) => ({ isError: true, content: [{ text: `[schema] ${e.message}` }] }));
  const got = r.isError ? "reject" : "accept";
  const line = (r.content?.[0]?.text ?? "").split("\n").filter(Boolean)[0] ?? "";
  if (got !== expect) failures += 1;
  console.log(`  ${got === expect ? "PASS" : "FAIL"} ${label}\n         ${line.slice(0, 165)}`);
  return r;
};

console.log(`\nSTORAGE (page ${storagePage})`);
await call("accept", "valid paragraph", { page_id: storagePage, content: "<p>Storage append.</p>" });
await call("accept", "macro round trip", {
  page_id: storagePage,
  content: '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>ok</p></ac:rich-text-body></ac:structured-macro>',
});
await call("reject", "unclosed macro", { page_id: storagePage, content: "<ac:structured-macro" });
await call("reject", "unbalanced element", { page_id: storagePage, content: "<p>Text" });
await call("reject", "HTML void <br>", { page_id: storagePage, content: "<p>a<br>b</p>" });
await call("reject", "whitespace only", { page_id: storagePage, content: "   " });
await call("reject", "unknown page", { page_id: "999999999999", content: "<p>x</p>" });
await call("reject", "non-numeric page id", { page_id: "abc", content: "<p>x</p>" });
await call("reject", "unknown representation", { page_id: storagePage, representation: "markdown", content: "x" });

console.log("\nCONFLICT (two concurrent appends, one must lose)");
const race = await Promise.all([
  client.callTool({ name: "confluence_append_page_content", arguments: { page_id: storagePage, content: "<p>race A</p>" } }),
  client.callTool({ name: "confluence_append_page_content", arguments: { page_id: storagePage, content: "<p>race B</p>" } }),
]);
const lost = race.filter((r) => r.isError);
if (lost.length !== 1) {
  failures += 1;
  console.log(`  FAIL expected exactly one conflict, got ${lost.length}`);
} else {
  const conflict = /version conflict/i.test(lost[0].content?.[0]?.text ?? "");
  if (!conflict) failures += 1;
  console.log(`  ${conflict ? "PASS" : "FAIL"} one append won, the other reported a version conflict`);
}

if (adfPage) {
  console.log(`\nATLAS_DOC_FORMAT (page ${adfPage})`);
  const node = { type: "paragraph", content: [{ type: "text", text: "ADF append." }] };
  await call("accept", "single node", { page_id: adfPage, representation: "atlas_doc_format", content: JSON.stringify(node) });
  await call("accept", "array of nodes", { page_id: adfPage, representation: "atlas_doc_format", content: JSON.stringify([node, node]) });
  await call("accept", "whole doc", { page_id: adfPage, representation: "atlas_doc_format", content: JSON.stringify({ type: "doc", version: 1, content: [node] }) });
  await call("reject", "storage markup as ADF", { page_id: adfPage, representation: "atlas_doc_format", content: "<p>nope</p>" });
  await call("reject", "node without type", { page_id: adfPage, representation: "atlas_doc_format", content: '[{"content":[]}]' });
  await call("reject", "empty doc", { page_id: adfPage, representation: "atlas_doc_format", content: '{"type":"doc","version":1,"content":[]}' });
} else {
  console.log("\nATLAS_DOC_FORMAT skipped (no adf-page-id given)");
}

if (tablePage) {
  console.log(`\nTABLES (page ${tablePage})`);
  const tables = await client.callTool({ name: "confluence_get_page_tables", arguments: { page_id: tablePage } });
  if (tables.isError) {
    failures += 1;
    console.log(`  FAIL read tables\n         ${(tables.content?.[0]?.text ?? "").split("\n")[0]}`);
  } else {
    const page = tables.structuredContent;
    const table = page.tables?.[0];
    if (page.tables?.length !== 1 || table?.columnCount !== 6) {
      failures += 1;
      console.log("  FAIL table sandbox must contain exactly one six-column table");
    } else {
      const marker = `CC-TABLE-SMOKE-${Date.now()}`;
      const inserted = await client.callTool({
        name: "confluence_insert_table_row",
        arguments: {
          page_id: tablePage,
          expected_version: page.version,
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
        },
      });
      if (inserted.isError) {
        failures += 1;
        console.log(`  FAIL insert temporary row\n         ${(inserted.content?.[0]?.text ?? "").split("\n")[0]}`);
      } else {
        const afterInsert = await client.callTool({ name: "confluence_get_page_tables", arguments: { page_id: tablePage } });
        const afterPage = afterInsert.structuredContent;
        const afterTable = afterPage.tables?.[table.index];
        const rowIndex = afterTable?.rows?.find((row) => row.cells.includes(marker))?.index;
        if (afterInsert.isError || rowIndex === undefined) {
          failures += 1;
          console.log("  FAIL temporary row was not readable after insertion");
        } else {
          const updated = await client.callTool({
            name: "confluence_update_table_cell",
            arguments: {
              page_id: tablePage,
              expected_version: afterPage.version,
              table_index: afterTable.index,
              expected_headers: afterTable.headers,
              row_index: rowIndex,
              column_index: 4,
              content: '<p><span data-type="status" data-color="green">Updated</span></p>',
              version_message: "Confluence Companion table smoke: update temporary cell",
            },
          });
          if (updated.isError) {
            failures += 1;
            console.log(`  FAIL update temporary cell\n         ${(updated.content?.[0]?.text ?? "").split("\n")[0]}`);
          } else {
            const afterUpdate = await client.callTool({ name: "confluence_get_page_tables", arguments: { page_id: tablePage } });
            const updatedPage = afterUpdate.structuredContent;
            const updatedTable = updatedPage.tables?.[table.index];
            const updatedRow = updatedTable?.rows?.find((row) => row.cells.includes(marker));
            if (afterUpdate.isError || updatedRow?.cells?.[4] !== "Updated") {
              failures += 1;
              console.log("  FAIL temporary cell was not readable after update");
            } else {
              const deleted = await client.callTool({
                name: "confluence_delete_table_row",
                arguments: {
                  page_id: tablePage,
                  expected_version: updatedPage.version,
                  table_index: updatedTable.index,
                  expected_headers: updatedTable.headers,
                  row_index: updatedRow.index,
                  version_message: "Confluence Companion table smoke: remove temporary row",
                },
              });
              if (deleted.isError) {
                failures += 1;
                console.log(`  FAIL remove temporary row\n         ${(deleted.content?.[0]?.text ?? "").split("\n")[0]}`);
              } else {
                console.log("  PASS temporary row inserted, cell updated, read, and removed");
              }
            }
          }
        }
      }
    }
  }
} else {
  console.log("\nTABLES skipped (no table-page-id given)");
}

if (columnPage) {
  console.log(`\nCOLUMNS (page ${columnPage})`);
  const before = await client.callTool({ name: "confluence_get_page_tables", arguments: { page_id: columnPage } });
  const page = before.structuredContent;
  const table = page.tables?.[0];
  if (before.isError || page.tables?.length !== 1 || table?.columnCount !== 2 || table.rows?.length !== 1) {
    failures += 1;
    console.log("  FAIL column sandbox must contain one two-column table with one data row");
  } else {
    const top = await client.callTool({
      name: "confluence_insert_table_row",
      arguments: {
        page_id: columnPage,
        expected_version: page.version,
        table_index: table.index,
        expected_headers: table.headers,
        insert_at_row: 0,
        cells: ["<p>Top row</p>", "<p>New</p>"],
        version_message: "Confluence Companion column smoke: insert top row",
      },
    });
    if (top.isError) {
      failures += 1;
      console.log(`  FAIL insert top row\n         ${(top.content?.[0]?.text ?? "").split("\n")[0]}`);
    } else {
      const afterTop = await client.callTool({ name: "confluence_get_page_tables", arguments: { page_id: columnPage } });
      const topPage = afterTop.structuredContent;
      const topTable = topPage.tables?.[0];
      const column = await client.callTool({
        name: "confluence_insert_table_column",
        arguments: {
          page_id: columnPage,
          expected_version: topPage.version,
          table_index: topTable.index,
          expected_headers: topTable.headers,
          insert_at_column: 1,
          header: "<p>Owner</p>",
          cells: ["<p>Top owner</p>", "<p>Baseline owner</p>"],
          version_message: "Confluence Companion column smoke: insert column",
        },
      });
      if (afterTop.isError || column.isError) {
        failures += 1;
        console.log(`  FAIL insert column\n         ${(column.content?.[0]?.text ?? "").split("\n")[0]}`);
      } else {
        const afterColumn = await client.callTool({ name: "confluence_get_page_tables", arguments: { page_id: columnPage } });
        const columnPageResult = afterColumn.structuredContent;
        const columnTable = columnPageResult.tables?.[0];
        const middle = await client.callTool({
          name: "confluence_insert_table_row",
          arguments: {
            page_id: columnPage,
            expected_version: columnPageResult.version,
            table_index: columnTable.index,
            expected_headers: columnTable.headers,
            insert_at_row: 1,
            cells: ["<p>Middle row</p>", "<p>Middle owner</p>", "<p>Pending</p>"],
            version_message: "Confluence Companion column smoke: insert middle row",
          },
        });
        if (afterColumn.isError || middle.isError) {
          failures += 1;
          console.log(`  FAIL insert middle row\n         ${(middle.content?.[0]?.text ?? "").split("\n")[0]}`);
        } else {
          const final = await client.callTool({ name: "confluence_get_page_tables", arguments: { page_id: columnPage } });
          const finalTable = final.structuredContent.tables?.[0];
          const expectedRows = ["Top row", "Middle row", "Baseline"];
          const passed =
            !final.isError &&
            JSON.stringify(finalTable?.headers) === JSON.stringify(["Item", "Owner", "Status"]) &&
            JSON.stringify(finalTable?.rows?.map((row) => row.cells[0])) === JSON.stringify(expectedRows);
          if (!passed) failures += 1;
          console.log(`  ${passed ? "PASS" : "FAIL"} top row, column, then middle row`);
        }
      }
    }
  }
} else {
  console.log("\nCOLUMNS skipped (no column-page-id given)");
}

await client.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
