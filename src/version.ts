/**
 * Single source for the version reported by the CLI and announced over MCP.
 * A constant rather than a read of package.json, because the planned install
 * artifact is one bundled file with no package.json beside it.
 */
export const VERSION = "0.1.0";
