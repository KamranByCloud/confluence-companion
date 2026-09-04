/**
 * Configuration comes from environment variables only. The MCP client passes
 * them through its server definition; for local runs a .env file next to the
 * project root is loaded as a convenience.
 */
export interface Config {
  /** Site base URL without trailing slash, e.g. https://example.atlassian.net */
  readonly siteUrl: string;
  /** Atlassian account email, used as the Basic Auth username. */
  readonly email: string;
  /** Normal (unscoped) Atlassian API token. */
  readonly apiToken: string;
}

export class ConfigError extends Error {}

/**
 * Loads a .env file if present. Missing files are ignored so that a client
 * supplying real environment variables does not need one.
 */
export function loadDotEnvIfPresent(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // No .env file, or unreadable. Environment variables may still be set.
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new ConfigError(
      `Missing environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  const siteUrl = required("ATLASSIAN_SITE_URL").replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(siteUrl)) {
    throw new ConfigError(
      `ATLASSIAN_SITE_URL must be an https site root such as ` +
        `https://your-site.atlassian.net, got: ${siteUrl}`,
    );
  }
  return { siteUrl, email: required("ATLASSIAN_EMAIL"), apiToken: required("ATLASSIAN_API_TOKEN") };
}
