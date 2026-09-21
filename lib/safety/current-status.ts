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
 *
 * Про `source`. До 17.09 это была константа «КБГС РАН» на любой ответ, при
 * том что таблицу кормят пять лент, и верхней тревогой в момент проверки был
 * паводок от МЧС. Теперь источник — происхождение ВЕРХНЕЙ тревоги, выведенное
 * из её `external_id` (`lib/safety/alert-origin.ts`); тревог нет — ленты
 * перечислены как есть; происхождение не узнано — так и сказано.
 */

import { query } from '@/lib/database';
import { alertOrigin, SAFETY_FEEDS, UNKNOWN_ORIGIN_TEXT } from '@/lib/safety/alert-origin';
import { RESOLUTION_SQL_PATTERN } from '@/lib/safety/resolution-notice';

export interface CurrentSafetyStatus {
  hasAlert: boolean;
  maxSeverity: number;
  activeCount: number;
  topTitle: string | null;
  topType: string | null;
  /** Когда последний раз обновлялись реалтайм-данные точек. */
  dataUpdatedAt: string | null;
  /**
   * Откуда верхняя тревога. Тревог нет — перечень лент; тревога есть, но
   * происхождение не узнано — `UNKNOWN_ORIGIN_TEXT`. Строка, а не null: её
   * показывает плитка главной и пакет офлайн-карты.
   */
  source: string;
}

/** Перечень лент одной строкой — для ответа без верхней тревоги. */
export const SAFETY_FEEDS_TEXT = SAFETY_FEEDS.join('; ');

/** `null` — данные недоступны. Не путать с «тревог нет». */
export async function getCurrentSafetyStatus(): Promise<CurrentSafetyStatus | null> {
  try {
    const [aggResult, topResult, ingestResult] = await Promise.all([
      query<{ max_severity: string; active_count: string }>(`
        SELECT
          COALESCE(MAX(severity), 0)::text AS max_severity,
          COUNT(*)::text                   AS active_count
        FROM external_alerts
        WHERE expires_at > NOW()
      `),
      // Верхняя тревога целиком, одной строкой: заголовок, тип и то, по чему
      // узнаётся её происхождение.
      //
      // Отбой («стабилизировалась паводковая обстановка») сортируется ПОСЛЕ
      // действующих тревог независимо от severity/свежести — иначе он же
      // почти всегда и побеждал: отбой приходит позже самой тревоги по
      // определению, а сегодня вся лента плоская (severity=1 у всех 13),
      // и тай-брейк `created_at DESC` отдавал строку «Наиболее значимое»
      // именно ему (issue #1984). Строка не выбрасывается — отбой остаётся
      // кандидатом, если ничего другого нет.
      query<{ title: string | null; alert_type: string | null; external_id: string | null; source_url: string | null }>(`
        SELECT title, alert_type, external_id, source_url
        FROM external_alerts
        WHERE expires_at > NOW()
        ORDER BY (title ~* $1) ASC, severity DESC, created_at DESC
        LIMIT 1
      `, [RESOLUTION_SQL_PATTERN]),
      // Время последнего запуска ingest-крона — маркер свежести данных
      query<{ last_update: string | null }>(`
        SELECT MAX(updated_at)::text AS last_update FROM location_real_time_status
      `),
    ]);

    const agg = aggResult.rows[0];
    const top = topResult.rows[0] ?? null;
    const activeCount = parseInt(agg?.active_count ?? '0');

    return {
      hasAlert: activeCount > 0,
      maxSeverity: parseInt(agg?.max_severity ?? '0'),
      activeCount,
      topTitle: top?.title ?? null,
      topType: top?.alert_type ?? null,
      dataUpdatedAt: ingestResult.rows[0]?.last_update ?? null,
      source: top
        ? (alertOrigin(top.external_id, top.source_url)?.label ?? UNKNOWN_ORIGIN_TEXT)
        : SAFETY_FEEDS_TEXT,
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
    // Источник — у верхней тревоги, а не у ответа: разные тревоги приходят
    // из разных лент, и подпись обязана принадлежать той, что названа.
    lines.push(`Источник этого предупреждения: ${status.source}.`);
  } else {
    lines.push(`Ленты, по которым собирается обстановка: ${status.source}.`);
  }
  if (status.dataUpdatedAt) {
    lines.push(`Данные обновлены: ${status.dataUpdatedAt}.`);
  }
  lines.push(
    'Это обстановка по краю целиком, а не оценка конкретного маршрута: по месту спрашивайте get_guardian_context. Экстренный телефон — 112.',
  );
  return lines.join('\n');
}
