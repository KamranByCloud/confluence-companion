import { XMLValidator } from "fast-xml-parser";

import { ConfluenceClient, type Page } from "./confluence.js";

export const STORAGE = "storage";
export const ADF = "atlas_doc_format";

/** Body representations this server can append to safely. */
export const SUPPORTED_REPRESENTATIONS = [STORAGE, ADF] as const;
export type Representation = (typeof SUPPORTED_REPRESENTATIONS)[number];

export const DEFAULT_VERSION_MESSAGE = "Appended content through Confluence Companion";
export const DEFAULT_PREPEND_VERSION_MESSAGE = "Prepended content through Confluence Companion";
export const DEFAULT_INSERT_VERSION_MESSAGE = "Inserted content through Confluence Companion";
export const DEFAULT_DELETE_VERSION_MESSAGE = "Deleted content through Confluence Companion";

export interface AppendResult {
  readonly page: Page;
  readonly previousVersion: number;
  readonly appendedChars: number;
  readonly appendedNodes: number | undefined;
}

export interface PageContentResult {
  readonly page: Page;
  readonly previousVersion: number;
}

export class ContentValidationError extends Error {}

/** HTML void elements that are legal in HTML but must be self-closed in XHTML. */
const VOID_ELEMENTS = ["br", "hr", "img", "input", "meta", "link", "col", "area", "source"];

/**
 * Rejects storage content that is not well-formed XHTML.
 *
 * This matters more than it looks: Confluence does NOT reject malformed storage
 * markup. Verified on 2026-09-04, sending the unclosed fragment
 * `<ac:structured-macro` returned HTTP 200 and Confluence silently rewrote it
 * into a self-closing macro named "invalidmacro". Validating up front is the
 * only way to keep that corruption off the page, so the check runs before any
 * write and the page is left untouched when it fails.
 */
export function validateStorageContent(content: string): void {
  if (!content.trim()) {
    throw new ContentValidationError("content must not be empty or whitespace only.");
  }

  // Storage format is an XHTML fragment using the ac: and ri: namespaces. Wrap
  // it so that multiple top-level elements and namespace prefixes both parse.
  const prefix =
    `<root xmlns:ac="http://atlassian.com/content" ` +
    `xmlns:ri="http://atlassian.com/resource/identifier">`;
  const result = XMLValidator.validate(`${prefix}${content}</root>`);
  if (result === true) return;

  // Report positions in the caller's own content, not in the wrapped string,
  // and drop the wrapper's name from the message so it never leaks out.
  const detail = result.err.msg
    .replace(/col (\d+)/g, (_m, col: string) => `col ${Math.max(1, Number(col) - prefix.length)}`)
    .replace(/<\/root/g, "<end of content")
    .replace(/closing tag 'root'/g, "end of content")
    .replace(/\.$/, "");

  const voidHint = VOID_ELEMENTS.find(
    (tag) =>
      new RegExp(`<${tag}(\\s[^>]*)?>`, "i").test(content) &&
      !new RegExp(`<${tag}[^>]*/>`, "i").test(content),
  );
  throw new ContentValidationError(
    `content is not well-formed Confluence Storage format: ${detail}` +
      (voidHint
        ? `. Storage format is XHTML, so <${voidHint}> must be written as <${voidHint}/>.`
        : ". Confluence would accept this and silently rewrite it, corrupting the page, " +
          "so it is rejected here instead."),
  );
}

/** An ADF node. Only the discriminator is needed; the rest is passed through. */
interface AdfNode {
  type: string;
  content?: unknown;
}

interface AdfDoc extends AdfNode {
  type: "doc";
  version?: number;
  content?: AdfNode[];
}

function isAdfNode(value: unknown): value is AdfNode {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string" &&
    (value as { type: string }).type.length > 0
  );
}

/**
 * Parses an ADF fragment into the nodes to append. Accepts a whole `doc`, a
 * bare array of nodes, or a single node, because all three are natural things
 * for a caller to produce.
 */
export function parseAdfContent(content: string): AdfNode[] {
  if (!content.trim()) {
    throw new ContentValidationError("content must not be empty or whitespace only.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    throw new ContentValidationError(
      `content is not valid JSON, which Atlassian Document Format requires: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const nodes: unknown[] = Array.isArray(parsed)
    ? parsed
    : isAdfNode(parsed) && parsed.type === "doc"
      ? ((parsed as AdfDoc).content ?? [])
      : [parsed];

  if (nodes.length === 0) {
    throw new ContentValidationError("content contains no Atlassian Document Format nodes.");
  }
  for (const [index, node] of nodes.entries()) {
    if (!isAdfNode(node)) {
      throw new ContentValidationError(
        `Atlassian Document Format node at position ${index} is not an object with a ` +
          `non-empty "type" field.`,
      );
    }
  }
  return nodes as AdfNode[];
}

/** Appends nodes to an existing ADF document, leaving every other field alone. */
function appendToAdfDocument(currentBody: string, nodes: AdfNode[]): string {
  let doc: unknown;
  try {
    doc = JSON.parse(currentBody);
  } catch (cause) {
    throw new Error(
      `The page's existing Atlassian Document Format body is not valid JSON, so it cannot ` +
        `be appended to safely: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (!isAdfNode(doc) || doc.type !== "doc") {
    throw new Error(`The page's existing body is not an Atlassian Document Format document.`);
  }
  const existing = Array.isArray(doc.content) ? (doc.content as AdfNode[]) : [];
  return JSON.stringify({ ...doc, content: [...existing, ...nodes] });
}

/**
 * Appends to a page as a controlled read-modify-write. The Confluence API has
 * no server-side append, and it enforces optimistic locking on version.number,
 * so a concurrent edit surfaces as a conflict instead of being overwritten.
 *
 * The page is read and written in the same representation. Crossing formats is
 * not offered: verified on 2026-09-04, writing a storage-authored page through
 * atlas_doc_format normalizes untouched markup, wrapping table cells in
 * paragraphs and adding layout attributes, while a storage write of unchanged
 * content is byte identical.
 */
export async function appendPageContent(
  client: ConfluenceClient,
  args: {
    pageId: string;
    content: string;
    representation?: Representation | undefined;
    versionMessage?: string | undefined;
  },
): Promise<AppendResult> {
  const representation: Representation = args.representation ?? STORAGE;

  // Validate before reading, so invalid content never causes a request.
  const nodes = representation === ADF ? parseAdfContent(args.content) : undefined;
  if (representation === STORAGE) validateStorageContent(args.content);

  const page = await client.getPage(args.pageId, representation);
  if (page.representation !== representation) {
    throw new ContentValidationError(
      `Page ${args.pageId} returned the '${page.representation}' representation, but ` +
        `'${representation}' was requested.`,
    );
  }

  let newBody: string;
  if (nodes) {
    newBody = appendToAdfDocument(page.body, nodes);
  } else {
    const separator = page.body.length > 0 && !page.body.endsWith("\n") ? "\n" : "";
    newBody = `${page.body}${separator}${args.content}`;
  }

  const updated = await client.updatePageBody({
    page,
    newBody,
    expectedVersion: page.version,
    versionMessage: args.versionMessage?.trim() || DEFAULT_VERSION_MESSAGE,
  });

  return {
    page: updated,
    previousVersion: page.version,
    appendedChars: args.content.length,
    appendedNodes: nodes?.length,
  };
}

function storageSeparator(left: string, right: string): string {
  return left.length > 0 && right.length > 0 && !left.endsWith("\n") ? "\n" : "";
}

async function updateStoragePage(
  client: ConfluenceClient,
  args: {
    pageId: string;
    versionMessage: string | undefined;
    defaultVersionMessage: string;
    change: (body: string) => string;
  },
): Promise<PageContentResult> {
  const page = await client.getPage(args.pageId, STORAGE);
  if (page.representation !== STORAGE) {
    throw new ContentValidationError(
      `Page ${args.pageId} returned the '${page.representation}' representation, but '${STORAGE}' was requested.`,
    );
  }

  const updated = await client.updatePageBody({
    page,
    newBody: args.change(page.body),
    expectedVersion: page.version,
    versionMessage: args.versionMessage?.trim() || args.defaultVersionMessage,
  });
  return { page: updated, previousVersion: page.version };
}

/** Inserts valid Storage XHTML before the existing page body. */
export async function prependPageContent(
  client: ConfluenceClient,
  args: { pageId: string; content: string; versionMessage?: string | undefined },
): Promise<PageContentResult> {
  validateStorageContent(args.content);
  return updateStoragePage(client, {
    pageId: args.pageId,
    versionMessage: args.versionMessage,
    defaultVersionMessage: DEFAULT_PREPEND_VERSION_MESSAGE,
    change: (body) => `${args.content}${storageSeparator(args.content, body)}${body}`,
  });
}

function singleOccurrence(body: string, fragment: string, name: string): number {
  const first = body.indexOf(fragment);
  if (first === -1) {
    throw new ContentValidationError(`${name} does not occur in the page body.`);
  }
  if (body.indexOf(fragment, first + fragment.length) !== -1) {
    throw new ContentValidationError(
      `${name} occurs more than once in the page body. Use a larger, unique Storage-XHTML fragment.`,
    );
  }
  return first;
}

/** Inserts valid Storage XHTML immediately before or after one unique Storage-XHTML fragment. */
export async function insertPageContent(
  client: ConfluenceClient,
  args: {
    pageId: string;
    content: string;
    anchorContent: string;
    position: "before" | "after";
    versionMessage?: string | undefined;
  },
): Promise<PageContentResult> {
  validateStorageContent(args.content);
  validateStorageContent(args.anchorContent);
  return updateStoragePage(client, {
    pageId: args.pageId,
    versionMessage: args.versionMessage,
    defaultVersionMessage: DEFAULT_INSERT_VERSION_MESSAGE,
    change: (body) => {
      const index = singleOccurrence(body, args.anchorContent, "anchor_content");
      const insertionPoint = args.position === "before" ? index : index + args.anchorContent.length;
      return `${body.slice(0, insertionPoint)}${args.content}${body.slice(insertionPoint)}`;
    },
  });
}

/** Deletes exactly one unique Storage-XHTML fragment from a page body. */
export async function deletePageContent(
  client: ConfluenceClient,
  args: { pageId: string; targetContent: string; versionMessage?: string | undefined },
): Promise<PageContentResult> {
  validateStorageContent(args.targetContent);
  return updateStoragePage(client, {
    pageId: args.pageId,
    versionMessage: args.versionMessage,
    defaultVersionMessage: DEFAULT_DELETE_VERSION_MESSAGE,
    change: (body) => {
      const index = singleOccurrence(body, args.targetContent, "target_content");
      return `${body.slice(0, index)}${body.slice(index + args.targetContent.length)}`;
    },
  });
}
