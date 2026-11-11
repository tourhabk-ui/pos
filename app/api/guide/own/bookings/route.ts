/**
 * POST /api/guide/own/bookings — гид-продавец записывает бронь своего тура
 * сам: по звонку (без заявки) или из заявки, адресованной ему (#3211, слово
 * владельца 10.11). Правило то же, что у ручной брони оператора
 * (lib/bookings/manual-booking): тур только свой, цена тура или своя, общая
 * вставка без гейта мест, бронь из заявки — «Договорились» той же
 * транзакцией, клиент — в CRM.
 *
 * Что здесь иначе, чем у оператора, — и почему:
 *  - заявка только адресованная гиду: ничейную гид не видит и не занимает,
 *    чужая неотличима от несуществующей (404), как у отметки заявки;
 *  - бронь записывается подтверждённой: гид записывает то, о чём уже
 *    договорился сам, — «новая» висела бы во «Входящих» ждать его же ответа;
 *  - оплаты здесь нет: ни способа, ни отметки «оплачено» — деньги и отметка
 *    оплаты напрямую живут своими путями (lib/bookings/direct-payments);
 *  - уведомлений нет: гид сам завёл бронь, сообщать ему о ней нечего.
 *    Кнопка в MAX/Telegram — отдельной задачей.
 * Контакты туриста — только в ответе самому гиду; в лог они не пишутся.
 */
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireRole } from '@/lib/auth/middleware';
import { getGuidePartnerId } from '@/lib/auth/guide-helpers';
import { createManualBooking } from '@/lib/bookings/manual-booking';
import { leadScopeCond } from '@/lib/leads/ownership';

export const dynamic = 'force-dynamic';

const optionalText = (max: number, what: string) => z.string().trim().max(max, `${what} длиннее ${max} знаков`).optional()
  .transform((v) => (v ? v : undefined));

const BodySchema = z.object({
  operator_tour_id: z.coerce.number().int().positive('Выберите тур'),
  booking_date: z.string().date('Дата поездки — в виде ГГГГ-ММ-ДД'),
  participants: z.coerce.number().int('Число человек — целое').min(1, 'Хотя бы один человек').max(100, 'Не больше 100 человек в одной брони'),
  tourist_name: optionalText(255, 'Имя'),
  tourist_phone: optionalText(20, 'Телефон'),
  tourist_email: z.string().trim().max(255).email('Почта не похожа на адрес').optional().or(z.literal('').transform(() => undefined)),
  final_price: z.coerce.number().nonnegative('Цена не может быть меньше нуля').optional(),
  special_requests: optionalText(1000, 'Пожелания'),
  lead_id: z.string().uuid('Неверный номер заявки').optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireRole(request, ['guide']);
  if (auth instanceof NextResponse) return auth;

  const body = BodySchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return NextResponse.json(
      { success: false, error: body.error.issues[0]?.message ?? 'Проверьте поля брони' },
      { status: 400 },
    );
  }

  const partnerId = await getGuidePartnerId(auth.userId);
  if (!partnerId) {
    return NextResponse.json({ success: false, error: 'Карточка гида не найдена' }, { status: 404 });
  }

  try {
    const outcome = await createManualBooking({
      partnerId,
      actorUserId: auth.userId,
      // Тур гида продаёт только он: свою цену брони назначает он же.
      mayEditPrice: true,
      mayMarkPaid: false,
      leadScope: async () => leadScopeCond({ kind: 'owner', partnerId, claimUnowned: false }, 2),
    }, {
      ...body.data,
      payment_status: 'pending',
      booking_status: 'confirmed',
      created_via: 'direct_contact',
    });
    if (outcome.kind === 'tour_not_found') {
      return NextResponse.json({ success: false, error: 'Тур не найден среди ваших' }, { status: 404 });
    }
    if (outcome.kind === 'lead_not_found') {
      return NextResponse.json({ success: false, error: 'Заявка не найдена среди ваших' }, { status: 404 });
    }
    if (outcome.kind !== 'ok') {
      // Гиду своя цена разрешена, «оплачено» он не передаёт: сюда не дойти.
      console.error('[guide/own/bookings] неожиданный отказ ручной брони:', outcome.kind);
      return NextResponse.json({ success: false, error: 'Бронь не записана — попробуйте ещё раз' }, { status: 503 });
    }
    return NextResponse.json(
      { success: true, data: { ...outcome.booking, id: String(outcome.booking.id), lead_id: outcome.leadId } },
      { status: 201 },
    );
  } catch (e) {
    const err = e as { code?: string };
    console.error('[guide/own/bookings] ручная бронь не записана:', `sqlstate=${err?.code ?? 'нет'}`);
    return NextResponse.json({ success: false, error: 'Бронь не записана — попробуйте ещё раз' }, { status: 503 });
  }
}
