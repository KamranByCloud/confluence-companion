#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const name = process.argv[2];

if (!name) {
  throw new Error("missing MCP server name");
}

const configHome = process.env.XDG_CONFIG_HOME || join(process.env.HOME, ".config");
const configPath = chooseGlobalConfig(configHome);
const entry = `"${name}": {\n      "type": "local",\n      "command": ["${name}"],\n      "enabled": true\n    }`;

if (!existsSync(configPath)) {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath, `{\n  "mcp": {\n    ${entry}\n  }\n}\n`, { mode: 0o600 });
  process.exit(0);
}

const source = readFileSync(configPath, "utf8");
const withoutComments = stripComments(source);
const mcp = findMcpObject(withoutComments);

if (!mcp) {
  if (/"mcp"\s*:/.test(withoutComments)) {
    throw new Error(`the mcp setting in ${configPath} is not an object`);
  }
  const rootEnd = findMatchingBrace(withoutComments, withoutComments.indexOf("{"));
  if (rootEnd === -1) throw new Error(`cannot locate the root object in ${configPath}`);
  const prefix = withoutComments.slice(0, rootEnd).trimEnd();
  const separator = prefix.endsWith("{") || prefix.endsWith(",") ? "\n" : ",\n";
  writeFileSync(configPath, `${source.slice(0, rootEnd)}${separator}  "mcp": {\n    ${entry}\n  }${source.slice(rootEnd)}`);
  process.exit(0);
}

if (hasProperty(withoutComments.slice(mcp.start, mcp.end + 1), name)) {
  process.exit(0);
}

const body = withoutComments.slice(mcp.start + 1, mcp.end).trim();
const separator = body && !body.endsWith(",") ? ",\n" : "\n";
writeFileSync(configPath, `${source.slice(0, mcp.end)}${separator}    ${entry}\n  ${source.slice(mcp.end)}`);

function chooseGlobalConfig(home) {
  const jsonc = join(home, "opencode", "opencode.jsonc");
  const json = join(home, "opencode", "opencode.json");
  return existsSync(jsonc) || !existsSync(json) ? jsonc : json;
}

function stripComments(source) {
  let result = "";
  let quote = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      result += character;
      if (!escaped && character === '"') quote = false;
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      continue;
    }
    if (character === '"') {
      quote = true;
      result += character;
    } else if (character === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        result += " ";
        index += 1;
      }
      result += source[index] || "";
    } else if (character === "/" && next === "*") {
      result += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      result += "  ";
      index += 1;
    } else {
      result += character;
    }
  }
  return result;
}

function findMcpObject(source) {
  const match = /"mcp"\s*:\s*\{/.exec(source);
  if (!match) return undefined;
  const start = source.indexOf("{", match.index);
  const end = findMatchingBrace(source, start);
  return end === -1 ? undefined : { start, end };
}

function findMatchingBrace(source, start) {
  let depth = 0;
  let quote = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (!escaped && character === '"') quote = false;
      escaped = !escaped && character === "\\";
      if (character !== "\\") escaped = false;
      continue;
    }
    if (character === '"') quote = true;
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function hasProperty(source, property) {
  return new RegExp(`"${property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*:`).test(source);
}
