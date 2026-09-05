import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  appendPageContent,
  ContentValidationError,
  deletePageContent,
  DEFAULT_VERSION_MESSAGE,
  insertPageContent,
  prependPageContent,
  validateStorageContent,
} from "../dist/append.js";

const valid = (content) => validateStorageContent(content);
const rejects = (content) =>
  assert.throws(() => validateStorageContent(content), ContentValidationError);

describe("validateStorageContent", () => {
  it("accepts a simple paragraph", () => {
    assert.doesNotThrow(() => valid("<p>Text</p>"));
  });

  it("accepts multiple top-level blocks", () => {
    assert.doesNotThrow(() => valid("<p>one</p><p>two</p>"));
  });

  it("accepts namespaced Confluence macros", () => {
    assert.doesNotThrow(() =>
      valid(
        '<ac:structured-macro ac:name="info"><ac:rich-text-body><p>hi</p>' +
          "</ac:rich-text-body></ac:structured-macro>",
      ),
    );
  });

  it("accepts resource identifiers in the ri namespace", () => {
    assert.doesNotThrow(() => valid('<ac:image><ri:attachment ri:filename="a.png"/></ac:image>'));
  });

  it("accepts entities and self-closing tags", () => {
    assert.doesNotThrow(() => valid("<p>a&nbsp;b<br/>c</p>"));
  });

  it("accepts CDATA sections", () => {
    assert.doesNotThrow(() => valid("<ac:plain-text-body><![CDATA[code]]></ac:plain-text-body>"));
  });

  it("rejects empty content", () => rejects(""));
  it("rejects whitespace-only content", () => rejects("   \n\t "));

  // Regression guard: Confluence answers HTTP 200 for this and silently
  // rewrites it into a macro named "invalidmacro", corrupting the page.
  it("rejects an unclosed macro tag", () => rejects("<ac:structured-macro"));

  it("rejects an unbalanced element", () => rejects("<p>Text"));
  it("rejects wrongly nested elements", () => rejects("<p><b>x</p></b>"));
  it("rejects unbalanced CDATA", () => rejects("<ac:plain-text-body><![CDATA[code</ac:plain-text-body>"));

  it("rejects HTML void elements that XHTML requires to be self-closed", () => {
    for (const tag of ["br", "hr", "img"]) rejects(`<p>a<${tag}>b</p>`);
  });

  it("names the offending void element and its XHTML form", () => {
    assert.throws(
      () => valid("<p>a<br>b</p>"),
      (error) => /<br> must be written as <br\/>/.test(error.message),
    );
  });

  it("reports positions in the caller's own content, not the internal wrapper", () => {
    assert.throws(
      () => valid("<p>a<br>b</p>"),
      (error) => {
        const col = Number(/col (\d+)/.exec(error.message)?.[1]);
        // "<br>" starts at column 5 of the supplied fragment.
        assert.equal(col, 5, `expected column 5, got ${col} in: ${error.message}`);
        return true;
      },
    );
  });

  it("never leaks the internal root wrapper into the message", () => {
    assert.throws(
      () => valid("<p>Text"),
      (error) => !/root/.test(error.message),
    );
  });
});

/** Minimal stand-in for ConfluenceClient, recording what the append would write. */
function fakeClient(page, { onUpdate } = {}) {
  const calls = [];
  return {
    calls,
    async getPage(pageId, representation) {
      calls.push({ op: "get", pageId, representation });
      return { ...page };
    },
    async updatePageBody(args) {
      calls.push({ op: "update", ...args });
      if (onUpdate) onUpdate(args);
      return { ...args.page, body: args.newBody, version: args.expectedVersion + 1 };
    },
  };
}

const basePage = {
  id: "123",
  title: "Page",
  status: "current",
  spaceId: "9",
  version: 4,
  body: "<p>existing</p>",
  representation: "storage",
  webUrl: "https://example.atlassian.net/wiki/pages/123",
};

describe("appendPageContent", () => {
  it("appends after the existing body and preserves it verbatim", async () => {
    const client = fakeClient(basePage);
    const result = await appendPageContent(client, { pageId: "123", content: "<p>new</p>" });
    const update = client.calls.find((c) => c.op === "update");
    assert.ok(update.newBody.startsWith(basePage.body), "existing body must be preserved");
    assert.ok(update.newBody.endsWith("<p>new</p>"));
    assert.equal(result.appendedChars, "<p>new</p>".length);
  });

  it("writes at exactly current version + 1", async () => {
    const client = fakeClient(basePage);
    const result = await appendPageContent(client, { pageId: "123", content: "<p>new</p>" });
    assert.equal(client.calls.find((c) => c.op === "update").expectedVersion, 4);
    assert.equal(result.previousVersion, 4);
    assert.equal(result.page.version, 5);
  });

  it("requests the storage representation", async () => {
    const client = fakeClient(basePage);
    await appendPageContent(client, { pageId: "123", content: "<p>new</p>" });
    assert.equal(client.calls.find((c) => c.op === "get").representation, "storage");
  });

  it("separates blocks with a newline when the body does not end in one", async () => {
    const client = fakeClient(basePage);
    await appendPageContent(client, { pageId: "123", content: "<p>new</p>" });
    assert.equal(client.calls.find((c) => c.op === "update").newBody, "<p>existing</p>\n<p>new</p>");
  });

  it("does not add a second newline when the body already ends in one", async () => {
    const client = fakeClient({ ...basePage, body: "<p>existing</p>\n" });
    await appendPageContent(client, { pageId: "123", content: "<p>new</p>" });
    assert.equal(client.calls.find((c) => c.op === "update").newBody, "<p>existing</p>\n<p>new</p>");
  });

  it("appends without a separator to an empty body", async () => {
    const client = fakeClient({ ...basePage, body: "" });
    await appendPageContent(client, { pageId: "123", content: "<p>new</p>" });
    assert.equal(client.calls.find((c) => c.op === "update").newBody, "<p>new</p>");
  });

  it("uses the default version message when none is given", async () => {
    const client = fakeClient(basePage);
    await appendPageContent(client, { pageId: "123", content: "<p>new</p>" });
    assert.equal(client.calls.find((c) => c.op === "update").versionMessage, DEFAULT_VERSION_MESSAGE);
  });

  it("falls back to the default when the version message is blank", async () => {
    const client = fakeClient(basePage);
    await appendPageContent(client, { pageId: "123", content: "<p>new</p>", versionMessage: "   " });
    assert.equal(client.calls.find((c) => c.op === "update").versionMessage, DEFAULT_VERSION_MESSAGE);
  });

  it("passes a supplied version message through", async () => {
    const client = fakeClient(basePage);
    await appendPageContent(client, { pageId: "123", content: "<p>new</p>", versionMessage: "Weekly note" });
    assert.equal(client.calls.find((c) => c.op === "update").versionMessage, "Weekly note");
  });

  it("refuses pages that are not in the storage representation", async () => {
    const client = fakeClient({ ...basePage, representation: "atlas_doc_format" });
    await assert.rejects(
      appendPageContent(client, { pageId: "123", content: "<p>new</p>" }),
      ContentValidationError,
    );
  });

  it("validates before reading, so invalid content never triggers a request", async () => {
    const client = fakeClient(basePage);
    await assert.rejects(
      appendPageContent(client, { pageId: "123", content: "<p>broken" }),
      ContentValidationError,
    );
    assert.deepEqual(client.calls, [], "no request may be made for invalid content");
  });
});

describe("targeted Storage content operations", () => {
  it("prepends while preserving the existing body", async () => {
    const client = fakeClient(basePage);
    await prependPageContent(client, { pageId: "123", content: "<p>first</p>" });
    assert.equal(client.calls.find((c) => c.op === "update").newBody, "<p>first</p>\n<p>existing</p>");
  });

  it("inserts immediately before a unique anchor", async () => {
    const client = fakeClient({ ...basePage, body: "<p>before</p><h2>Anchor</h2><p>after</p>" });
    await insertPageContent(client, {
      pageId: "123",
      content: "<p>new</p>",
      anchorContent: "<h2>Anchor</h2>",
      position: "before",
    });
    assert.equal(client.calls.find((c) => c.op === "update").newBody, "<p>before</p><p>new</p><h2>Anchor</h2><p>after</p>");
  });

  it("inserts immediately after a unique anchor", async () => {
    const client = fakeClient({ ...basePage, body: "<h2>Anchor</h2><p>after</p>" });
    await insertPageContent(client, {
      pageId: "123",
      content: "<p>new</p>",
      anchorContent: "<h2>Anchor</h2>",
      position: "after",
    });
    assert.equal(client.calls.find((c) => c.op === "update").newBody, "<h2>Anchor</h2><p>new</p><p>after</p>");
  });

  it("rejects a missing anchor without writing", async () => {
    const client = fakeClient(basePage);
    await assert.rejects(
      insertPageContent(client, { pageId: "123", content: "<p>new</p>", anchorContent: "<h2>missing</h2>", position: "after" }),
      /anchor_content does not occur/,
    );
    assert.equal(client.calls.filter((c) => c.op === "update").length, 0);
  });

  it("rejects a repeated anchor without writing", async () => {
    const client = fakeClient({ ...basePage, body: "<h2>Anchor</h2><p>x</p><h2>Anchor</h2>" });
    await assert.rejects(
      insertPageContent(client, { pageId: "123", content: "<p>new</p>", anchorContent: "<h2>Anchor</h2>", position: "after" }),
      /occurs more than once/,
    );
    assert.equal(client.calls.filter((c) => c.op === "update").length, 0);
  });

  it("deletes exactly one unique fragment", async () => {
    const client = fakeClient({ ...basePage, body: "<p>keep</p><p>remove</p><p>keep too</p>" });
    await deletePageContent(client, { pageId: "123", targetContent: "<p>remove</p>" });
    assert.equal(client.calls.find((c) => c.op === "update").newBody, "<p>keep</p><p>keep too</p>");
  });

  it("names the entity rewrite when only the encoding differs, and writes nothing", async () => {
    // Confluence stored this paragraph after it was written as "angehängt — äöü".
    const stored = "<p>keep</p><p>angeh&auml;ngt &mdash; &auml;&ouml;&uuml;</p>";
    const client = fakeClient({ ...basePage, body: stored });
    await assert.rejects(
      deletePageContent(client, { pageId: "123", targetContent: "<p>angehängt — äöü</p>" }),
      /target_content occurs in the page body only once HTML entities are decoded/,
    );
    assert.equal(client.calls.filter((c) => c.op === "update").length, 0);
  });

  it("still reports a plainly absent fragment as absent", async () => {
    const client = fakeClient({ ...basePage, body: "<p>angeh&auml;ngt</p>" });
    await assert.rejects(
      deletePageContent(client, { pageId: "123", targetContent: "<p>nowhere near it</p>" }),
      /target_content does not occur in the page body\./,
    );
    assert.equal(client.calls.filter((c) => c.op === "update").length, 0);
  });

  it("names the entity rewrite for a mis-encoded insertion anchor too", async () => {
    const client = fakeClient({ ...basePage, body: "<h2>Ge&auml;ndert</h2><p>after</p>" });
    await assert.rejects(
      insertPageContent(client, { pageId: "123", content: "<p>new</p>", anchorContent: "<h2>Geändert</h2>", position: "after" }),
      /anchor_content occurs in the page body only once HTML entities are decoded/,
    );
    assert.equal(client.calls.filter((c) => c.op === "update").length, 0);
  });

  it("rejects a repeated deletion target without writing", async () => {
    const client = fakeClient({ ...basePage, body: "<p>remove</p><p>remove</p>" });
    await assert.rejects(
      deletePageContent(client, { pageId: "123", targetContent: "<p>remove</p>" }),
      /occurs more than once/,
    );
    assert.equal(client.calls.filter((c) => c.op === "update").length, 0);
  });

  it("validates inserted content before reading", async () => {
    const client = fakeClient(basePage);
    await assert.rejects(
      insertPageContent(client, { pageId: "123", content: "<p>broken", anchorContent: "<p>existing</p>", position: "after" }),
      ContentValidationError,
    );
    assert.deepEqual(client.calls, []);
  });
});
