/**
 * Перепись условий посещения по маршрутам (#3302, срез 4).
 *
 * Перепись отвечает на вопрос, которого по коду не решить: где карточка
 * маршрута показывает способы КГБУ («Зелёная кнопка», Госуслуги41), а
 * справочник парков этого не подтверждает. Судится счёт на заданных строках и
 * дверь роута — вызовом (CLAUDE.md §4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import {
  cardShowsKgbuBlock, countRoutePermits, runRoutePermitCensus, CENSUS_PARKS_SQL, CENSUS_ROUTES_SQL,
} from '@/lib/parks/route-permit-census';
import { GET } from '@/app/api/cron/route-permit-census/route';

const KGBU_PAGE = 'https://www.vulcanikamchatki.ru/v_pomow_gostyu/usloviya_poseweniya/';
const park = (slug: string, display_name: string, over: Record<string, string | null> = {}) => ({
  slug, display_name, permit_url: null, permit_email: null, permit_office_address: null,
  permit_office_hours: null, permit_gosuslugi_url: null, permit_online_url: null, ...over,
});
const route = (title: string, park_name: string | null, over: { mchs?: boolean; approval?: string | null } = {}) => ({
  title, park_name, mchs_registration_required: over.mchs ?? false, park_approval_url: over.approval ?? null,
});

const ROUTES = [
  route('Вилючинский водопад', 'Природный парк «Вилючинский»'),
  route('Перевал Вилючинский', 'Природный парк «Вилючинский»'),
  route('Остров Беринга', 'Командорские острова'),
  route('Голубые озёра', 'Природный парк «Голубые озёра»'),
  route('Вулкан Горелый', 'Южно-Камчатский'),
  route('Курильское озеро', 'Южно-Камчатский заказник федерального значения'),
  route('Горный массив Вачкажец', 'Вачкажец'),
  route('Авачинский перевал', 'Природный парк «Налычево»'),
  route('Тропа без парка', null, { mchs: true }),
  route('Тропа совсем без всего', null),
  route('Спорная', 'Парк'),
];
const NAMES = [
  { park_name: 'Природный парк «Вилючинский»', parks: [park('vilyuchinsky', 'Природный парк «Вилючинский»', { permit_url: KGBU_PAGE })] },
  { park_name: 'Командорские острова', parks: [park('komandorskiy', 'Национальный парк «Командорские острова»', { permit_email: 'ostrova.ohrana@gmail.com' })] },
  { park_name: 'Природный парк «Голубые озёра»', parks: null },
  { park_name: 'Южно-Камчатский', parks: [park('yuzhno-kamchatsky', 'Национальный парк «Вулканы Камчатки» — «Южно-Камчатский»')] },
  { park_name: 'Южно-Камчатский заказник федерального значения', parks: [park('yuzhno-kamchatsky-zakaznik', 'Южно-Камчатский федеральный заказник')] },
  { park_name: 'Вачкажец', parks: [park('vachkazhets', 'Памятник природы «Вачкажец»')] },
  { park_name: 'Природный парк «Налычево»', parks: [park('nalychevo', 'Природный парк «Налычево»', { permit_url: KGBU_PAGE })] },
  { park_name: 'Парк', parks: [park('a', 'А'), park('b', 'Б')] },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.CRON_SECRET = 'census-secret';
});

describe('счёт случаев', () => {
  const c = countRoutePermits(ROUTES, NAMES);

  it('каждый маршрут попал ровно в один случай', () => {
    expect(c.routes_total).toBe(11);
    expect(Object.values(c.by_kind).reduce((a, b) => a + b, 0)).toBe(11);
    expect(c.by_kind).toEqual({
      none: 2, no_permit: 1, kronoki: 1, free_visit: 1, federal: 1, kgbu: 2, recorded: 1, unrecorded: 1, ambiguous: 1, unread: 0,
    });
  });

  it('расхождение с карточкой: способы КГБУ показаны, а справочник их не подтверждает', () => {
    // Карточка показывает способы КГБУ семи маршрутам из одиннадцати: трёх
    // узнало правило по названию (Вачкажец, Курильское озеро, Авачинский
    // перевал), у одного нет ни территории, ни регистрации, ни ссылки.
    expect(c.card_kgbu_block.total).toBe(7);
    expect(c.card_kgbu_block.by_agent_kind).toMatchObject({ kgbu: 2, federal: 1, recorded: 1, unrecorded: 1, ambiguous: 1, none: 1 });
    expect(c.card_kgbu_block.mismatch_total).toBe(4);
    expect(c.card_kgbu_block.mismatch_examples).toEqual([
      { title: 'Остров Беринга', park_name: 'Командорские острова', agent_kind: 'recorded' },
      { title: 'Голубые озёра', park_name: 'Природный парк «Голубые озёра»', agent_kind: 'unrecorded' },
      { title: 'Тропа без парка', park_name: null, agent_kind: 'none' },
      { title: 'Спорная', park_name: 'Парк', agent_kind: 'ambiguous' },
    ]);
  });

  it('территории: сколько маршрутов, какие строки справочника и какие случаи', () => {
    expect(c.park_names[0]).toEqual({
      park_name: 'Природный парк «Вилючинский»', routes: 2, parks: ['vilyuchinsky'], kinds: { kgbu: 2 },
    });
    const blue = c.park_names.find((p) => p.park_name === 'Природный парк «Голубые озёра»');
    expect(blue).toEqual({ park_name: 'Природный парк «Голубые озёра»', routes: 1, parks: [], kinds: { unrecorded: 1 } });
    const disputed = c.park_names.find((p) => p.park_name === 'Парк');
    expect(disputed?.parks).toEqual(['a', 'b']);
    expect(c.park_names).toHaveLength(8);
  });

  it('территория, которой нет в выборке справочника, — «не прочитано», а не «не записано»', () => {
    const only = countRoutePermits([route('Тропа', 'Неизвестная территория')], []);
    expect(only.by_kind.unread).toBe(1);
    expect(only.by_kind.unrecorded).toBe(0);
  });
});

describe('когда карточка показывает способы КГБУ', () => {
  it('территория, регистрация в МЧС или ссылка согласования — любое из трёх', () => {
    expect(cardShowsKgbuBlock(route('Тропа', 'Парк'))).toBe(true);
    expect(cardShowsKgbuBlock(route('Тропа', null, { mchs: true }))).toBe(true);
    expect(cardShowsKgbuBlock(route('Тропа', null, { approval: 'https://example.org' }))).toBe(true);
    expect(cardShowsKgbuBlock(route('Тропа', null))).toBe(false);
  });
  it('правило по названию карточку от способов КГБУ уводит', () => {
    expect(cardShowsKgbuBlock(route('Горный массив Вачкажец', 'Вачкажец'))).toBe(false);
    expect(cardShowsKgbuBlock(route('Курильское озеро', null, { mchs: true }))).toBe(false);
    expect(cardShowsKgbuBlock(route('Авачинский перевал', 'Налычево'))).toBe(false);
  });
});

describe('чтение и дверь', () => {
  const req = (auth?: string) => new NextRequest('https://vedarai.ru/api/cron/route-permit-census', {
    headers: auth ? { authorization: auth } : {},
  });

  it('перепись читает живые маршруты и справочник двумя запросами', async () => {
    mockQuery.mockImplementation((sql: string) => Promise.resolve({ rows: sql === CENSUS_ROUTES_SQL ? ROUTES : NAMES }));
    const census = await runRoutePermitCensus();
    expect(census.routes_total).toBe(11);
    expect(mockQuery).toHaveBeenCalledTimes(2);
    expect(mockQuery.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([CENSUS_ROUTES_SQL, CENSUS_PARKS_SQL]));
  });

  it('только чтение: ни одного пишущего слова в запросах', () => {
    for (const sql of [CENSUS_ROUTES_SQL, CENSUS_PARKS_SQL]) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|TRUNCATE)\b/i);
    }
  });

  it('без секрета — 401, и база не спрашивается', async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect((await GET(req('Bearer wrong'))).status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('с секретом — счёт; отказ базы — 500 словами, а не пустая перепись', async () => {
    mockQuery.mockImplementation((sql: string) => Promise.resolve({ rows: sql === CENSUS_ROUTES_SQL ? ROUTES : NAMES }));
    const ok = await GET(req('Bearer census-secret'));
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body).toMatchObject({ success: true, routes_total: 11, card_kgbu_block: { mismatch_total: 4 } });

    mockQuery.mockRejectedValue(Object.assign(new Error('relation "parks" does not exist'), { code: '42P01' }));
    const bad = await GET(req('Bearer census-secret'));
    expect(bad.status).toBe(500);
    const err = await bad.json();
    expect(err).toEqual({ success: false, error: 'Перепись не выполнена' });
    expect(JSON.stringify(err)).not.toContain('parks');
  });
});
