import { decodeHTMLStrict } from "entities";

import { DEFAULT_VERSION_MESSAGE, validateStorageContent } from "./append.js";
import { ConfluenceClient, type Page } from "./confluence.js";

export interface TableRow {
  readonly index: number;
  readonly cells: readonly string[];
}

export interface PageTable {
  readonly index: number;
  readonly headers: readonly string[];
  readonly columnCount: number;
  readonly rows: readonly TableRow[];
}

interface Element {
  readonly name: string;
  readonly start: number;
  readonly contentStart: number;
  end: number;
  contentEnd: number;
  readonly parent: Element | undefined;
}

interface ParsedTable {
  readonly body: Element;
  readonly rows: readonly Element[];
  readonly headers: readonly string[];
  readonly columnCount: number;
}

export class TableValidationError extends Error {}

function tagEnd(markup: string, start: number): number {
  let quote = "";
  for (let index = start + 1; index < markup.length; index += 1) {
    const character = markup[index];
    if (quote) {
      if (character === quote) quote = "";
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  throw new TableValidationError("The page body contains an unterminated XML tag.");
}

/** Parses validated Storage XHTML while retaining offsets for a surgical row edit. */
function parseElements(markup: string): Element[] {
  const elements: Element[] = [];
  const open: Element[] = [];
  let cursor = 0;
  while (cursor < markup.length) {
    const start = markup.indexOf("<", cursor);
    if (start < 0) break;
    if (markup.startsWith("<!--", start)) {
      const end = markup.indexOf("-->", start + 4);
      cursor = end < 0 ? markup.length : end + 3;
      continue;
    }
    if (markup.startsWith("<![CDATA[", start)) {
      const end = markup.indexOf("]]>", start + 9);
      cursor = end < 0 ? markup.length : end + 3;
      continue;
    }
    if (markup.startsWith("<?", start) || markup.startsWith("<!", start)) {
      cursor = tagEnd(markup, start);
      continue;
    }

    const end = tagEnd(markup, start);
    const raw = markup.slice(start + 1, end - 1).trim();
    const closing = raw.startsWith("/");
    const name = (closing ? raw.slice(1) : raw).match(/^([\w:-]+)/)?.[1]?.toLowerCase();
    if (!name) {
      cursor = end;
      continue;
    }
    if (closing) {
      const element = open.pop();
      if (!element || element.name !== name) throw new TableValidationError("The page body has invalid XML nesting.");
      element.contentEnd = start;
      element.end = end;
    } else if (!raw.endsWith("/")) {
      const element: Element = {
        name,
        start,
        contentStart: end,
        end: -1,
        contentEnd: -1,
        parent: open.at(-1),
      };
      elements.push(element);
      open.push(element);
    }
    cursor = end;
  }
  if (open.length > 0) throw new TableValidationError("The page body has unclosed XML elements.");
  return elements;
}

function directChildren(element: Element, elements: readonly Element[], name: string): Element[] {
  return elements.filter((candidate) => candidate.parent === element && candidate.name === name);
}

function cellsIn(row: Element, elements: readonly Element[]): Element[] {
  return elements.filter(
    (candidate) => candidate.parent === row && (candidate.name === "td" || candidate.name === "th"),
  );
}

// Storage bodies carry HTML named entities beyond the five XML defines, so a
// hand-kept list leaks the ones it misses: a real page returned "Ge&auml;ndert"
// through this projection. A chain of replaces also decodes twice, turning the
// escaped text "&amp;lt;" into "<" instead of "&lt;". One strict pass avoids
// both; strict, so an entity that lost its semicolon is never invented into
// a character.
function plainText(markup: string): string {
  const text = markup.replace(/<br\s*\/?\s*>/gi, "\n").replace(/<[^>]+>/g, "");
  return (
    decodeHTMLStrict(text)
      // A no-break space is still a space to whoever reads this projection.
      .replace(/\u00a0/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim()
  );
}

function parseTables(markup: string, elements = parseElements(markup)): ParsedTable[] {
  return elements
    .filter((element) => element.name === "table")
    .map((table) => {
      const head = directChildren(table, elements, "thead")[0];
      const headerRow = head ? directChildren(head, elements, "tr")[0] : undefined;
      const body = directChildren(table, elements, "tbody")[0];
      if (!body) throw new TableValidationError("A table has no tbody and cannot be edited safely.");
      const bodyRows = directChildren(body, elements, "tr");
      const impliedHeaderRow =
        headerRow ??
        (bodyRows[0] && cellsIn(bodyRows[0], elements).every((cell) => cell.name === "th")
          ? bodyRows[0]
          : undefined);
      const rows = impliedHeaderRow === bodyRows[0] ? bodyRows.slice(1) : bodyRows;
      const headers = impliedHeaderRow
        ? cellsIn(impliedHeaderRow, elements).map((cell) => plainText(markup.slice(cell.contentStart, cell.contentEnd)))
        : [];
      const columnCount = headers.length || (rows[0] ? cellsIn(rows[0], elements).length : 0);
      if (columnCount === 0) throw new TableValidationError("A table has no columns and cannot be edited safely.");
      if (rows.some((row) => cellsIn(row, elements).length !== columnCount)) {
        throw new TableValidationError("A table has rows with different column counts and cannot be edited safely.");
      }
      return { body, rows, headers, columnCount };
    });
}

function summarizeTables(markup: string): PageTable[] {
  const elements = parseElements(markup);
  return parseTables(markup, elements).map((table, tableIndex) => ({
    index: tableIndex,
    headers: table.headers,
    columnCount: table.columnCount,
    rows: table.rows.map((row, rowIndex) => ({
      index: rowIndex,
      cells: cellsIn(row, elements).map((cell) => plainText(markup.slice(cell.contentStart, cell.contentEnd))),
    })),
  }));
}

function selectTable(
  body: string,
  tableIndex: number,
  expectedHeaders: readonly string[],
  elements = parseElements(body),
): ParsedTable {
  const table = parseTables(body, elements)[tableIndex];
  if (!table) throw new TableValidationError(`Table index ${tableIndex} does not exist on this page.`);
  if (JSON.stringify(table.headers) !== JSON.stringify(expectedHeaders)) {
    throw new TableValidationError(
      `Table ${tableIndex} no longer has the expected headers. Re-read the page tables before changing it.`,
    );
  }
  return table;
}

function validateCells(cells: readonly string[], columnCount: number): void {
  if (cells.length !== columnCount) {
    throw new TableValidationError(`The table has ${columnCount} columns, but ${cells.length} cells were supplied.`);
  }
  for (const cell of cells) validateStorageContent(cell);
}

async function updateTable(
  client: ConfluenceClient,
  args: {
    pageId: string;
    expectedVersion: number;
    versionMessage: string | undefined;
    transform: (body: string) => string;
  },
): Promise<{ page: Page; previousVersion: number }> {
  const page = await client.getPage(args.pageId, "storage");
  if (page.version !== args.expectedVersion) {
    throw new TableValidationError(
      `The page is now at version ${page.version}, but version ${args.expectedVersion} was read. Re-read the page tables before changing it.`,
    );
  }
  const updated = await client.updatePageBody({
    page,
    newBody: args.transform(page.body),
    expectedVersion: page.version,
    versionMessage: args.versionMessage?.trim() || DEFAULT_VERSION_MESSAGE,
  });
  return { page: updated, previousVersion: page.version };
}

export async function getPageTables(
  client: ConfluenceClient,
  pageId: string,
): Promise<{ page: Page; tables: PageTable[] }> {
  const page = await client.getPage(pageId, "storage");
  validateStorageContent(page.body);
  return { page, tables: summarizeTables(page.body) };
}

export async function insertTableRow(
  client: ConfluenceClient,
  args: {
    pageId: string;
    expectedVersion: number;
    tableIndex: number;
    expectedHeaders: readonly string[];
    insertAtRow: number;
    cells: readonly string[];
    versionMessage?: string | undefined;
  },
): Promise<{ page: Page; previousVersion: number }> {
  return updateTable(client, {
    pageId: args.pageId,
    expectedVersion: args.expectedVersion,
    versionMessage: args.versionMessage,
    transform: (body) => {
      validateStorageContent(body);
      const elements = parseElements(body);
      const table = selectTable(body, args.tableIndex, args.expectedHeaders, elements);
      if (!Number.isInteger(args.insertAtRow) || args.insertAtRow < 0 || args.insertAtRow > table.rows.length) {
        throw new TableValidationError(
          `insert_at_row must be between 0 and ${table.rows.length} for this table, inclusive.`,
        );
      }
      validateCells(args.cells, table.columnCount);
      const row = `<tr>${args.cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
      const offset = table.rows[args.insertAtRow]?.start ?? table.body.contentEnd;
      return `${body.slice(0, offset)}${row}${body.slice(offset)}`;
    },
  });
}

export async function deleteTableRow(
  client: ConfluenceClient,
  args: {
    pageId: string;
    expectedVersion: number;
    tableIndex: number;
    expectedHeaders: readonly string[];
    rowIndex: number;
    versionMessage?: string | undefined;
  },
): Promise<{ page: Page; previousVersion: number }> {
  return updateTable(client, {
    pageId: args.pageId,
    expectedVersion: args.expectedVersion,
    versionMessage: args.versionMessage,
    transform: (body) => {
      validateStorageContent(body);
      const table = selectTable(body, args.tableIndex, args.expectedHeaders);
      const row = table.rows[args.rowIndex];
      if (!Number.isInteger(args.rowIndex) || args.rowIndex < 0 || !row) {
        throw new TableValidationError(`row_index must be between 0 and ${table.rows.length - 1} for this table.`);
      }
      return `${body.slice(0, row.start)}${body.slice(row.end)}`;
    },
  });
}

export async function updateTableCell(
  client: ConfluenceClient,
  args: {
    pageId: string;
    expectedVersion: number;
    tableIndex: number;
    expectedHeaders: readonly string[];
    rowIndex: number;
    columnIndex: number;
    content: string;
    versionMessage?: string | undefined;
  },
): Promise<{ page: Page; previousVersion: number }> {
  validateStorageContent(args.content);
  return updateTable(client, {
    pageId: args.pageId,
    expectedVersion: args.expectedVersion,
    versionMessage: args.versionMessage,
    transform: (body) => {
      validateStorageContent(body);
      const elements = parseElements(body);
      const table = selectTable(body, args.tableIndex, args.expectedHeaders, elements);
      const row = table.rows[args.rowIndex];
      if (!Number.isInteger(args.rowIndex) || args.rowIndex < 0 || !row) {
        throw new TableValidationError(`row_index must be between 0 and ${table.rows.length - 1} for this table.`);
      }
      if (!Number.isInteger(args.columnIndex) || args.columnIndex < 0 || args.columnIndex >= table.columnCount) {
        throw new TableValidationError(`column_index must be between 0 and ${table.columnCount - 1} for this table.`);
      }
      const cell = cellsIn(row, elements)[args.columnIndex]!;
      return `${body.slice(0, cell.contentStart)}${args.content}${body.slice(cell.contentEnd)}`;
    },
  });
}

export async function insertTableColumn(
  client: ConfluenceClient,
  args: {
    pageId: string;
    expectedVersion: number;
    tableIndex: number;
    expectedHeaders: readonly string[];
    insertAtColumn: number;
    header: string;
    cells: readonly string[];
    versionMessage?: string | undefined;
  },
): Promise<{ page: Page; previousVersion: number }> {
  validateStorageContent(args.header);
  for (const cell of args.cells) validateStorageContent(cell);
  return updateTable(client, {
    pageId: args.pageId,
    expectedVersion: args.expectedVersion,
    versionMessage: args.versionMessage,
    transform: (body) => {
      validateStorageContent(body);
      const elements = parseElements(body);
      const table = selectTable(body, args.tableIndex, args.expectedHeaders, elements);
      if (
        !Number.isInteger(args.insertAtColumn) ||
        args.insertAtColumn < 0 ||
        args.insertAtColumn > table.columnCount
      ) {
        throw new TableValidationError(
          `insert_at_column must be between 0 and ${table.columnCount} for this table, inclusive.`,
        );
      }
      if (args.cells.length !== table.rows.length) {
        throw new TableValidationError(
          `The table has ${table.rows.length} data rows, but ${args.cells.length} new cell values were supplied.`,
        );
      }

      const rows = table.rows;
      const tableElement = elements.find(
        (element) => element.name === "table" && element.start <= table.body.start && element.end >= table.body.end,
      );
      if (!tableElement) throw new TableValidationError("Could not locate the selected table.");
      const head = directChildren(tableElement, elements, "thead")[0];
      const explicitHeader = head ? directChildren(head, elements, "tr")[0] : undefined;
      const firstBodyRow = directChildren(table.body, elements, "tr")[0];
      const impliedHeader =
        !explicitHeader && firstBodyRow && cellsIn(firstBodyRow, elements).every((cell) => cell.name === "th")
          ? firstBodyRow
          : undefined;
      const headerRow = explicitHeader ?? impliedHeader;
      if (!headerRow) throw new TableValidationError("A table without a header row cannot be edited safely.");

      const replacements = [
        { row: headerRow, content: args.header, tag: "th" },
        ...rows.map((row, index) => ({ row, content: args.cells[index]!, tag: "td" })),
      ]
        .map(({ row, content, tag }) => {
          const cells = cellsIn(row, elements);
          const reference = cells[args.insertAtColumn];
          const offset = reference?.start ?? row.contentEnd;
          return { offset, value: `<${reference?.name ?? tag}>${content}</${reference?.name ?? tag}>` };
        })
        .sort((left, right) => right.offset - left.offset);

      let updated = body;
      for (const replacement of replacements) {
        updated = `${updated.slice(0, replacement.offset)}${replacement.value}${updated.slice(replacement.offset)}`;
      }
      return updated;
    },
  });
}
