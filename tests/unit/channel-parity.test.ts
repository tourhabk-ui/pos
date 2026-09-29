/**
 * Сторож снимка «MCP против сайта» (29.09).
 *
 * Разборщики читают ТЕКСТЫ, которые MCP отдаёт агенту. Проверять их на
 * выдуманных примерах бессмысленно: формат живёт в другом файле и уходит от
 * разборщика молча (так и работают все расхождения каналов). Поэтому тексты
 * здесь делают НАСТОЯЩИЕ производители — `buildTourCatalog`,
 * `getTourAvailabilityForKuzmich`, `formatSafetyStatusForAgent`,
 * `composeVolcanoReport` — а разборщик обязан вернуть то, что в них положили.
 * Изменил производитель формат — красный здесь, а не тихий пустой снимок.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('@/lib/db-pool', () => ({ pool: { query: vi.fn() } }));
const availability = vi.fn();
vi.mock('@/lib/planner', () => ({
  createPlannerCache: () => ({}),
  fetchAvailabilityForTour: (...a: unknown[]) => availability(...a),
}));

import { pool } from '@/lib/db-pool';
import { buildTourCatalog } from '@/lib/kuzmich/core';
import { getTourAvailabilityForKuzmich } from '@/lib/kuzmich/tour-availability-tool';
import { formatSafetyStatusForAgent } from '@/lib/safety/current-status';
import { composeVolcanoReport, type VolcanoInput } from '@/lib/kuzmich/volcano-tool';
import {
  parseToursText, parseAvailabilityText, parseSafetyText, parseVolcanoText,
  parseVolcanoAggregates, parseRuDayMonth, diffFields, contractParams,
} from '@/lib/quality/channel-parity';
import {
  collectChannelParity, sameVolcano, PARITY_TOUR_IDS, PARITY_VOLCANOES, type ParityDeps,
} from '@/lib/quality/channel-parity-collect';
import type { MarketplaceTourRow } from '@/lib/search/tour-search';
import type { SafetyLiveData } from '@/app/_home/data';

const q = pool.query as unknown as ReturnType<typeof vi.fn>;
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8');

const TODAY = '2026-09-29';

function tourRow(over: Record<string, unknown>) {
  return {
    id: 27, title: 'Сплав', base_price: 13000, price_unit: 'per_person', multi_day_count: null,
    activity_type: 'rafting', location_name: 'Быстрая', available_slots: 4, next_available_date: '2026-10-03',
    short_description: 'Кратко — с тире и "кавычками"', has_details: true, operator_name: 'Оператор Один',
    ...over,
  };
}

describe('get_tours → факты (тексты делает настоящий buildTourCatalog)', () => {
  beforeEach(() => { q.mockReset(); });

  it('единица цены читается из подписи и совпадает с кодом колонки', async () => {
    q.mockResolvedValueOnce({ rows: [
      tourRow({ id: 27, price_unit: 'per_person' }),
      tourRow({ id: 9, base_price: 140000, price_unit: 'per_tour', multi_day_count: 5, activity_type: 'trekking' }),
      tourRow({ id: 6, base_price: 28000, price_unit: 'per_day_per_person' }),
    ] });
    // Кэш каталога — в процессе: сбрасываем модуль, чтобы не читать чужое.
    vi.resetModules();
    const { buildTourCatalog: fresh } = await import('@/lib/kuzmich/core');
    const facts = parseToursText(await fresh(), TODAY);
    expect(facts.get(27)).toMatchObject({ price_amount: 13000, price_unit: 'per_person', operator: 'Оператор Один', seats_free: 4, next_date: '2026-10-03', activity_type: 'rafting' });
    expect(facts.get(9)).toMatchObject({ price_amount: 140000, price_unit: 'per_tour', duration_days: 5 });
    expect(facts.get(6)).toMatchObject({ price_amount: 28000, price_unit: 'per_day_per_person' });
    expect(buildTourCatalog).toBeTypeOf('function');
  });

  it('единица не записана — price_unit null, а не «за человека»; цены нет — null, а не 0', async () => {
    q.mockResolvedValueOnce({ rows: [
      tourRow({ id: 5, price_unit: null }),
      tourRow({ id: 34, base_price: null, price_unit: null, available_slots: 0, next_available_date: null }),
    ] });
    vi.resetModules();
    const { buildTourCatalog: fresh } = await import('@/lib/kuzmich/core');
    const facts = parseToursText(await fresh(), TODAY);
    expect(facts.get(5)).toMatchObject({ price_amount: 13000, price_unit: null });
    expect(facts.get(34)).toMatchObject({ price_amount: null, price_unit: null, seats_free: 0, next_date: null });
  });

  it('пустой текст и чужой текст — ноль туров, а не выдумка', () => {
    expect(parseToursText('', TODAY).size).toBe(0);
    expect(parseToursText('Туры не найдены', TODAY).size).toBe(0);
  });

  it('год у «29 сентября» — ближайший, не раньше сегодня', () => {
    expect(parseRuDayMonth('29', 'сентября', TODAY)).toBe('2026-09-29');
    expect(parseRuDayMonth('3', 'января', TODAY)).toBe('2027-01-03');
    expect(parseRuDayMonth('31', 'сентября', TODAY)).toBeNull();
    expect(parseRuDayMonth('5', 'нечто', TODAY)).toBeNull();
  });
});

describe('get_tour_availability → даты', () => {
  beforeEach(() => { q.mockReset(); availability.mockReset(); });

  it('строки дат и мест разбираются, единица сохраняется', async () => {
    q.mockResolvedValueOnce({ rows: [{ id: 27, title: 'Сплав', base_price: 13000, price_unit: 'per_tour' }] });
    availability.mockResolvedValueOnce([
      { date: '2026-10-03', remaining: 4, priceOverride: null },
      { date: '2026-10-05', remaining: 0 + 2, priceOverride: 15000 },
    ]);
    const out = await getTourAvailabilityForKuzmich({ tour: '27' });
    const f = parseAvailabilityText(out);
    expect(f).toMatchObject({ tour_id: 27, none_free: false });
    expect(f?.dates).toEqual([
      { date: '2026-10-03', free: 4, price_amount: 13000, price_unit: 'per_tour' },
      { date: '2026-10-05', free: 2, price_amount: 15000, price_unit: 'per_tour' },
    ]);
  });

  it('свободных дат нет — none_free, это не отказ разбора', async () => {
    q.mockResolvedValueOnce({ rows: [{ id: 27, title: 'Сплав', base_price: 13000, price_unit: 'per_person' }] });
    availability.mockResolvedValueOnce([]);
    const f = parseAvailabilityText(await getTourAvailabilityForKuzmich({ tour: '27' }));
    expect(f).toMatchObject({ dates: [], none_free: true });
  });

  it('«занятость недоступна» — не разобрано (null), а не «мест нет»', () => {
    expect(parseAvailabilityText('Занятость временно недоступна — не называй даты по памяти.')).toBeNull();
  });
});

describe('safety_status → поля', () => {
  const base = { hasAlert: true, maxSeverity: 3, activeCount: 14, topTitle: 'Циклон (штормовое предупреждение)', topType: 'weather', dataUpdatedAt: '2026-09-29 10:00:00+03', source: 'ГУ МЧС Камчатки' };

  it('счётчик, верхнее предупреждение, тип, источник, время', () => {
    const f = parseSafetyText(formatSafetyStatusForAgent(base));
    expect(f).toMatchObject({ alert_count: 14, max_severity: 3, updated_at: '2026-09-29 10:00:00+03', feed_titles: null });
    expect(f?.top_alert).toEqual({ text: 'Циклон (штормовое предупреждение)', source: 'ГУ МЧС Камчатки', kind: 'weather' });
  });

  it('тревог нет — ноль и ноль, верхнего нет', () => {
    const f = parseSafetyText(formatSafetyStatusForAgent({ ...base, hasAlert: false, activeCount: 0, maxSeverity: 0, topTitle: null, topType: null }));
    expect(f).toMatchObject({ alert_count: 0, max_severity: 0 });
    expect(f?.top_alert?.text ?? null).toBeNull();
  });

  it('«данных нет» — null, а не «ноль предупреждений»', () => {
    expect(parseSafetyText(formatSafetyStatusForAgent(null))).toBeNull();
  });
});

const NOW = Date.parse('2026-09-25T06:00:00Z');
const INPUT: VolcanoInput = {
  kvert: [
    { ark: 'a1', place_name: 'Вулкан Ключевская сопка', name: 'Klyuchevskoy', acc: 'orange', ash_height_m: 6000, observed_at: '2026-09-25T01:00:00Z' },
    { ark: 'a2', place_name: 'Вулкан Мутновский', name: 'Mutnovsky', acc: 'green', ash_height_m: null, observed_at: '2026-09-24T20:00:00Z' },
    { ark: null, place_name: null, name: 'CHIKURACHKI', acc: 'orange', ash_height_m: null, observed_at: '2026-09-25T01:00:00Z' },
  ],
  kfegsDate: '2026-09-24',
  kfegs: [
    { ark: 'a2', place_name: 'Вулкан Мутновский', name: 'Мутновский', name_en: 'Mutnovsky', color: 'yellow', raw: 'Ж', seismicity: 'Сейсмичность выше фона, событий 255.' },
    { ark: 'a1', place_name: 'Вулкан Ключевская сопка', name: 'Ключевской', name_en: 'Klyuchevskoy', color: 'orange', raw: 'О', seismicity: null },
  ],
};

describe('get_volcano_status → поля', () => {
  it('вулкан по имени: обе шкалы, пепел, сутки наблюдения, события, дата сводки', () => {
    const f = parseVolcanoText(composeVolcanoReport(INPUT, 'Мутновский', NOW), (n) => sameVolcano(n, 'Мутновский'));
    expect(f).toEqual({
      name_ru: 'Вулкан Мутновский', kvert_color: 'green', ash_km: null, kvert_observed_at: '2026-09-25',
      egs_color: 'yellow', egs_events: 255, egs_bulletin_date: '2026-09-24',
    });
  });

  it('пепел читается числом; Чикурачки — по-русски и без КФ ЕГС (в сводке нет)', () => {
    const kl = parseVolcanoText(composeVolcanoReport(INPUT, 'Ключевская', NOW));
    expect(kl).toMatchObject({ kvert_color: 'orange', ash_km: 6, egs_color: 'orange', egs_events: null });
    const ch = parseVolcanoText(composeVolcanoReport(INPUT, 'Чикурачки', NOW));
    expect(ch).toMatchObject({ name_ru: 'Чикурачки', kvert_color: 'orange', egs_color: null, egs_events: null, egs_bulletin_date: null });
  });

  it('вулкана нет ни в одной сводке — null', () => {
    expect(parseVolcanoText(composeVolcanoReport(INPUT, 'Ичинский', NOW))).toBeNull();
  });

  it('шапка общего ответа: сколько повышенных и сколько вулканов ведёт KVERT', () => {
    expect(parseVolcanoAggregates(composeVolcanoReport(INPUT, undefined, NOW))).toEqual({ elevated_any_scale: 3, kvert_watched: 3 });
    const calm: VolcanoInput = { kvert: [INPUT.kvert![1]], kfegsDate: '2026-09-24', kfegs: [{ ...INPUT.kfegs![0], color: 'green' }] };
    expect(parseVolcanoAggregates(composeVolcanoReport(calm, undefined, NOW)).elevated_any_scale).toBe(0);
    // Неполные источники: «повышенных нет» не сказано — null, не 0.
    const partial = composeVolcanoReport({ ...calm, kvert: null }, undefined, NOW);
    expect(parseVolcanoAggregates(partial).elevated_any_scale).toBeNull();
  });
});

describe('сравнение полей — третье состояние', () => {
  it('null с любой стороны — не расхождение, а «не сравнено» с именем молчащей стороны', () => {
    const r = diffFields('t', ['a', 'b', 'c'], { a: 1, b: null, c: 'x' }, { a: 2, b: 5, c: null });
    expect(r.diffs).toEqual([{ scope: 't', field: 'a', mcp: 1, ui: 2 }]);
    expect(r.not_compared).toEqual([
      { scope: 't', field: 'b', silent: ['mcp'] },
      { scope: 't', field: 'c', silent: ['ui'] },
    ]);
  });

  it('ноль и false — значения, а не пустота', () => {
    expect(diffFields('t', ['n', 'f'], { n: 0, f: false }, { n: 0, f: true }).diffs).toEqual([{ scope: 't', field: 'f', mcp: false, ui: true }]);
  });

  it('схема инструмента → параметры в порядке объявления', () => {
    expect(contractParams({ properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['b'] })).toEqual([
      { name: 'a', type: 'string', required: false }, { name: 'b', type: 'integer', required: true },
    ]);
    expect(contractParams(null)).toEqual([]);
  });
});

// ── Сборка целиком, на подставных зависимостях ───────────────────────────────

function uiRow(id: number, over: Partial<MarketplaceTourRow> = {}): MarketplaceTourRow {
  return {
    id, title: `Тур ${id}`, description: '', short_description: null, base_price: 13000, price_old: null,
    price_unit: 'per_person', activity_type: 'rafting', location_type: 'river', location_name: null, tour_image: null,
    max_participants: 10, duration_hours: null, duration_type: 'day', multi_day_count: null, difficulty: null,
    included: null, season_start: null, season_end: null, operator_name: 'Оператор Один', operator_id: 'o1',
    operator_verified: true, bookings_count: 0, has_availability: true, ...over,
  };
}

const LIVE: SafetyLiveData = {
  safety: {
    activeCount: 5, maxSeverity: 1, updatedAt: '2026-09-29 10:00:00+03', volcanoes: [],
    alerts: [{ title: 'Штормовое предупреждение', description: null, type: 'weather', severity: 1, at: '2026-09-29', until: null }],
  },
  seismic: {} as SafetyLiveData['seismic'],
  radar: { hazards: [], center: { lat: 0, lng: 0, label: '' } },
  volcanoes: {
    items: [{ name: 'Вулкан Мутновский', placeId: 'p2', acc: 'green', ashHeightM: null, observedAt: '2026-09-24T20:00:00Z', summary: null }],
    updatedAt: null, checkedAt: null, degraded: false,
  },
};

function deps(over: Partial<ParityDeps> = {}): ParityDeps {
  const tours = PARITY_TOUR_IDS.map((id) => `ID${id}: "Тур ${id}" — Быстрая  тип:rafting  ${' '}от 13${' '}000 ₽/группа | Оп: Оператор Один | Мест: 4 | Ближайшая дата: 3 октября`).join('\n');
  return {
    now: new Date('2026-09-29T06:00:00Z'),
    mcpServerInfo: { name: 'vedar-mcp', version: '2.3.0' },
    mcpTools: [{ name: 'get_tours', inputSchema: { properties: {}, required: [] } }],
    callMcp: async (tool, args) => {
      if (tool === 'get_tours') return tours;
      if (tool === 'get_tour_availability') return 'Тур "Тур 27" (ID27) — свободные даты (реальная занятость из броней):\n- 03.10 (2026-10-03): свободно 4, от 13 000 ₽/чел.\nБронь.';
      if (tool === 'safety_status') return formatSafetyStatusForAgent({ hasAlert: true, maxSeverity: 1, activeCount: 13, topTitle: 'Штормовое предупреждение', topType: 'weather', dataUpdatedAt: '2026-09-29 10:00:00+03', source: 'ГУ МЧС Камчатки' });
      if (tool === 'get_volcano_status') return composeVolcanoReport(INPUT, args.volcano, Date.parse('2026-09-29T06:00:00Z'));
      throw new Error(`неожиданный инструмент ${tool}`);
    },
    uiTours: async () => PARITY_TOUR_IDS.map((id) => uiRow(id)),
    uiSlots: async () => [{ date: '2026-10-03', free_slots: 4 }],
    uiSafety: async () => LIVE,
    ...over,
  };
}

describe('collectChannelParity', () => {
  it('единица цены и счётчик обстановки видны как расхождения; молчащие поля — не расхождения', async () => {
    const r = await collectChannelParity(deps());
    expect(r.probe).toBe('channel_parity_v1');
    // MCP сказал «/группа», сайт держит per_person — все 8 туров.
    const unit = r.diffs.filter((d) => d.field === 'price_unit');
    expect(unit).toHaveLength(PARITY_TOUR_IDS.length);
    expect(unit[0]).toMatchObject({ mcp: 'per_tour', ui: 'per_person' });
    // Счётчик обстановки: 13 против 5.
    expect(r.diffs).toContainEqual({ scope: 'safety', field: 'alert_count', mcp: 13, ui: 5 });
    // MCP не называет сезон — не расхождение, а «не сравнено».
    expect(r.diffs.some((d) => d.field === 'season_open')).toBe(false);
    expect(r.not_compared).toContainEqual({ scope: 'tour:27', field: 'season_open', silent: ['mcp'] });
    // Совпавшее не попадает в расхождения.
    expect(r.diffs.some((d) => d.scope === 'tour:27' && d.field === 'seats_free')).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.contract.mcp.server).toEqual({ name: 'vedar-mcp', version: '2.3.0' });
    // Ключи-числа JS хранит по возрастанию: порядок набора — в PARITY_TOUR_IDS, а не в объекте.
    expect(Object.keys(r.tours.mcp!).sort()).toEqual(PARITY_TOUR_IDS.map(String).sort());
    expect(Object.keys(r.volcanoes.ui!)).toEqual([...PARITY_VOLCANOES]);
  });

  it('отказ одного блока не гасит остальные и краснит ok', async () => {
    const r = await collectChannelParity(deps({
      callMcp: async (tool, args) => {
        if (tool === 'safety_status') throw new Error('MCP safety: сеть');
        return deps().callMcp(tool, args);
      },
    }));
    expect(r.ok).toBe(false);
    expect(r.failed).toEqual([{ block: 'safety.mcp', reason: 'MCP safety: сеть' }]);
    expect(r.safety.mcp).toBeNull();
    expect(r.tours.mcp).not.toBeNull();
    expect(r.diffs.some((d) => d.scope === 'safety')).toBe(false);
  });

  it('ответ, из которого ничего не разобрано, — отказ, а не пустой снимок', async () => {
    const r = await collectChannelParity(deps({
      callMcp: async (tool, args) => (tool === 'get_tours' ? 'Туры не найдены' : deps().callMcp(tool, args)),
    }));
    expect(r.ok).toBe(false);
    expect(r.failed.map((f) => f.block)).toContain('tours.mcp');
    expect(r.tours.mcp).toBeNull();
  });

  it('лента сайта в degraded — не «ноль предупреждений», а отказ стороны ui', async () => {
    const r = await collectChannelParity(deps({
      uiSafety: async () => ({ ...LIVE, safety: { ...LIVE.safety, degraded: true, activeCount: 0, alerts: [] } }),
    }));
    expect(r.failed.map((f) => f.block)).toContain('safety.ui');
    expect(r.safety.ui).toBeNull();
    expect(r.diffs.some((d) => d.scope === 'safety')).toBe(false);
  });

  it('id из pg приходит строкой — в снимке он числом', async () => {
    const r = await collectChannelParity(deps({ uiTours: async () => PARITY_TOUR_IDS.map((id) => uiRow(String(id) as unknown as number)) }));
    expect(r.tours.ui!['27']?.id).toBe(27);
  });

  it('радар в degraded — число отметок не считается полным: null и оговорка, а не занижение', async () => {
    const live: SafetyLiveData = { ...LIVE, radar: { ...LIVE.radar, degraded: true } };
    const r = await collectChannelParity(deps({ uiSafety: async () => live }));
    expect(r.volcanoes.aggregates.ui?.elevated_any_scale).toBeNull();
    expect(r.notes.some((n) => n.includes('degraded'))).toBe(true);
    expect(r.diffs.some((d) => d.field === 'elevated_any_scale')).toBe(false);
  });

  it('тур есть у MCP и нет на сайте — расхождение «presence»', async () => {
    const r = await collectChannelParity(deps({ uiTours: async () => PARITY_TOUR_IDS.filter((i) => i !== 9).map((id) => uiRow(id)) }));
    expect(r.diffs).toContainEqual({ scope: 'tour:9', field: 'presence', mcp: 'есть', ui: 'нет' });
  });

  it('вулкан латиницей на стороне MCP — расхождение name_script', async () => {
    const line = 'Chikurachki: КФ ЕГС: в сводке этого вулкана нет · KVERT (авиация): оранжевый — высокая активность, наблюдение 25.09.2026';
    const live: SafetyLiveData = { ...LIVE, volcanoes: { ...LIVE.volcanoes, items: [...LIVE.volcanoes.items, { name: 'Чикурачки', placeId: null, acc: 'orange', ashHeightM: null, observedAt: '2026-09-25T01:00:00Z', summary: null }] } };
    const r = await collectChannelParity(deps({
      uiSafety: async () => live,
      callMcp: async (tool, args) => (tool === 'get_volcano_status' && args.volcano === 'Чикурачки' ? `Источники — KVERT: 3 вулканов.\n${line}` : deps().callMcp(tool, args)),
    }));
    expect(r.diffs).toContainEqual({ scope: 'volcano:Чикурачки', field: 'name_script', mcp: 'Chikurachki', ui: 'Чикурачки' });
    // Цвет KVERT при этом совпал — расхождение только в имени.
    expect(r.diffs.some((d) => d.scope === 'volcano:Чикурачки' && d.field === 'kvert_color')).toBe(false);
  });
});

describe('роут снимка', () => {
  const route = read('app/api/cron/channel-parity/route.ts');
  const code = route.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('только чтение: журнал вызовов MCP не пишется, БД не меняется', () => {
    expect(code).not.toMatch(/logMcpToolCall|logMcpClient/);
    expect(code).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/);
  });

  it('вызывает MCP тем же путём, что /api/mcp: валидатор и исполнитель', () => {
    expect(code).toMatch(/validateToolArgs\(tool, args\)/);
    expect(code).toMatch(/executeKuzmichTool\(tool, v\.args\)/);
  });

  it('закрыт CRON_SECRET и объявлен как ручной', () => {
    expect(code).toMatch(/timingSafeCompare\(secret, process\.env\.CRON_SECRET/);
    expect(read('lib/agents/cron-schedulers.ts')).toMatch(/'channel-parity':\s+\{ kind: 'manual', writes: false/);
  });

  it('набор владельца: восемь туров и восемь вулканов', () => {
    expect([...PARITY_TOUR_IDS]).toEqual([27, 4, 5, 6, 7, 9, 10, 11]);
    expect([...PARITY_VOLCANOES]).toEqual(['Крашенинникова', 'Шивелуч', 'Чикурачки', 'Безымянный', 'Горелый', 'Карымская', 'Ключевская', 'Мутновский']);
  });
});
