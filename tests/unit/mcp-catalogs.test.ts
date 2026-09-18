/**
 * Сторож: каталоги, где числится MCP-сервер, названы у первоисточника — одним
 * списком, и этот список не расходится с тем, чем записи заводятся.
 *
 * ── Откуда ────────────────────────────────────────────────────────────────
 *
 * 18.09, после публикации в реестре и Smithery, владелец назвал приоритет:
 * «чтобы агент, которому сказали „Камчатка“, имел шанс тебя найти и счесть
 * надёжным источником». Найти — каталоги; счесть надёжным — подтверждение
 * у первоисточника: манифест, llms.txt, страница /mcp и README обязаны
 * называть те же идентификаторы, что стоят в каталогах. Иначе запись в
 * каталоге выглядит чужой, а первоисточник — не знающим о ней.
 *
 * ── Что держится ──────────────────────────────────────────────────────────
 *
 * · имя реестра и английское описание — из server.json, не второй копией;
 * · имя Smithery равно имени в маркере публикации (маркер — то, чем запись
 *   заводится; константа — то, что о ней говорят; разойдутся — сторож красный);
 * · glama.json — по схеме Glama, с владельцем репозитория из server.json;
 * · манифест, llms.txt, /mcp и README читают список, а не держат свой.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_CATALOGS, SMITHERY_SERVER_NAME, MCP_TITLE_EN, MCP_DESCRIPTION_EN } from '@/lib/mcp/catalogs';
import { GET as manifestGet } from '@/app/.well-known/mcp.json/route';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const SERVER_JSON = JSON.parse(read('server.json')) as {
  name: string; title: string; description: string; repository: { url: string };
};
const SMITHERY_MARKER = JSON.parse(read('.github/triggers/smithery-publish.json')) as { name: string };
const GLAMA = JSON.parse(read('glama.json')) as { $schema: string; maintainers: string[] };

describe('список каталогов — один, и он совпадает с тем, чем записи заводятся', () => {
  it('реестр: имя и английский текст — из server.json', () => {
    // Каталог узнаётся по хосту адреса с якорем: подстрока в середине URL
    // совпала бы и с чужим хостом (CodeQL на первом прогоне).
    const registry = MCP_CATALOGS.find((c) => c.url.startsWith('https://registry.modelcontextprotocol.io/'));
    expect(registry).toBeDefined();
    expect(registry!.name).toBe(SERVER_JSON.name);
    expect(registry!.catalog).toMatch(/^MCP Registry/);
    expect(MCP_TITLE_EN).toBe(SERVER_JSON.title);
    expect(MCP_DESCRIPTION_EN).toBe(SERVER_JSON.description);
    // Английский текст — латиницей: кириллица здесь значит, что описание
    // подменили русским и каталоги получат не то, что обещано.
    expect(MCP_DESCRIPTION_EN).not.toMatch(/[А-Яа-я]/);
  });

  it('Smithery: имя равно имени в маркере публикации, команда подключения — по нему', () => {
    const smithery = MCP_CATALOGS.find((c) => c.catalog === 'Smithery');
    expect(smithery).toBeDefined();
    expect(smithery!.name).toBe(SMITHERY_SERVER_NAME);
    expect(SMITHERY_SERVER_NAME).toBe(SMITHERY_MARKER.name);
    expect(smithery!.install).toBe(`npx -y smithery mcp add ${SMITHERY_SERVER_NAME}`);
    expect(smithery!.url).toContain(SMITHERY_SERVER_NAME);
  });

  it('у каждой записи есть каталог, имя и адрес; имён не два одинаковых', () => {
    for (const c of MCP_CATALOGS) {
      expect(c.catalog).toBeTruthy();
      expect(c.name).toMatch(/^[a-z0-9.-]+\/[a-z0-9._-]+$/i);
      expect(c.url).toMatch(/^https:\/\//);
    }
    expect(new Set(MCP_CATALOGS.map((c) => c.name)).size).toBe(MCP_CATALOGS.length);
  });
});

describe('glama.json — заявка на запись в Glama', () => {
  it('по схеме Glama, владелец — тот же, что у репозитория в server.json', () => {
    /**
     * Glama индексирует репозитории GitHub и отдаёт запись тому, кто назван
     * в `maintainers`; чужое имя здесь — запись, которую мы не сможем править.
     */
    expect(GLAMA.$schema).toBe('https://glama.ai/mcp/schemas/server.json');
    const owner = SERVER_JSON.repository.url.match(/github\.com\/([^/]+)\//)?.[1];
    expect(owner).toBeTruthy();
    expect(GLAMA.maintainers).toEqual([owner]);
  });
});

describe('первоисточники читают список, а не держат свой', () => {
  it('манифест отдаёт каталоги и английский текст', async () => {
    const res = await manifestGet();
    const body = await res.json() as {
      title: string; descriptionEn: string; catalogs: { name: string }[];
    };
    expect(body.title).toBe(SERVER_JSON.title);
    expect(body.descriptionEn).toBe(SERVER_JSON.description);
    expect(body.catalogs.map((c) => c.name).sort()).toEqual(MCP_CATALOGS.map((c) => c.name).sort());
  });

  it('llms.txt и /mcp импортируют список; своих идентификаторов в разметке нет', () => {
    for (const f of ['app/llms.txt/route.ts', 'app/mcp/page.tsx', 'app/.well-known/mcp.json/route.ts']) {
      const src = read(f);
      expect(src, f).toMatch(/from '@\/lib\/mcp\/catalogs'/);
      expect(src, f).toMatch(/MCP_CATALOGS/);
      expect(src, `${f}: идентификатор каталога захардкожен`).not.toMatch(/tourhabk\/vedar|ru\.vedarai\/mcp/);
    }
    const page = read('app/mcp/page.tsx');
    expect(page).toMatch(/В каталогах MCP/);
    expect(page).toMatch(/sameAs: MCP_CATALOGS\.map/);
    const llms = read('app/llms.txt/route.ts');
    expect(llms).toMatch(/В каталогах:/);
    expect(llms).toMatch(/English: \$\{MCP_TITLE_EN\}/);
  });

  it('README называет те же идентификаторы (Glama и поисковые ответы читают GitHub)', () => {
    const readme = read('README.md');
    for (const c of MCP_CATALOGS) expect(readme, c.catalog).toContain(`\`${c.name}\``);
    expect(readme).toMatch(/glama\.json/);
    expect(readme).toContain(MCP_TITLE_EN);
  });
});
