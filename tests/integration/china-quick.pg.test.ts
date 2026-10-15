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
 *     род размечены, ничего не пишется.
 *
 * Своя база `china_quick_test`. Запуск ТРЕБУЕТ базы:
 * KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл честно
 * пропускается — «не прогнано», а не «прошло».
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { createTestDatabase } from '../helpers/pg-schema';

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
});
