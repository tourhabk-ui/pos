/**
 * GET /api/admin/diagnostics/bystraya  (admin-only)
 *
 * Точная диагностика, почему карточка тура «Сплав по реке Быстрая» не видна на
 * проде. Каталог показывает тур только при is_active + is_published +
 * deleted_at IS NULL (lib/search/tour-search.ts). Публикацию ставит миграция
 * 789. Здесь отвечаем детерминированно: есть ли строка тура, в каком она
 * состоянии, применились ли миграции 788–797 и не падали ли они.
 *
 * Только чтение, без побочных эффектов.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';

export const dynamic = 'force-dynamic';

const PARTNER_SLUG = 'kamchatka-rafting';
const TOUR_TITLE = 'Однодневная экскурсия СПЛАВ ПО РЕКЕ БЫСТРАЯ';
const MIGRATIONS = [
  '788_bystraya_tour_honest_dates.sql',
  '789_bystraya_tour_publish.sql',
  '790_bystraya_tour_capacity.sql',
  '793_bystraya_tour_description_from_channel.sql',
  '794_bystraya_tour_real_photos.sql',
  '795_bystraya_tour_gallery_expand.sql',
  '796_bystraya_tour_content_fields.sql',
  '797_operator_tours_meeting_point.sql',
  '800_bystraya_tour_force_publish.sql',
];

export async function GET(request: NextRequest): Promise<NextResponse> {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const result: Record<string, unknown> = {};

  // 1. Партнёр
  try {
    const p = await pool.query<{ id: string; name: string }>(
      `SELECT id::text, name FROM partners WHERE slug = $1`, [PARTNER_SLUG],
    );
    result.partner = p.rows[0] ?? null;
  } catch (e) { result.partner_error = e instanceof Error ? e.message : String(e); }

  // 2. Тур: существует ли и в каком состоянии
  try {
    const t = await pool.query<{
      id: string; title: string; is_published: boolean | null; is_active: boolean | null;
      deleted_at: string | null; activity_type: string | null; base_price: string | null;
      has_description: boolean; has_meeting_point: boolean; photos_count: number;
    }>(
      `SELECT ot.id::text, ot.title, ot.is_published, ot.is_active,
              ot.deleted_at::text, ot.activity_type, ot.base_price::text,
              (ot.description IS NOT NULL AND length(ot.description) > 0) AS has_description,
              (ot.meeting_point IS NOT NULL) AS has_meeting_point,
              COALESCE(array_length(ot.photos, 1), 0) AS photos_count
         FROM operator_tours ot
         JOIN partners p ON p.id = ot.operator_id
        WHERE p.slug = $1 AND ot.title = $2`,
      [PARTNER_SLUG, TOUR_TITLE],
    );
    result.tour = t.rows[0] ?? null;
    result.tour_found = t.rows.length > 0;

    // 2b. Видна ли в каталоге по фильтру (is_active + is_published + not deleted)
    if (t.rows[0]) {
      const row = t.rows[0];
      result.visible_in_catalog =
        row.is_active === true && row.is_published === true && row.deleted_at === null;
    }
  } catch (e) { result.tour_error = e instanceof Error ? e.message : String(e); }

  // 3. Будущие даты доступности
  try {
    const a = await pool.query<{ future_dates: string }>(
      `SELECT COUNT(*)::text AS future_dates
         FROM tour_availability ta
         JOIN operator_tours ot ON ot.id = ta.operator_tour_id
         JOIN partners p ON p.id = ot.operator_id
        WHERE p.slug = $1 AND ot.title = $2
          AND ta.date >= CURRENT_DATE AND ta.deleted_at IS NULL`,
      [PARTNER_SLUG, TOUR_TITLE],
    );
    result.future_availability_dates = parseInt(a.rows[0]?.future_dates ?? '0', 10);
  } catch (e) { result.availability_error = e instanceof Error ? e.message : String(e); }

  // 4. Применены ли миграции 788–797
  try {
    const m = await pool.query<{ name: string }>(
      `SELECT name FROM _migrations WHERE name = ANY($1)`, [MIGRATIONS],
    );
    const applied = new Set(m.rows.map(r => r.name));
    result.migrations_applied = MIGRATIONS.map(n => ({ name: n, applied: applied.has(n) }));
  } catch (e) { result.migrations_error = e instanceof Error ? e.message : String(e); }

  // 5. Падавшие миграции (если таблица есть)
  try {
    const f = await pool.query<{ name: string; error: string; attempts: number; last_failed_at: string }>(
      `SELECT name, error, attempts, last_failed_at::text
         FROM _migration_failures WHERE name = ANY($1)`, [MIGRATIONS],
    );
    result.migration_failures = f.rows;
  } catch {
    result.migration_failures = 'таблица _migration_failures недоступна (старый деплой?)';
  }

  // 6. Вердикт — человекочитаемо
  const verdict: string[] = [];
  if (result.tour_found === false) {
    verdict.push('Тур НЕ найден в БД: миграция 060 не создала строку на проде (или slug/title иные). Публиковать нечего.');
  } else if (result.visible_in_catalog === true) {
    verdict.push('Тур опубликован и проходит фильтр каталога. Не видно на телефоне → кэш PWA: закрыть-открыть приложение / очистить кэш.');
  } else {
    const tour = result.tour as Record<string, unknown> | null;
    if (tour) {
      if (tour.is_published !== true) verdict.push('is_published != true → миграция 789 не применилась (см. migrations_applied/failures).');
      if (tour.is_active !== true) verdict.push('is_active != true.');
      if (tour.deleted_at !== null) verdict.push('deleted_at проставлен → тур скрыт как удалённый.');
    }
  }
  result.verdict = verdict;

  return NextResponse.json(result);
}
