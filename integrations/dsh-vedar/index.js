// dsh-vedar — carrier plugin for DeepSeek Harness (dsh).
//
// The work is done by the bundle patch (cordis.patch.yml): it registers one
// instance of the official bridge @deepseek-ai/dsh-mcp-client pointed at the
// Vedar MCP server, and the harness exposes its tools as mcp__vedar__<tool>.
// This module stays inert so the package is loadable wherever the harness
// expects a plugin entry; it registers nothing itself.
export const name = 'dsh-vedar';
export const inject = [];
export function apply() {}
