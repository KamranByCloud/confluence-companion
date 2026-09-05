import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  CONFIG_KEYS,
  ConfigError,
  configSources,
  loadConfig,
  loadConfigSources,
  loadDotEnvIfPresent,
  normalizeConfig,
  renderConfigFile,
  resolveWithProvenance,
  userConfigPath,
  warnIfReadableByOthers,
  writeUserConfig,
} from "../dist/config.js";

const KEYS = ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const temporaries = [];

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  while (temporaries.length > 0) rmSync(temporaries.pop(), { recursive: true, force: true });
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "confluence-companion-test-"));
  temporaries.push(dir);
  return dir;
}

/** Files never override a variable that is already set, so start from nothing. */
function setEnv(overrides) {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, overrides);
}

const complete = {
  ATLASSIAN_SITE_URL: "https://example.atlassian.net",
  ATLASSIAN_EMAIL: "user@example.com",
  ATLASSIAN_API_TOKEN: "token",
};

describe("loadConfig", () => {
  it("reads a complete environment", () => {
    setEnv(complete);
    assert.deepEqual(loadConfig(), {
      siteUrl: "https://example.atlassian.net",
      email: "user@example.com",
      apiToken: "token",
    });
  });

  it("strips trailing slashes from the site URL", () => {
    setEnv({ ...complete, ATLASSIAN_SITE_URL: "https://example.atlassian.net///" });
    assert.equal(loadConfig().siteUrl, "https://example.atlassian.net");
  });

  it("trims surrounding whitespace", () => {
    setEnv({ ...complete, ATLASSIAN_EMAIL: "  user@example.com  " });
    assert.equal(loadConfig().email, "user@example.com");
  });

  it("reads an explicitly supplied environment instead of process.env", () => {
    setEnv({});
    assert.equal(loadConfig(complete).email, "user@example.com");
  });

  for (const key of KEYS) {
    it(`names ${key} when it is missing`, () => {
      const env = { ...complete };
      delete env[key];
      setEnv(env);
      assert.throws(
        () => loadConfig(),
        (error) => {
          assert.ok(error instanceof ConfigError);
          assert.match(error.message, new RegExp(key));
          return true;
        },
      );
    });

    it(`rejects ${key} when it is blank`, () => {
      setEnv({ ...complete, [key]: "   " });
      assert.throws(() => loadConfig(), ConfigError);
    });
  }

  it("rejects a site URL that carries a path, which would break endpoint building", () => {
    setEnv({ ...complete, ATLASSIAN_SITE_URL: "https://example.atlassian.net/wiki" });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it("rejects a plain http site URL", () => {
    setEnv({ ...complete, ATLASSIAN_SITE_URL: "http://example.atlassian.net" });
    assert.throws(() => loadConfig(), ConfigError);
  });

  it("never puts the token into the error message", () => {
    setEnv({ ...complete, ATLASSIAN_SITE_URL: "not-a-url" });
    assert.throws(
      () => loadConfig(),
      (error) => !error.message.includes("token"),
    );
  });
});

describe("normalizeConfig", () => {
  it("validates an interactively entered value exactly like an environment one", () => {
    assert.throws(
      () => normalizeConfig({ siteUrl: "example.atlassian.net", email: "a@b.c", apiToken: "t" }),
      ConfigError,
    );
  });

  it("names the environment variable even when the value came from a prompt", () => {
    assert.throws(
      () => normalizeConfig({ siteUrl: "https://example.atlassian.net", apiToken: "t" }),
      (error) => {
        assert.match(error.message, /ATLASSIAN_EMAIL/);
        return true;
      },
    );
  });
});

describe("userConfigPath", () => {
  it("defaults to ~/.config, outside every project", () => {
    assert.equal(
      userConfigPath({}, "/home/someone"),
      "/home/someone/.config/confluence-companion/config.env",
    );
  });

  it("honours XDG_CONFIG_HOME, which is how a container redirects it", () => {
    assert.equal(
      userConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/someone"),
      "/xdg/confluence-companion/config.env",
    );
  });

  it("ignores a relative XDG_CONFIG_HOME rather than resolving it against the cwd", () => {
    assert.equal(
      userConfigPath({ XDG_CONFIG_HOME: "relative/dir" }, "/home/someone"),
      "/home/someone/.config/confluence-companion/config.env",
    );
  });
});

describe("configSources", () => {
  it("consults the per-user file and nothing else", () => {
    // A .env inside the checkout is deliberately not a source: relative to an
    // installed single-file bundle that path resolves to nonsense, and it
    // could carry a token to another machine.
    const sources = configSources();
    assert.deepEqual(sources, [userConfigPath()]);
  });

  it("uses an absolute path, since the server is started from anywhere", () => {
    assert.ok(configSources()[0].startsWith("/"), configSources()[0]);
  });
});

describe("loadDotEnvIfPresent", () => {
  it("ignores a missing file instead of throwing", () => {
    assert.doesNotThrow(() => loadDotEnvIfPresent("does/not/exist.env"));
  });

  it("reports whether the file was there", () => {
    const dir = tempDir();
    const path = join(dir, "present.env");
    writeFileSync(path, "ATLASSIAN_EMAIL=from@file\n");
    setEnv({});
    assert.equal(loadDotEnvIfPresent(path), true);
    assert.equal(loadDotEnvIfPresent(join(dir, "absent.env")), false);
  });
});

describe("configuration precedence", () => {
  function sourcesWith(first, second) {
    const dir = tempDir();
    const a = join(dir, "first.env");
    const b = join(dir, "second.env");
    writeFileSync(a, first, { mode: 0o600 });
    writeFileSync(b, second, { mode: 0o600 });
    return [a, b];
  }

  it("lets the environment win over every file", () => {
    const sources = sourcesWith("ATLASSIAN_EMAIL=first@file\n", "ATLASSIAN_EMAIL=second@file\n");
    setEnv({ ATLASSIAN_EMAIL: "real@env" });
    loadConfigSources({ sources, warn: () => {} });
    assert.equal(process.env.ATLASSIAN_EMAIL, "real@env");
  });

  it("lets an earlier source win over a later one", () => {
    const sources = sourcesWith("ATLASSIAN_EMAIL=first@file\n", "ATLASSIAN_EMAIL=second@file\n");
    setEnv({});
    loadConfigSources({ sources, warn: () => {} });
    assert.equal(process.env.ATLASSIAN_EMAIL, "first@file");
  });

  it("falls back to a later source for a setting the earlier one omits", () => {
    const sources = sourcesWith(
      "ATLASSIAN_EMAIL=first@file\n",
      "ATLASSIAN_EMAIL=second@file\nATLASSIAN_API_TOKEN=second-token\n",
    );
    setEnv({});
    loadConfigSources({ sources, warn: () => {} });
    assert.equal(process.env.ATLASSIAN_EMAIL, "first@file");
    assert.equal(process.env.ATLASSIAN_API_TOKEN, "second-token");
  });

  it("returns only the sources that existed", () => {
    const [a] = sourcesWith("ATLASSIAN_EMAIL=first@file\n", "");
    setEnv({});
    const loaded = loadConfigSources({ sources: [a, "/nope/missing.env"], warn: () => {} });
    assert.deepEqual(loaded, [a]);
  });
});

describe("warnIfReadableByOthers", () => {
  it("says nothing about a file only its owner can read", () => {
    const path = join(tempDir(), "tight.env");
    writeFileSync(path, "x=1\n", { mode: 0o600 });
    const warnings = [];
    assert.equal(warnIfReadableByOthers(path, (m) => warnings.push(m)), false);
    assert.deepEqual(warnings, []);
  });

  it("warns about a token file others can read, and says how to fix it", () => {
    const path = join(tempDir(), "loose.env");
    writeFileSync(path, "x=1\n", { mode: 0o600 });
    chmodSync(path, 0o644);
    const warnings = [];
    assert.equal(warnIfReadableByOthers(path, (m) => warnings.push(m)), true);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /644/);
    assert.match(warnings[0], /chmod 600/);
  });

  it("stays quiet about a file that is not there", () => {
    const warnings = [];
    assert.equal(warnIfReadableByOthers("/nope/missing.env", (m) => warnings.push(m)), false);
    assert.deepEqual(warnings, []);
  });
});

describe("renderConfigFile", () => {
  const config = {
    siteUrl: "https://example.atlassian.net",
    email: "user@example.com",
    apiToken: "plain-token",
  };

  it("writes all three settings", () => {
    const rendered = renderConfigFile(config);
    for (const key of CONFIG_KEYS) assert.match(rendered, new RegExp(`^${key}=`, "m"));
  });

  it("quotes values, because an unquoted '#' would truncate the token", () => {
    // Measured: Node's parser reads PLAIN=abc#def as "abc". A real Atlassian
    // token containing '#' would be silently cut short without the quotes.
    const path = join(tempDir(), "hash.env");
    writeFileSync(path, renderConfigFile({ ...config, apiToken: "abc#def" }), { mode: 0o600 });
    setEnv({});
    loadDotEnvIfPresent(path);
    assert.equal(process.env.ATLASSIAN_API_TOKEN, "abc#def");
  });

  it("round trips a written file back through the loader", () => {
    const path = join(tempDir(), "round.env");
    writeFileSync(path, renderConfigFile(config), { mode: 0o600 });
    setEnv({});
    loadDotEnvIfPresent(path);
    assert.deepEqual(loadConfig(), config);
  });

  for (const [name, apiToken] of [
    ["a quote", 'to"ken'],
    ["a backslash", "to\\ken"],
    ["a line break", "to\nken"],
  ]) {
    it(`refuses to store a token containing ${name} instead of corrupting it`, () => {
      // The parser has no escape sequence inside quotes, so such a value
      // cannot be represented at all.
      assert.throws(() => renderConfigFile({ ...config, apiToken }), ConfigError);
    });
  }
});

describe("writeUserConfig", () => {
  const config = {
    siteUrl: "https://example.atlassian.net",
    email: "user@example.com",
    apiToken: "plain-token",
  };

  it("creates the file at mode 600 inside a directory at mode 700", () => {
    const path = join(tempDir(), "nested", "config.env");
    assert.equal(writeUserConfig(config, path), path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(path, "..")).mode & 0o777, 0o700);
    assert.match(readFileSync(path, "utf8"), /ATLASSIAN_SITE_URL/);
  });

  it("tightens a file whose mode had been loosened", () => {
    // Measured: writeFileSync's mode option only applies when the file is
    // created, so overwriting a 644 file would otherwise leave it at 644.
    const path = join(tempDir(), "config.env");
    writeUserConfig(config, path);
    chmodSync(path, 0o644);
    writeUserConfig(config, path);
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});

describe("resolveWithProvenance", () => {
  it("names the environment, the file, or nothing for each setting", () => {
    const dir = tempDir();
    const path = join(dir, "user.env");
    writeFileSync(path, "ATLASSIAN_EMAIL=user@file\n", { mode: 0o600 });
    setEnv({ ATLASSIAN_SITE_URL: "https://example.atlassian.net" });

    const provenance = resolveWithProvenance([path], process.env);
    assert.deepEqual(
      provenance.map(({ key, source }) => [key, source]),
      [
        ["ATLASSIAN_SITE_URL", "environment"],
        ["ATLASSIAN_EMAIL", path],
        ["ATLASSIAN_API_TOKEN", null],
      ],
    );
    assert.deepEqual(
      provenance.map(({ set }) => set),
      [true, true, false],
    );
  });
});
