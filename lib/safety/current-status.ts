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

import { isoUtcSql, utcWallIsoSql } from '@/lib/db/timestamp-iso';
import { query } from '@/lib/database';
import { alertOrigin, SAFETY_FEEDS, UNKNOWN_ORIGIN_TEXT } from '@/lib/safety/alert-origin';
import { basisLine, basisOf, type AlertBasis } from '@/lib/safety/alert-basis';
import { RESOLUTION_SQL_PATTERN } from '@/lib/safety/resolution-notice';
import { alertDayLabel } from '@/lib/safety/alert-dates';
import { FEED_ALERT_TYPES, isFeedAlertType } from '@/lib/services/safety/feed-types';

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
  /**
   * Основание каждого пункта ленты (приказ, распоряжение) — тем же порядком,
   * что feedTitles; null у пункта — основания не нашли (10.10). Optional:
   * старые места, собирающие статус руками, его не знают.
   */
  feedBasis?: (AlertBasis | null)[] | null;
  /**
   * Когда пункт ленты появился и до какого срока он в ленте — тем же
   * порядком, что feedTitles (#2495, 15.10). Без этого «Вилючинский перевал:
   * проезд по пропускам с 15 июля» в октябре читался как свежее
   * предупреждение, а «дорога перекрыта» — без единой даты. `manual` — запись
   * внесена руками (`manual-…`): её `expires_at` ставят на годы вперёд, когда
   * окончание не объявлено. Optional: старые места его не знают.
   */
  feedWhen?: (FeedWhen | null)[] | null;
  /**
   * Что входит в общее число, но не в ленту туриста (#2495): типы вне ленты
   * со счётом и повторы одной темы (лента — одна строка на заголовок).
   * Ответ называл «7 активных, меняют решение 5» и пять строк — две записи
   * оставались невидимыми, и это читалось как обрезанный список. `null` — не
   * смогли посчитать.
   */
  outsideFeed?: OutsideFeed | null;
}

export interface FeedWhen {
  /** Когда запись появилась (ISO, UTC). */
  createdAt: string | null;
  /** До какого момента запись держится в ленте (ISO, UTC). */
  expiresAt: string | null;
  manual: boolean;
}

export interface OutsideFeed {
  byType: Array<{ type: string | null; count: number }>;
  /** Сколько записей ленты повторяют уже названный заголовок. */
  repeats: number;
}

/** Типы вне ленты словами — для строки «остальные N». */
const OUTSIDE_FEED_WORDS: Record<string, string> = {
  earthquake: 'землетрясения',
  seismic_bulletin: 'сейсмические сводки',
  info: 'сводки и сообщения',
  fire_danger: 'класс пожарной опасности',
};

function outsideFeedWord(type: string | null): string {
  if (!type) return 'без типа';
  return OUTSIDE_FEED_WORDS[type] ?? type;
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
        SELECT ${isoUtcSql('MAX(updated_at)')} AS last_update FROM location_real_time_status
      `),
    ]);

    // Лента — отдельным запросом со своим отказом: не смогли её прочитать —
    // общее число всё равно верно, и обнулять ответ целиком незачем. Условие и
    // порядок те же, что у ленты сайта (app/_home/data.ts, fetchSafety).
    let feedCount: number | null = null;
    let feedTitles: string[] | null = null;
    let feedBasis: (AlertBasis | null)[] | null = null;
    let feedWhen: (FeedWhen | null)[] | null = null;
    try {
      const feed = await query<{
        title: string; basis_title: string | null; basis_url: string | null; basis_origin: string | null;
        created_utc_iso: string | null; created_session_iso: string | null; expires_iso: string | null;
        external_id: string | null; source_url: string | null;
      }>(`
        SELECT title, basis_title, basis_url, basis_origin, external_id, source_url,
               ${utcWallIsoSql('created_at')} AS created_utc_iso, ${isoUtcSql('created_at')} AS created_session_iso,
               ${utcWallIsoSql('expires_at')} AS expires_iso FROM (
          SELECT DISTINCT ON (lower(title)) title, severity::int AS severity, created_at, expires_at,
                 external_id, source_url,
                 basis_title, basis_url, basis_origin
            FROM external_alerts
           WHERE expires_at > NOW()
             AND alert_type = ANY($1::text[])
           ORDER BY lower(title), severity DESC, created_at DESC
        ) t
        ORDER BY severity DESC, created_at DESC
      `, [[...FEED_ALERT_TYPES]]);
      feedCount = feed.rows.length;
      feedTitles = feed.rows.slice(0, AGENT_FEED_TITLES_LIMIT).map((r) => r.title);
      feedBasis = feed.rows.slice(0, AGENT_FEED_TITLES_LIMIT).map((r) => basisOf(r));
      feedWhen = feed.rows.slice(0, AGENT_FEED_TITLES_LIMIT).map((r) => {
        const manual = alertOrigin(r.external_id, r.source_url)?.key === 'manual';
        // Стенное время в колонке пишут по-разному: ингест — датой JS с
        // сервера в UTC, ручные записи (миграции 718/729, админка) — через
        // NOW(), то есть в поясе сессии (+03 на проде). Прочесть их одним
        // правилом — сдвинуть одну из двух групп на три часа: Вилючинский
        // перевал (13:23 МСК 7 июля) стал бы «внесено 8 июля». Срок у обеих
        // групп — стенное время UTC (дата JS или литерал без пояса).
        return {
          createdAt: manual ? r.created_session_iso : r.created_utc_iso,
          expiresAt: r.expires_iso,
          manual,
        };
      });
    } catch (err) {
      console.error('[current-status] лента предупреждений не прочитана:', err instanceof Error ? err.message : err);
    }

    // Что входит в общее число, но не в ленту (#2495) — своим отказом, как и
    // лента: не посчитали остаток — общее число всё равно верно.
    let outsideFeed: OutsideFeed | null = null;
    try {
      const byType = await query<{ alert_type: string | null; n: number }>(`
        SELECT alert_type, COUNT(*)::int AS n
          FROM external_alerts
         WHERE expires_at > NOW()
         GROUP BY alert_type
         ORDER BY n DESC, alert_type
      `);
      const feedRows = byType.rows
        .filter((r) => isFeedAlertType(r.alert_type))
        .reduce((s, r) => s + r.n, 0);
      outsideFeed = {
        byType: byType.rows
          .filter((r) => !isFeedAlertType(r.alert_type))
          .map((r) => ({ type: r.alert_type, count: r.n })),
        repeats: feedCount === null ? 0 : Math.max(0, feedRows - feedCount),
      };
    } catch (err) {
      console.error('[current-status] остаток вне ленты не посчитан:', err instanceof Error ? err.message : err);
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
      feedBasis,
      feedWhen,
      outsideFeed,
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
 * Подробность пункта ленты: когда появился и до какого числа стоит в ленте
 * (#2495). Ручная запись называется ручной. Срок — «в ленте до», а не
 * «действует до»: это окно платформы, а не объявленное окончание (разбор —
 * lib/safety/alert-dates).
 */
export function feedWhenLine(when: FeedWhen | null | undefined, nowMs: number = Date.now()): string | null {
  if (!when) return null;
  const day = alertDayLabel(when.createdAt, nowMs);
  const origin = when.manual ? 'внесено вручную' : 'опубликовано';
  const since = day ? `${origin} ${day}` : `${origin}, дата не записана`;
  const until = alertDayLabel(when.expiresAt, nowMs);
  return `${since}; ${until ? `в ленте до ${until}` : 'срок в ленте не записан'}`;
}

/**
 * «Остальные N — вне ленты туриста: …» (#2495). Общее число и лента
 * считаются по-разному, и разница обязана быть названа: иначе две записи из
 * семи выглядят обрезанными, а не отобранными.
 */
export function outsideFeedLine(status: CurrentSafetyStatus): string | null {
  if (status.feedCount === null) return null;
  const rest = status.activeCount - status.feedCount;
  if (rest <= 0) return null;
  const o = status.outsideFeed;
  if (!o) return `Остальные ${rest} — вне ленты туриста; разбивку по типам посчитать не удалось.`;
  const parts = o.byType.map((t) => `${outsideFeedWord(t.type)} — ${t.count}`);
  if (o.repeats > 0) parts.push(`повторы уже названной темы — ${o.repeats}`);
  return `Остальные ${rest} — вне ленты туриста${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.`;
}

/** Вулканы в ответе: строки сводок, а не прочитать не смогли — так и сказано. */
function volcanoBlock(volcanoes: string[] | null | undefined): string[] {
  if (volcanoes === undefined) return [];
  if (volcanoes === null) {
    return ['Вулканы: сводки KVERT и КФ ЕГС прочитать не удалось — это не «спокойно»; по вулканам спросите get_volcano_status.'];
  }
  return volcanoes;
}

/**
 * Текст для внешнего агента. Отдельно от формы для UI: агент передаёт ответ
 * человеку словами, и «данных нет» обязано звучать как «данных нет».
 *
 * `volcanoes` — строки вулканов (KVERT, КФ ЕГС) от `volcanoLinesForSafetyStatus`
 * (#2495: оранжевый Шивелуч красил место в красный, а в краевой ленте его не
 * было — общий статус по краю недооценивал обстановку). `null` — сводки не
 * прочитаны; не передан — блока нет.
 */
export function formatSafetyStatusForAgent(
  status: CurrentSafetyStatus | null,
  volcanoes?: string[] | null,
  nowMs: number = Date.now(),
): string {
  if (!status) {
    return [
      'Данных об обстановке сейчас нет — источник недоступен. Это НЕ означает, что опасности нет: проверьте оперативную информацию МЧС Камчатского края (телефон 112).',
      ...volcanoBlock(volcanoes),
    ].join('\n');
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
    const rest = outsideFeedLine(status);
    if (rest) lines.push(rest);
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
    status.feedTitles.forEach((t, i) => {
      lines.push(`- ${t}`);
      // Когда появилось и до какого срока — строкой под пунктом (#2495):
      // летнее объявление без даты читалось как сегодняшнее.
      const when = feedWhenLine(status.feedWhen?.[i] ?? null, nowMs);
      if (when) lines.push(`  ${when}`);
      // Основание — документом, а не пересказом: агент обязан различать
      // «внесено вручную» и «распознано со снимка» и так и передать человеку.
      const basis = basisLine(status.feedBasis?.[i] ?? null);
      if (basis) lines.push(`  ${basis}`);
    });
    if (status.feedCount !== null && status.feedCount > status.feedTitles.length) {
      lines.push(`…и ещё ${status.feedCount - status.feedTitles.length}.`);
    }
  }
  lines.push(...volcanoBlock(volcanoes));
  if (status.dataUpdatedAt) {
    lines.push(`Данные обновлены: ${status.dataUpdatedAt}.`);
  }
  lines.push(
    'Это обстановка по краю целиком, а не оценка конкретного маршрута: по месту спрашивайте get_guardian_context. Экстренный телефон — 112.',
  );
  return lines.join('\n');
}
