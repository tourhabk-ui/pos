/**
 * README называет столько инструментов MCP, сколько их в реестре сервера.
 *
 * Внешняя проверка MCP 26.09: README говорил «13 инструментов», а сервер
 * отдавал 14 — число в прозе устарело молча, как «778 мест» (CLAUDE.md
 * §4.1). Страница /mcp берёт число из реестра сама; README — текст, и держит
 * его только этот сторож.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PUBLIC_MCP_TOOLS } from '@/lib/mcp/public-tools';

describe('README: число инструментов MCP', () => {
  it('совпадает с реестром сервера', () => {
    const readme = readFileSync('README.md', 'utf-8');
    const m = /(\d+) инструмент/.exec(readme.slice(readme.indexOf('MCP-сервер')));
    expect(m, 'README не называет число инструментов MCP').not.toBeNull();
    expect(Number(m![1])).toBe(PUBLIC_MCP_TOOLS.length);
  });
});
