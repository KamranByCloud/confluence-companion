import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deleteTableRow,
  getPageTables,
  insertTableRow,
  insertTableColumn,
  TableValidationError,
  updateTableCell,
} from "../dist/tables.js";

// Reduced fixture from the Change-, Backlog- und Release-Register's first table.
const registerTable = `<table><thead><tr><th><p>Datum</p></th><th><p>Typ</p></th><th><p>Backlog / Thema</p></th><th><p>PR / Branch</p></th><th><p>Status</p></th><th><p>Scope und Ergebnis</p></th></tr></thead><tbody><tr><td><p>2026-09-04</p></td><td><p>Maintenance</p></td><td><p>OMN-371<br/>Lokale Caddy-Domain in Django freigeben</p></td><td><p>#501</p></td><td><p>Gemerged</p></td><td><p>Browser-Login-Smoke offen.</p></td></tr><tr><td><p>2026-09-04</p></td><td><p>Runtime-Haertung</p></td><td><p>OMN-370<br/>Redis-Image-Pinning</p></td><td><p>Kein PR</p></td><td><p>Backlog</p></td><td><p>Stage- und Rollback-Nachweise.</p></td></tr><tr><td><p>2026-09-03</p></td><td><p>Upgrade</p></td><td><p>OMN-360<br/>django-redis 7</p></td><td><p>#503</p></td><td><p>Gemerged</p></td><td><p>Deployment-Nachweis offen.</p></td></tr></tbody></table>`;
const page = { id: "123", title: "Register", status: "current", spaceId: "9", version: 4, body: `<p>Intro</p>${registerTable}`, representation: "storage", webUrl: "https://example.test/pages/123" };
const headers = ["Datum", "Typ", "Backlog / Thema", "PR / Branch", "Status", "Scope und Ergebnis"];

function fakeClient(initial = page) {
  const calls = [];
  return {
    calls,
    async getPage() { return { ...initial }; },
    async updatePageBody(args) { calls.push(args); return { ...args.page, body: args.newBody, version: args.expectedVersion + 1 }; },
  };
}

const newCells = ["<p>2026-09-05</p>", "<p>Test</p>", "<p>OMN-999</p>", "<p>Kein PR</p>", "<p>Backlog</p>", "<p>Test row</p>"];

describe("Confluence storage tables", () => {
  it("lists headers, zero-based row indexes, and text cells from the register table", async () => {
    const result = await getPageTables(fakeClient(), "123");
    assert.deepEqual(result.tables[0].headers, headers);
    assert.equal(result.tables[0].columnCount, 6);
    assert.equal(result.tables[0].rows[0].index, 0);
    assert.equal(result.tables[0].rows[0].cells[2], "OMN-371\nLokale Caddy-Domain in Django freigeben");
  });

  it("recognizes a Confluence table whose header row is in tbody", async () => {
    const tbodyHeader = page.body.replace("<thead>", "<tbody>").replace("</thead><tbody>", "");
    const result = await getPageTables(fakeClient({ ...page, body: tbodyHeader }), "123");
    assert.deepEqual(result.tables[0].headers, headers);
    assert.equal(result.tables[0].rows.length, 3);
  });

  it("inserts at row zero before the first existing row", async () => {
    const client = fakeClient();
    await insertTableRow(client, { pageId: "123", expectedVersion: 4, tableIndex: 0, expectedHeaders: headers, insertAtRow: 0, cells: newCells });
    assert.ok(client.calls[0].newBody.indexOf("OMN-999") < client.calls[0].newBody.indexOf("OMN-371"));
  });

  it("inserts before an arbitrary row and after the final row", async () => {
    const middle = fakeClient();
    await insertTableRow(middle, { pageId: "123", expectedVersion: 4, tableIndex: 0, expectedHeaders: headers, insertAtRow: 1, cells: newCells });
    assert.ok(middle.calls[0].newBody.indexOf("OMN-371") < middle.calls[0].newBody.indexOf("OMN-999"));
    assert.ok(middle.calls[0].newBody.indexOf("OMN-999") < middle.calls[0].newBody.indexOf("OMN-370"));

    const last = fakeClient();
    await insertTableRow(last, { pageId: "123", expectedVersion: 4, tableIndex: 0, expectedHeaders: headers, insertAtRow: 3, cells: newCells });
    assert.ok(last.calls[0].newBody.indexOf("OMN-360") < last.calls[0].newBody.indexOf("OMN-999"));
  });

  it("rejects wrong cell counts and positions before writing", async () => {
    const client = fakeClient();
    await assert.rejects(insertTableRow(client, { pageId: "123", expectedVersion: 4, tableIndex: 0, expectedHeaders: headers, insertAtRow: 4, cells: newCells }), TableValidationError);
    await assert.rejects(insertTableRow(client, { pageId: "123", expectedVersion: 4, tableIndex: 0, expectedHeaders: headers, insertAtRow: 0, cells: ["<p>x</p>"] }), TableValidationError);
    assert.equal(client.calls.length, 0);
  });

  it("rejects a stale version and changed headers before writing", async () => {
    const stale = fakeClient({ ...page, version: 5 });
    await assert.rejects(insertTableRow(stale, { pageId: "123", expectedVersion: 4, tableIndex: 0, expectedHeaders: headers, insertAtRow: 0, cells: newCells }), /version 5/);
    assert.equal(stale.calls.length, 0);

    const changed = fakeClient();
    await assert.rejects(deleteTableRow(changed, { pageId: "123", expectedVersion: 4, tableIndex: 0, expectedHeaders: ["Different"], rowIndex: 0 }), /expected headers/);
    assert.equal(changed.calls.length, 0);
  });

  it("deletes only the requested zero-based row", async () => {
    const client = fakeClient();
    await deleteTableRow(client, { pageId: "123", expectedVersion: 4, tableIndex: 0, expectedHeaders: headers, rowIndex: 1 });
    assert.ok(!client.calls[0].newBody.includes("OMN-370"));
    assert.ok(client.calls[0].newBody.includes("OMN-371"));
    assert.ok(client.calls[0].newBody.includes("OMN-360"));
  });

  it("replaces only the requested cell while preserving the cell element and attributes", async () => {
    const attributed = page.body.replace('<td><p>Backlog</p></td>', '<td data-colwidth="246"><p>Backlog</p></td>');
    const client = fakeClient({ ...page, body: attributed });
    await updateTableCell(client, {
      pageId: "123",
      expectedVersion: 4,
      tableIndex: 0,
      expectedHeaders: headers,
      rowIndex: 1,
      columnIndex: 4,
      content: '<p><span data-type="status" data-color="green">Erledigt</span></p>',
    });
    const body = client.calls[0].newBody;
    assert.ok(body.includes('<td data-colwidth="246"><p><span data-type="status" data-color="green">Erledigt</span></p></td>'));
    assert.ok(body.includes("<p>Gemerged</p>"));
  });

  it("inserts a column at a chosen position across the header and every data row", async () => {
    const client = fakeClient();
    await insertTableColumn(client, {
      pageId: "123",
      expectedVersion: 4,
      tableIndex: 0,
      expectedHeaders: headers,
      insertAtColumn: 1,
      header: "<p>Owner</p>",
      cells: ["<p>Ada</p>", "<p>Bea</p>", "<p>Cam</p>"],
    });
    const result = await getPageTables(fakeClient({ ...page, body: client.calls[0].newBody }), "123");
    assert.deepEqual(result.tables[0].headers, ["Datum", "Owner", ...headers.slice(1)]);
    assert.deepEqual(result.tables[0].rows.map((row) => row.cells[1]), ["Ada", "Bea", "Cam"]);
  });

  it("rejects a column whose cells do not cover every data row", async () => {
    const client = fakeClient();
    await assert.rejects(
      insertTableColumn(client, {
        pageId: "123",
        expectedVersion: 4,
        tableIndex: 0,
        expectedHeaders: headers,
        insertAtColumn: 0,
        header: "<p>Owner</p>",
        cells: ["<p>Ada</p>"],
      }),
      TableValidationError,
    );
    assert.equal(client.calls.length, 0);
  });

  it("rejects an out-of-range cell before writing", async () => {
    const client = fakeClient();
    await assert.rejects(
      updateTableCell(client, {
        pageId: "123",
        expectedVersion: 4,
        tableIndex: 0,
        expectedHeaders: headers,
        rowIndex: 3,
        columnIndex: 6,
        content: "<p>x</p>",
      }),
      TableValidationError,
    );
    assert.equal(client.calls.length, 0);
  });
});
