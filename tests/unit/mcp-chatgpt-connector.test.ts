// @vitest-environment node
/**
 * Пара search / fetch для коннекторов ChatGPT (lib/mcp/connector-tools,
 * ступень 2 агентного контура, 12.10).
 *
 * Держит: имена ровно `search` и `fetch` (иначе ChatGPT сервер не
 * подключает), форма результата по документации OpenAI (results[] с id,
 * title, url; id/title/text/url/metadata), outputSchema объявлена, оба
 * читают и идемпотентны, поиск идёт под теми же гейтами витрины, что
 * страницы сайта (publicTourSql, NOT_MERGED, publicAccommodationSql,
 * is_visible у представления маршрутов), отказ источника — отказ всего
 * поиска (§4.0), в тексте fetch нет телефонов и почт (pd-guard), роут MCP
 * отдаёт structuredContent, а A2A кладёт объект в DataPart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('@/lib/db-pool', () => ({ pool: { query } }));

import {
  SEARCH_TOOL, FETCH_TOOL, CONNECTOR_TOOL_NAMES, parseDocId, docId, docUrl, searchDocuments, fetchDocument, runConnectorTool,
  SEARCH_RESULTS_MAX, QUERY_MIN_CHARS,
} from '@/lib/mcp/connector-tools';
import { PUBLIC_MCP_TOOLS, PUBLIC_MCP_TOOL_NAMES, TOOL_ANNOTATIONS, WRITE_TOOL_NAMES } from '@/lib/mcp/public-tools';
import { McpUserError } from '@/lib/mcp/jsonrpc';

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');
const BASE = 'https://vedarai.ru';

beforeEach(() => {
  query.mockReset();
});

describe('объявление инструментов', () => {
  it('имена ровно search и fetch, оба в публичном реестре, оба читают и идемпотентны', () => {
    expect(SEARCH_TOOL.name).toBe('search');
    expect(FETCH_TOOL.name).toBe('fetch');
    expect([...CONNECTOR_TOOL_NAMES].sort()).toEqual(['fetch', 'search']);
    for (const n of ['search', 'fetch']) {
      expect(PUBLIC_MCP_TOOL_NAMES.has(n), n).toBe(true);
      expect(WRITE_TOOL_NAMES.has(n), n).toBe(false);
      expect(TOOL_ANNOTATIONS[n]).toMatchObject({ readOnlyHint: true, idempotentHint: true, destructiveHint: false });
    }
  });

  it('схемы входа и выхода — по документации OpenAI: query → results[{id,title,url}], id → {id,title,text,url,metadata}', () => {
    const search = PUBLIC_MCP_TOOLS.find((t) => t.name === 'search')!;
    const fetch = PUBLIC_MCP_TOOLS.find((t) => t.name === 'fetch')!;
    expect((search.inputSchema as { required: string[] }).required).toEqual(['query']);
    expect((fetch.inputSchema as { required: string[] }).required).toEqual(['id']);
    const so = search.outputSchema as { required: string[]; properties: { results: { items: { required: string[] } } } };
    expect(so.required).toEqual(['results']);
    expect(so.properties.results.items.required).toEqual(['id', 'title', 'url']);
    const fo = fetch.outputSchema as { required: string[]; properties: Record<string, unknown> };
    expect(fo.required).toEqual(['id', 'title', 'text', 'url']);
    expect(Object.keys(fo.properties)).toEqual(['id', 'title', 'text', 'url', 'metadata']);
    // Английский слой и заголовок — как у остальных (каталоги и Glama читают буквы).
    expect(search.title).toBeTruthy();
    expect(search.description).toMatch(/Kamchatka/);
    expect(fetch.description).toMatch(/Published records only/);
  });
});

describe('идентификаторы документов', () => {
  it('род и ключ читаются из id, мусор — null; url ведёт на свою страницу', () => {
    expect(parseDocId('tour:12')).toEqual({ kind: 'tour', key: '12' });
    expect(parseDocId('place:kurilskoe-ozero')).toEqual({ kind: 'place', key: 'kurilskoe-ozero' });
    expect(parseDocId('stay:0b10231b-063c-4d6d-8778-8e18486b6fa4')).toEqual({ kind: 'stay', key: '0b10231b-063c-4d6d-8778-8e18486b6fa4' });
    expect(parseDocId('route:vulkan-gorelyy')).toEqual({ kind: 'route', key: 'vulkan-gorelyy' });
    expect(parseDocId('booking:1')).toBeNull();
    expect(parseDocId('tour:')).toBeNull();
    expect(parseDocId("tour:1'; DROP TABLE x")).toBeNull();
    expect(parseDocId(42)).toBeNull();
    expect(docId('tour', '12')).toBe('tour:12');
    expect(docUrl('tour', '12', BASE)).toBe('https://vedarai.ru/catalog/tours/12');
    expect(docUrl('place', 'kurilskoe-ozero', BASE)).toBe('https://vedarai.ru/places/kurilskoe-ozero');
    expect(docUrl('stay', 'abc', BASE)).toBe('https://vedarai.ru/accommodations/abc');
    expect(docUrl('route', 'x-y', BASE)).toBe('https://vedarai.ru/routes/x-y');
  });
});

describe('search', () => {
  it('четыре источника под гейтами витрины, слияние по похожести, не больше десяти, у каждого url', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM operator_tours')) {
        expect(sql).toMatch(/ot\.is_active = true AND ot\.is_published = true AND ot\.deleted_at IS NULL/);
        return { rows: [{ key: '7', title: 'Курильское озеро (вертолёт)', score: 0.6 }] };
      }
      if (sql.includes('FROM places')) {
        expect(sql).toMatch(/p\.is_visible = TRUE AND p\.merged_into_id IS NULL/);
        return { rows: [{ key: 'kurilskoe-ozero', title: 'Курильское озеро', score: 0.9 }] };
      }
      if (sql.includes('FROM accommodations')) {
        expect(sql).toMatch(/a\.is_active = true AND a\.moderation_status = 'approved'/);
        return { rows: [] };
      }
      if (sql.includes('FROM v_kamchatka_routes_api')) {
        expect(sql).toMatch(/r\.is_visible = TRUE/);
        return { rows: Array.from({ length: 12 }, (_, i) => ({ key: `r${i}`, title: `Маршрут ${i}`, score: 0.1 })) };
      }
      throw new Error(`неожиданный запрос: ${sql.slice(0, 60)}`);
    });
    const out = await searchDocuments('Курильское озеро', BASE);
    expect(out.results.length).toBe(SEARCH_RESULTS_MAX);
    expect(out.results[0]).toEqual({ id: 'place:kurilskoe-ozero', title: 'Курильское озеро', url: 'https://vedarai.ru/places/kurilskoe-ozero' });
    expect(out.results[1].id).toBe('tour:7');
    for (const r of out.results) expect(r.url).toMatch(/^https:\/\/vedarai\.ru\//);
    // Параметры: запрос для similarity и шаблон ILIKE на КАЖДОЕ слово (основы),
    // без конкатенации. До 12.10 вся строка шла одним куском, и пример из
    // описания инструмента на проде отвечал пусто.
    for (const call of query.mock.calls) {
      expect(call[1]).toEqual(['Курильское озеро', '%курильск%', '%озер%']);
      expect(call[0]).not.toMatch(/\|\| *'%'/);
      expect(call[0]).toContain('ILIKE $3');
    }
  });

  it('ранг — число совпавших слов раньше похожести: запись с двумя словами выше записи с одним', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM places')) {
        return { rows: [
          { key: 'ozero-tolmacheva', title: 'Озеро Толмачёва', score: 0.7, hits: 1 },
          { key: 'kurilskoe-ozero', title: 'Курильское озеро', score: 0.4, hits: 2 },
        ] };
      }
      return { rows: [] };
    });
    const out = await searchDocuments('Курильское озеро медведи', BASE);
    expect(out.results.map((r) => r.id)).toEqual(['place:kurilskoe-ozero', 'place:ozero-tolmacheva']);
    expect(query.mock.calls[0][1]).toEqual(['Курильское озеро медведи', '%курильск%', '%озер%', '%медве%']);
  });

  it('короткий запрос — отказ по входу (McpUserError), база не трогается', async () => {
    await expect(searchDocuments('а', BASE)).rejects.toBeInstanceOf(McpUserError);
    await expect(searchDocuments(undefined, BASE)).rejects.toThrow(new RegExp(`${QUERY_MIN_CHARS}`));
    expect(query).not.toHaveBeenCalled();
  });

  it('отказ одного источника — отказ всего поиска с SQLSTATE в логе, а не «нашлось меньше»', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM accommodations')) throw Object.assign(new Error('relation missing'), { code: '42P01' });
      return { rows: [{ key: '1', title: 'x', score: 1 }] };
    });
    await expect(searchDocuments('озеро', BASE)).rejects.not.toBeInstanceOf(McpUserError);
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('источник stays'), expect.stringContaining('42P01'), expect.any(String));
    spy.mockRestore();
  });
});

describe('fetch', () => {
  it('тур: публичный гейт, текст из полей строки, url по slug, metadata с ценой; телефонов и почт нет', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: '12', title: 'Вулкан Горелый', slug: 'mestechko-vulkan-gorelyy', short_description: 'Коротко', description: 'Подробно',
      base_price: '15000.00', currency: 'RUB', price_unit: 'per_person', duration_hours: '9.00', duration_type: 'day', multi_day_count: null,
      difficulty: 'medium', season_start: null, season_end: null, location_name: 'Вулкан Горелый',
      included: ['обед'], not_included: null, what_to_bring: ['очки'], safety_notes: ['погода меняется'],
      program: [{ title: 'Выезд', text: 'в 7:00' }], price_note: 'детям скидка', cancellation_policy: null, operator_name: 'Местечко Камчатка',
    }] });
    const doc = await fetchDocument('tour:12', BASE);
    expect(query.mock.calls[0][0]).toMatch(/ot\.is_active = true AND ot\.is_published = true AND ot\.deleted_at IS NULL/);
    expect(query.mock.calls[0][0]).not.toMatch(/contact|phone|email/i);
    expect(query.mock.calls[0][1]).toEqual(['12']);
    expect(doc.id).toBe('tour:12');
    expect(doc.url).toBe('https://vedarai.ru/catalog/tours/mestechko-vulkan-gorelyy');
    expect(doc.text).toContain('Цена: 15000 RUB за человека');
    expect(doc.text).toContain('1. Выезд — в 7:00');
    expect(doc.text).toContain('Включено: обед');
    expect(doc.text).toMatch(/подтверждается оператором/);
    expect(doc.metadata).toMatchObject({ kind: 'tour', price: 15000, operator: 'Местечко Камчатка' });
    expect(doc.text).not.toMatch(/\+7|@/);
  });

  it('место: видимое и не слитое, с профилем безопасности и 112', async () => {
    query.mockResolvedValueOnce({ rows: [{
      key: 'kurilskoe-ozero', name: 'Курильское озеро', description: 'Нерест нерки', essence: null, location_type: 'lake', category: null,
      district: 'Усть-Большерецкий', lat: '51.455', lng: '157.0983', best_season: 'август', access_info: null, eco_permit_required: true,
      hazard_types: ['bears', 'no_such_key'], profile_source: 'manual', nearest_medical_km: '120',
    }] });
    const doc = await fetchDocument('place:kurilskoe-ozero', BASE);
    expect(query.mock.calls[0][0]).toMatch(/p\.is_visible = TRUE AND p\.merged_into_id IS NULL/);
    expect(doc.url).toBe('https://vedarai.ru/places/kurilskoe-ozero');
    expect(doc.text).toContain('Координаты: 51.45500, 157.09830');
    expect(doc.text).toContain('Опасности: медведи');
    expect(doc.text).toContain('112');
    expect(doc.metadata).toMatchObject({ kind: 'place', hazards: ['медведи'] });
  });

  it('место: опасности, выведенные шаблоном 070 из типа места, фактом не произносятся (lib/safety/profile-source)', async () => {
    query.mockResolvedValueOnce({ rows: [{
      key: 'nikolskaya', name: 'Сопка Никольская', description: 'Городской парк', essence: null, location_type: 'volcano', category: null,
      district: null, lat: '53.02', lng: '158.64', best_season: null, access_info: null, eco_permit_required: false,
      hazard_types: ['avalanche', 'rockfall', 'thermal', 'altitude'], profile_source: 'type_template', nearest_medical_km: '1',
    }] });
    const doc = await fetchDocument('place:nikolskaya', BASE);
    expect(query.mock.calls[0][0]).toMatch(/lsp\.profile_source/);
    expect(doc.text).not.toMatch(/Опасности|лавин|камнепад/i);
    expect(doc.text).toContain('До медпомощи: 1 км');
    expect(doc.metadata).toMatchObject({ kind: 'place', hazards: [] });
  });

  it('место: описание-дневник агенту фактом не уходит, справка — целиком (правило describeForAgent, 14.10)', async () => {
    const row = {
      key: 'burlyashchij', name: 'Бурлящий', essence: null, location_type: 'volcano', category: null,
      district: null, lat: '52.14', lng: '157.32', best_season: null, access_info: null, eco_permit_required: false,
      hazard_types: null, profile_source: null, nearest_medical_km: null,
    };
    query.mockResolvedValueOnce({ rows: [{ ...row, description: 'Я стою у подножия Бурлящего, и вокруг непрерывное сипение.' }] });
    const diary = await fetchDocument('place:burlyashchij', BASE);
    expect(diary.text).not.toContain('Я стою у подножия');
    expect(diary.text).toMatch(/Описание: не приводится — текст в базе написан как путевая заметка/);

    const reference = 'Вулкан на юге Камчатки. '.repeat(60).trim();
    query.mockResolvedValueOnce({ rows: [{ ...row, description: reference }] });
    const plain = await fetchDocument('place:burlyashchij', BASE);
    expect(plain.text).toContain(`Описание: ${reference}`);
  });

  it('схемы пары живут без базы: их читает реестр, а реестр — страница /mcp, собираемая на сборке', () => {
    const schemas = read('lib/mcp/connector-schemas.ts');
    expect(schemas).not.toMatch(/db-pool|from 'pg'|\bpool\b/);
    expect(read('lib/mcp/public-tools.ts')).toMatch(/from '@\/lib\/mcp\/connector-schemas'/);
    expect(read('lib/mcp/public-tools.ts')).not.toMatch(/from '@\/lib\/mcp\/connector-tools'/);
  });

  it('жильё: только одобренное и активное, без контактов; маршрут: только видимый', async () => {
    query.mockResolvedValueOnce({ rows: [{
      id: '0b10231b-063c-4d6d-8778-8e18486b6fa4', name: 'Кутха', type: 'guesthouse', description: 'Дом целиком', short_description: null,
      location_zone: 'Паратунка', price_from: '28000', price_to: null, currency: 'RUB', amenities: ['баня'], cancellation_policy: null, external_booking_url: null,
    }] });
    const stay = await fetchDocument('stay:0b10231b-063c-4d6d-8778-8e18486b6fa4', BASE);
    expect(query.mock.calls[0][0]).toMatch(/a\.is_active = true AND a\.moderation_status = 'approved'/);
    expect(query.mock.calls[0][0]).not.toMatch(/contact_phone|contact_messengers/);
    expect(stay.text).toContain('от 28000 RUB за ночь');
    expect(stay.text).toContain('Удобства: баня');

    query.mockResolvedValueOnce({ rows: [{
      key: 'vulkan-gorelyy', title: 'Вулкан Горелый', description: 'Подъём', difficulty: 'medium', distance_km: '12.5', duration_hours: '8',
      duration_days: null, elevation_gain_m: 900, season: 'summer', route_type: 'radial', hazards: ['фумаролы'], equipment: ['ботинки'],
      mchs_registration_required: true, park_name: 'Южно-Камчатский', zone: 'south',
    }] });
    const route = await fetchDocument('route:vulkan-gorelyy', BASE);
    expect(query.mock.calls[1][0]).toMatch(/FROM v_kamchatka_routes_api r\s+WHERE r\.is_visible = TRUE/);
    expect(route.url).toBe('https://vedarai.ru/routes/vulkan-gorelyy');
    expect(route.text).toContain('регистрация в МЧС');
    expect(route.text).toContain('Дистанция: 12.5 км');
  });

  it('нет на витрине — отказ по входу с объяснением; кривой id — отказ без запроса; сбой базы — исключение, не «не найдено»', async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(fetchDocument('tour:999', BASE)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fetchDocument('stay:not-a-uuid', BASE)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fetchDocument('tour:abc', BASE)).rejects.toMatchObject({ code: 'not_found' });
    await expect(fetchDocument('nope', BASE)).rejects.toMatchObject({ code: 'invalid_args:id' });
    expect(query).toHaveBeenCalledTimes(1);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    query.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: '57014' }));
    await expect(fetchDocument('place:x', BASE)).rejects.not.toBeInstanceOf(McpUserError);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('runConnectorTool отдаёт JSON-строку того же объекта (content[0].text у ChatGPT)', async () => {
    query.mockResolvedValue({ rows: [] });
    const text = await runConnectorTool('search', { query: 'вулканы' });
    expect(JSON.parse(text)).toEqual({ results: [] });
    await expect(runConnectorTool('get_tours', {})).rejects.toMatchObject({ code: 'unknown_tool' });
  });
});

describe('подключение в роут MCP и в A2A', () => {
  it('роут зовёт runConnectorTool для пары и кладёт объект в structuredContent', () => {
    const route = read('app/api/mcp/route.ts');
    expect(route).toMatch(/if \(CONNECTOR_TOOL_NAMES\.has\(name\)\) return runConnectorTool\(name, rawArgs\)/);
    expect(route).toMatch(/structuredContent/);
    expect(route).toMatch(/CONNECTOR_TOOL_NAMES\.has\(toolName\)/);
  });

  it('A2A кладёт объект в DataPart ответа', () => {
    expect(read('lib/a2a/handle.ts')).toMatch(/if \(outcome\.structured\) extra\.result = outcome\.structured/);
  });

  it('llms.txt называет пару для ChatGPT', () => {
    expect(read('app/llms.txt/route.ts')).toMatch(/search \/ fetch/);
  });
});
