/**
 * POST /api/operator/calendar/bulk-open
 *
 * Массовое открытие слотов для тура на диапазон дат.
 * Поддерживает фильтрацию по дням недели (например, только субботы).
 *
 * Body:
 *   tourId:     number
 *   startDate:  YYYY-MM-DD
 *   endDate:    YYYY-MM-DD
 *   slots:      number (кол-во мест на каждый день)
 *   weekdays?:  number[] (0=пн, 6=вс; пусто = все дни)
 *   priceOverride?: number
 *   skipExisting?:  boolean (не перезаписывать уже открытые даты)
 *
 * Запись — общей функцией `openTourDates` (lib/tours/availability-open.ts):
 * владение и блокировка тура, занятость по броням, исход по каждой дате.
 * Кабинет открывает и закрытые даты (`closedDates: 'reopen'`), прошлые даты и
 * сезон не проверяет — как раньше. Скрытому туру даты здесь не открываются, как
 * и до 22.10 (владение проверялось с `is_active = true`), но ответ теперь
 * называет причину — «тур скрыт», а не «тур не найден»: тур есть, и он виден
 * оператору в списке. Новое правило одно: места ниже числа уже записанных не
 * ставятся — такая дата приходит в `refused` с числом записанных.
 *
 * Ответ: `opened` — открыто всего, ВКЛЮЧАЯ открытые снова; `reopenedDates` —
 * открытые снова поимённо с причиной закрытия (она при открытии снимается, и
 * панель называет её отдельной строкой). Пустая цена цену уже открытой даты не
 * трогает (меняется только переданная).
 */

import { NextRequest, NextResponse } from 'next/server';
import { managerMay, permissionDenied, requireOperatorTeam } from '@/lib/operators/team-access';
import { countResults, datesInRange, isCalendarDate, openTourDates, tourHiddenText } from '@/lib/tours/availability-open';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

// Дата, которой нет в календаре (2027-02-31), — неверный ввод: Date перекатил
// бы её в март, и открылись бы не те дни.
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isCalendarDate, 'Такой даты нет в календаре');

const BulkOpenSchema = z.object({
  tourId:        z.coerce.number().int().positive('tourId обязателен'),
  startDate:     Day,
  endDate:       Day,
  slots:         z.number().int().min(1).max(500),
  weekdays:      z.array(z.number().int().min(0).max(6)).optional(),
  priceOverride: z.number().min(0).optional(),
  skipExisting:  z.boolean().optional().default(false),
});

// Кабинет — свой у владельца или командный у менеджера (CRM 2г). Даты и места
// открывает любой из команды, цену на даты — владелец или менеджер с правом.

export async function POST(request: NextRequest) {
  const ctx = await requireOperatorTeam(request, { noProfileStatus: 404 });
  if (ctx instanceof NextResponse) return ctx;
  const operatorId = ctx.partnerId;

  let body: unknown;
  try { body = await request.json(); } catch {
    return NextResponse.json({ success: false, error: 'Некорректный JSON' }, { status: 400 });
  }

  const parsed = BulkOpenSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { success: false, error: parsed.error.issues[0]?.message ?? 'Некорректные данные' },
      { status: 400 }
    );
  }
  const { tourId, startDate, endDate, slots, weekdays, priceOverride, skipExisting } = parsed.data;

  const mayPrice = managerMay(ctx.access, 'can_edit_prices');
  if (priceOverride !== undefined && !mayPrice) return permissionDenied('can_edit_prices');

  const dates = datesInRange(startDate, endDate, weekdays);
  if (dates.length === 0) {
    return NextResponse.json({ success: false, error: 'Нет дат в выбранном диапазоне/фильтре' }, { status: 400 });
  }

  const outcome = await openTourDates({
    operatorId,
    tourId: String(tourId),
    rows: dates.map((date) => ({ date, slots, price: priceOverride ?? null })),
    mayPrice,
    inactiveTour: 'refuse',
    skipExisting,
    closedDates: 'reopen',
  });
  if (!outcome.ok) {
    if (outcome.reason === 'tour_not_found') {
      return NextResponse.json({ success: false, error: 'Тур не найден или нет прав' }, { status: 404 });
    }
    if (outcome.reason === 'tour_inactive') {
      return NextResponse.json(
        { success: false, error: tourHiddenText(outcome.title) },
        { status: 409 },
      );
    }
    // Текст ошибки базы — в лог (его пишет openTourDates с SQLSTATE), а не
    // человеку: он про колонки, а не про даты.
    return NextResponse.json({ success: false, error: 'Не удалось открыть даты — попробуйте позже' }, { status: 500 });
  }

  const n = countResults(outcome.perDate);
  const refused = outcome.perDate.flatMap((r) => (r.result === 'refused_booked' ? [{ date: r.date, taken: r.taken }] : []));
  // Открытые СНОВА — поимённо и с причиной закрытия: кабинет открывает и
  // закрытые оператором даты (например, «Шторм»), а причина при открытии
  // снимается. Без отдельной строки такая дата растворялась в «Открыто N»
  // (ревью 22.10).
  const reopenedDates = outcome.perDate.flatMap((r) => (r.result === 'reopened' ? [{ date: r.date, reason: r.reason }] : []));
  const opened = n.opened + n.reopened;
  const parts = [`Открыто ${opened} дат`];
  if (n.reopened > 0) parts.push(`из них открыто снова ${n.reopened} — были закрыты или сняты`);
  if (n.updated > 0) parts.push(`обновлено ${n.updated}`);
  if (n.already_open > 0) parts.push(`пропущено ${n.already_open}`);
  if (refused.length > 0) parts.push(`не открыто ${refused.length}: уже записано больше мест`);
  return NextResponse.json({
    success: true,
    data: {
      opened,
      reopened: n.reopened,
      reopenedDates,
      updated: n.updated,
      skipped: n.already_open,
      refused,
      total: dates.length,
    },
    message: parts.join(', '),
  });
}
