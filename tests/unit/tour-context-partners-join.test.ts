/**
 * Каталог туров Кузьмича и MCP (аудит владельца 08.08: «MCP не отдаёт список
 * туров» — get_tours возвращал «Туры не найдены» при живых турах в БД).
 *
 * Корень: buildTourContext джойнил users и читал u.company_name, а
 * company_name существует ТОЛЬКО в partners (052: алиас для name у
 * партнёров). «column does not exist» глушился общим catch — и Кузьмич в
 * чате, и MCP оставались без каталога; get_tour_details работал, потому что
 * джойна не имел. Оператор туров — partners (§1 CLAUDE.md).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
vi.mock('@/lib/planner', () => ({}));

import { pool } from '@/lib/db-pool';
import { TOOL_EXECUTION_FAILED } from '@/lib/kuzmich/tool-failure';

const q = pool.query as unknown as ReturnType<typeof vi.fn>;
afterEach(() => { q.mockReset(); vi.restoreAllMocks(); });

/** Строка базы, как её отдаёт SELECT каталога. */
const row = (id: number, over: Record<string, unknown>) => ({
  id, title: `Тур ${id}`, base_price: 10000, price_unit: 'per_person', multi_day_count: null,
  activity_type: 'trekking', location_name: null, duration_type: null, duration_hours: null,
  season_start: null, season_end: null, available_slots: null, next_available_date: null,
  short_description: null, has_schedule: false, has_details: false, operator_name: 'Тестовая компания',
  description: null, program_text: null, main_place_name: null, main_place_type: null,
  ...over,
});

/** get_tours настоящим исполнителем на подменённой базе; модуль новый — кэш каталога пуст. */
async function getTours(rows: unknown, args: Record<string, string>, surface?: 'mcp') {
  if (rows instanceof Error) q.mockRejectedValue(rows);
  else q.mockResolvedValue({ rows });
  vi.resetModules();
  const { executeKuzmichTool } = await import('@/lib/kuzmich/core');
  return executeKuzmichTool('get_tours', args, surface ? { surface } : {});
}
const ids = (s: string) => s.match(/^ID\d+/gm) ?? [];

const CORE = readFileSync(join(process.cwd(), 'lib/kuzmich/core.ts'), 'utf-8');

describe('buildTourContext: оператор — из partners', () => {
  it('джойн идёт в partners; фантомного users.company_name больше нет', () => {
    expect(CORE).toMatch(/LEFT JOIN partners p ON p\.id = ot\.operator_id/);
    expect(CORE).toMatch(/p\.name AS operator_name/);
    expect(CORE).not.toMatch(/LEFT JOIN users u ON u\.id = ot\.operator_id/);
    expect(CORE).not.toMatch(/u\.company_name/);
  });

  it('скрытые с витрины туры (837) не попадают и в каталог агентов', () => {
    // С 29.09 — общий шлюз витрины (publicTourSql): NULL в is_published
    // больше не считается опубликованным, как на сайте.
    expect(CORE).toMatch(/WHERE \$\{publicTourSql\('ot'\)\}/);
  });
});

describe('buildTourContext: обогащение не роняет каталог', () => {
  it('туры — отдельным запросом; places/knowledge — allSettled', () => {
    expect(CORE).toMatch(/const toursResult = await pool\.query<TourContextRow>/);
    expect(CORE).toMatch(/Promise\.allSettled\(\[\s*\n\s*pool\.query<\{ name: string; category/);
  });

  it('live-контекст с собственным catch', () => {
    expect(CORE).toMatch(/loadLiveContext\(\)\.catch\(\(\) => ''\)/);
  });

  it('ошибка каталога больше не глушится молча', () => {
    expect(CORE).toMatch(/console\.error\('\[buildTourContext\]/);
  });
});

describe('перф-аудит 08.08, пп. 4-5: тонкий каталог и раздельные TTL', () => {
  it('get_tours отдаёт только каталог — без блоба мест и знаний; отказ базы ≠ пустота', async () => {
    const out = await getTours([row(1, { title: 'Сплав' })], {});
    // Один запрос — каталог туров; мест и базы знаний инструмент не читает.
    expect(q).toHaveBeenCalledTimes(1);
    expect(ids(out)).toEqual(['ID1']);
    expect(out).not.toContain('МЕСТА И ДОСТОПРИМЕЧАТЕЛЬНОСТИ');
    expect(out).not.toContain('БАЗА ЗНАНИЙ');
    expect(await getTours([], {})).toBe('Туры не найдены.');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await getTours(new Error('connection refused'), {})).toBe(TOOL_EXECUTION_FAILED);
  });

  it('TTL раздельные: туры протухают быстрее обогащения', () => {
    const catalog = Number(CORE.match(/CATALOG_TTL_MS = (\d+) \* 60 \* 1000/)?.[1]);
    const enrich = Number(CORE.match(/ENRICHMENT_TTL_MS = (\d+) \* 60 \* 1000/)?.[1]);
    expect(catalog).toBeGreaterThan(0);
    expect(enrich).toBeGreaterThan(catalog);
  });

  it('дата «СЕГОДНЯ» собирается на каждый вызов, а не кэшируется', () => {
    const composeIdx = CORE.indexOf('export async function buildTourContext');
    const compose = CORE.slice(composeIdx, composeIdx + 1200);
    expect(compose).toMatch(/kamchatkaDateContext\(\)/);
    expect(compose).not.toMatch(/_tourCatalogCache =/);
  });
});

describe('get_tours: фильтр по типу активности применяется', () => {
  // С 25.09 фильтр — чистая функция lib/kuzmich/tour-filter; её правила держит
  // tour-filter.test.ts. Здесь — что исполнитель её зовёт: вызовом на
  // подменённой базе, а не поиском строки вызова в исходнике (решение 13.10).
  const ROWS = [
    row(1, { title: 'Рыбалка на Большой', activity_type: 'fishing' }),
    row(2, { title: 'Сплав по Быстрой', activity_type: 'rafting' }),
    row(3, { title: 'Облёт', activity_type: 'helicopter', description: 'Внизу видно озеро в кратере.' }),
    row(4, { title: 'Джип к перевалу', activity_type: 'jeep_safari', program_text: 'День 1. Перевал Вид на озеро.' }),
  ];

  it('аргумент activity_type фильтрует по слагу и по метке, без учёта регистра и пробелов', async () => {
    for (const want of ['  Рыбалка ', 'fishing']) {
      const out = await getTours(ROWS, { activity_type: want });
      expect(ids(out), want).toEqual(['ID1']);
    }
  });

  it('пустой результат фильтра — не тупик: агент получает полный каталог, но как замену', async () => {
    const out = await getTours(ROWS, { activity_type: 'дайвинг' });
    expect(out).toMatch(/^Туров «дайвинг» у операторов платформы сейчас нет/);
    expect(out).toContain('Весь каталог — для замены с явной оговоркой:');
    expect(ids(out).sort()).toEqual(['ID1', 'ID2', 'ID3', 'ID4']);
  });

  it('указатель полей доходит до фильтра: слово из описания и программы — блок (в)', async () => {
    const out = await getTours(ROWS, { activity_type: 'озеро' });
    expect(out).toContain('только в полном описании или программе');
    expect(ids(out).sort()).toEqual(['ID3', 'ID4']);
  });
});

describe('get_tours: проводка страниц', () => {
  const many = Array.from({ length: 10 }, (_, i) => row(100 + i, { title: `Облёт ${i}`, activity_type: 'helicopter',
    description: 'В полёте видно озеро в кратере.' }));

  it('на MCP — всегда страницы, и одна страница называет себя', async () => {
    const one = await getTours([row(1, { title: 'Сплав' })], {}, 'mcp');
    expect(one).toMatch(/Страница 1 из 1, туров всего 1\. Других страниц нет\.$/);
    const p1 = await getTours(many, {}, 'mcp');
    expect(ids(p1)).toHaveLength(7);
    expect(p1).toContain('Страница 1 из 2, туров всего 10.');
    expect(await getTours([row(1, { title: 'Сплав' })], { page: '2' }, 'mcp')).toBe('Страницы 2 нет: туров 1, страниц 1. Начни с page=1.');
  });

  it('в чате — целиком без строки о страницах; по просьбе страницы — страницы', async () => {
    const whole = await getTours(many, {});
    expect(ids(whole)).toHaveLength(10);
    expect(whole).not.toContain('Страница ');
    const asked = await getTours(many, { page: '2' });
    expect(ids(asked)).toHaveLength(3);
    expect(asked).toContain('Страница 2 из 2, туров всего 10. Это последняя.');
  });

  it('блок (в) в чате без страницы — до предела и строка «ещё»; на MCP — все туры страницами', async () => {
    const { FAR_CHAT_CAP } = await import('@/lib/kuzmich/tour-filter');
    expect(many.length).toBeGreaterThan(FAR_CHAT_CAP);
    const chat = await getTours(many, { activity_type: 'озеро' });
    expect(ids(chat)).toHaveLength(FAR_CHAT_CAP);
    expect(chat).toContain(`(Ещё ${many.length - FAR_CHAT_CAP} таких туров — get_tours с тем же activity_type и page=1 покажет все по страницам.)`);
    const p2 = await getTours(many, { activity_type: 'озеро', page: '2' }, 'mcp');
    expect(p2).toContain('туров всего 10.');
    expect(p2).not.toContain('(Ещё ');
  });
});
