import { XMLValidator } from "fast-xml-parser";

import { ConfluenceClient, type Page } from "./confluence.js";

/**
 * Only Confluence Storage format is supported so far. Atlassian Document Format
 * round trips are not verified, and claiming support without verifying it risks
 * corrupting page content.
 */
export const SUPPORTED_REPRESENTATION = "storage";

export const DEFAULT_VERSION_MESSAGE = "Appended content through Confluence Companion";

export interface AppendResult {
  readonly page: Page;
  readonly previousVersion: number;
  readonly appendedChars: number;
}

export class ContentValidationError extends Error {}

/** HTML void elements that are legal in HTML but must be self-closed in XHTML. */
const VOID_ELEMENTS = ["br", "hr", "img", "input", "meta", "link", "col", "area", "source"];

/**
 * Rejects content that is not well-formed XHTML.
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
  const voidHint = VOID_ELEMENTS.find((tag) =>
    new RegExp(`<${tag}(\\s[^>]*)?>`, "i").test(content) && !new RegExp(`<${tag}[^>]*/>`, "i").test(content),
  );
  throw new ContentValidationError(
    `content is not well-formed Confluence Storage format: ${detail}` +
      (voidHint
        ? `. Storage format is XHTML, so <${voidHint}> must be written as <${voidHint}/>.`
        : ". Confluence would accept this and silently rewrite it, corrupting the page, " +
          "so it is rejected here instead."),
  );
}

/**
 * Appends to a page as a controlled read-modify-write. The Confluence API has
 * no server-side append, and it enforces optimistic locking on version.number,
 * so a concurrent edit surfaces as a conflict instead of being overwritten.
 */
export async function appendPageContent(
  client: ConfluenceClient,
  args: { pageId: string; content: string; versionMessage?: string | undefined },
): Promise<AppendResult> {
  validateStorageContent(args.content);

  const page = await client.getPage(args.pageId, SUPPORTED_REPRESENTATION);
  if (page.representation !== SUPPORTED_REPRESENTATION) {
    throw new ContentValidationError(
      `Page ${args.pageId} uses the '${page.representation}' representation, but only ` +
        `'${SUPPORTED_REPRESENTATION}' is supported.`,
    );
  }

  const separator = page.body.length > 0 && !page.body.endsWith("\n") ? "\n" : "";
  const newBody = `${page.body}${separator}${args.content}`;

  const updated = await client.updatePageBody({
    page,
    newBody,
    expectedVersion: page.version,
    versionMessage: args.versionMessage?.trim() || DEFAULT_VERSION_MESSAGE,
  });

  return { page: updated, previousVersion: page.version, appendedChars: args.content.length };
}
