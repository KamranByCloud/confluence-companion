import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { execFileSync } from "node:child_process";

const repo = new URL("..", import.meta.url).pathname;
const temporaries = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "confluence-companion-install-"));
  temporaries.push(dir);
  return dir;
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

describe("bin/install", () => {
  it("registers the installed command in OpenCode's JSONC configuration", () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    const prefix = join(dir, "prefix");
    const configHome = join(dir, "config");
    mkdirSync(bin);
    writeExecutable(join(bin, "opencode"), "#!/bin/sh\n");
    mkdirSync(join(configHome, "opencode"), { recursive: true });
    writeFileSync(join(configHome, "opencode", "opencode.jsonc"), '{\n  // Keep this user setting.\n  "mcp": {\n    "atlassian": { "type": "remote", "url": "https://example.test" },\n  }\n}\n');

    execFileSync("sh", ["bin/install", "--no-deps"], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PREFIX: prefix, XDG_CONFIG_HOME: configHome },
      stdio: "pipe",
    });
    execFileSync("sh", ["bin/install", "--no-deps"], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PREFIX: prefix, XDG_CONFIG_HOME: configHome },
      stdio: "pipe",
    });

    const config = readFileSync(join(configHome, "opencode", "opencode.jsonc"), "utf8");
    assert.match(config, /Keep this user setting/);
    assert.match(config, /"atlassian"/);
    assert.match(config, /"confluence-companion": \{\s+"type": "local",\s+"command": \["confluence-companion"\],\s+"enabled": true/s);
    assert.equal((config.match(/"confluence-companion"\s*:/g) || []).length, 1);
  });

  it("creates an mcp object when OpenCode's configuration does not have one", () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    const configHome = join(dir, "config");
    mkdirSync(bin);
    writeExecutable(join(bin, "opencode"), "#!/bin/sh\n");
    mkdirSync(join(configHome, "opencode"), { recursive: true });
    writeFileSync(join(configHome, "opencode", "opencode.jsonc"), '{\n  "model": "example",\n}\n');

    execFileSync("sh", ["bin/install", "--no-deps"], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PREFIX: join(dir, "prefix"), XDG_CONFIG_HOME: configHome },
      stdio: "pipe",
    });

    const config = readFileSync(join(configHome, "opencode", "opencode.jsonc"), "utf8");
    assert.match(config, /"model": "example"/);
    assert.match(config, /"mcp": \{\s+"confluence-companion"/s);
  });

  it("does not invoke OpenCode when explicitly disabled", () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    const configHome = join(dir, "config");
    mkdirSync(bin);
    writeExecutable(join(bin, "opencode"), "#!/bin/sh\n");

    execFileSync("sh", ["bin/install", "--no-deps", "--no-opencode"], {
      cwd: repo,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PREFIX: join(dir, "prefix"), XDG_CONFIG_HOME: configHome },
      stdio: "pipe",
    });

    assert.equal(existsSync(join(configHome, "opencode", "opencode.jsonc")), false);
  });
});

after(() => {
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true });
});
