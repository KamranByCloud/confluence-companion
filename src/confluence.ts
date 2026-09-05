import type { Config } from "./config.js";

/** A Confluence REST call that returned a non-success status. */
export class ConfluenceApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(`Confluence API ${method} ${path} failed with HTTP ${status}: ${detail}`);
    this.name = "ConfluenceApiError";
  }
}

/**
 * The page changed between the read and the write. The caller must re-read and
 * decide what to do; retrying blindly would discard the concurrent edit.
 */
export class VersionConflictError extends Error {
  constructor(
    readonly pageId: string,
    readonly attemptedVersion: number,
    readonly detail: string,
  ) {
    super(
      `Version conflict on page ${pageId}: the page was modified after it was read. ` +
        `Update to version ${attemptedVersion} was rejected. Confluence reported: ${detail}`,
    );
    this.name = "VersionConflictError";
  }
}

/** The subset of the v2 page representation this server relies on. */
export interface Page {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly spaceId: string;
  readonly version: number;
  readonly body: string;
  readonly representation: string;
  readonly webUrl: string;
}

interface RawPage {
  id?: string;
  title?: string;
  status?: string;
  spaceId?: string;
  version?: { number?: number };
  body?: Record<string, { value?: string; representation?: string } | undefined>;
  _links?: { base?: string; webui?: string };
}

/** Pulls the most useful message out of the varied Confluence error shapes. */
function describeError(status: number, payload: unknown): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim().slice(0, 500);
  if (payload && typeof payload === "object") {
    const p = payload as {
      errors?: Array<{ title?: string; detail?: string }>;
      message?: string;
    };
    const first = p.errors?.[0];
    const parts = [first?.title, first?.detail, p.message].filter(
      (s): s is string => typeof s === "string" && s.trim().length > 0,
    );
    if (parts.length > 0) return parts.join(" - ").slice(0, 500);
  }
  return `no error detail supplied (HTTP ${status})`;
}

export class ConfluenceClient {
  readonly #authHeader: string;
  readonly #baseUrl: string;

  constructor(private readonly config: Config) {
    this.#baseUrl = `${config.siteUrl}/wiki`;
    const credentials = Buffer.from(`${config.email}:${config.apiToken}`, "utf8").toString("base64");
    this.#authHeader = `Basic ${credentials}`;
  }

  async #request(method: "GET" | "PUT", path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: this.#authHeader,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new Error(
        `Could not reach ${this.config.siteUrl}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    }

    const text = await response.text();
    let payload: unknown = undefined;
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      throw new ConfluenceApiError(response.status, describeError(response.status, payload), method, path);
    }
    return payload;
  }

  /**
   * Cheapest authenticated call the site offers. `init` uses it to prove the
   * credentials work while the user is still in front of the prompt, instead
   * of letting a bad token surface at the first tool call much later.
   */
  async verifyAccess(): Promise<void> {
    await this.#request("GET", "/api/v2/spaces?limit=1");
  }

  /** Reads a page including its body in the given representation. */
  async getPage(pageId: string, representation: string): Promise<Page> {
    const raw = (await this.#request(
      "GET",
      `/api/v2/pages/${encodeURIComponent(pageId)}?body-format=${encodeURIComponent(representation)}`,
    )) as RawPage;

    const version = raw.version?.number;
    const bodyPart = raw.body?.[representation];
    if (!raw.id || !raw.title || typeof version !== "number") {
      throw new Error(`Unexpected page payload for ${pageId}: missing id, title, or version.`);
    }
    if (bodyPart?.value === undefined) {
      throw new Error(
        `Page ${pageId} returned no '${representation}' body. It may use a different ` +
          `content representation than requested.`,
      );
    }

    const base = raw._links?.base ?? this.#baseUrl;
    const webui = raw._links?.webui ?? "";

    return {
      id: raw.id,
      title: raw.title,
      status: raw.status ?? "current",
      spaceId: raw.spaceId ?? "",
      version,
      body: bodyPart.value,
      representation: bodyPart.representation ?? representation,
      webUrl: webui ? `${base}${webui}` : `${this.#baseUrl}/pages/${raw.id}`,
    };
  }

  /**
   * Writes the complete body back at `expectedVersion + 1`. The v2 API has no
   * partial update, so the full body must always be sent.
   */
  async updatePageBody(args: {
    page: Page;
    newBody: string;
    expectedVersion: number;
    versionMessage: string;
  }): Promise<Page> {
    const { page, newBody, expectedVersion, versionMessage } = args;
    const nextVersion = expectedVersion + 1;

    let raw: RawPage;
    try {
      raw = (await this.#request("PUT", `/api/v2/pages/${encodeURIComponent(page.id)}`, {
        id: page.id,
        status: page.status,
        title: page.title,
        body: { representation: page.representation, value: newBody },
        version: { number: nextVersion, message: versionMessage },
      })) as RawPage;
    } catch (error) {
      if (error instanceof ConfluenceApiError && error.status === 409) {
        throw new VersionConflictError(page.id, nextVersion, error.detail);
      }
      throw error;
    }

    const version = raw.version?.number ?? nextVersion;
    const base = raw._links?.base ?? this.#baseUrl;
    const webui = raw._links?.webui ?? "";
    return {
      ...page,
      version,
      body: newBody,
      webUrl: webui ? `${base}${webui}` : page.webUrl,
    };
  }
}
