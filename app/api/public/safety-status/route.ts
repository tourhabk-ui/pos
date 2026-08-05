import { NextResponse } from 'next/server';
import { getCurrentSafetyStatus, SAFETY_SOURCE } from '@/lib/safety/current-status';

/**
 * GET /api/public/safety-status
 * Public endpoint — текущий уровень опасности для главной страницы
 * Возвращает минимум данных, без деталей (ПД не передаются)
 *
 * Запрос живёт в lib/safety/current-status.ts: тот же ответ нужен MCP-инстру-
 * менту safety_status для внешних агентов, и держать два одинаковых SQL —
 * значит однажды поправить один. Форма ответа здесь не менялась: главная
 * читает её как раньше.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const status = await getCurrentSafetyStatus();

  // Источник недоступен. Для плитки на главной отдаём спокойное состояние —
  // так было и раньше. Внешним агентам недоступность передаётся честно, там
  // цена ошибки другая (см. formatSafetyStatusForAgent).
  if (!status) {
    return NextResponse.json({
      success: true,
      data: {
        hasAlert: false,
        maxSeverity: 0,
        activeCount: 0,
        topTitle: null,
        topType: null,
        dataUpdatedAt: null,
        source: SAFETY_SOURCE,
      },
    });
  }

  return NextResponse.json({ success: true, data: status });
}
