/**
 * GET /api/admin/health/ai-providers
 *
 * Преполётная проверка провайдеров ИИ: каждый получает короткий реальный
 * запрос, ответ фиксируется вместе с HTTP-кодом и задержкой; рядом —
 * остаток OpenRouter числом.
 *
 * Зачем отдельный вход, а не метрика на дашборде. Проба ЗОВЁТ провайдеров и
 * тратит их квоту — она действие, а не число, и не должна выполняться при
 * каждом открытии страницы. Поэтому карточка на дашборде запрашивает этот
 * маршрут по кнопке.
 *
 * Зачем вообще. `preflightProviders()` была написана и не имела ни одного
 * вызова, а причину немоты разбора находок четверо суток вычитывали из тела
 * чужой ошибки — из обрывка «credit balance is too low» внутри HTTP 400 от
 * постороннего провайдера. Спросить прямо было нечем, хотя код для этого
 * лежал в репозитории.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth/middleware';
import { preflightProviders } from '@/lib/ai/providers';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  try {
    const preflight = await preflightProviders();
    return NextResponse.json({ success: true, data: preflight });
  } catch (error) {
    // Отказ самой пробы — третий исход, не «все провайдеры мертвы»: молчать
    // о нём значит показать администратору спокойный экран при сломанной
    // проверке.
    return NextResponse.json(
      {
        success: false,
        error: 'Преполётная проверка не выполнилась',
        detail: error instanceof Error ? error.message : String(error),
      },
      { status: 500 },
    );
  }
}
