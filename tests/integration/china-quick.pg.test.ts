/**
 * Китайский контур на настоящем PostgreSQL (аудит 15.10, CN-quick).
 *
 * Мок ответил бы на любой SQL, поэтому здесь — схема baseline прода плюс все
 * миграции (tests/helpers/pg-schema.ts). Судится то, что текстом запроса не
 * проверить:
 *
 *   - /zh берёт ВСЕ живые туры под шлюзом витрины (publicTourSql) — больше
 *     прежнего среза в 40, — с вывеской, адресом и открытостью карточки
 *     компании; удалённый и снятый тур в список не входят; порядок — по
 *     названию компании, затем тура, а не по дате правки;
 *   - счётчик пишет /zh, /zh/* и /sitemap.xml в agent_entry_hits по
 *     семейству и не пишет человека;
 *   - перепись A2A выполняется на схеме прода: окно отсекает старое, регион и
 *     род размечены, ничего не пишется;
 *   - китайские конспекты (CN-pages, миграция 1283): таблица переводов держит
 *     «пустой строки как перевода нет» и один перевод на поле; крон перевода
 *     берёт только живые туры и места по правилу (маршрут живого тура, связь
 *     не «рядом», место видимо); перевод с подменённой моделью пишется, страница,
 *     sitemap и hreflang видят его свежим, а после правки исходника — устаревшим;
 *     китайское имя места — только из источника OSM name:zh.
 *
 * Своя база `china_quick_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from '../helpers/pg-schema';

// Модель подменена: перевод — детерминированный и сохраняет числа и латиницу,
// чтобы сверка (lib/zh/translate) его принимала. Остальной модуль — настоящий.
vi.mock('@/lib/ai/providers', async (orig) => {
  const real = await orig<typeof import('@/lib/ai/providers')>();
  const fake = async (messages: Array<{ content: string }>) => {
    const { segments } = JSON.parse(messages[1].content) as { segments: string[] };
    return JSON.stringify({ segments: segments.map((x) => `译文 ${(x.match(/[0-9]+|[A-Za-z][A-Za-z0-9]+/g) ?? []).join(' ')}`.trim()) });
  };
  return { ...real, callAIQualityOrNull: vi.fn(fake), callAIFastOrNull: vi.fn(fake) };
});

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[china-quick.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'china_quick_test';
const OPS = {
  ya: { id: 'c1500000-0000-4000-8000-000000000001', slug: 'test-zh-ya', name: 'Ясный Тест', pub: true },
  al: { id: 'c1500000-0000-4000-8000-000000000002', slug: 'test-zh-al', name: 'Альфа Тест', pub: false },
} as const;
const LIVE_PER_OPERATOR = 21; // 42 живых — больше прежнего среза в 40

const BAIDU = 'Mozilla/5.0 (compatible; Baiduspider/2.0; +http://www.baidu.com/search/spider.html)';
const ZH = {
  routeLive: '', routeDead: '',
  placeOn: 'zh-test-place-on', placeNearby: 'zh-test-place-nearby',
  placeDead: 'zh-test-place-dead', placeHidden: 'zh-test-place-hidden',
};
const HUMAN = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

withPg('китайский контур на схеме прода (CN-quick)', () => {
  let pool: import('pg').Pool;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';
    process.env.CRON_SECRET = 'test-secret';

    // Сцена своя: туры, заведённые миграциями, с витрины убираются.
    await pool.query(`UPDATE operator_tours SET is_active = FALSE`);
    for (const p of Object.values(OPS)) {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
         VALUES ($1, $2, 'operator', '{}'::jsonb, $3, $4, TRUE, 'active')`,
        [p.id, p.name, p.slug, p.pub],
      );
    }
    let n = 0;
    for (const p of Object.values(OPS)) {
      for (let i = 0; i < LIVE_PER_OPERATOR; i++) {
        n++;
        // Ясный правил туры позже — при прежнем ORDER BY updated_at DESC он стоял бы первым.
        await pool.query(
          `INSERT INTO operator_tours (operator_id, title, slug, base_price, max_participants, is_active, is_published, updated_at)
           VALUES ($1, $2, $3, 1000, 10, TRUE, TRUE, NOW() - ($4::int * INTERVAL '1 hour'))`,
          [p.id, `Тур ${String(i).padStart(2, '0')}`, `test-zh-tour-${n}`, p === OPS.ya ? 0 : 100 + i],
        );
      }
    }
    await pool.query(
      `INSERT INTO operator_tours (operator_id, title, slug, base_price, max_participants, is_active, is_published, deleted_at)
       VALUES ($1, 'Удалённый', 'test-zh-deleted', 1000, 10, TRUE, TRUE, NOW()),
              ($1, 'Снятый',    'test-zh-inactive', 1000, 10, FALSE, TRUE, NULL)`,
      [OPS.ya.id],
    );

    // Журнал A2A: КНР внешний, КНР проба, РФ, реестр, и старая строка вне окна.
    const rows: Array<[string, string, number, string]> = [
      ['Qwen-Agent', 'other', 3, '1 hour'],
      ['deepseek-audit', 'other', 2, '2 hours'],
      ['GigaChat', 'other', 1, '3 hours'],
      ['A2A-Registry-TaskProbe', 'other', 4, '1 day'],
      ['Kimi-Old', 'other', 5, '40 days'],
    ];
    for (const [agent, family, count, ago] of rows) {
      for (let i = 0; i < count; i++) {
        await pool.query(
          `INSERT INTO a2a_requests (created_at, binding, op, version, ok, input, state, agent, ua_family, caller_hash)
           VALUES (NOW() - $1::interval, 'jsonrpc', 'SendMessage', '1.0', TRUE, 'text', 'completed', $2, $3, $4)`,
          [ago, agent, family, `hash-${agent}`],
        );
      }
    }

    // Китайские конспекты: маршрут живого тура и маршрут снятого тура, четыре
    // места с разной связью и видимостью, имена места из двух источников.
    const r = await pool.query<{ id: string }>(
      `INSERT INTO kamchatka_routes (category, title) VALUES ('hiking', 'ZH маршрут живого тура'), ('hiking', 'ZH маршрут снятого тура') RETURNING id`,
    );
    [ZH.routeLive, ZH.routeDead] = r.rows.map((x) => x.id);
    await pool.query(`UPDATE operator_tours SET route_id = $1 WHERE slug = 'test-zh-tour-1'`, [ZH.routeLive]);
    await pool.query(`UPDATE operator_tours SET route_id = $1 WHERE slug = 'test-zh-inactive'`, [ZH.routeDead]);
    for (const [id, slug, visible] of [
      [ZH.placeOn, 'test-zh-place-on', true],
      [ZH.placeNearby, 'test-zh-place-nearby', true],
      [ZH.placeDead, 'test-zh-place-dead', true],
      [ZH.placeHidden, 'test-zh-place-hidden', false],
    ] as const) {
      await pool.query(
        `INSERT INTO places (id, name, lat, lng, description, slug, is_visible, ark_id, location_type)
         VALUES ($1, $2, 54.5, 158.5, 'Место у тропы, 2 км от стоянки.', $3, $4, gen_random_uuid(), 'lake')`,
        [id, `ZH место ${slug}`, slug, visible],
      );
    }
    for (const [route, place, kind] of [
      [ZH.routeLive, ZH.placeOn, 'waypoint'],
      [ZH.routeLive, ZH.placeNearby, 'nearby'],
      [ZH.routeDead, ZH.placeDead, 'waypoint'],
      [ZH.routeLive, ZH.placeHidden, 'waypoint'],
    ] as const) {
      await pool.query(
        `INSERT INTO route_waypoints (route_id, place_id, position, link_kind) VALUES ($1, $2, 0, $3)`,
        [route, place, kind],
      );
    }
    await pool.query(
      `INSERT INTO place_aliases (place_id, alias, source_name)
       VALUES ($1, '测试别名', 'Википедия'), ($1, '测试地点', 'OpenStreetMap name:zh')`,
      [ZH.placeOn],
    );
  }, 600_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  it('/zh: все живые туры без среза, с компанией; порядок по названию компании, затем тура', async () => {
    const { loadZhTours } = await import('@/lib/zh/entry');
    const tours = await loadZhTours();
    expect(tours).not.toBeNull();
    const mine = (tours ?? []).filter((t) => t.slug?.startsWith('test-zh-'));
    expect(mine).toHaveLength(LIVE_PER_OPERATOR * 2);
    expect(mine.map((t) => t.slug)).not.toContain('test-zh-deleted');
    expect(mine.map((t) => t.slug)).not.toContain('test-zh-inactive');
    // Альфа раньше Ясного, хотя Ясный правил туры последним.
    expect(mine[0].operator_name).toBe('Альфа Тест');
    expect(mine[mine.length - 1].operator_name).toBe('Ясный Тест');
    expect(mine.slice(0, 3).map((t) => t.title)).toEqual(['Тур 00', 'Тур 01', 'Тур 02']);
    // Адрес и открытость карточки компании приходят из базы — ссылкой станет только открытая.
    expect(mine.find((t) => t.operator_name === 'Ясный Тест')).toMatchObject({ operator_slug: 'test-zh-ya', operator_public: true });
    expect(mine.find((t) => t.operator_name === 'Альфа Тест')).toMatchObject({ operator_public: false });
  });

  it('счётчик: /zh, /zh/* и /sitemap.xml пишутся по семейству, человек на /zh — нет', async () => {
    const { recordAgentEntryHit, recordZhEntryHit } = await import('@/lib/analytics/agent-entry-hits');
    recordZhEntryHit('/zh', BAIDU);
    recordZhEntryHit('/zh', BAIDU);
    recordZhEntryHit('/zh', HUMAN);
    recordZhEntryHit('/zh/tours/x', BAIDU);
    recordAgentEntryHit('/sitemap.xml', BAIDU);
    // Запись не ждётся вызывающим — ждём её здесь.
    let got: Array<{ path: string; family: string; hits: number }> = [];
    for (let i = 0; i < 50; i++) {
      got = (await pool.query(`SELECT path, family, hits FROM agent_entry_hits WHERE day = CURRENT_DATE ORDER BY path, family`)).rows;
      if (got.reduce((s, r) => s + r.hits, 0) >= 4) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(got).toEqual([
      { path: '/sitemap.xml', family: 'baidu', hits: 1 },
      { path: '/zh', family: 'baidu', hits: 2 },
      { path: '/zh/*', family: 'baidu', hits: 1 },
    ]);
  });

  it('перепись A2A: окно отсекает старое, регион и род размечены, журнал не меняется', async () => {
    const before = (await pool.query(`SELECT COUNT(*)::int AS n FROM a2a_requests`)).rows[0].n;
    const { GET } = await import('@/app/api/cron/a2a-census/route');
    const res = await GET(new NextRequest('http://localhost/api/cron/a2a-census?days=30', { headers: { authorization: 'Bearer test-secret' } }));
    expect(res.status).toBe(200);
    const body = await res.json() as {
      window_total: number; journal_total_all_time: number;
      china: { external: { agents: number; requests: number }; own_and_probes: { agents: number; requests: number } };
      ru: { external: { requests: number } };
      by_kind: { registry: { requests: number } };
      by_agent: Array<{ agent: string }>;
    };
    expect(body.window_total).toBe(10);
    expect(body.journal_total_all_time).toBe(15);
    expect(body.by_agent.map((a) => a.agent)).not.toContain('Kimi-Old');
    expect(body.china.external).toEqual({ agents: 1, requests: 3 });
    expect(body.china.own_and_probes).toEqual({ agents: 1, requests: 2 });
    expect(body.ru.external.requests).toBe(1);
    expect(body.by_kind.registry.requests).toBe(4);
    const after = (await pool.query(`SELECT COUNT(*)::int AS n FROM a2a_requests`)).rows[0].n;
    expect(after).toBe(before);
  });

  it('миграция 1283: пустого перевода и чужого языка нет, один перевод на поле', async () => {
    const hash = 'a'.repeat(64);
    const ins = (text: string, lang = 'zh-CN') => pool.query(
      `INSERT INTO content_translations (entity_type, entity_id, field, lang, source_hash, text, model)
       VALUES ('tour', 'mig-check', 'title', $1, $2, $3, 'ai-quality')`,
      [lang, hash, text],
    );
    await expect(ins('   ')).rejects.toMatchObject({ code: '23514' });
    await expect(ins('标题', 'en')).rejects.toMatchObject({ code: '23514' });
    await ins('标题');
    await expect(ins('标题二')).rejects.toMatchObject({ code: '23505' });
    await pool.query(`DELETE FROM content_translations WHERE entity_id = 'mig-check'`);
  });

  it('отбор: только живые туры; места — на маршруте живого тура, связь не «рядом», место видимо', async () => {
    const { loadZhTourSources, loadZhPlaceSources } = await import('@/lib/zh/content');
    const tours = await loadZhTourSources();
    const slugs = tours.map((t) => t.slug);
    expect(slugs.filter((x) => x?.startsWith('test-zh-tour-'))).toHaveLength(LIVE_PER_OPERATOR * 2);
    expect(slugs).not.toContain('test-zh-deleted');
    expect(slugs).not.toContain('test-zh-inactive');
    const places = (await loadZhPlaceSources()).map((p) => p.id);
    expect(places).toContain(ZH.placeOn);
    expect(places).not.toContain(ZH.placeNearby);
    expect(places).not.toContain(ZH.placeDead);
    expect(places).not.toContain(ZH.placeHidden);
  });

  it('крон: перевод пишется; страница, sitemap и hreflang видят его свежим, а после правки исходника — устаревшим', async () => {
    const { GET } = await import('@/app/api/cron/zh-translate/route');
    const call = (qs: string) => GET(new NextRequest(`http://localhost/api/cron/zh-translate${qs}`, { headers: { authorization: 'Bearer test-secret' } }));

    const dry = await (await call('?kind=place')).json() as { mode: string; entities: { places: number }; pending: number };
    expect(dry.mode).toBe('dry');
    expect(dry.entities.places).toBe(1);
    expect(dry.pending).toBe(1);
    expect((await pool.query(`SELECT COUNT(*)::int AS n FROM content_translations`)).rows[0].n).toBe(0);

    const placeRun = await call('?kind=place&apply=1');
    expect(placeRun.status).toBe(200);
    expect((await placeRun.json()).translated).toEqual([{ entity_type: 'place', entity_id: ZH.placeOn, field: 'description' }]);
    const tourRun = await call('?kind=tour&apply=1&limit=2');
    expect(tourRun.status).toBe(200);
    expect((await tourRun.json()).translated).toHaveLength(2);

    const stored = (await pool.query(
      `SELECT text, back_translation, model, reviewed_at FROM content_translations WHERE entity_type = 'place' AND entity_id = $1`, [ZH.placeOn],
    )).rows[0];
    expect(stored).toMatchObject({ text: '译文 2', model: 'ai-quality', reviewed_at: null });
    expect(stored.back_translation).toBeTruthy();

    const { loadZhPlacePage, zhPlaceAlternatePath, loadZhDetailEntries } = await import('@/lib/zh/content');
    const page = await loadZhPlacePage('test-zh-place-on');
    expect(page?.zhName).toEqual({ name: '测试地点', source: 'OpenStreetMap name:zh' });
    expect(page?.translations?.get('description')?.text).toBe('译文 2');
    // Страница места вне правила не открывается.
    expect(await loadZhPlacePage('test-zh-place-nearby')).toBeNull();

    const placeRow = { id: ZH.placeOn, slug: 'test-zh-place-on', description: 'Место у тропы, 2 км от стоянки.' };
    expect(await zhPlaceAlternatePath(placeRow)).toBe('/zh/places/test-zh-place-on');
    const detail = (await loadZhDetailEntries()).map((d) => d.path);
    expect(detail).toContain('/zh/places/test-zh-place-on');
    // Крон перевёл только limit=2, а в sitemap — все живые: страница фактов
    // не ждёт прозы. Удалённый и снятый не входят.
    expect(detail.filter((x) => x.startsWith('/zh/tours/'))).toHaveLength(LIVE_PER_OPERATOR * Object.keys(OPS).length);
    expect(detail).not.toContain('/zh/tours/test-zh-deleted');
    expect(detail).not.toContain('/zh/tours/test-zh-inactive');

    // Исходник правят — перевод устарел: пары и sitemap нет, крон видит stale.
    await pool.query(`UPDATE places SET description = 'Новое описание.' WHERE id = $1`, [ZH.placeOn]);
    expect(await zhPlaceAlternatePath({ ...placeRow, description: 'Новое описание.' })).toBeNull();
    expect((await loadZhDetailEntries()).map((d) => d.path)).not.toContain('/zh/places/test-zh-place-on');
    const stale = await (await call('?kind=place')).json() as { pending_stale: number };
    expect(stale.pending_stale).toBe(1);
  });
});
