/**
 * GET /api/tourist/summary — числа на «Моей Камчатке».
 *
 * ── Считается по ВОШЕДШЕМУ, а не по строке из чужой формы ─────────────────
 *
 * Прежде брони отбирались `WHERE tourist_email = $1` — по email из JWT. Но
 * `tourist_email` пишет ФОРМА брони (`/api/hub/bookings/create`), и гостевую
 * бронь она принимает без авторизации. То есть любой мог оформить бронь на
 * чужой адрес, и хозяин адреса увидел бы в своём кабинете чужую поездку и
 * чужую сумму. Обратная ошибка та же: свою бронь, оформленную на другой
 * адрес, человек не видел вовсе.
 *
 * Скоуп кабинета один — `operator_bookings.user_id`, и живёт он в
 * `lib/tourist/cabinet.ts` (тот же источник кормит `/api/tourist/stats` и
 * `/api/tourist/profile`). Своего третьего способа считать здесь нет
 * намеренно: три способа — это три разных числа на трёх экранах об одном
 * человеке.
 *
 * Сторож: `tests/unit/tourist-summary-scope.test.ts`.
 */
import { NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { touristTravelStats } from '@/lib/tourist/cabinet';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await requireAuth(req as never);
  if (auth instanceof NextResponse) return auth;
  const { userId } = auth;

  try {
    const [travel, ecoRes] = await Promise.all([
      // Брони, завершённые поездки и потраченное — общий счёт кабинета.
      touristTravelStats(userId, null),
      // Реестр эко — единственный источник. Раньше здесь читалась таблица
      // user_eco_points, которую не создаёт ни одна миграция (она есть только
      // в неприменяемом lib/database/schema.sql). Запрос стоял в Promise.all,
      // поэтому падал ВЕСЬ ответ: /my-kamchatka не получал даже число броней.
      pool.query<{ utility: string; contribution: string }>(
        `SELECT
           COALESCE(MAX(balance) FILTER (WHERE account = $1), 0)::text AS utility,
           COALESCE(MAX(balance) FILTER (WHERE account = $2), 0)::text AS contribution
         FROM eco_balances
         WHERE account IN ($1, $2)`,
        [`user:${userId}`, `contrib:${userId}`],
      ),
    ]);

    const eco = ecoRes.rows[0] ?? { utility: '0', contribution: '0' };

    return NextResponse.json({
      ok: true,
      data: {
        bookings_count: travel.total_trips,
        bookings_completed: travel.completed_trips,
        total_spent: travel.total_spent,
        // Два слоя раздельно (docs/ECO.md): вклад не тратится, польза тратится.
        eco_utility: Number(eco.utility),
        eco_contribution: Number(eco.contribution),
      },
    });
  } catch (err) {
    // Отказ не глушится и не пересказывается туристу: имя проверки и SQLSTATE
    // — в лог, наружу род отказа. Прежде сообщение PostgreSQL уходило прямо в
    // браузер (§4.0 про лог, §7 про то, что наружу не отдают схему).
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[tourist/summary] отказ чтения сводки${typeof code === 'string' ? ` SQLSTATE ${code}` : ''} — ${message}`,
    );
    return NextResponse.json({ ok: false, error: 'Не удалось загрузить сводку' }, { status: 500 });
  }
}
