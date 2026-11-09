/**
 * Страницы партнёров `/operators/[slug]` в sitemap — одно правило (09.11).
 *
 * Страница открывается любой публичной карточке со slug (перевозчик и прокат
 * уводятся на свои страницы). sitemap до 09.11 брал только
 * `category = 'operator'`, и страницы гида Андрея Запорожца — 9 туров на
 * витрине, самая подробная карточка — в нём не было (инвентаризация 09.11).
 *
 * Теперь в sitemap:
 *  - туроператор с публичной карточкой — как раньше, даже без туров: его
 *    страница — описание базы, условия и контакты;
 *  - гид с публичной карточкой и хотя бы одним туром на витрине (шлюз
 *    `publicTourSql` — тот же, что у каталога): у гида без туров страница
 *    пустая для поиска, а гидов-карточек в базе больше сотни;
 *  - никогда — тестовый стенд (`lib/seat-requests/test-stand`): его адрес
 *    раздавался поисковикам и отвечал 404.
 */
import type { Pool, PoolClient } from 'pg';
import { pool } from '@/lib/db-pool';
import { publicTourSql } from '@/lib/tours/public-visibility';
import { TEST_STAND_PARTNER_IDS } from '@/lib/seat-requests/test-stand';

export const PARTNER_PAGES_SQL = `
  SELECT p.slug, p.updated_at
    FROM partners p
   WHERE p.slug IS NOT NULL
     AND p.is_public = TRUE
     AND NOT (p.id = ANY($1::uuid[]))
     AND (
       p.category = 'operator'
       OR (p.category = 'guide' AND EXISTS (
             SELECT 1 FROM operator_tours ot
              WHERE ot.operator_id = p.id AND ${publicTourSql('ot')}))
     )
   ORDER BY p.updated_at DESC
   LIMIT 200`;

export async function partnerSitemapRows(
  db: Pick<Pool | PoolClient, 'query'> = pool,
): Promise<Array<{ slug: string; updated_at: Date }>> {
  const { rows } = await db.query<{ slug: string; updated_at: Date }>(PARTNER_PAGES_SQL, [TEST_STAND_PARTNER_IDS]);
  return rows;
}
