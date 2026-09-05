import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  HELP,
  nonInteractivePrompts,
  parseArgs,
  runConfig,
  runInit,
} from "../dist/cli.js";
import { ConfigError } from "../dist/config.js";

describe("parseArgs", () => {
  it("starts the MCP server with no arguments, which is how every client invokes it", () => {
    assert.deepEqual(parseArgs([]), { kind: "mcp" });
  });

  it("starts the MCP server for the explicit subcommand", () => {
    assert.deepEqual(parseArgs(["mcp"]), { kind: "mcp" });
  });

  for (const [argv, kind] of [
    [["help"], "help"],
    [["--help"], "help"],
    [["-h"], "help"],
    [["version"], "version"],
    [["--version"], "version"],
    [["-v"], "version"],
    [["config"], "config"],
  ]) {
    it(`maps ${argv.join(" ")} to ${kind}`, () => {
      assert.equal(parseArgs(argv).kind, kind);
    });
  }

  it("parses init without options", () => {
    assert.deepEqual(parseArgs(["init"]), { kind: "init", force: false });
  });

  for (const flag of ["--force", "-f"]) {
    it(`parses init ${flag}`, () => {
      assert.deepEqual(parseArgs(["init", flag]), { kind: "init", force: true });
    });
  }

  it("rejects an unknown option for init", () => {
    const command = parseArgs(["init", "--yolo"]);
    assert.equal(command.kind, "usage");
    assert.match(command.message, /--yolo/);
  });

  it("rejects an unknown command and points at help", () => {
    const command = parseArgs(["frobnicate"]);
    assert.equal(command.kind, "usage");
    assert.match(command.message, /frobnicate/);
    assert.match(command.message, /help/);
  });

  it("rejects stray arguments after a subcommand that takes none", () => {
    assert.equal(parseArgs(["config", "extra"]).kind, "usage");
    assert.equal(parseArgs(["mcp", "extra"]).kind, "usage");
  });
});

describe("HELP", () => {
  it("documents that an argumentless call is the server", () => {
    assert.match(HELP, /confluence-companion\s+Start the MCP server/);
  });

  it("states the precedence, which is what a container setup needs to know", () => {
    assert.match(HELP, /environment first/);
  });
});

const config = {
  siteUrl: "https://example.atlassian.net",
  email: "user@example.com",
  apiToken: "a-token",
};

/** Scripted prompts; records what was asked so the flow can be asserted. */
function fakePrompts(answers, confirmations = []) {
  const asked = [];
  const confirmed = [];
  return {
    asked,
    confirmed,
    prompts: {
      async ask(question, options = {}) {
        asked.push(question);
        const next = answers.shift();
        return next === undefined ? (options.default ?? "") : next;
      },
      async confirm(question, fallback) {
        confirmed.push(question);
        const next = confirmations.shift();
        return next === undefined ? fallback : next;
      },
      close() {},
    },
  };
}

function initDeps(overrides = {}) {
  const written = [];
  const output = [];
  const base = {
    out: (message) => output.push(message),
    env: {},
    path: "/home/someone/.config/confluence-companion/config.env",
    force: false,
    fileExists: () => false,
    verify: async () => {},
    write: (value, path) => {
      written.push({ config: value, path });
      return path;
    },
  };
  return { written, output, deps: { ...base, ...overrides } };
}

describe("runInit", () => {
  it("asks, verifies, and writes", async () => {
    const { prompts, asked } = fakePrompts([config.siteUrl, config.email, config.apiToken]);
    const { written, output, deps } = initDeps({ prompts });

    assert.equal(await runInit(deps), 0);
    assert.equal(asked.length, 3);
    assert.deepEqual(written, [{ config, path: deps.path }]);
    assert.ok(output.some((line) => line.includes(deps.path)));
  });

  it("hides the token prompt so it never reaches the scrollback", async () => {
    const secretFlags = [];
    const prompts = {
      async ask(_question, options = {}) {
        secretFlags.push(options.secret === true);
        return [config.siteUrl, config.email, config.apiToken][secretFlags.length - 1];
      },
      async confirm(_question, fallback) {
        return fallback;
      },
      close() {},
    };
    const { deps } = initDeps({ prompts });
    await runInit(deps);
    assert.deepEqual(secretFlags, [false, false, true]);
  });

  it("takes every value from the environment, which is how a dev container runs it", async () => {
    const { prompts } = fakePrompts([]);
    const { written, deps } = initDeps({
      prompts,
      env: {
        ATLASSIAN_SITE_URL: config.siteUrl,
        ATLASSIAN_EMAIL: config.email,
        ATLASSIAN_API_TOKEN: config.apiToken,
      },
    });
    // Empty answers fall back to the offered defaults, including the token.
    assert.equal(await runInit(deps), 0);
    assert.deepEqual(written, [{ config, path: deps.path }]);
  });

  it("runs headlessly with the non-interactive prompts and no terminal", async () => {
    const { written, deps } = initDeps({
      prompts: nonInteractivePrompts(),
      env: {
        ATLASSIAN_SITE_URL: config.siteUrl,
        ATLASSIAN_EMAIL: config.email,
        ATLASSIAN_API_TOKEN: config.apiToken,
      },
    });
    assert.equal(await runInit(deps), 0);
    assert.deepEqual(written, [{ config, path: deps.path }]);
  });

  it("offers the token as a default without ever revealing it", async () => {
    const seen = [];
    const prompts = {
      async ask(question, options = {}) {
        seen.push({ question, secret: options.secret === true, default: options.default });
        return "";
      },
      async confirm(_question, fallback) {
        return fallback;
      },
      close() {},
    };
    const { deps } = initDeps({ prompts, env: { ATLASSIAN_API_TOKEN: "a-token" } });
    await runInit(deps);
    const token = seen.find((entry) => entry.secret);
    assert.equal(token.default, "a-token");
    assert.ok(!token.question.includes("a-token"), "the prompt text must not carry the token");
  });

  it("asks before replacing an existing file and writes nothing when refused", async () => {
    const { prompts, confirmed } = fakePrompts([], [false]);
    const { written, output, deps } = initDeps({ prompts, fileExists: () => true });

    assert.equal(await runInit(deps), 0);
    assert.equal(written.length, 0);
    assert.match(confirmed[0], /already exists/);
    assert.ok(output.includes("Nothing was written."));
  });

  it("replaces an existing file without asking when forced", async () => {
    const { prompts, confirmed } = fakePrompts([config.siteUrl, config.email, config.apiToken]);
    const { written, deps } = initDeps({ prompts, fileExists: () => true, force: true });

    assert.equal(await runInit(deps), 0);
    assert.deepEqual(confirmed, []);
    assert.equal(written.length, 1);
  });

  it("stops on an invalid value before touching the network or the disk", async () => {
    let verified = false;
    const { prompts } = fakePrompts(["not-a-url", config.email, config.apiToken]);
    const { written, output, deps } = initDeps({
      prompts,
      verify: async () => {
        verified = true;
      },
    });

    assert.equal(await runInit(deps), 1);
    assert.equal(verified, false);
    assert.equal(written.length, 0);
    assert.ok(output.some((line) => line.includes("ATLASSIAN_SITE_URL")));
  });

  it("does not store credentials the API rejected", async () => {
    const { prompts } = fakePrompts([config.siteUrl, config.email, config.apiToken], [false]);
    const { written, output, deps } = initDeps({
      prompts,
      verify: async () => {
        throw new Error("HTTP 401: Unauthorized");
      },
    });

    assert.equal(await runInit(deps), 1);
    assert.equal(written.length, 0);
    assert.ok(output.some((line) => line.includes("401")));
    assert.ok(output.some((line) => line.includes("scoped")), "must hint at the token type");
  });

  it("stores them anyway when the user insists, for an offline machine", async () => {
    const { prompts } = fakePrompts([config.siteUrl, config.email, config.apiToken], [true]);
    const { written, deps } = initDeps({
      prompts,
      verify: async () => {
        throw new Error("network unreachable");
      },
    });

    assert.equal(await runInit(deps), 0);
    assert.equal(written.length, 1);
  });

  it("never prints the token", async () => {
    const { prompts } = fakePrompts([config.siteUrl, config.email, "super-secret-token"]);
    const { output, deps } = initDeps({
      prompts,
      verify: async () => {
        throw new Error("HTTP 401");
      },
    });
    await runInit(deps);
    for (const line of output) assert.ok(!line.includes("super-secret-token"), line);
  });
});

describe("nonInteractivePrompts", () => {
  it("takes the value from the environment default", async () => {
    const prompts = nonInteractivePrompts();
    assert.equal(await prompts.ask("Site", { default: "https://x.atlassian.net" }), "https://x.atlassian.net");
  });

  it("explains what to set when a value is missing and there is no terminal", async () => {
    const prompts = nonInteractivePrompts();
    await assert.rejects(() => prompts.ask("Atlassian API token", { secret: true }), (error) => {
      assert.ok(error instanceof ConfigError);
      assert.match(error.message, /ATLASSIAN_API_TOKEN/);
      return true;
    });
  });

  it("takes the safe answer for a confirmation", async () => {
    const prompts = nonInteractivePrompts();
    assert.equal(await prompts.confirm("Overwrite?", false), false);
  });
});

describe("runConfig", () => {
  const lines = () => {
    const collected = [];
    return { collected, out: (message) => collected.push(message) };
  };

  it("reports the source of every setting", () => {
    const { collected, out } = lines();
    const env = {
      ATLASSIAN_SITE_URL: "https://example.atlassian.net",
      ATLASSIAN_EMAIL: "user@example.com",
      ATLASSIAN_API_TOKEN: "a-token",
    };
    assert.equal(runConfig(out, [], env, () => false), 0);
    const text = collected.join("\n");
    assert.match(text, /ATLASSIAN_SITE_URL\s+https:\/\/example\.atlassian\.net\s+<- environment/);
  });

  it("shows the token's length but never the token", () => {
    const { collected, out } = lines();
    const env = {
      ATLASSIAN_SITE_URL: "https://example.atlassian.net",
      ATLASSIAN_EMAIL: "user@example.com",
      ATLASSIAN_API_TOKEN: "super-secret-token",
    };
    runConfig(out, [], env, () => false);
    const text = collected.join("\n");
    assert.ok(!text.includes("super-secret-token"));
    assert.match(text, /set, 18 characters/);
  });

  it("fails with a hint when a setting is missing", () => {
    const { collected, out } = lines();
    assert.equal(runConfig(out, [], { ATLASSIAN_EMAIL: "user@example.com" }, () => false), 1);
    const text = collected.join("\n");
    assert.match(text, /ATLASSIAN_SITE_URL, ATLASSIAN_API_TOKEN/);
    assert.match(text, /init/);
  });

  it("warns about a source file other users can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "confluence-companion-cli-"));
    temporaries.push(dir);
    const path = join(dir, "config.env");
    writeFileSync(path, 'ATLASSIAN_EMAIL="user@file"\n', { mode: 0o600 });
    chmodSync(path, 0o644);

    const { collected, out } = lines();
    runConfig(out, [path], {}, () => true);
    const text = collected.join("\n");
    assert.match(text, /chmod 600/);
  });

  it("marks a source file that is not present", () => {
    const { collected, out } = lines();
    runConfig(out, ["/nope/config.env"], {}, () => false);
    assert.ok(collected.some((line) => line.includes("/nope/config.env") && line.includes("not present")));
  });
});

const temporaries = [];
after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});
