import { describe, expect, it } from 'vitest';
import { parseRssItems } from '@/lib/agents/scout-digest';
import { RSS_SOURCES } from '@/lib/agents/scout-sources';

/**
 * Форматы сверены с живыми ответами 22.11: GitHub releases.atom (Atom
 * <entry>/<link href>/<updated>) и cursor.com/changelog/rss.xml (RSS 2.0
 * <item>/<link>/<pubDate>). Сами тела здесь — укороченные фикстуры, чтобы
 * тест не ходил в сеть.
 */
const GITHUB_ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en-US">
  <title>Release notes from modelcontextprotocol</title>
  <updated>2026-07-28T12:00:00Z</updated>
  <entry>
    <id>tag:github.com,2008:Repository/1/Release/1</id>
    <updated>2026-07-28T12:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2025-11-25"/>
    <title>2025-11-25</title>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1/Release/2</id>
    <updated>2026-06-18T09:00:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/modelcontextprotocol/modelcontextprotocol/releases/tag/2025-06-18"/>
    <title>Specification 2025-06-18</title>
  </entry>
</feed>`;

const CURSOR_RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Cursor Changelog</title>
    <item>
      <title>Voice Chat with Agents</title>
      <link>https://cursor.com/changelog</link>
      <pubDate>Fri, 06 Nov 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

describe('официальные ленты релизов в RSS_SOURCES', () => {
  it('пять проверенных адресов стоят в списке', () => {
    const byKey = Object.fromEntries(RSS_SOURCES.map(s => [s.key, s.url]));
    expect(byKey.mcp_spec).toBe('https://github.com/modelcontextprotocol/modelcontextprotocol/releases.atom');
    expect(byKey.mcp_ts_sdk).toBe('https://github.com/modelcontextprotocol/typescript-sdk/releases.atom');
    expect(byKey.mcp_py_sdk).toBe('https://github.com/modelcontextprotocol/python-sdk/releases.atom');
    expect(byKey.a2a_releases).toBe('https://github.com/a2aproject/A2A/releases.atom');
    expect(byKey.cursor_changelog).toBe('https://cursor.com/changelog/rss.xml');
  });
});

describe('parseRssItems понимает Atom релизов GitHub и RSS changelog Cursor', () => {
  it('разбирает GitHub releases.atom', () => {
    const items = parseRssItems(GITHUB_ATOM, 'MCP specification');
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('2025-11-25');
    expect(items[0].url).toContain('/releases/tag/');
    expect(items[0].publishedAt).toBe('2026-07-28T12:00:00.000Z');
    expect(items[0].source).toBe('MCP specification');
  });

  it('разбирает RSS changelog Cursor', () => {
    const items = parseRssItems(CURSOR_RSS, 'Cursor changelog');
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Voice Chat with Agents');
    expect(items[0].url).toBe('https://cursor.com/changelog');
    expect(items[0].publishedAt).toBe('2026-11-06T00:00:00.000Z');
  });
});
