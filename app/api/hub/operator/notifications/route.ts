/**
 * GET  /api/hub/operator/notifications — уведомления оператора из БД:
 *      новые бронирования, отмены, новые отзывы.
 * POST /api/hub/operator/notifications — отметить прочитанным: одно
 *      уведомление (`{ id }`) или все показанные (`{ all: true }`).
 *
 * Прогулка оператором 11.09 (#1801) нашла здесь три вещи:
 * 1. «Прочитано» жило только в useState — после перезагрузки всё снова
 *    непрочитано. Теперь отметки лежат в `operator_notification_reads`
 *    (миграция 951).
 * 2. Уведомление о брони никуда не вело, хотя её id известен. Теперь у
 *    каждого уведомления есть `href`.
 * 3. Отзывы читались из `operator_reviews` — таблицы, которой нет ни в одной
 *    миграции, — и отказ глушился пустым catch, превращаясь в «отзывов нет».
 *    Отзывы живут в `operator_tour_reviews`; отказ теперь пишется в лог с
 *    SQLSTATE (§4.0: ловить можно, молчать нельзя).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperator } from '@/lib/auth/middleware';
import { pool } from '@/lib/db-pool';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { logScreenQueryFailure } from '@/lib/operator/screen-queries';

export const dynamic = 'force-dynamic';

type NType = 'booking' | 'cancellation' | 'review';

interface Notification {
  id: string;
  type: NType;
  title: string;
  message: string;
  time: string;
  read: boolean;
  created_at: string;
  /** Куда ведёт уведомление: бронь или тур с отзывами. */
  href: string;
}

type BookingRow = {
  id: string; tourist_name: string | null; booking_status: string;
  created_at: string; tour_title: string; final_price: string | null;
};
type ReviewRow = {
  id: string; rating: string; created_at: string;
  tour_title: string; tour_id: string; reviewer_name: string | null;
};

function relativeTime(iso: string, now: number): string {
  const diff = now - new Date(iso).getTime();
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `${min} мин. назад`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} ч. назад`;
  const d = Math.floor(h / 24);
  if (d === 1) return 'вчера';
  return `${d} д. назад`;
}

export async function GET(req: NextRequest) {
  const auth = await requireOperator(req);
  if (auth instanceof NextResponse) return auth;

  const { searchParams } = new URL(req.url);
  const filter = searchParams.get('filter') ?? 'all'; // all | unread

  const operatorId = await getOperatorPartnerId(auth.userId);
  if (!operatorId) {
    return NextResponse.json({ notifications: [], total: 0 });
  }

  // Бронирования: последние 30
  const bookings = await pool.query<BookingRow>(
    `SELECT ob.id::text, ob.tourist_name, ob.booking_status,
            ob.created_at::text, ot.title AS tour_title,
            ob.final_price::text
     FROM operator_bookings ob
     JOIN operator_tours ot ON ot.id = ob.operator_tour_id
     WHERE ot.operator_id = $1 AND ob.deleted_at IS NULL
     ORDER BY ob.created_at DESC
     LIMIT 30`,
    [operatorId]
  ).catch((e: unknown) => { logScreenQueryFailure('notifications.bookings', e); return { rows: [] as BookingRow[] }; });

  // Отзывы: последние 10. Таблица — operator_tour_reviews (operator_reviews
  // не существует; см. шапку файла).
  const reviews = await pool.query<ReviewRow>(
    `SELECT r.id::text, r.rating::text, r.created_at::text,
            ot.title AS tour_title, ot.id::text AS tour_id,
            COALESCE(u.name, r.author_name, 'Турист') AS reviewer_name
     FROM operator_tour_reviews r
     JOIN operator_tours ot ON ot.id = r.tour_id
     LEFT JOIN users u ON u.id = r.user_id
     WHERE ot.operator_id = $1 AND r.is_hidden IS NOT TRUE
     ORDER BY r.created_at DESC
     LIMIT 10`,
    [operatorId]
  ).catch((e: unknown) => { logScreenQueryFailure('notifications.reviews', e); return { rows: [] as ReviewRow[] }; });

  // Сохранённые отметки «прочитано».
  const reads = await pool.query<{ notification_id: string }>(
    `SELECT notification_id FROM operator_notification_reads WHERE partner_id = $1`,
    [operatorId]
  ).catch((e: unknown) => { logScreenQueryFailure('notifications.reads', e); return { rows: [] as { notification_id: string }[] }; });
  const readIds = new Set(reads.rows.map((r) => r.notification_id));

  const now = Date.now();
  const items: Notification[] = [];

  for (const b of bookings.rows) {
    const isCancelled = b.booking_status === 'cancelled';
    const price = b.final_price ? ` — ${Number(b.final_price).toLocaleString('ru')} ₽` : '';
    const id = `b-${b.id}`;
    items.push({
      id,
      type: isCancelled ? 'cancellation' : 'booking',
      title: isCancelled ? 'Отмена бронирования' : 'Новое бронирование',
      message: isCancelled
        ? `${b.tourist_name ?? 'Турист'} отменил(а) «${b.tour_title}»`
        : `${b.tourist_name ?? 'Турист'} забронировал(а) «${b.tour_title}»${price}`,
      time: relativeTime(b.created_at, now),
      // Отметка человека сильнее вывода из статуса: оператор мог прочитать
      // бронь, которая всё ещё «new».
      read: readIds.has(id) || (isCancelled ? true : b.booking_status !== 'new'),
      created_at: b.created_at,
      href: `/hub/operator/bookings/${b.id}`,
    });
  }

  for (const r of reviews.rows) {
    const id = `r-${r.id}`;
    items.push({
      id,
      type: 'review',
      title: 'Новый отзыв',
      message: `${r.reviewer_name} оставил(а) ${r.rating} — «${r.tour_title}»`,
      time: relativeTime(r.created_at, now),
      read: readIds.has(id),
      created_at: r.created_at,
      href: `/hub/operator/tours/${r.tour_id}`,
    });
  }

  items.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const filtered = filter === 'unread' ? items.filter((n) => !n.read) : items;

  return NextResponse.json({ notifications: filtered, total: items.length });
}

const ReadSchema = z.union([
  z.object({ id: z.string().regex(/^[br]-\d+$/, 'неизвестный идентификатор уведомления') }),
  z.object({ all: z.literal(true), ids: z.array(z.string().regex(/^[br]-\d+$/)).max(200) }),
]);

export async function POST(req: NextRequest) {
  const auth = await requireOperator(req);
  if (auth instanceof NextResponse) return auth;

  const operatorId = await getOperatorPartnerId(auth.userId);
  if (!operatorId) {
    return NextResponse.json({ success: false, error: 'Профиль оператора не найден' }, { status: 404 });
  }

  const parsed = ReadSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: 'Некорректный запрос: нужен id уведомления или список ids' },
      { status: 400 }
    );
  }

  const ids = 'all' in parsed.data ? parsed.data.ids : [parsed.data.id];
  if (ids.length === 0) return NextResponse.json({ success: true, marked: 0 });

  try {
    // Повторная отметка — не ошибка: человек мог нажать дважды.
    const res = await pool.query(
      `INSERT INTO operator_notification_reads (partner_id, notification_id)
       SELECT $1, unnest($2::text[])
       ON CONFLICT (partner_id, notification_id) DO NOTHING`,
      [operatorId, ids]
    );
    return NextResponse.json({ success: true, marked: res.rowCount ?? 0 });
  } catch (e) {
    logScreenQueryFailure('notifications.mark-read', e);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить отметку. Попробуйте ещё раз.' },
      { status: 500 }
    );
  }
}
