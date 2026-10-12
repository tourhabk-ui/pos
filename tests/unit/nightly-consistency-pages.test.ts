// @vitest-environment node
/**
 * Ночная сверка каналов листает get_tours до последней страницы (#2362).
 *
 * С #2314 каталог для агентов отдаётся страницами по TOURS_PAGE_SIZE туров:
 * клиент MCP резал длинный ответ. Сверка же два дня снимала одну первую
 * страницу и честно сообщала расхождение, которого не было: 15 из 22 туров
 * «в llms есть, в mcp нет» при живом канале. Сторож, читающий первую страницу
 * многостраничного ответа, зеленеет ровно на каталоге до семи туров — и
 * краснеет, как только каталог вырос. Это и случилось.
 *
 * Держится связка целиком: число страниц берётся из хвоста, который пишет
 * сам paginateTourText (производитель и потребитель — один формат), страницы
 * склеиваются в один ответ, который разбор читает как есть, а не пришедшая
 * страница — третий исход «не смог», не расхождение (§4.0).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mcpTourIds, mcpDiagnosis } from '@/lib/quality/channel-consistency';
import { paginateTourText, TOURS_PAGE_SIZE } from '@/lib/kuzmich/tour-filter';

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf-8');
const WF = read('.github/workflows/nightly-consistency.yml');
const SCRIPT = read('scripts/check-channel-consistency.ts');

/** Каталог на 22 тура — как на проде 10.10 (#2362), четыре страницы по 7. */
const TOTAL = 22;
const CATALOG = ['РЕАЛЬНЫЕ ТУРЫ НА ПЛАТФОРМЕ (актуальные цены, называй по имени):']
  .concat(Array.from({ length: TOTAL }, (_, i) => `ID${i + 1}: "Тур ${i + 1}" — тип:trekking  от 10 000 р/чел | Оп: Оператор | Мест: 5`))
  .join('\n');
const PAGES = Math.ceil(TOTAL / TOURS_PAGE_SIZE);

/** Ответ /api/mcp на одну страницу — сырой JSON-RPC, как его кладёт curl. */
const rpc = (page: number) => JSON.stringify({
  jsonrpc: '2.0', id: page,
  result: { content: [{ type: 'text', text: paginateTourText(CATALOG, page) }] },
});

describe('workflow листает get_tours', () => {
  it('страница спрашивается аргументом page, число страниц — из хвоста первой', () => {
    expect(WF).toContain('\\"arguments\\":{\\"page\\":\\"$1\\"}');
    expect(WF).toContain("grep -oE 'Страница 1 из [0-9]+' mcp.json");
    expect(WF).toMatch(/for P in \$\(seq 2 "\$PAGES"\)/);
  });

  it('страницы 2..N дописываются в content первого ответа — для разбора это один ответ', () => {
    expect(WF).toContain(".result.content += input.result.content");
    expect(WF).toMatch(/mv mcp\.merged\.json mcp\.json/);
  });

  it('не пришедшая страница — «не смог», названный файлом, а не тихая первая страница', () => {
    expect(WF).toContain('> mcp-pages.problem');
    expect(WF).toMatch(/не получена \(HTTP \$CODE\)/);
    expect(WF).toMatch(/::error::get_tours/);
  });
});

describe('хвост страницы — тот, что ищет workflow', () => {
  it('производитель пишет «Страница 1 из N» в первую страницу и «Это последняя.» — в последнюю', () => {
    const first = paginateTourText(CATALOG, 1);
    expect(PAGES).toBeGreaterThan(1);
    expect(first).toContain(`Страница 1 из ${PAGES}, туров всего ${TOTAL}.`);
    expect(paginateTourText(CATALOG, PAGES)).toContain('Это последняя.');
  });

  it('в сыром JSON хвост виден как есть — кириллица не экранируется, grep его найдёт', () => {
    expect(rpc(1)).toContain(`Страница 1 из ${PAGES}`);
    expect(/Страница 1 из ([0-9]+)/.exec(rpc(1))?.[1]).toBe(String(PAGES));
  });
});

describe('склеенный ответ читается разбором целиком', () => {
  it('одна первая страница — семь туров из 22: ровно та ложная находка #2362', () => {
    expect(mcpTourIds(rpc(1)).size).toBe(TOURS_PAGE_SIZE);
  });

  it('content всех страниц в одном ответе — все 22 ID, и причина к нему не зовётся', () => {
    const merged = JSON.parse(rpc(1)) as { result: { content: unknown[] } };
    for (let p = 2; p <= PAGES; p++) {
      const page = JSON.parse(rpc(p)) as { result: { content: unknown[] } };
      merged.result.content.push(...page.result.content);
    }
    const body = JSON.stringify(merged);
    expect(mcpTourIds(body).size).toBe(TOTAL);
    expect(mcpDiagnosis(body)).toBeNull();
  });
});

describe('скрипт сверки: неполный канал не сравнивается', () => {
  it('читает mcp-pages.problem, называет исход «не смог» и убирает mcp из расхождений', () => {
    expect(SCRIPT).toContain("read('mcp-pages.problem')");
    expect(SCRIPT).toMatch(/не смог снять канал mcp целиком/);
    expect(SCRIPT).toMatch(/channels\.filter\(\(c\) => c\.channel !== 'mcp'\)/);
  });
});
