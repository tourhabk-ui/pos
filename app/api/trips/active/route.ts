/**
 * GET /api/trips/active — «моя активная поездка», источник режима «я в поездке».
 *
 * Зачем отдельный эндпоинт. Колонка `users.active_trip_id` (миграция 791) до
 * сих пор только ПИСАЛАСЬ: её ставит и снимает `POST /api/trips/[id]/active`,
 * а читающего пути не было ни одного. Поэтому `tripProgress()` из
 * `lib/home/trip-mode.ts` жил в тестах и никуда не выводился.
 *
 * Почему id не приходит от клиента. «Моя активная поездка» — не «поездка,
 * которую клиент назвал своей». Идентичность берётся из серверной сессии
 * (`requireAuth`), поездка выбирается по `users.active_trip_id` этого
 * пользователя, а `user_trips.user_id` в JOIN перепроверяет владение ещё раз.
 * Ни один параметр запроса на выбор строки не влияет — чужую поездку получить
 * нечем.
 *
 * Что отдаём: минимум для шапки режима — id, заголовок, даты и посчитанный
 * прогресс. Ни точек, ни планов по дням, ни транспорта: их незачем возить в
 * персональном ответе, который нельзя кэшировать.
 *
 * Когда отдаём `null` (а не 404): режим не включён, поездка удалена, либо
 * данные неконсистентны. Для главной «режима нет» — нормальное состояние, а не
 * ошибка; 404 заставил бы клиент разбирать исключение там, где ответ известен.
 *
 * Даты не интерпретируются здесь: их разбирает та же `tripProgress()`, что
 * покрыта тестами. При испорченных или отсутствующих датах она даёт
 * `phase: 'unknown'` и `day/total: null` — интерфейс обязан в этом случае не
 * рисовать «День N из M», а не подставлять единицу.
 *
 * Кэш. Ответ персональный, поэтому `private, no-store`: на общем телефоне
 * поездка одного человека не должна достаться другому из общего кэша. Service
 * worker этот путь и так не кэширует (в `sw.js` отдельная ветка только у
 * `/api/places/[id]`), но полагаться на это молча нельзя — заголовок ставим
 * явно и держим сторожем.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { requireAuth } from '@/lib/auth/middleware';
import { tripProgress, type TripProgress } from '@/lib/home/trip-mode';
import type { ApiResponse } from '@/types';

export const dynamic = 'force-dynamic';

/** Минимальный DTO режима поездки. */
export interface ActiveTripDto {
  id: string;
  title: string;
  arrivalDate: string | null;
  departureDate: string | null;
  progress: TripProgress;
}

/** DATE из pg приходит как Date или строка — нормализуем в YYYY-MM-DD или null. */
function toIsoDate(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}

const NO_STORE = {
  'Cache-Control': 'private, no-store, max-age=0',
} as const;

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (auth instanceof NextResponse) return auth;

  try {
    // Строка выбирается ТОЛЬКО по серверной идентичности: active_trip_id этого
    // пользователя, плюс перепроверка user_id в JOIN. Параметр один — userId.
    const { rows } = await pool.query<{
      id: string;
      title: string;
      arrival_date: unknown;
      departure_date: unknown;
    }>(
      `SELECT t.id, t.title, t.arrival_date, t.departure_date
         FROM users u
         JOIN user_trips t
           ON t.id = u.active_trip_id
          AND t.user_id = u.id
          AND t.deleted_at IS NULL
        WHERE u.id = $1
        LIMIT 1`,
      [auth.userId],
    );

    const row = rows[0];
    if (!row) {
      // Режим не включён либо поездка удалена — это норма, не ошибка.
      return NextResponse.json(
        { success: true, data: null } as ApiResponse<null>,
        { headers: NO_STORE },
      );
    }

    const arrivalDate = toIsoDate(row.arrival_date);
    const departureDate = toIsoDate(row.departure_date);
    const today = new Date().toISOString().slice(0, 10);

    const data: ActiveTripDto = {
      id: row.id,
      title: row.title,
      arrivalDate,
      departureDate,
      // Единственный источник «День N из M» — общая функция с тестами.
      // Здесь её результат не правится и не досчитывается.
      progress: tripProgress({ arrivalDate, departureDate }, today),
    };

    return NextResponse.json(
      { success: true, data } as ApiResponse<ActiveTripDto>,
      { headers: NO_STORE },
    );
  } catch (e) {
    // Режим поездки — украшение поверх главной, а не её условие. Молчаливое
    // «режима нет» безопаснее пятисотки: человек увидит обычную главную.
    console.error('[trips/active]', e instanceof Error ? e.message : e);
    return NextResponse.json(
      { success: true, data: null } as ApiResponse<null>,
      { headers: NO_STORE },
    );
  }
}
