import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ADF, appendPageContent, ContentValidationError, parseAdfContent } from "../dist/append.js";

const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });

describe("parseAdfContent", () => {
  it("takes the content array out of a whole doc", () => {
    const nodes = parseAdfContent(JSON.stringify({ type: "doc", version: 1, content: [para("a"), para("b")] }));
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0].type, "paragraph");
  });

  it("accepts a bare array of nodes", () => {
    assert.equal(parseAdfContent(JSON.stringify([para("a")])).length, 1);
  });

  it("accepts a single node", () => {
    assert.equal(parseAdfContent(JSON.stringify(para("a")))[0].type, "paragraph");
  });

  it("preserves node fields untouched", () => {
    const node = { type: "panel", attrs: { panelType: "info" }, content: [para("x")] };
    assert.deepEqual(parseAdfContent(JSON.stringify(node))[0], node);
  });

  it("rejects empty content", () => {
    assert.throws(() => parseAdfContent("   "), ContentValidationError);
  });

  it("rejects content that is not JSON, naming the format", () => {
    assert.throws(
      () => parseAdfContent("<p>storage markup</p>"),
      (error) => error instanceof ContentValidationError && /not valid JSON/.test(error.message),
    );
  });

  it("rejects a doc with no nodes", () => {
    assert.throws(
      () => parseAdfContent(JSON.stringify({ type: "doc", version: 1, content: [] })),
      /no Atlassian Document Format nodes/,
    );
  });

  it("rejects an empty array", () => {
    assert.throws(() => parseAdfContent("[]"), /no Atlassian Document Format nodes/);
  });

  it("rejects a node without a type, naming its position", () => {
    assert.throws(
      () => parseAdfContent(JSON.stringify([para("a"), { content: [] }])),
      /node at position 1 is not an object with a non-empty "type"/,
    );
  });

  it("rejects a node whose type is empty or not a string", () => {
    assert.throws(() => parseAdfContent(JSON.stringify([{ type: "" }])), ContentValidationError);
    assert.throws(() => parseAdfContent(JSON.stringify([{ type: 7 }])), ContentValidationError);
  });

  it("rejects JSON primitives", () => {
    for (const raw of ['"text"', "42", "null", "true"]) {
      assert.throws(() => parseAdfContent(raw), ContentValidationError);
    }
  });
});

function fakeClient(page) {
  const calls = [];
  return {
    calls,
    async getPage(pageId, representation) {
      calls.push({ op: "get", pageId, representation });
      return { ...page };
    },
    async updatePageBody(args) {
      calls.push({ op: "update", ...args });
      return { ...args.page, body: args.newBody, version: args.expectedVersion + 1 };
    },
  };
}

const adfPage = {
  id: "123",
  title: "Page",
  status: "current",
  spaceId: "9",
  version: 3,
  body: JSON.stringify({ type: "doc", version: 1, content: [para("existing")] }),
  representation: ADF,
  webUrl: "https://example.atlassian.net/wiki/pages/123",
};

const writtenDoc = (client) => JSON.parse(client.calls.find((c) => c.op === "update").newBody);

describe("appendPageContent in atlas_doc_format", () => {
  it("appends nodes after the existing ones", async () => {
    const client = fakeClient(adfPage);
    await appendPageContent(client, {
      pageId: "123",
      content: JSON.stringify(para("added")),
      representation: ADF,
    });
    const doc = writtenDoc(client);
    assert.equal(doc.content.length, 2);
    assert.equal(doc.content[0].content[0].text, "existing");
    assert.equal(doc.content[1].content[0].text, "added");
  });

  it("keeps the document type and version fields intact", async () => {
    const client = fakeClient(adfPage);
    await appendPageContent(client, {
      pageId: "123",
      content: JSON.stringify(para("added")),
      representation: ADF,
    });
    const doc = writtenDoc(client);
    assert.equal(doc.type, "doc");
    assert.equal(doc.version, 1);
  });

  it("reads and writes the same representation, never crossing formats", async () => {
    const client = fakeClient(adfPage);
    await appendPageContent(client, {
      pageId: "123",
      content: JSON.stringify(para("added")),
      representation: ADF,
    });
    assert.equal(client.calls.find((c) => c.op === "get").representation, ADF);
    assert.equal(client.calls.find((c) => c.op === "update").page.representation, ADF);
  });

  it("reports how many nodes were appended", async () => {
    const client = fakeClient(adfPage);
    const result = await appendPageContent(client, {
      pageId: "123",
      content: JSON.stringify([para("a"), para("b")]),
      representation: ADF,
    });
    assert.equal(result.appendedNodes, 2);
  });

  it("leaves appendedNodes undefined for storage appends", async () => {
    const client = fakeClient({ ...adfPage, representation: "storage", body: "<p>x</p>" });
    const result = await appendPageContent(client, { pageId: "123", content: "<p>y</p>" });
    assert.equal(result.appendedNodes, undefined);
  });

  it("still writes at version + 1", async () => {
    const client = fakeClient(adfPage);
    const result = await appendPageContent(client, {
      pageId: "123",
      content: JSON.stringify(para("added")),
      representation: ADF,
    });
    assert.equal(client.calls.find((c) => c.op === "update").expectedVersion, 3);
    assert.equal(result.page.version, 4);
  });

  it("appends into a document that has no content array yet", async () => {
    const client = fakeClient({ ...adfPage, body: JSON.stringify({ type: "doc", version: 1 }) });
    await appendPageContent(client, {
      pageId: "123",
      content: JSON.stringify(para("added")),
      representation: ADF,
    });
    assert.equal(writtenDoc(client).content.length, 1);
  });

  it("refuses to append when the stored body is not a valid ADF document", async () => {
    const client = fakeClient({ ...adfPage, body: "not json" });
    await assert.rejects(
      appendPageContent(client, {
        pageId: "123",
        content: JSON.stringify(para("added")),
        representation: ADF,
      }),
      /not valid JSON/,
    );
  });

  it("refuses a stored body that is JSON but not a doc", async () => {
    const client = fakeClient({ ...adfPage, body: JSON.stringify({ type: "paragraph" }) });
    await assert.rejects(
      appendPageContent(client, {
        pageId: "123",
        content: JSON.stringify(para("added")),
        representation: ADF,
      }),
      /not an Atlassian Document Format document/,
    );
  });

  it("validates before reading, so bad ADF never causes a request", async () => {
    const client = fakeClient(adfPage);
    await assert.rejects(
      appendPageContent(client, { pageId: "123", content: "<p>not adf</p>", representation: ADF }),
      ContentValidationError,
    );
    assert.deepEqual(client.calls, []);
  });

  it("rejects a representation mismatch from the API instead of writing", async () => {
    const client = fakeClient({ ...adfPage, representation: "storage" });
    await assert.rejects(
      appendPageContent(client, {
        pageId: "123",
        content: JSON.stringify(para("added")),
        representation: ADF,
      }),
      ContentValidationError,
    );
    assert.ok(!client.calls.some((c) => c.op === "update"), "must not write on mismatch");
  });

  it("defaults to storage when no representation is given", async () => {
    const client = fakeClient({ ...adfPage, representation: "storage", body: "<p>x</p>" });
    await appendPageContent(client, { pageId: "123", content: "<p>y</p>" });
    assert.equal(client.calls.find((c) => c.op === "get").representation, "storage");
  });
});
