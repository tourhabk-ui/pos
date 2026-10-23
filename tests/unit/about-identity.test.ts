// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('/about identity and Organization sameAs', () => {
  it('about names MCP endpoint and llms files in three languages', () => {
    const src = readFileSync('app/about/page.tsx', 'utf8');
    expect(src).toContain('https://vedarai.ru/api/mcp');
    expect(src).toContain('/llms.txt');
    expect(src).toContain('/llms-en.txt');
    expect(src).toContain('/llms-zh.txt');
    expect(src).toContain('Model Context Protocol');
    expect(src).toContain('мгновенной брони и оплаты через');
  });
  it('Organization JSON-LD links GitHub, MCP registry and Smithery', () => {
    const src = readFileSync('app/layout.tsx', 'utf8');
    for (const u of ['https://t.me/kamchatka_real', 'https://github.com/tourhabk-ui/pos', 'registry.modelcontextprotocol.io', 'https://smithery.ai/servers/tourhabk/vedar', 'https://github.com/tourhabk-ui/vedar-mcp-examples', 'https://t.me/kuzmichai_bot', 'https://max.ru/id4101147649_bot']) {
      expect(src).toContain(u);
    }
  });
});
