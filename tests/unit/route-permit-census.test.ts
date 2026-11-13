/**
 * Перепись условий посещения по маршрутам (#3302, срезы 4 и 6).
 *
 * Перепись отвечает на вопрос, которого по коду не решить: что блок о
 * разрешении парка говорит на карточках живых маршрутов — где утверждает
 * «нужно разрешение», где говорит с условием и где утверждает без
 * подтверждения справочника. Судится счёт на заданных строках и дверь роута —
 * вызовом (CLAUDE.md §4).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const mockQuery = vi.fn();
vi.mock('@/lib/db-pool', () => ({
  pool: { query: (...args: unknown[]) => mockQuery(...args) },
}));

import {
  cardShowsPermitBlock, countRoutePermits, runRoutePermitCensus, CENSUS_PARKS_SQL, CENSUS_ROUTES_SQL,
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

  it('что блок говорит на карточке: утверждает только там, где подтверждает справочник', () => {
    // Блок стоит на семи карточках из одиннадцати: трёх увело правило по
    // названию (Вачкажец, Курильское озеро, Авачинский перевал), у одного
    // маршрута нет ни территории, ни регистрации, ни ссылки.
    expect(c.card_block.total).toBe(7);
    expect(c.card_block.by_agent_kind).toMatchObject({ kgbu: 2, federal: 1, recorded: 1, unrecorded: 1, ambiguous: 1, none: 1 });
    // Утверждают три: два маршрута парка КГБУ и парк в федеральном ведении (со
    // своей оговоркой). Территория без условий в базе и маршрут без территории —
    // с условием; своя запись территории и спорное название — своими словами.
    expect(c.card_block.by_wording).toEqual({ asserted: 3, conditional: 2, recorded: 1, ambiguous: 1 });
    expect(Object.values(c.card_block.by_wording).reduce((a, b) => a + b, 0)).toBe(c.card_block.total);
    expect(c.card_block.asserted_unconfirmed_total).toBe(0);
    expect(c.card_block.asserted_unconfirmed_examples).toEqual([]);
  });

  it('ссылка согласования — основание утверждать; такие карточки названы поимённо', () => {
    const withLinks = countRoutePermits([
      route('Тропа со ссылкой', null, { approval: 'https://example.org/approve' }),
      route('Голубые озёра', 'Природный парк «Голубые озёра»', { approval: 'https://example.org/blue' }),
      route('Остров Беринга', 'Командорские острова', { approval: 'https://example.org/bering' }),
      route('Тропа с пустой ссылкой', null, { mchs: true, approval: '   ' }),
    ], NAMES);
    // Своя запись территории сильнее ссылки: чужое ведомство способами КГБУ не подменяется.
    expect(withLinks.card_block.by_wording).toEqual({ asserted: 2, conditional: 1, recorded: 1, ambiguous: 0 });
    expect(withLinks.card_block.asserted_unconfirmed_total).toBe(2);
    expect(withLinks.card_block.asserted_unconfirmed_examples).toEqual([
      { title: 'Тропа со ссылкой', park_name: null, agent_kind: 'none' },
      { title: 'Голубые озёра', park_name: 'Природный парк «Голубые озёра»', agent_kind: 'unrecorded' },
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

describe('когда карточка показывает блок о разрешении парка', () => {
  it('территория, регистрация в МЧС или ссылка согласования — любое из трёх', () => {
    expect(cardShowsPermitBlock(route('Тропа', 'Парк'))).toBe(true);
    expect(cardShowsPermitBlock(route('Тропа', null, { mchs: true }))).toBe(true);
    expect(cardShowsPermitBlock(route('Тропа', null, { approval: 'https://example.org' }))).toBe(true);
    expect(cardShowsPermitBlock(route('Тропа', null))).toBe(false);
  });
  it('правило по названию уводит карточку к своим строкам', () => {
    expect(cardShowsPermitBlock(route('Горный массив Вачкажец', 'Вачкажец'))).toBe(false);
    expect(cardShowsPermitBlock(route('Курильское озеро', null, { mchs: true }))).toBe(false);
    expect(cardShowsPermitBlock(route('Авачинский перевал', 'Налычево'))).toBe(false);
    // Заказник в обратном порядке слов (перепись 13.11) — тоже территория заповедника.
    expect(cardShowsPermitBlock(route('Тропа', 'государственный природный заказник федерального значения «Южно-Камчатский»'))).toBe(false);
    // Природный парк с тем же именем — другая территория: блок остаётся.
    expect(cardShowsPermitBlock(route('Тропа', 'Природный парк «Южно-Камчатский»'))).toBe(true);
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
    expect(body).toMatchObject({ success: true, routes_total: 11, card_block: { total: 7, by_wording: { asserted: 3, conditional: 2 } } });

    mockQuery.mockRejectedValue(Object.assign(new Error('relation "parks" does not exist'), { code: '42P01' }));
    const bad = await GET(req('Bearer census-secret'));
    expect(bad.status).toBe(500);
    const err = await bad.json();
    expect(err).toEqual({ success: false, error: 'Перепись не выполнена' });
    expect(JSON.stringify(err)).not.toContain('parks');
  });
});
