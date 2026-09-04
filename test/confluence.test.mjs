import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  ConfluenceApiError,
  ConfluenceClient,
  VersionConflictError,
} from "../dist/confluence.js";

const config = {
  siteUrl: "https://example.atlassian.net",
  email: "user@example.com",
  apiToken: "secret-token",
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Replaces fetch with a recorder returning the queued responses in order. */
function stubFetch(...responses) {
  const calls = [];
  const queue = [...responses];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift() ?? { status: 200, body: {} };
    if (next.throws) throw next.throws;
    return new Response(typeof next.body === "string" ? next.body : JSON.stringify(next.body), {
      status: next.status,
    });
  };
  return calls;
}

const pagePayload = {
  id: "123",
  title: "My Page",
  status: "current",
  spaceId: "9",
  version: { number: 7 },
  body: { storage: { value: "<p>body</p>", representation: "storage" } },
  _links: { base: "https://example.atlassian.net/wiki", webui: "/spaces/X/pages/123/My+Page" },
};

describe("ConfluenceClient.getPage", () => {
  it("requests the v2 page endpoint with the requested body format", async () => {
    const calls = stubFetch({ status: 200, body: pagePayload });
    await new ConfluenceClient(config).getPage("123", "storage");
    assert.equal(
      calls[0].url,
      "https://example.atlassian.net/wiki/api/v2/pages/123?body-format=storage",
    );
    assert.equal(calls[0].init.method, "GET");
  });

  it("sends Basic authentication built from email and token", async () => {
    const calls = stubFetch({ status: 200, body: pagePayload });
    await new ConfluenceClient(config).getPage("123", "storage");
    const expected = `Basic ${Buffer.from("user@example.com:secret-token").toString("base64")}`;
    assert.equal(calls[0].init.headers.Authorization, expected);
  });

  it("percent-encodes the page id", async () => {
    const calls = stubFetch({ status: 200, body: pagePayload });
    await new ConfluenceClient(config).getPage("1 2/3", "storage");
    assert.ok(calls[0].url.includes("/pages/1%202%2F3?"), calls[0].url);
  });

  it("maps the payload onto the page shape", async () => {
    stubFetch({ status: 200, body: pagePayload });
    const page = await new ConfluenceClient(config).getPage("123", "storage");
    assert.deepEqual(
      { id: page.id, title: page.title, version: page.version, body: page.body },
      { id: "123", title: "My Page", version: 7, body: "<p>body</p>" },
    );
  });

  it("builds the web URL from the returned links", async () => {
    stubFetch({ status: 200, body: pagePayload });
    const page = await new ConfluenceClient(config).getPage("123", "storage");
    assert.equal(page.webUrl, "https://example.atlassian.net/wiki/spaces/X/pages/123/My+Page");
  });

  it("falls back to a page URL when no links are returned", async () => {
    stubFetch({ status: 200, body: { ...pagePayload, _links: undefined } });
    const page = await new ConfluenceClient(config).getPage("123", "storage");
    assert.equal(page.webUrl, "https://example.atlassian.net/wiki/pages/123");
  });

  it("fails clearly when the requested representation is absent", async () => {
    stubFetch({ status: 200, body: { ...pagePayload, body: { atlas_doc_format: { value: "{}" } } } });
    await assert.rejects(new ConfluenceClient(config).getPage("123", "storage"), /no 'storage' body/);
  });

  it("fails when the version is missing rather than guessing one", async () => {
    stubFetch({ status: 200, body: { ...pagePayload, version: undefined } });
    await assert.rejects(new ConfluenceClient(config).getPage("123", "storage"), /missing id, title, or version/);
  });
});

describe("ConfluenceClient error reporting", () => {
  it("raises ConfluenceApiError carrying the status", async () => {
    stubFetch({ status: 404, body: { errors: [{ title: "Cannot find a page with id [9]" }] } });
    await assert.rejects(new ConfluenceClient(config).getPage("9", "storage"), (error) => {
      assert.ok(error instanceof ConfluenceApiError);
      assert.equal(error.status, 404);
      assert.match(error.message, /Cannot find a page with id \[9\]/);
      return true;
    });
  });

  it("combines error title and detail", async () => {
    stubFetch({ status: 400, body: { errors: [{ title: "Bad body", detail: "line 3" }] } });
    await assert.rejects(new ConfluenceClient(config).getPage("9", "storage"), /Bad body - line 3/);
  });

  it("falls back to the message field", async () => {
    stubFetch({ status: 403, body: { message: "Forbidden here" } });
    await assert.rejects(new ConfluenceClient(config).getPage("9", "storage"), /Forbidden here/);
  });

  it("handles a non-JSON error body", async () => {
    stubFetch({ status: 502, body: "upstream exploded" });
    await assert.rejects(new ConfluenceClient(config).getPage("9", "storage"), /upstream exploded/);
  });

  it("reports an unreachable site instead of a bare network error", async () => {
    stubFetch({ throws: new Error("ENOTFOUND") });
    await assert.rejects(
      new ConfluenceClient(config).getPage("9", "storage"),
      /Could not reach https:\/\/example\.atlassian\.net/,
    );
  });
});

describe("ConfluenceClient.updatePageBody", () => {
  const page = {
    id: "123",
    title: "My Page",
    status: "current",
    spaceId: "9",
    version: 7,
    body: "<p>body</p>",
    representation: "storage",
    webUrl: "https://example.atlassian.net/wiki/pages/123",
  };

  it("sends the full body at the next version number", async () => {
    const calls = stubFetch({ status: 200, body: { ...pagePayload, version: { number: 8 } } });
    await new ConfluenceClient(config).updatePageBody({
      page,
      newBody: "<p>body</p><p>added</p>",
      expectedVersion: 7,
      versionMessage: "note",
    });
    const sent = JSON.parse(calls[0].init.body);
    assert.equal(calls[0].init.method, "PUT");
    assert.deepEqual(sent, {
      id: "123",
      status: "current",
      title: "My Page",
      body: { representation: "storage", value: "<p>body</p><p>added</p>" },
      version: { number: 8, message: "note" },
    });
  });

  it("translates HTTP 409 into a version conflict", async () => {
    stubFetch({
      status: 409,
      body: { errors: [{ title: "Version must be incremented when updating a page." }] },
    });
    await assert.rejects(
      new ConfluenceClient(config).updatePageBody({
        page,
        newBody: "<p>x</p>",
        expectedVersion: 7,
        versionMessage: "note",
      }),
      (error) => {
        assert.ok(error instanceof VersionConflictError);
        assert.equal(error.pageId, "123");
        assert.equal(error.attemptedVersion, 8);
        assert.match(error.message, /was modified after it was read/);
        return true;
      },
    );
  });

  it("leaves other error statuses as API errors", async () => {
    stubFetch({ status: 400, body: { message: "bad" } });
    await assert.rejects(
      new ConfluenceClient(config).updatePageBody({
        page,
        newBody: "<p>x</p>",
        expectedVersion: 7,
        versionMessage: "note",
      }),
      (error) => error instanceof ConfluenceApiError && !(error instanceof VersionConflictError),
    );
  });
});
