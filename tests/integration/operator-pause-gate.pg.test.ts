/**
 * Пауза оператора на настоящем PostgreSQL (23.11, слово владельца «Разберись с
 * Местечком»).
 *
 * Пауза 21.11 жила только в блоках туров мест и посадочных, и «Местечко» с
 * шестнадцатью турами стояло в списке компаний, каталоге и ответах агентов.
 * Сцена держит связку на данных, а не на тексте запроса:
 *   - тур компании на паузе (slug из OPERATOR_SITE_PAUSE_SLUGS) и
 *     приостановленной (`status = 'suspended'`) не проходит шлюз витрины
 *     `publicTourSql`, но открывается по прямой ссылке (`tourOpenByLinkSql`);
 *   - список компаний /operators таких компаний не ставит, живую — ставит.
 *
 * Запуск: KERNEL_PG_TEST_URL=postgresql://user:pass@host/db. Без неё файл
 * честно пропускается (не прогнан, а не зелёный).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createTestDatabase } from '../helpers/pg-schema';

vi.mock('next/cache', () => ({ unstable_cache: (fn: () => unknown) => fn }));

const PG_URL = process.env.KERNEL_PG_TEST_URL ?? '';
const withPg = PG_URL ? describe : describe.skip;
if (!PG_URL) {
  console.warn('[operator-pause-gate.pg] KERNEL_PG_TEST_URL не задан — интеграционные тесты пропущены (не прогнаны, а не зелёные)');
}

const TEST_DB = 'operator_pause_gate_test';

type Kind = 'live' | 'paused' | 'suspended';
const KINDS: Kind[] = ['live', 'paused', 'suspended'];
const PARTNER: Record<Kind, { id: string; name: string }> = {
  live: { id: 'b1200000-0000-4000-8000-000000000001', name: 'Пауза Тест Живая' },
  paused: { id: 'b1200000-0000-4000-8000-000000000002', name: 'Пауза Тест На паузе' },
  suspended: { id: 'b1200000-0000-4000-8000-000000000003', name: 'Пауза Тест Приостановлена' },
};

withPg('пауза оператора — шлюз витрины и список компаний', () => {
  let pool: import('pg').Pool;
  const tour = {} as Record<Kind, string>;
  const slug = {} as Record<Kind, string>;

  beforeAll(async () => {
    const { Pool } = await import('pg');
    const { OPERATOR_SITE_PAUSE_SLUGS } = await import('@/lib/operators/site-pause');
    const dbUrl = await createTestDatabase(PG_URL, TEST_DB);
    pool = new Pool({ connectionString: dbUrl, max: 4 });
    process.env.DATABASE_URL = dbUrl;
    process.env.DATABASE_SSL = 'false';

    // Компания на паузе — та, что названа в списке паузы. Если миграции уже
    // завели её карточку, сцена берёт её slug у нового партнёра, освободив
    // прежний: решать должен slug, а не история данных.
    const pausedSlug = OPERATOR_SITE_PAUSE_SLUGS[0];
    expect(pausedSlug).toBeTruthy();
    await pool.query(`UPDATE partners SET slug = slug || '-old-pause-test' WHERE slug = $1`, [pausedSlug]);
    slug.live = 'pause-test-live';
    slug.paused = pausedSlug;
    slug.suspended = 'pause-test-suspended';

    for (const k of KINDS) {
      await pool.query(
        `INSERT INTO partners (id, name, category, contact, slug, is_public, is_verified, status)
         VALUES ($1, $2, 'operator', '{}'::jsonb, $3, TRUE, TRUE, $4)`,
        [PARTNER[k].id, PARTNER[k].name, slug[k], k === 'suspended' ? 'suspended' : 'active'],
      );
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO operator_tours (operator_id, title, slug, activity_type, base_price, price_unit,
                                     min_participants, max_participants, duration_hours, difficulty,
                                     is_active, is_published)
         VALUES ($1, $2, $3, 'jeep_safari', 1000, 'per_person', 1, 10, 8, 'easy', TRUE, TRUE)
         RETURNING id::text`,
        [PARTNER[k].id, `Пауза тест тур ${k}`, `pause-test-tour-${k}`],
      );
      tour[k] = rows[0].id;
    }
  }, 300_000);

  afterAll(async () => {
    await pool?.end();
    const { pool: appPool } = await import('@/lib/db-pool');
    await (appPool as unknown as { end?: () => Promise<void> }).end?.();
  });

  const ours = async (where: string): Promise<string[]> => {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT ot.id::text AS id FROM operator_tours ot WHERE ot.id::text = ANY($1::text[]) AND ${where}`,
      [KINDS.map((k) => tour[k])],
    );
    return rows.map((r) => r.id).sort();
  };

  it('витрина пускает только тур живой компании', async () => {
    const { publicTourSql } = await import('@/lib/tours/public-visibility');
    expect(await ours(publicTourSql('ot'))).toEqual([tour.live]);
  });

  it('прямая ссылка открывает тур и на паузе, и приостановленной компании', async () => {
    const { tourOpenByLinkSql } = await import('@/lib/tours/public-visibility');
    expect(await ours(tourOpenByLinkSql('ot'))).toEqual(KINDS.map((k) => tour[k]).sort());
  });

  it('список /operators: компании на паузе и приостановленной нет, живая есть', async () => {
    const { queryOperators } = await import('@/lib/operators/list-query');
    const r = await queryOperators({ page: 1, limit: 100, search: 'Пауза Тест' });
    const slugs = r.items.map((i) => i.slug);
    expect(slugs).toContain(slug.live);
    expect(slugs).not.toContain(slug.paused);
    expect(slugs).not.toContain(slug.suspended);
    expect(r.items.find((i) => i.slug === slug.live)?.tourFacts?.total).toBe(1);
  });
});
