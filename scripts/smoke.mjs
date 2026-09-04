import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const PAGE = process.argv[2];
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["dist/index.js"] }));

const call = async (label, args) => {
  const r = await client.callTool({ name: "confluence_append_page_content", arguments: args })
    .catch((e) => ({ isError: true, content: [{ text: `[schema] ${e.message}` }] }));
  const first = (r.content?.[0]?.text ?? "").split("\n").filter(Boolean)[0] ?? "";
  console.log(`${r.isError ? "ERROR" : "OK   "} | ${label}\n        ${first.slice(0, 175)}`);
  return r;
};

console.log("=== erwartet ABGELEHNT (keine Seitenänderung) ===");
await call("unclosed macro", { page_id: PAGE, content: "<ac:structured-macro" });
await call("unbalanced <p>", { page_id: PAGE, content: "<p>Text" });
await call("HTML void <br>", { page_id: PAGE, content: "<p>a<br>b</p>" });
await call("falsche Verschachtelung", { page_id: PAGE, content: "<p><b>x</p></b>" });
await call("nur Whitespace", { page_id: PAGE, content: "   " });

console.log("\n=== erwartet AKZEPTIERT ===");
await call("echtes Makro", { page_id: PAGE, content: '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>Valid macro.</p></ac:rich-text-body></ac:structured-macro>' });
await call("Entity + self-closing", { page_id: PAGE, content: "<p>a&nbsp;b<br/>c</p>" });
await call("mehrere Blöcke", { page_id: PAGE, content: "<p>eins</p><p>zwei</p>" });

await client.close();
