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

  // Источник недоступен. Раньше здесь отдавалось «спокойно» (hasAlert:false)
  // без каких-либо признаков недоступности — и «мы не знаем» было неотличимо
  // от «мы знаем, что тихо». Для полевого контура это ловушка: по этому
  // ответу человек решает выходить. Форма сохранена (старые потребители
  // не ломаются), но добавлен флаг unavailable — потребители обязаны на него
  // смотреть и не рисовать спокойное состояние из отсутствия данных.
  if (!status) {
    return NextResponse.json({
      success: true,
      data: {
        unavailable: true,
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
