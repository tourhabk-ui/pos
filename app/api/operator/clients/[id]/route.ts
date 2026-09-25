import { NextRequest, NextResponse } from 'next/server';
import { query } from '@/lib/database';
import { requireOperator } from '@/lib/auth/middleware';
import { getOperatorPartnerId } from '@/lib/auth/operator-helpers';
import { z } from 'zod';
import { isUuid } from '@/lib/text/slugify';
import { logScreenQueryFailure } from '@/lib/operator/screen-queries';

const UpdateClientSchema = z.object({
  tags: z.array(z.string()).optional(),
  telegram_id: z.string().optional(),
});

export const dynamic = 'force-dynamic';

/** Проверяет, что клиент является клиентом этого оператора */
async function verifyClientAccess(clientId: string, partnerId: string): Promise<boolean> {
  const res = await query(
    `SELECT 1 FROM operator_bookings b
     JOIN operator_tours t ON b.operator_tour_id = t.id
     WHERE b.user_id = $1 AND t.operator_id = $2
       AND b.deleted_at IS NULL AND t.deleted_at IS NULL
     LIMIT 1`,
    [clientId, partnerId]
  );
  return res.rows.length > 0;
}

/**
 * GET /api/operator/clients/[id]
 * Профиль клиента: бронирования, отзывы, теги, экобаллы
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const userOrResponse = await requireOperator(request);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const partnerId = await getOperatorPartnerId(userOrResponse.userId);
    if (!partnerId) {
      return NextResponse.json({ success: false, error: 'Партнёрский профиль не найден' }, { status: 404 });
    }

    const { id } = await context.params;
    // users.id — uuid; строка вида «1» роняла запрос с 22P02 и отдавала 500
    // там, где это просто неверный адрес (#1794).
    if (!isUuid(id)) {
      return NextResponse.json({ success: false, error: 'Некорректный идентификатор клиента' }, { status: 400 });
    }
    const hasAccess = await verifyClientAccess(id, partnerId);
    if (!hasAccess) {
      return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
    }

    // 1. Инфо о клиенте + экобаллы. Теги и Telegram — ниже, из
    // operator_client_notes (заметки ЭТОГО оператора), не из users.preferences.
    // Эко берём из реестра (eco_balances), а не из user_eco_points: последней
    // не создаёт ни одна миграция, поэтому JOIN ронял ВЕСЬ запрос — карточка
    // клиента у оператора отдавала 500 независимо от эко. Оператору показываем
    // вклад (contrib:) — накопленную историю поступков туриста, а не остаток
    // к трате: остаток — кошелёк туриста, оператору он не нужен.
    const userRes = await query(
      `SELECT
         u.id, u.name, u.email, u.phone,
         COALESCE(eb.balance, 0)::int AS eco_points
       FROM users u
       LEFT JOIN eco_balances eb ON eb.account = 'contrib:' || u.id::text
       WHERE u.id = $1`,
      [id]
    );
    if (userRes.rows.length === 0) {
      return NextResponse.json({ success: false, error: 'Пользователь не найден' }, { status: 404 });
    }
    const u = userRes.rows[0] as {
      id: string; name: string; email: string; phone: string | null; eco_points: number;
    };

    // Заметки оператора о клиенте — своя строка на пару (оператор, клиент),
    // миграция 1017. Раньше теги и telegram жили в users.preferences —
    // общем профиле туриста, и операторы перезаписывали друг друга.
    const notesRes = await query<{ tags: string[] | null; telegram: string | null }>(
      `SELECT tags, telegram
         FROM operator_client_notes
        WHERE operator_id = $1 AND user_id = $2`,
      [partnerId, id]
    );
    const tags: string[] = notesRes.rows[0]?.tags ?? [];
    const telegramId: string = notesRes.rows[0]?.telegram ?? '';

    // 2. Все бронирования клиента у этого оператора
    interface BookingRow {
      id: string; status: string; total_price: unknown;
      guests_count: number; start_date: unknown; created_at: unknown; tour_name: string;
    }
    const bookingsRes = await query<BookingRow>(
      `SELECT
         b.id,
         b.booking_status AS status,
         COALESCE(b.final_price, b.base_total_price)::numeric AS total_price,
         b.participants AS guests_count,
         b.booking_date AS start_date,
         b.created_at,
         t.title AS tour_name
       FROM operator_bookings b
       JOIN operator_tours t ON b.operator_tour_id = t.id
       WHERE b.user_id = $1 AND t.operator_id = $2
         AND b.deleted_at IS NULL AND t.deleted_at IS NULL
       ORDER BY b.created_at DESC
       LIMIT 50`,
      [id, partnerId]
    );

    // 3. Отзывы клиента на туры этого оператора — из operator_tour_reviews.
    // Прежний JOIN шёл по старой reviews: reviews.tour_id (uuid) против
    // operator_tours.id (bigint) — 42883 на КАЖДОМ открытии карточки, то есть
    // CRM-карточка клиента не открывалась никогда. Скрытые модератором
    // отзывы (is_hidden, миграция 878) не показываются и здесь.
    interface ReviewRow {
      id: string; rating: number; comment: string | null;
      created_at: unknown; tour_name: string;
    }
    const reviewsRes = await query<ReviewRow>(
      `SELECT
         r.id::text AS id, r.rating, r.comment, r.created_at,
         t.title AS tour_name
       FROM operator_tour_reviews r
       JOIN operator_tours t ON r.tour_id = t.id
       WHERE r.user_id = $1 AND t.operator_id = $2
         AND t.deleted_at IS NULL
         AND r.is_hidden = FALSE
       ORDER BY r.created_at DESC
       LIMIT 20`,
      [id, partnerId]
    );

    return NextResponse.json({
      success: true,
      data: {
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone ?? '',
        ecoPoints: u.eco_points,
        tags,
        telegramId,
        bookings: bookingsRes.rows.map((b) => ({
          id:          b.id,
          tourName:    b.tour_name,
          status:      b.status,
          totalPrice:  parseFloat(String(b.total_price)),
          guestsCount: b.guests_count,
          startDate:   b.start_date ? new Date(b.start_date as string).toISOString() : null,
          createdAt:   new Date(b.created_at as string).toISOString(),
        })),
        reviews: reviewsRes.rows.map((r) => ({
          id:         r.id,
          tourName:   r.tour_name,
          rating:     r.rating,
          comment:    r.comment ?? '',
          createdAt:  new Date(r.created_at as string).toISOString(),
        })),
      },
    });
  } catch (err) {
    // Текст PostgreSQL наружу не отдаётся (имена таблиц, колонок) — в лог с
    // SQLSTATE; оператору понятная фраза (§4.0).
    logScreenQueryFailure('clients/[id] GET', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось загрузить карточку клиента. Попробуйте обновить страницу.' },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/operator/clients/[id]
 * Обновить теги и/или telegram клиента в заметках ЭТОГО оператора
 * (operator_client_notes, миграция 1017). users.preferences не трогается.
 */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const userOrResponse = await requireOperator(request);
    if (userOrResponse instanceof NextResponse) return userOrResponse;

    const partnerId = await getOperatorPartnerId(userOrResponse.userId);
    if (!partnerId) {
      return NextResponse.json({ success: false, error: 'Партнёрский профиль не найден' }, { status: 404 });
    }

    const { id } = await context.params;
    // users.id — uuid; строка вида «1» роняла запрос с 22P02 и отдавала 500
    // там, где это просто неверный адрес (#1794).
    if (!isUuid(id)) {
      return NextResponse.json({ success: false, error: 'Некорректный идентификатор клиента' }, { status: 400 });
    }
    const hasAccess = await verifyClientAccess(id, partnerId);
    if (!hasAccess) {
      return NextResponse.json({ success: false, error: 'Клиент не найден' }, { status: 404 });
    }

    const body = await request.json() as { tags?: unknown; telegram_id?: unknown };
    const parsed = UpdateClientSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Некорректные данные' }, { status: 400 });
    }

    // Валидация tags
    if ('tags' in body && (!Array.isArray(body.tags) || !body.tags.every((t) => typeof t === 'string'))) {
      return NextResponse.json({ success: false, error: 'tags должен быть массивом строк' }, { status: 400 });
    }
    // Нормализация и валидация telegram_id
    let normalizedTgId: string | undefined;
    if ('telegram_id' in body) {
      const raw = typeof body.telegram_id === 'string' ? body.telegram_id.trim() : '';
      normalizedTgId = raw.startsWith('@') ? raw.slice(1) : raw; // убираем @ — храним без него
      if (normalizedTgId !== '' && !/^([a-zA-Z0-9_]{4,32}|\d{4,12})$/.test(normalizedTgId)) {
        return NextResponse.json(
          { success: false, error: 'Неверный формат: введите @username (4–32 символа) или числовой ID' },
          { status: 400 }
        );
      }
    }

    const hasTags = 'tags' in body;
    const hasTelegram = normalizedTgId !== undefined;
    if (!hasTags && !hasTelegram) {
      return NextResponse.json({ success: false, error: 'Нечего обновлять' }, { status: 400 });
    }
    const nextTags: string[] | null = hasTags ? (body.tags as string[]).slice(0, 10) : null;
    // Пустая строка — оператор стёр Telegram: храним NULL («не записано»).
    const nextTelegram: string | null = hasTelegram && normalizedTgId !== '' ? (normalizedTgId as string) : null;

    // Upsert по паре (оператор, клиент). Меняется только переданное поле:
    // $4/$5 — флаги «поле пришло», чтобы PATCH одних тегов не стирал telegram.
    await query(
      `INSERT INTO operator_client_notes (operator_id, user_id, tags, telegram, updated_at)
       VALUES ($1, $2, COALESCE($3::text[], '{}'::text[]), $6::text, NOW())
       ON CONFLICT (operator_id, user_id) DO UPDATE
         SET tags       = CASE WHEN $4::boolean THEN COALESCE($3::text[], '{}'::text[]) ELSE operator_client_notes.tags END,
             telegram   = CASE WHEN $5::boolean THEN $6::text ELSE operator_client_notes.telegram END,
             updated_at = NOW()`,
      [partnerId, id, nextTags, hasTags, hasTelegram, nextTelegram]
    );

    return NextResponse.json({ success: true, data: { id } });
  } catch (err) {
    logScreenQueryFailure('clients/[id] PATCH', err);
    return NextResponse.json(
      { success: false, error: 'Не удалось сохранить заметки о клиенте. Попробуйте ещё раз.' },
      { status: 500 }
    );
  }
}
