/**
 * End-to-end check driving the server as a real MCP client.
 *
 * Usage: node scripts/smoke.mjs <storage-page-id> [adf-page-id]
 *
 * This WRITES to the pages you name. Point it at scratch pages only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [storagePage, adfPage] = process.argv.slice(2);
if (!storagePage) {
  console.error("Usage: node scripts/smoke.mjs <storage-page-id> [adf-page-id]");
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

await client.close();
console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
