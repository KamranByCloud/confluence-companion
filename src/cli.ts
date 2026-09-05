import { existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";

import {
  CONFIG_KEYS,
  type Config,
  ConfigError,
  configSources,
  normalizeConfig,
  resolveWithProvenance,
  userConfigPath,
  warnIfReadableByOthers,
  writeUserConfig,
} from "./config.js";
import { ConfluenceClient } from "./confluence.js";
import { VERSION } from "./version.js";

/**
 * What the process was asked to do.
 *
 * An argumentless call starts the MCP server, because every existing client
 * registration invokes the command with no arguments and must keep working.
 * `mcp` names the same thing explicitly, so a new registration can say what it
 * means.
 */
export type Command =
  | { readonly kind: "mcp" }
  | { readonly kind: "init"; readonly force: boolean }
  | { readonly kind: "config" }
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "usage"; readonly message: string };

export const HELP = `confluence-companion ${VERSION}

An MCP server for direct Confluence Cloud REST operations that complement the
Atlassian Rovo MCP server.

Usage:
  confluence-companion             Start the MCP server on stdio (what a client runs)
  confluence-companion mcp         The same, stated explicitly
  confluence-companion init        Store this machine's Atlassian credentials
  confluence-companion config      Show where each setting is resolved from
  confluence-companion help        This text
  confluence-companion version     Print the version

Options for init:
  --force                          Overwrite an existing configuration file without asking

Credentials are read from the environment first, then from
${userConfigPath()},
then from a .env next to the package. Environment variables always win, which
is how a dev container passes credentials in without a file.`;

export function parseArgs(argv: readonly string[]): Command {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "mcp" };

  const noExtra = (command: Command): Command =>
    rest.length === 0
      ? command
      : {
          kind: "usage",
          message: `'${first}' takes no arguments, got: ${rest.join(" ")}`,
        };

  switch (first) {
    case "mcp":
      return noExtra({ kind: "mcp" });
    case "config":
      return noExtra({ kind: "config" });
    case "help":
    case "--help":
    case "-h":
      return noExtra({ kind: "help" });
    case "version":
    case "--version":
    case "-v":
      return noExtra({ kind: "version" });
    case "init": {
      let force = false;
      for (const argument of rest) {
        if (argument === "--force" || argument === "-f") force = true;
        else return { kind: "usage", message: `Unknown option for init: ${argument}` };
      }
      return { kind: "init", force };
    }
    default:
      return {
        kind: "usage",
        message: `Unknown command: ${first}. Run 'confluence-companion help'.`,
      };
  }
}

/** Everything `init` touches, injected so the flow can be tested without a terminal. */
export interface InitPrompts {
  ask(
    question: string,
    options?: { default?: string | undefined; secret?: boolean | undefined },
  ): Promise<string>;
  confirm(question: string, fallback: boolean): Promise<boolean>;
  close(): void;
}

export interface InitDeps {
  readonly prompts: InitPrompts;
  readonly out: (message: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly path: string;
  readonly force: boolean;
  readonly fileExists: (path: string) => boolean;
  readonly verify: (config: Config) => Promise<void>;
  readonly write: (config: Config, path: string) => string;
}

/**
 * Asks for the three settings, proves them against the live API, and stores
 * them in the per-user file.
 *
 * Verification happens before the write on purpose: a token that only fails at
 * the first tool call, hours later and inside an assistant, is the usual way
 * this kind of setup goes wrong.
 */
export async function runInit(deps: InitDeps): Promise<number> {
  const { prompts, out, env, path } = deps;

  if (deps.fileExists(path) && !deps.force) {
    const overwrite = await prompts.confirm(`${path} already exists. Replace it?`, false);
    if (!overwrite) {
      out("Nothing was written.");
      return 0;
    }
  }

  const siteUrl = await prompts.ask("Confluence site URL (https://your-site.atlassian.net)", {
    default: env.ATLASSIAN_SITE_URL,
  });
  const email = await prompts.ask("Atlassian account email", { default: env.ATLASSIAN_EMAIL });
  const apiToken = await prompts.ask("Atlassian API token (normal, not scoped; input hidden)", {
    secret: true,
    default: env.ATLASSIAN_API_TOKEN,
  });

  let config: Config;
  try {
    config = normalizeConfig({ siteUrl, email, apiToken });
  } catch (error) {
    out(error instanceof ConfigError ? error.message : String(error));
    return 1;
  }

  out(`Checking the credentials against ${config.siteUrl} ...`);
  try {
    await deps.verify(config);
    out("The credentials work.");
  } catch (error) {
    out(`The check failed: ${error instanceof Error ? error.message : String(error)}`);
    out(
      "A normal API token is required; a scoped token fails against the site REST API. " +
        "Create one at https://id.atlassian.com/manage-profile/security/api-tokens",
    );
    const anyway = await prompts.confirm("Store them anyway?", false);
    if (!anyway) {
      out("Nothing was written.");
      return 1;
    }
  }

  const written = deps.write(config, path);
  out(`Wrote ${written} at mode 600.`);
  out("Register the server with an assistant, for example Claude Code:");
  out("  claude mcp add -s user confluence-companion -- confluence-companion");
  return 0;
}

/** Prints where each setting comes from, without ever printing the token. */
export function runConfig(
  out: (message: string) => void,
  sources: readonly string[] = configSources(),
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): number {
  const provenance = resolveWithProvenance(sources, env);

  out("Sources, in descending precedence:");
  out("  environment variables");
  for (const path of sources) {
    out(`  ${path}${fileExists(path) ? "" : "   (not present)"}`);
  }
  for (const path of sources) warnIfReadableByOthers(path, out);

  out("");
  out("Resolved:");
  const width = Math.max(...CONFIG_KEYS.map((key) => key.length));
  for (const { key, source, set } of provenance) {
    const raw = env[key]?.trim();
    // The token is never printed. Its length is enough to tell an empty
    // value from a truncated paste, which is the failure worth diagnosing.
    const shown = !set
      ? "not set"
      : key === "ATLASSIAN_API_TOKEN"
        ? `set, ${raw?.length ?? 0} characters`
        : (raw ?? "");
    out(`  ${key.padEnd(width)}  ${shown}${source ? `   <- ${source}` : ""}`);
  }

  const missing = provenance.filter((entry) => !entry.set);
  if (missing.length > 0) {
    out("");
    out(`Missing: ${missing.map((entry) => entry.key).join(", ")}.`);
    out("Run 'confluence-companion init' to store them for this user.");
    return 1;
  }
  return 0;
}

/**
 * Prompts backed by the terminal.
 *
 * Hiding the token relies on readline's internal `_writeToOutput`, which is
 * the only hook for suppressing the echo. If a future Node removes it the
 * input stays visible rather than the prompt breaking, and the caller is told.
 */
export function terminalPrompts(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): InitPrompts {
  const rl = createInterface({ input, output, terminal: true });
  const internals = rl as unknown as { _writeToOutput?: (text: string) => void };
  const echo = internals._writeToOutput?.bind(rl);

  return {
    async ask(question, options = {}) {
      const fallback = options.default?.trim();
      const suffix = fallback ? ` [${fallback}]` : "";

      if (!options.secret) {
        const answer = (await rl.question(`${question}${suffix}: `)).trim();
        return answer || (fallback ?? "");
      }

      // A secret default is never shown, only offered: printing it would put
      // the token into the scrollback, which is what hiding the input avoids.
      output.write(`${question}${fallback ? " [press Enter to keep the current value]" : ""}: `);
      if (echo) internals._writeToOutput = () => {};
      else output.write("(cannot hide input on this Node version) ");
      try {
        const answer = (await rl.question("")).trim();
        return answer || (fallback ?? "");
      } finally {
        if (echo) internals._writeToOutput = echo;
        output.write("\n");
      }
    },
    async confirm(question, fallback) {
      const answer = (await rl.question(`${question} ${fallback ? "[Y/n]" : "[y/N]"} `))
        .trim()
        .toLowerCase();
      if (!answer) return fallback;
      return answer === "y" || answer === "yes";
    },
    close() {
      rl.close();
    },
  };
}

/**
 * Prompts for a non-interactive run, where `init` is driven by environment
 * variables. This is the dev container and provisioning path: the values are
 * already in the environment, and the command only has to store them.
 */
export function nonInteractivePrompts(): InitPrompts {
  return {
    async ask(question, options = {}) {
      const value = options.default?.trim();
      if (value) return value;
      throw new ConfigError(
        `Cannot ask for "${question}" because the input is not a terminal. Set ` +
          `${CONFIG_KEYS.join(", ")} in the environment, or run init interactively.`,
      );
    },
    async confirm(_question, fallback) {
      return fallback;
    },
    close() {},
  };
}

export interface RunDeps {
  readonly out: (message: string) => void;
  readonly err: (message: string) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly isInteractive: boolean;
  readonly startMcpServer: () => Promise<void>;
}

/** Dispatches a parsed command. Returns the process exit code. */
export async function runCommand(command: Command, deps: RunDeps): Promise<number> {
  switch (command.kind) {
    case "mcp":
      await deps.startMcpServer();
      return 0;
    case "help":
      deps.out(HELP);
      return 0;
    case "version":
      deps.out(VERSION);
      return 0;
    case "config":
      return runConfig(deps.out, configSources(), deps.env);
    case "usage":
      deps.err(command.message);
      return 2;
    case "init": {
      // The secret prompt is only meaningful on a terminal; without one the
      // values must come from the environment.
      const prompts = deps.isInteractive ? terminalPrompts() : nonInteractivePrompts();
      try {
        return await runInit({
          prompts,
          out: deps.out,
          env: deps.env,
          path: userConfigPath(deps.env),
          force: command.force,
          fileExists: existsSync,
          verify: (config) => new ConfluenceClient(config).verifyAccess(),
          write: writeUserConfig,
        });
      } catch (error) {
        deps.err(error instanceof Error ? error.message : String(error));
        return 1;
      } finally {
        prompts.close();
      }
    }
  }
}
