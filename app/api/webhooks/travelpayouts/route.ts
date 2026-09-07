/**
 * POST /api/webhooks/travelpayouts
 * Receive payout confirmations from TravelPayouts
 * Validates with X-Access-Token header
 */

import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db-pool';
import { z } from 'zod';
import { timingSafeCompare } from '@/lib/security/timing-safe';

const TP_WEBHOOK_TOKEN = process.env.TRAVELPAYOUTS_WEBHOOK_TOKEN || '';

const PayoutSchema = z.object({
  click_id: z.string().max(100).optional(),
  partner: z.string().max(50).optional(),
  currency: z.string().max(3).default('USD'),
  revenue: z.number().optional(),
  commission: z.number(),
  status: z.enum(['approved', 'pending', 'declined']),
  timestamp: z.string().optional(),
});

export async function POST(request: NextRequest) {
  // Сравнение по постоянному времени (разбор периметра 07.09). Было `!==`:
  // обычное сравнение строк выходит на первом несовпавшем байте, и токен
  // подбирается побайтно по времени ответа. Здесь это дорого не абстрактно —
  // ниже INSERT в affiliate_payouts, то есть подделанный запрос заводит нам
  // строку о выплате.
  //
  // Токена нет — отказ, а не пропуск: приём выплат без проверки хуже
  // отсутствия приёма. Отдельная переменная, не общая с кроном.
  if (!TP_WEBHOOK_TOKEN || !timingSafeCompare(request.headers.get('X-Access-Token'), TP_WEBHOOK_TOKEN)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const parsed = PayoutSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid payload', details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const data = parsed.data;

    // Store all events, not just approved (for reconciliation).
    //
    // Идемпотентность (миграция 921): дедуп по (tp_click_id, status) —
    // только когда click_id есть в payload. TravelPayouts не гарантирует
    // click_id и не даёт отдельный event-id, поэтому событие без click_id
    // дедуплицировать из самого payload нечем (§4.0 — ограничение
    // источника, названо явно, не скрыто).
    const { rowCount } = await pool.query(
      `INSERT INTO affiliate_payouts (partner, amount, currency, status, tp_click_id, received_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (tp_click_id, status) WHERE tp_click_id IS NOT NULL DO NOTHING`,
      [data.partner || 'unknown', data.commission, data.currency, data.status, data.click_id || null]
    );

    return NextResponse.json({ success: true, stored: (rowCount ?? 0) > 0 });
  } catch {
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
