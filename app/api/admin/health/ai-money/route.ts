/**
 * GET /api/admin/health/ai-money
 *
 * Деньги на ИИ одним взглядом (запрос владельца 18.09): остаток у провайдеров
 * и расход по каждой модели за 1 / 7 / 30 дней.
 *
 * Баланс — свойство счёта провайдера, расход — наш `llm_usage_log`; поэтому
 * два списка, а не один. Запросы балансов токенов не тратят (это не проба
 * модели), так что карточка читает роут при открытии страницы.
 *
 * Отказ каждой части — свой: балансы не спросились → массив с failed по
 * каждому, лог не прочитался → 500 с причиной. «Не смог» не выдаётся за
 * «денег нет» (§4.0).
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { collectProviderBalances } from '@/lib/ai/balances';
import { loadModelSpend } from '@/lib/ai/model-spend';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const [balances, spend] = await Promise.all([collectProviderBalances(), loadModelSpend()]);
    return NextResponse.json({
      success: true,
      data: { balances, spend, checked_at: new Date().toISOString() },
    });
  } catch (err) {
    console.error('[health/ai-money]', err instanceof Error ? err.message : err);
    return NextResponse.json(
      { success: false, error: 'Не удалось собрать деньги на ИИ', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
