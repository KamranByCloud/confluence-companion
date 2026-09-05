import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Configuration is resolved from the environment first and from a single
 * per-user file second. The file lives outside every project so that the API
 * token is entered once per machine and never reaches a repository or a client
 * configuration.
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

/** The environment variables this server reads, in the order it reports them. */
export const CONFIG_KEYS = [
  "ATLASSIAN_SITE_URL",
  "ATLASSIAN_EMAIL",
  "ATLASSIAN_API_TOKEN",
] as const;

/**
 * Path to the per-user configuration file.
 *
 * `XDG_CONFIG_HOME` is honoured because that is where a dev container or a
 * dotfile setup redirects configuration. Per the XDG specification a relative
 * value is ignored rather than resolved against the working directory.
 */
export function userConfigPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const configured = env.XDG_CONFIG_HOME?.trim();
  const base = configured?.startsWith("/") ? configured : join(home, ".config");
  return join(base, "confluence-companion", "config.env");
}

/**
 * Path to a .env shipped next to the installed package.
 *
 * Resolved from this module rather than the working directory: an MCP client
 * starts the server from wherever it happens to be, so a relative ".env" would
 * be found or missed depending on how it was launched.
 *
 * This is the transitional source. It only works for a checkout that is also
 * the install, and it is the one mechanism that could carry a token to another
 * machine by accident, so prefer the per-user file.
 */
export function packageEnvPath(): string {
  return fileURLToPath(new URL("../.env", import.meta.url));
}

/** The files that are consulted, in descending precedence. */
export function configSources(): readonly string[] {
  return [userConfigPath(), packageEnvPath()];
}

/**
 * Loads a .env file if present, and reports whether it was there. Missing
 * files are ignored so that a caller supplying real environment variables does
 * not need one.
 *
 * Node's loader never overwrites a variable that is already set, neither one
 * from the real environment nor one from a file loaded earlier. Precedence
 * therefore falls out of the load order and needs no bookkeeping here.
 */
export function loadDotEnvIfPresent(path: string = packageEnvPath()): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    // No such file, or unreadable. Environment variables may still be set.
    return false;
  }
}

/**
 * Warns when a configuration file can be read by anyone but its owner. It
 * holds an API token with write access to Confluence, so a loose mode is worth
 * one line on stderr rather than silence.
 */
export function warnIfReadableByOthers(path: string, warn: (message: string) => void): boolean {
  let mode: number;
  try {
    mode = statSync(path).mode;
  } catch {
    return false;
  }
  if ((mode & 0o077) === 0) return false;
  const octal = (mode & 0o777).toString(8).padStart(3, "0");
  warn(
    `Warning: ${path} is mode ${octal} and readable by other users. It holds an ` +
      `Atlassian API token. Fix it with: chmod 600 ${path}`,
  );
  return true;
}

/**
 * Loads every configuration source in precedence order and returns those that
 * existed. Diagnostics go to stderr because stdout carries the MCP protocol.
 */
export function loadConfigSources(
  options: { sources?: readonly string[]; warn?: (message: string) => void } = {},
): readonly string[] {
  const sources = options.sources ?? configSources();
  const warn = options.warn ?? ((message: string) => process.stderr.write(`${message}\n`));
  const loaded: string[] = [];
  for (const path of sources) {
    if (!loadDotEnvIfPresent(path)) continue;
    loaded.push(path);
    warnIfReadableByOthers(path, warn);
  }
  return loaded;
}

/** Where a single setting came from, for `confluence-companion config`. */
export interface Provenance {
  readonly key: (typeof CONFIG_KEYS)[number];
  /** "environment", a file path, or null when the setting is unresolved. */
  readonly source: string | null;
  readonly set: boolean;
}

/**
 * Resolves the configuration and records which source supplied each setting.
 *
 * This exists for debugging an installation across several assistants and
 * machines, where the usual question is not whether a value is set but which
 * of three places it came from. Loading mutates `process.env`, exactly as
 * starting the server does.
 */
export function resolveWithProvenance(
  sources: readonly string[] = configSources(),
  env: NodeJS.ProcessEnv = process.env,
): readonly Provenance[] {
  const found = new Map<string, string>();
  for (const key of CONFIG_KEYS) {
    if (env[key]?.trim()) found.set(key, "environment");
  }
  for (const path of sources) {
    if (!loadDotEnvIfPresent(path)) continue;
    for (const key of CONFIG_KEYS) {
      if (!found.has(key) && env[key]?.trim()) found.set(key, path);
    }
  }
  return CONFIG_KEYS.map((key) => ({
    key,
    source: found.get(key) ?? null,
    set: found.has(key),
  }));
}

function requireValue(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new ConfigError(
      `Missing environment variable ${name}. Run 'confluence-companion init' to store it, ` +
        `or set it in the environment.`,
    );
  }
  return trimmed;
}

/**
 * Validates and normalizes raw settings, whatever their source. Shared by the
 * server start-up path and by `init`, so an interactively entered value is
 * checked exactly as strictly as one from the environment.
 */
export function normalizeConfig(raw: {
  siteUrl?: string | undefined;
  email?: string | undefined;
  apiToken?: string | undefined;
}): Config {
  const siteUrl = requireValue("ATLASSIAN_SITE_URL", raw.siteUrl).replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+$/.test(siteUrl)) {
    throw new ConfigError(
      `ATLASSIAN_SITE_URL must be an https site root such as ` +
        `https://your-site.atlassian.net, got: ${siteUrl}`,
    );
  }
  return {
    siteUrl,
    email: requireValue("ATLASSIAN_EMAIL", raw.email),
    apiToken: requireValue("ATLASSIAN_API_TOKEN", raw.apiToken),
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return normalizeConfig({
    siteUrl: env.ATLASSIAN_SITE_URL,
    email: env.ATLASSIAN_EMAIL,
    apiToken: env.ATLASSIAN_API_TOKEN,
  });
}

/**
 * Renders the per-user configuration file.
 *
 * Values are double-quoted because Node's parser treats an unquoted '#' as the
 * start of a comment and would silently truncate a token containing one. That
 * parser has no escape sequence inside quotes, so a value carrying a quote,
 * a backslash, or a newline cannot be represented and is rejected here rather
 * than written back in corrupted form.
 */
export function renderConfigFile(config: Config): string {
  const entries: ReadonlyArray<readonly [string, string]> = [
    ["ATLASSIAN_SITE_URL", config.siteUrl],
    ["ATLASSIAN_EMAIL", config.email],
    ["ATLASSIAN_API_TOKEN", config.apiToken],
  ];
  const lines = entries.map(([key, value]) => {
    if (/["\\\r\n]/.test(value)) {
      throw new ConfigError(
        `${key} contains a quote, backslash, or line break, which cannot be stored in the ` +
          `configuration file. Set it in the environment instead.`,
      );
    }
    return `${key}="${value}"`;
  });
  return (
    `# Confluence Companion credentials for this user.\n` +
    `# Written by 'confluence-companion init'. Keep this file at mode 600.\n` +
    `# Environment variables of the same name take precedence over this file.\n` +
    `${lines.join("\n")}\n`
  );
}

/**
 * Writes the per-user configuration file at mode 600, creating its directory
 * at mode 700. The mode is set explicitly after writing because the `mode`
 * option only applies when the file is created; overwriting a file that had
 * been loosened would otherwise leave it loose.
 */
export function writeUserConfig(config: Config, path: string = userConfigPath()): string {
  const content = renderConfigFile(config);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}
