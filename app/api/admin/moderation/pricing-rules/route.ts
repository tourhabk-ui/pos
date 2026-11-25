/**
 * GET /api/admin/moderation/pricing-rules — скидки и наценки туров, которые
 * ждут проверки, и просьбы снять действующее правило (миграция 1513).
 *
 * Слово владельца 23.11: «Наценки тоже показываются в модерации: цена тура
 * меняется только через одну дверь».
 *
 * В списке нет телефона и почты: администратору нужны владелец, тур, само
 * правило и то, как оно меняет цену. Пустой список — проверять нечего, отказ
 * базы — 503, не пустота.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { listPendingPricingRules } from '@/lib/tours/pricing-rule-review';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authOrResponse = await requireAdmin(request);
  if (authOrResponse instanceof NextResponse) return authOrResponse;

  const listed = await listPendingPricingRules();
  if (listed.outcome === 'db_error') {
    return NextResponse.json({ success: false, error: 'Не смог прочитать скидки и наценки на проверке' }, { status: 503 });
  }
  return NextResponse.json({ success: true, data: { rules: listed.rules } });
}
