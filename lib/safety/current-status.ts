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
import { FEED_ALERT_TYPES } from '@/lib/services/safety/feed-types';

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
  /**
   * Сколько из активных предупреждений меняют решение туриста сегодня — те же
   * типы, что показывает лента сайта (`FEED_ALERT_TYPES`), одна тема — одна
   * строка. `null` — не смогли посчитать (это не «ноль»): активные считаются
   * ВСЕ типы, лента сайта — только эти, и без разбивки «14 против 5» читалось
   * как расхождение двух каналов (сверка 29.09).
   */
  feedCount: number | null;
  /** Заголовки этих предупреждений в порядке ленты сайта; `null` — не смогли прочитать. */
  feedTitles: string[] | null;
}

/** Сколько заголовков лент MCP называет: столько же, сколько видно на сайте, с запасом. */
export const AGENT_FEED_TITLES_LIMIT = 8;

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

    // Лента — отдельным запросом со своим отказом: не смогли её прочитать —
    // общее число всё равно верно, и обнулять ответ целиком незачем. Условие и
    // порядок те же, что у ленты сайта (app/_home/data.ts, fetchSafety).
    let feedCount: number | null = null;
    let feedTitles: string[] | null = null;
    try {
      const feed = await query<{ title: string }>(`
        SELECT title FROM (
          SELECT DISTINCT ON (lower(title)) title, severity::int AS severity, created_at
            FROM external_alerts
           WHERE expires_at > NOW()
             AND alert_type = ANY($1::text[])
           ORDER BY lower(title), severity DESC, created_at DESC
        ) t
        ORDER BY severity DESC, created_at DESC
      `, [[...FEED_ALERT_TYPES]]);
      feedCount = feed.rows.length;
      feedTitles = feed.rows.slice(0, AGENT_FEED_TITLES_LIMIT).map((r) => r.title);
    } catch (err) {
      console.error('[current-status] лента предупреждений не прочитана:', err instanceof Error ? err.message : err);
    }

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
      feedCount,
      feedTitles,
    };
  } catch (err) {
    // null — честное «не знаю» для вызывающего, но отказ чтения виден в логе (§4.0).
    console.error('[current-status] статус не прочитан:', err instanceof Error ? err.message : err);
    return null;
  }
}

// Шкала тяжести словами — lib/safety/severity-words (одна на сервер и экран).
import { ALERT_SEVERITY_WORDS, alertSeverityWord } from '@/lib/safety/severity-words';
export { ALERT_SEVERITY_WORDS, alertSeverityWord };

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
      ? `Активных предупреждений по Камчатскому краю: ${status.activeCount} (наивысший уровень — «${alertSeverityWord(status.maxSeverity)}», ${status.maxSeverity} по шкале 0–${ALERT_SEVERITY_WORDS.length - 1}).`
      : 'Активных предупреждений по Камчатскому краю нет.',
  );
  // Разбивка: общее число включает и то, что решения туриста не меняет.
  // Без неё внешний агент читал «14» как «14 опасностей» и расходился с
  // лентой сайта, где их пять (сверка каналов 29.09).
  if (status.feedCount !== null) {
    lines.push(`Из них меняют решение туриста сегодня (закрытия, вулканы, стихии, погода, медведи): ${status.feedCount}.`);
  }
  if (status.topTitle) {
    lines.push(`Наиболее значимое: ${status.topTitle}${status.topType ? ` (${status.topType})` : ''}.`);
    // Источник — у верхней тревоги, а не у ответа: разные тревоги приходят
    // из разных лент, и подпись обязана принадлежать той, что названа.
    lines.push(`Источник этого предупреждения: ${status.source}.`);
  } else {
    lines.push(`Ленты, по которым собирается обстановка: ${status.source}.`);
  }
  if (status.feedTitles && status.feedTitles.length > 0) {
    lines.push('Лента предупреждений (как на сайте):');
    for (const t of status.feedTitles) lines.push(`- ${t}`);
    if (status.feedCount !== null && status.feedCount > status.feedTitles.length) {
      lines.push(`…и ещё ${status.feedCount - status.feedTitles.length}.`);
    }
  }
  if (status.dataUpdatedAt) {
    lines.push(`Данные обновлены: ${status.dataUpdatedAt}.`);
  }
  lines.push(
    'Это обстановка по краю целиком, а не оценка конкретного маршрута: по месту спрашивайте get_guardian_context. Экстренный телефон — 112.',
  );
  return lines.join('\n');
}
