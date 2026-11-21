import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const MCP_URL = 'https://vedarai.ru/api/mcp';

function read(rel: string): string {
  return readFileSync(resolve(root, rel), 'utf8');
}

function json(rel: string): Record<string, unknown> {
  return JSON.parse(read(rel)) as Record<string, unknown>;
}

describe('agent catalog manifests', () => {
  it('official server.json stays in sync with the published MCP version and endpoint', () => {
    const server = json('server.json');
    expect(server.name).toBe('ru.vedarai/mcp');
    expect(server.version).toBe('2.10.2');
    expect(String(server.description).length).toBeLessThanOrEqual(100);
    const remotes = server.remotes as Array<{ type: string; url: string }>;
    expect(remotes).toEqual([{ type: 'streamable-http', url: MCP_URL }]);
  });

  it('Cursor plugin manifest uses the official name field and points at the public MCP server', () => {
    const plugin = json('.cursor-plugin/plugin.json');
    expect(plugin.name).toBe('vedar');
    expect(plugin.license).toBe('AGPL-3.0');
    expect(plugin.mcpServers).toBe('mcp.json');
    const mcp = json('mcp.json');
    const servers = mcp.mcpServers as { vedar: { url: string } };
    expect(servers.vedar.url).toBe(MCP_URL);
  });

  it('Claude plugin manifest includes the remote HTTP MCP endpoint', () => {
    const plugin = json('.claude-plugin/plugin.json');
    expect(plugin.name).toBe('vedar');
    const servers = plugin.mcpServers as { vedar: { type: string; url: string } };
    expect(servers.vedar).toEqual({ type: 'http', url: MCP_URL });
  });

  it('Gemini CLI extension manifest uses url and type http', () => {
    const ext = json('gemini-extension.json');
    expect(ext.name).toBe('vedar');
    expect(ext.version).toBe('2.10.2');
    const servers = ext.mcpServers as { vedar: { type: string; url: string } };
    expect(servers.vedar).toEqual({ type: 'http', url: MCP_URL });
  });

  it('root SKILL.md and skills/vedar-kamchatka/SKILL.md share Agent Skills frontmatter', () => {
    for (const rel of ['SKILL.md', 'skills/vedar-kamchatka/SKILL.md']) {
      const text = read(rel);
      expect(text.startsWith('---\n')).toBe(true);
      expect(text).toContain('name: vedar-kamchatka');
      expect(text).toContain('license: AGPL-3.0');
      expect(text).toContain(MCP_URL);
    }
  });
});
