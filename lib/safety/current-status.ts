/**
 * Обстановка по краю прямо сейчас — один источник на всех потребителей.
 *
 * Читают: главная (`/api/public/safety-status` → плитка «Обстановка в крае»),
 * карточка тура и MCP-инструмент `safety_status` для внешних агентов.
 *
 * Про `null`. Функция возвращает его, когда СПРОСИТЬ НЕ УДАЛОСЬ, и это не то
 * же самое, что «тревог нет». Публичный эндпоинт исторически на ошибке отдаёт
 * «спокойно» — для плитки на главной это терпимо (пустая плитка не пугает), но
 * внешнему агенту такой ответ прямо опасен: он спросит «безопасно ли сейчас на
 * Камчатке», получит «спокойно» и передаст это человеку, который поедет. Тут
 * разница между «мы знаем, что тихо» и «мы не знаем» — это разница между
 * информацией и выдумкой, поэтому она поднята в тип.
 */

import { query } from '@/lib/database';

export interface CurrentSafetyStatus {
  hasAlert: boolean;
  maxSeverity: number;
  activeCount: number;
  topTitle: string | null;
  topType: string | null;
  /** Когда последний раз обновлялись реалтайм-данные точек. */
  dataUpdatedAt: string | null;
  source: string;
}

export const SAFETY_SOURCE = 'КБГС РАН';

/** `null` — данные недоступны. Не путать с «тревог нет». */
export async function getCurrentSafetyStatus(): Promise<CurrentSafetyStatus | null> {
  try {
    const [alertsResult, ingestResult] = await Promise.all([
      query<{
        max_severity: string;
        active_count: string;
        top_title: string | null;
        top_type: string | null;
      }>(`
        SELECT
          COALESCE(MAX(severity), 0)::text           AS max_severity,
          COUNT(*)::text                             AS active_count,
          (SELECT title FROM external_alerts
           WHERE expires_at > NOW()
           ORDER BY severity DESC, created_at DESC
           LIMIT 1)                                 AS top_title,
          (SELECT alert_type FROM external_alerts
           WHERE expires_at > NOW()
           ORDER BY severity DESC, created_at DESC
           LIMIT 1)                                 AS top_type
        FROM external_alerts
        WHERE expires_at > NOW()
      `),
      // Время последнего запуска ingest-крона — маркер свежести данных
      query<{ last_update: string | null }>(`
        SELECT MAX(updated_at)::text AS last_update FROM location_real_time_status
      `),
    ]);

    const row = alertsResult.rows[0];
    const activeCount = parseInt(row?.active_count ?? '0');

    return {
      hasAlert: activeCount > 0,
      maxSeverity: parseInt(row?.max_severity ?? '0'),
      activeCount,
      topTitle: row?.top_title ?? null,
      topType: row?.top_type ?? null,
      dataUpdatedAt: ingestResult.rows[0]?.last_update ?? null,
      source: SAFETY_SOURCE,
    };
  } catch {
    return null;
  }
}

/**
 * Текст для внешнего агента. Отдельно от формы для UI: агент передаёт ответ
 * человеку словами, и «данных нет» обязано звучать как «данных нет».
 */
export function formatSafetyStatusForAgent(status: CurrentSafetyStatus | null): string {
  if (!status) {
    return 'Данных об обстановке сейчас нет — источник недоступен. Это НЕ означает, что опасности нет: проверьте оперативную информацию МЧС Камчатского края (телефон 112).';
  }

  const lines: string[] = [];
  lines.push(
    status.hasAlert
      ? `Активных предупреждений по Камчатскому краю: ${status.activeCount} (максимальная тяжесть ${status.maxSeverity} из 5).`
      : 'Активных предупреждений по Камчатскому краю нет.',
  );
  if (status.topTitle) {
    lines.push(`Наиболее значимое: ${status.topTitle}${status.topType ? ` (${status.topType})` : ''}.`);
  }
  if (status.dataUpdatedAt) {
    lines.push(`Данные обновлены: ${status.dataUpdatedAt}.`);
  }
  lines.push(`Источник: ${status.source}.`);
  lines.push(
    'Это обстановка по краю целиком, а не оценка конкретного маршрута: по месту спрашивайте get_guardian_context. Экстренный телефон — 112.',
  );
  return lines.join('\n');
}
