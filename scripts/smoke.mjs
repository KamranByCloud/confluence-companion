/**
 * Manual end-to-end check driving the server as a real MCP client.
 *
 * Usage: node scripts/smoke.mjs [--keep]
 *
 * Run this by hand, never from CI. It creates its own pages in the configured
 * space, writes to them through every tool, and deletes them again in a finally
 * block. Nothing else on the site is touched, so it needs no scratch page kept
 * alive between runs and no page IDs on the command line: the earlier version
 * took four of them, and three of those pages had silently disappeared.
 *
 * --keep leaves the created pages behind for inspection after a failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { loadConfig, loadConfigSources } from "../dist/config.js";

const keep = process.argv.includes("--keep");
// Same resolution the server performs at start-up: the per-user config file
// first, then the environment on top of it.
loadConfigSources();
const config = loadConfig();
const auth = `Basic ${Buffer.from(`${config.email}:${config.apiToken}`, "utf8").toString("base64")}`;

/** Direct REST, because the server deliberately exposes no page create or delete. */
async function api(method, path, body) {
  const response = await fetch(`${config.siteUrl}/wiki/api/v2${path}`, {
    method,
    headers: {
      Accept: "application/json",
      Authorization: auth,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> HTTP ${response.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}

// The target space is never hard-coded: this repository is public, and a space
// or page id identifies the site it belongs to. Pass them in the environment.
const SPACE_KEY = process.env.SMOKE_SPACE_KEY;
const PARENT_ID = process.env.SMOKE_PARENT_ID;
if (!SPACE_KEY && !process.env.SMOKE_SPACE_ID) {
  console.error("Set SMOKE_SPACE_KEY (or SMOKE_SPACE_ID) to the space the smoke pages may be created in.");
  console.error("Optionally set SMOKE_PARENT_ID to nest them under an existing page.");
  process.exit(2);
}
const SPACE_ID =
  process.env.SMOKE_SPACE_ID ??
  (await api("GET", `/spaces?keys=${encodeURIComponent(SPACE_KEY)}`)).results?.[0]?.id;
if (!SPACE_ID) {
  console.error(`No space found for key ${SPACE_KEY}.`);
  process.exit(2);
}


let failures = 0;
const created = [];

function check(condition, label, detail = "") {
  if (!condition) failures += 1;
  const line = detail ? `\n         ${String(detail).split("\n")[0].slice(0, 165)}` : "";
  console.log(`  ${condition ? "PASS" : "FAIL"} ${label}${line}`);
}

const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

/** Calls a tool and never throws: a schema rejection is a result like any other. */
async function tool(name, args) {
  return client
    .callTool({ name, arguments: args })
    .catch((error) => ({ isError: true, content: [{ text: `[schema] ${error.message}` }] }));
}

const firstLine = (result) => (result.content?.[0]?.text ?? "").split("\n").filter(Boolean)[0] ?? "";

async function accepts(name, label, args) {
  const result = await tool(name, args);
  check(!result.isError, label, result.isError ? firstLine(result) : "");
  return result;
}

async function rejects(name, label, args, pattern) {
  const result = await tool(name, args);
  const text = firstLine(result);
  const matched = result.isError && (pattern === undefined || pattern.test(text));
  check(matched, label, result.isError ? (matched ? "" : `unexpected message: ${text}`) : "was accepted");
  return result;
}

const readTables = async (pageId) => (await tool("confluence_get_page_tables", { page_id: pageId })).structuredContent;
const readBody = async (pageId) => (await api("GET", `/pages/${pageId}?body-format=storage`)).body.storage.value;

// One paragraph carries non-ASCII characters on purpose: Confluence rewrites
// them into named entities on save, and only a live page proves that the
// mismatch is reported as such rather than as a missing fragment.
const FIXTURE = [
  "<p>Smoke fixture. Created and deleted by scripts/smoke.mjs.</p>",
  "<h2>Smoke anchor heading</h2>",
  "<table><thead><tr><th><p>Item</p></th><th><p>Owner</p></th><th><p>Status</p></th></tr></thead><tbody>",
  "<tr><td><p>First</p></td><td><p>A</p></td><td><p>Ready</p></td></tr>",
  "<tr><td><p>Second</p></td><td><p>B</p></td><td><p>Pending</p></td></tr>",
  "</tbody></table>",
  "<p>Umlaut probe: angehängt — äöüß</p>",
  "<p>Repeated fragment</p><p>Repeated fragment</p>",
].join("");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

async function createPage(suffix, representation, value) {
  const page = await api("POST", "/pages", {
    spaceId: SPACE_ID,
    status: "current",
    title: `[TEST] Confluence Companion - Smoke ${stamp} ${suffix}`,
    ...(PARENT_ID ? { parentId: PARENT_ID } : {}),
    body: { representation, value },
  });
  created.push(page.id);
  return page.id;
}

try {
  const storagePage = await createPage("storage", "storage", FIXTURE);
  console.log(`\nSTORAGE (page ${storagePage})`);
  await accepts("confluence_append_page_content", "valid paragraph", { page_id: storagePage, content: "<p>Storage append.</p>" });
  await accepts("confluence_append_page_content", "macro round trip", {
    page_id: storagePage,
    content: '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>ok</p></ac:rich-text-body></ac:structured-macro>',
  });
  await rejects("confluence_append_page_content", "unclosed macro", { page_id: storagePage, content: "<ac:structured-macro" });
  await rejects("confluence_append_page_content", "unbalanced element", { page_id: storagePage, content: "<p>Text" });
  await rejects("confluence_append_page_content", "HTML void <br>", { page_id: storagePage, content: "<p>a<br>b</p>" });
  await rejects("confluence_append_page_content", "whitespace only", { page_id: storagePage, content: "   " });
  await rejects("confluence_append_page_content", "unknown page", { page_id: "999999999999", content: "<p>x</p>" });
  await rejects("confluence_append_page_content", "non-numeric page id", { page_id: "abc", content: "<p>x</p>" });
  await rejects("confluence_append_page_content", "unknown representation", {
    page_id: storagePage,
    representation: "markdown",
    content: "x",
  });

  console.log("\nCONFLICT (two concurrent appends, one must lose)");
  const race = await Promise.all([
    tool("confluence_append_page_content", { page_id: storagePage, content: "<p>race A</p>" }),
    tool("confluence_append_page_content", { page_id: storagePage, content: "<p>race B</p>" }),
  ]);
  const lost = race.filter((result) => result.isError);
  check(lost.length === 1, `exactly one append lost, got ${lost.length}`);
  if (lost.length === 1) check(/version conflict/i.test(firstLine(lost[0])), "the loser reported a version conflict", firstLine(lost[0]));

  console.log(`\nTARGETED EDITS (page ${storagePage})`);
  await accepts("confluence_prepend_page_content", "prepend", { page_id: storagePage, content: "<p>Prepended.</p>" });
  check((await readBody(storagePage)).startsWith("<p>Prepended.</p>"), "prepended content is first in the body");

  await accepts("confluence_insert_page_content", "insert after a unique anchor", {
    page_id: storagePage,
    anchor_content: "<h2>Smoke anchor heading</h2>",
    position: "after",
    content: "<p>Inserted after the heading.</p>",
  });
  check(
    (await readBody(storagePage)).includes("<h2>Smoke anchor heading</h2><p>Inserted after the heading.</p>"),
    "inserted content sits directly after the anchor",
  );
  await rejects(
    "confluence_insert_page_content",
    "missing anchor",
    { page_id: storagePage, anchor_content: "<h2>Nowhere</h2>", position: "after", content: "<p>x</p>" },
    /does not occur/,
  );
  await rejects(
    "confluence_insert_page_content",
    "repeated anchor",
    { page_id: storagePage, anchor_content: "<p>Repeated fragment</p>", position: "after", content: "<p>x</p>" },
    /more than once/,
  );

  await accepts("confluence_delete_page_content", "delete a unique fragment", {
    page_id: storagePage,
    target_content: "<p>Inserted after the heading.</p>",
  });
  check(!(await readBody(storagePage)).includes("Inserted after the heading."), "deleted fragment is gone from the body");
  await rejects(
    "confluence_delete_page_content",
    "repeated target",
    { page_id: storagePage, target_content: "<p>Repeated fragment</p>" },
    /more than once/,
  );
  // The characters below are what was written; Confluence stored named
  // entities. Only a live page can prove the diagnostic fires.
  await rejects(
    "confluence_delete_page_content",
    "target that differs only in entity encoding",
    { page_id: storagePage, target_content: "<p>Umlaut probe: angehängt — äöüß</p>" },
    /entities are decoded/,
  );
  await accepts("confluence_delete_page_content", "same target in its stored form", {
    page_id: storagePage,
    target_content: "<p>Umlaut probe: angeh&auml;ngt &mdash; &auml;&ouml;&uuml;&szlig;</p>",
  });

  console.log(`\nTABLES (page ${storagePage})`);
  const initial = await readTables(storagePage);
  const table = initial.tables?.[0];
  check(initial.tables?.length === 1 && table?.columnCount === 3, "fixture table is readable with three columns");
  check(table?.rows?.length === 2, "fixture table has two data rows");

  const marker = `CC-SMOKE-${Date.now()}`;
  await accepts("confluence_insert_table_row", "append a row at the end", {
    page_id: storagePage,
    expected_version: initial.version,
    table_index: 0,
    expected_headers: table.headers,
    insert_at_row: table.rows.length,
    cells: [`<p>${marker}</p>`, "<p>Smoke</p>", "<p>Temporary</p>"],
    version_message: "Smoke: insert temporary row",
  });
  const afterInsert = await readTables(storagePage);
  const row = afterInsert.tables[0].rows.find((candidate) => candidate.cells.includes(marker));
  check(row !== undefined && row.index === 2, "temporary row is readable at the end");

  await accepts("confluence_insert_table_row", "insert a row at position zero", {
    page_id: storagePage,
    expected_version: afterInsert.version,
    table_index: 0,
    expected_headers: afterInsert.tables[0].headers,
    insert_at_row: 0,
    cells: ["<p>Top</p>", "<p>Smoke</p>", "<p>Temporary</p>"],
    version_message: "Smoke: insert row at the top",
  });
  const afterTop = await readTables(storagePage);
  check(afterTop.tables[0].rows[0].cells[0] === "Top", "row zero is the new first row");

  await accepts("confluence_update_table_cell", "update one cell", {
    page_id: storagePage,
    expected_version: afterTop.version,
    table_index: 0,
    expected_headers: afterTop.tables[0].headers,
    row_index: 0,
    column_index: 2,
    content: "<p><strong>Geändert</strong></p>",
    version_message: "Smoke: update a cell",
  });
  const afterUpdate = await readTables(storagePage);
  check(afterUpdate.tables[0].rows[0].cells[2] === "Geändert", "updated cell reads back decoded, not as Ge&auml;ndert");

  await accepts("confluence_insert_table_column", "insert a column at the right edge", {
    page_id: storagePage,
    expected_version: afterUpdate.version,
    table_index: 0,
    expected_headers: afterUpdate.tables[0].headers,
    insert_at_column: afterUpdate.tables[0].columnCount,
    header: "<p>Note</p>",
    cells: afterUpdate.tables[0].rows.map(() => "<p>-</p>"),
    version_message: "Smoke: insert a column",
  });
  const afterColumn = await readTables(storagePage);
  check(afterColumn.tables[0].columnCount === 4, "table has four columns");
  check(afterColumn.tables[0].headers[3] === "Note", "new column carries its header");

  await rejects(
    "confluence_insert_table_column",
    "column with too few cells",
    {
      page_id: storagePage,
      expected_version: afterColumn.version,
      table_index: 0,
      expected_headers: afterColumn.tables[0].headers,
      insert_at_column: 0,
      header: "<p>Short</p>",
      cells: ["<p>only one</p>"],
      version_message: "Smoke: must be rejected",
    },
    /data rows/,
  );

  await accepts("confluence_delete_table_row", "delete the row that was added at the top", {
    page_id: storagePage,
    expected_version: afterColumn.version,
    table_index: 0,
    expected_headers: afterColumn.tables[0].headers,
    row_index: 0,
    version_message: "Smoke: remove the top row",
  });
  const afterDelete = await readTables(storagePage);
  check(afterDelete.tables[0].rows.length === afterColumn.tables[0].rows.length - 1, "one row fewer after the delete");
  check(!afterDelete.tables[0].rows.some((candidate) => candidate.cells[0] === "Top"), "the right row was removed");

  // Every table write is guarded by expected_version and expected_headers. The
  // unit tests cover the guard; these two prove it against the real API, which
  // the earlier smoke never did because it always read the version first.
  console.log("\nSTALE GUARDS (each write must refuse a stale read)");
  const current = await readTables(storagePage);
  const staleVersion = current.version - 1;
  const staleHeaders = current.tables[0].headers.map((header, index) => (index === 0 ? `${header} (stale)` : header));
  const guards = [
    ["confluence_insert_table_row", { insert_at_row: 0, cells: current.tables[0].headers.map(() => "<p>x</p>") }],
    ["confluence_update_table_cell", { row_index: 0, column_index: 0, content: "<p>x</p>" }],
    ["confluence_delete_table_row", { row_index: 0 }],
    [
      "confluence_insert_table_column",
      { insert_at_column: 0, header: "<p>x</p>", cells: current.tables[0].rows.map(() => "<p>x</p>") },
    ],
  ];
  for (const [name, extra] of guards) {
    const base = { page_id: storagePage, table_index: 0, version_message: "Smoke: must be rejected", ...extra };
    await rejects(name, `${name} refuses a stale version`, { ...base, expected_version: staleVersion, expected_headers: current.tables[0].headers }, /version/i);
    await rejects(name, `${name} refuses changed headers`, { ...base, expected_version: current.version, expected_headers: staleHeaders }, /header/i);
  }
  const untouched = await readTables(storagePage);
  check(untouched.version === current.version, "no stale write reached the page", `version ${current.version} -> ${untouched.version}`);

  const adfPage = await createPage(
    "adf",
    "atlas_doc_format",
    JSON.stringify({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "ADF fixture." }] }] }),
  );
  console.log(`\nATLAS_DOC_FORMAT (page ${adfPage})`);
  const node = { type: "paragraph", content: [{ type: "text", text: "ADF append." }] };
  const adf = (content) => ({ page_id: adfPage, representation: "atlas_doc_format", content });
  await accepts("confluence_append_page_content", "single node", adf(JSON.stringify(node)));
  await accepts("confluence_append_page_content", "array of nodes", adf(JSON.stringify([node, node])));
  await accepts("confluence_append_page_content", "whole doc", adf(JSON.stringify({ type: "doc", version: 1, content: [node] })));
  await rejects("confluence_append_page_content", "storage markup as ADF", adf("<p>nope</p>"));
  await rejects("confluence_append_page_content", "node without type", adf('[{"content":[]}]'));
  await rejects("confluence_append_page_content", "empty doc", adf('{"type":"doc","version":1,"content":[]}'));
} finally {
  await client.close().catch(() => {});
  if (keep) {
    console.log(`\nKEPT (--keep): ${created.join(", ") || "nothing was created"}`);
  } else {
    for (const id of created) {
      try {
        await api("DELETE", `/pages/${id}`);
        await api("DELETE", `/pages/${id}?purge=true`).catch(() => {});
        console.log(`\nCleaned up page ${id}`);
      } catch (error) {
        failures += 1;
        console.log(`\nFAIL could not delete page ${id}: ${error.message}`);
      }
    }
  }
}

console.log(`\n${failures === 0 ? "All checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
