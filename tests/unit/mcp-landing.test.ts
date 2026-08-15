/**
 * /mcp — человекочитаемый первоисточник о MCP-сервере (диагноз 15.08:
 * Алиса галлюцинировала «у Ведара нет MCP», потому что поисковый AI-ответ
 * читает индексируемый HTML, а не JSON-манифест).
 *
 * Сторож держит: факт сервера в первых строках страницы, список
 * инструментов из ЕДИНОГО реестра (не свой список), связность —
 * sitemap, футер, llms.txt, манифест и README ссылаются на страницу.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const PAGE = read('app/mcp/page.tsx');
const SITEMAP = read('lib/seo/sitemap-entries.ts');
const FOOTER = read('components/layout/Footer.tsx');
const LLMS = read('app/llms.txt/route.ts');
const MANIFEST = read('app/.well-known/mcp.json/route.ts');
const README = read('README.md');

describe('страница /mcp', () => {
  it('факт сервера — в первых строках: endpoint, transport, auth', () => {
    expect(PAGE).toMatch(/публичный MCP-сервер для ИИ-агентов/);
    expect(PAGE).toMatch(/https:\/\/vedarai\.ru\/api\/mcp/);
    expect(PAGE).toMatch(/Streamable HTTP/);
    expect(PAGE).toMatch(/не требуется/);
  });

  it('инструменты — из единого реестра, свой список запрещён', () => {
    expect(PAGE).toMatch(/import \{ PUBLIC_MCP_TOOLS, MCP_SERVER_INFO \} from '@\/lib\/mcp\/public-tools'/);
    expect(PAGE).toMatch(/PUBLIC_MCP_TOOLS\.map/);
    // Ни одного захардкоженного имени инструмента в разметке.
    expect(PAGE).not.toMatch(/'get_tours'|'make_trip_plan'|'create_lead'/);
  });

  it('каноника и JSON-LD WebAPI', () => {
    expect(PAGE).toMatch(/canonical: `\$\{SITE\}\/mcp`/);
    expect(PAGE).toMatch(/'@type': 'WebAPI'/);
    expect(PAGE).toMatch(/<JsonLd data=\{jsonLd\} \/>/);
  });
});

describe('связность первоисточника', () => {
  it('sitemap содержит /mcp', () => {
    expect(SITEMAP).toMatch(/\/mcp`/);
  });

  it('футер ведёт на /mcp', () => {
    expect(FOOTER).toMatch(/href: '\/mcp'/);
  });

  it('llms.txt и манифест ссылаются на HTML-страницу', () => {
    expect(LLMS).toMatch(/\$\{BASE\}\/mcp/);
    expect(MANIFEST).toMatch(/homepage: `\$\{base\}\/mcp`/);
  });

  it('README описывает MCP (Алиса опиралась на GitHub и не нашла)', () => {
    expect(README).toMatch(/публичный MCP-сервер/);
    expect(README).toMatch(/vedarai\.ru\/api\/mcp/);
  });
});
