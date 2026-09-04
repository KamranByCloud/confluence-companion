import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { ConfigError, loadConfig, loadDotEnvIfPresent } from "../dist/config.js";

const KEYS = ["ATLASSIAN_SITE_URL", "ATLASSIAN_EMAIL", "ATLASSIAN_API_TOKEN"];
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

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

  for (const key of KEYS) {
    it(`names ${key} when it is missing`, () => {
      const env = { ...complete };
      delete env[key];
      setEnv(env);
      assert.throws(() => loadConfig(), (error) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, new RegExp(key));
        return true;
      });
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
    assert.throws(() => loadConfig(), (error) => !error.message.includes("token"));
  });
});

describe("loadDotEnvIfPresent", () => {
  it("ignores a missing file instead of throwing", () => {
    assert.doesNotThrow(() => loadDotEnvIfPresent("does/not/exist.env"));
  });
});
