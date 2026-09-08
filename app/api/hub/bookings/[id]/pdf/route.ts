/**
 * GET /api/hub/bookings/[id]/pdf?type=contract|voucher&token=<ключ брони>
 *
 * Договор или ваучер гостевой брони. Документ содержит ТЕЛЕФОН И ПОЧТУ
 * туриста, поэтому ключ здесь обязателен и проверяется по базе.
 *
 * ── Почему сменился замок (08.09) ─────────────────────────────────────────
 *
 * Прежний `verifyPdfToken` был HMAC от номера брони и задумывался ровно как
 * защита от перебора этих номеров. Замысел разрушал соседний роут: JSON
 * подтверждения выдавал тот же токен любому анониму, назвавшему номер. То
 * есть защита от перебора вручалась перебору.
 *
 * Теперь ключ один на оба роута — `operator_bookings.access_token` (миграция
 * 943), случайный UUID, который получает только создатель брони. Отдельного
 * HMAC-токена больше нет; модуль lib/pdf/pdf-token.ts удалён вместе с его
 * запасным значением секрета `'no-secret'`, при котором токен был
 * предсказуем.
 *
 * Отказ — 404, а не 403: существование брони с этим номером не
 * подтверждается.
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { generateContractPDF, type ContractData } from '@/lib/pdf/contract-generator';
import { generateVoucherPDF, type VoucherData } from '@/lib/pdf/voucher-generator';
import { bookingTokenFrom, verifyBookingAccess } from '@/lib/bookings/access';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const id    = parseInt(params.id, 10);
  const type  = req.nextUrl.searchParams.get('type') ?? 'voucher';
  const token = bookingTokenFrom(req.nextUrl, req.headers);

  if (isNaN(id) || id <= 0) {
    return NextResponse.json({ error: 'Неверный ID' }, { status: 400 });
  }
  if (type !== 'contract' && type !== 'voucher') {
    return NextResponse.json({ error: 'type должен быть contract или voucher' }, { status: 400 });
  }

  const access = await verifyBookingAccess(id, token);
  if (access.state === 'unknown') {
    return NextResponse.json(
      { error: 'Не удалось проверить доступ к брони. Попробуйте позже.' },
      { status: 503 },
    );
  }
  if (access.state === 'denied') {
    return NextResponse.json({ error: 'Документ не найден' }, { status: 404 });
  }

  try {
    const { rows } = await pool.query<{
      id: number;
      tourist_name: string;
      tourist_phone: string;
      tourist_email: string | null;
      participants: number;
      booking_date: string;
      booking_status: string;
      payment_status: string;
      final_price: string;
      paid_at: string | null;
      created_at: string;
      tour_title: string;
      tour_duration: string | null;
      tour_category: string | null;
      operator_name: string;
      operator_phone: string | null;
      operator_telegram: string | null;
      operator_email: string | null;
      operator_inn: string | null;
    }>(`
      SELECT
        b.id,
        b.tourist_name,
        b.tourist_phone,
        b.tourist_email,
        b.participants,
        b.booking_date::text,
        b.booking_status,
        b.payment_status,
        b.final_price::text,
        b.paid_at::text,
        b.created_at::text,
        t.title                                          AS tour_title,
        COALESCE(t.multi_day_count::text || ' дн.', '—')  AS tour_duration,
        t.activity_type                                   AS tour_category,
        COALESCE(p.name, u.name, u.email)               AS operator_name,
        COALESCE(p.contacts->>'phone', u.phone)         AS operator_phone,
        COALESCE(p.contacts->>'telegram', u.telegram_username) AS operator_telegram,
        COALESCE(p.contacts->>'email', u.email)         AS operator_email,
        NULL::text                                       AS operator_inn
      FROM operator_bookings b
      JOIN operator_tours t    ON t.id = b.operator_tour_id
      LEFT JOIN partners p     ON p.id = t.operator_id
      LEFT JOIN users    u     ON u.id = p.user_id
      WHERE b.id = $1
    `, [id]);

    if (!rows[0]) {
      return NextResponse.json({ error: 'Бронирование не найдено' }, { status: 404 });
    }

    const r = rows[0];
    const finalPrice = parseFloat(r.final_price ?? '0') || 0;
    const today = new Date().toISOString();

    let pdfBuffer: Buffer;
    let filename: string;

    if (type === 'contract') {
      const data: ContractData = {
        bookingId:     r.id,
        issueDate:     today,
        touristName:   r.tourist_name,
        touristPhone:  r.tourist_phone,
        touristEmail:  r.tourist_email ?? undefined,
        tourName:      r.tour_title,
        tourDate:      r.booking_date,
        tourDuration:  r.tour_duration ?? '—',
        paxCount:      r.participants,
        totalPrice:    finalPrice,
        paymentDate:   r.paid_at ?? undefined,
        paymentStatus: r.payment_status,
        operatorName:  r.operator_name,
        operatorPhone: r.operator_phone ?? undefined,
        operatorEmail: r.operator_email ?? undefined,
        operatorInn:   r.operator_inn ?? undefined,
      };
      pdfBuffer = await generateContractPDF(data);
      filename  = `tourhab-contract-${r.id}.pdf`;
    } else {
      const data: VoucherData = {
        bookingId:     r.id,
        accessToken:   token,
        issueDate:     today,
        touristName:   r.tourist_name,
        touristPhone:  r.tourist_phone,
        touristEmail:  r.tourist_email ?? undefined,
        paxCount:      r.participants,
        tourName:      r.tour_title,
        tourDate:      r.booking_date,
        tourDuration:  r.tour_duration ?? '—',
        totalPrice:    finalPrice,
        paymentStatus: r.payment_status,
        paymentDate:   r.paid_at ?? undefined,
        operatorName:  r.operator_name,
        operatorPhone: r.operator_phone ?? undefined,
        operatorTelegram: r.operator_telegram ?? undefined,
        operatorEmail: r.operator_email ?? undefined,
      };
      pdfBuffer = await generateVoucherPDF(data);
      filename  = `tourhab-voucher-${r.id}.pdf`;
    }

    // Uint8Array: с TS 5.9 Buffer не проходит в BodyInit без каста.
    return new NextResponse(new Uint8Array(pdfBuffer), {
      status: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length':      String(pdfBuffer.length),
        'Cache-Control':       'no-store',
      },
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
