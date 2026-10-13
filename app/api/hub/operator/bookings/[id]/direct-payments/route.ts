/**
 * Оплата напрямую оператору по брони (CRM фаза 2в, миграция 1215).
 *
 * GET   — записи, получено, сколько осталось;
 * POST  — записать полученные деньги (сумма, способ, дата, примечание);
 * PATCH — аннулировать ошибочную запись с причиной.
 *
 * Решение владельца 11.10: отметка отдельная от оплаты через платформу. Роут
 * НЕ пишет `paid_at`, `payment_status`, `tour_payments` и комиссию — деньги,
 * полученные оператором наличными или переводом, через платформу не шли
 * (§7 CLAUDE.md; сторож crm-direct-payments).
 *
 * Только владелец кабинета (requireOperatorOwner): это деньги, а менеджеру
 * команды деньги закрыты (CRM 2г, решение владельца 11.10). Бронь — своего
 * кабинета: тур → оператор (operatorOwnsBooking). Чужая бронь неотличима от
 * несуществующей (404); не смогли проверить — 503.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireOperatorOwner } from '@/lib/operators/team-access';
import { pool } from '@/lib/db-pool';
import { operatorOwnsBooking } from '@/lib/bookings/operator-owns';
import {
  DIRECT_PAYMENT_METHODS, DIRECT_PAYMENT_METHOD_LABELS,
  addDirectPayment, directPaidTotal, directRemaining, listDirectPayments, voidDirectPayment,
} from '@/lib/bookings/direct-payments';
import { kamchatkaToday, isRealDate } from '@/lib/seat-requests/core';
import { recordSourceEventQuietly } from '@/lib/crm/events';

export const dynamic = 'force-dynamic';

const AddSchema = z.object({
  amount: z.number({ error: 'Сумма — число' }).positive('Сумма больше нуля').max(10_000_000, 'Сумма не больше 10 млн ₽'),
  method: z.enum(DIRECT_PAYMENT_METHODS, { error: 'Способ: наличные, перевод, терминал или другое' }),
  received_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата получения в формате ГГГГ-ММ-ДД'),
  note: z.string().trim().max(500, 'Примечание не длиннее 500 символов').optional(),
});

const VoidSchema = z.object({
  payment_id: z.string().uuid('Неверный номер записи'),
  reason: z.string().trim().min(3, 'Причина — хотя бы несколько слов').max(300, 'Причина не длиннее 300 символов'),
});

const rub = (n: number) => `${n.toLocaleString('ru-RU')} ₽`;

function dbFailure(where: string, err: unknown): NextResponse {
  const code = (err as { code?: string } | null)?.code ?? '?';
  console.error(`[hub/operator/direct-payments] ${where} (SQLSTATE ${code}):`, err instanceof Error ? err.message : err);
  return NextResponse.json({ success: false, error: 'Оплаты не записаны и не прочитаны: база не ответила. Попробуйте позже.' }, { status: 503 });
}

/** Владение бронью: null — можно; иначе готовый ответ. */
async function ownershipGate(bookingId: string, userId: string): Promise<NextResponse | null> {
  const own = await operatorOwnsBooking(bookingId, userId);
  if (own === 'unknown') {
    return NextResponse.json({ success: false, error: 'Не удалось проверить бронь — попробуйте позже.' }, { status: 503 });
  }
  if (own === 'denied') {
    return NextResponse.json({ success: false, error: 'Бронь не найдена' }, { status: 404 });
  }
  return null;
}

async function summary(bookingId: string) {
  const [payments, priceRes] = await Promise.all([
    listDirectPayments(bookingId),
    pool.query<{ final_price: string | null }>(
      `SELECT final_price FROM operator_bookings WHERE id = $1::bigint`, [bookingId],
    ),
  ]);
  const raw = priceRes.rows[0]?.final_price;
  const finalPrice = raw == null ? null : Number(raw);
  const paid = directPaidTotal(payments);
  return { payments, paid, final_price: finalPrice, remaining: directRemaining(finalPrice, paid) };
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperatorOwner(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;
  const gate = await ownershipGate(id, auth.userId);
  if (gate) return gate;
  try {
    return NextResponse.json({ success: true, data: await summary(id) });
  } catch (err) {
    return dbFailure('чтение', err);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperatorOwner(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const parsed = AddSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }
  const { amount, method, received_on: receivedOn } = parsed.data;
  if (!isRealDate(receivedOn)) {
    return NextResponse.json({ success: false, error: 'Такой даты нет в календаре' }, { status: 400 });
  }
  // Получено — это прошлое: дата позже сегодняшней по Камчатке — опечатка.
  if (receivedOn > kamchatkaToday()) {
    return NextResponse.json({ success: false, error: 'Дата получения не может быть в будущем' }, { status: 400 });
  }

  const gate = await ownershipGate(id, auth.userId);
  if (gate) return gate;

  try {
    const row = await addDirectPayment({
      bookingId: id, amount, method, receivedOn, note: parsed.data.note || null, userId: auth.userId,
    });
    // В ленту клиента — сумма и способ, без примечания: туда может попасть ПД.
    await recordSourceEventQuietly({
      kind: 'change', sourceKind: 'operator_booking', sourceId: id,
      actorKind: 'partner_user', actorUserId: auth.userId,
      title: `Оплата напрямую: ${rub(amount)} ${DIRECT_PAYMENT_METHOD_LABELS[method]}`,
      payload: { amount, method, received_on: receivedOn },
    });
    return NextResponse.json({ success: true, data: { payment: row, ...(await summary(id)) } }, { status: 201 });
  } catch (err) {
    return dbFailure('запись', err);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireOperatorOwner(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await params;

  const parsed = VoidSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message ?? 'Неверные данные' }, { status: 400 });
  }

  const gate = await ownershipGate(id, auth.userId);
  if (gate) return gate;

  try {
    const row = await voidDirectPayment(id, parsed.data.payment_id, parsed.data.reason, auth.userId);
    if (!row) {
      return NextResponse.json({ success: false, error: 'Запись не найдена или уже аннулирована' }, { status: 404 });
    }
    await recordSourceEventQuietly({
      kind: 'change', sourceKind: 'operator_booking', sourceId: id,
      actorKind: 'partner_user', actorUserId: auth.userId,
      title: `Оплата напрямую аннулирована: ${rub(row.amount)} ${DIRECT_PAYMENT_METHOD_LABELS[row.method]}`,
      payload: { amount: row.amount, method: row.method, received_on: row.received_on },
    });
    return NextResponse.json({ success: true, data: { payment: row, ...(await summary(id)) } });
  } catch (err) {
    return dbFailure('аннулирование', err);
  }
}
