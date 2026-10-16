/**
 * «Сводка дня» десктопной главной (решение владельца 30.09: десктоп — по доске
 * «Десктоп — сводка дня» из артефакта, мобильное дерево пока не трогаем).
 *
 * Своего счёта здесь нет. Обстановка, вулканы и погода — `loadSvodka`
 * (`lib/svodka/svodka.ts`): та же сводка, что утром уходит гидам и что
 * говорит Кузьмич. Строки «Что меняет план» — та же лента, что у сайта и у
 * MCP (`FEED_ALERT_TYPES`, одна тема — одна строка, тот же порядок), только
 * с полями, которых нет в `CurrentSafetyStatus`: тип, срок и происхождение.
 *
 * Третий исход (§4.0) держится на каждом поле: `null` — «не смогли узнать»,
 * пустой список — «узнали, что нет». Экран обязан различать их словами.
 */

import { unstable_cache } from 'next/cache';
import { query } from '@/lib/database';
import { FEED_ALERT_TYPES } from '@/lib/services/safety/feed-types';
import { alertOrigin, UNKNOWN_ORIGIN_TEXT } from '@/lib/safety/alert-origin';
import { alertDayLabel, alertTerm } from '@/lib/safety/alert-dates';
import { UTC_WALL_NOW_SQL, utcWallIsoSql } from '@/lib/db/timestamp-iso';
import { loadSvodka, type Svodka } from '@/lib/svodka/svodka';

/** Сколько строк «Что меняет план» на главной; остальные — по ссылке. */
export const DESK_CHANGES_LIMIT = 4;

export type ChangeKind = 'road' | 'volcano' | 'water' | 'snow' | 'weather' | 'bear' | 'park' | 'other';

export interface PlanChange {
  /** Где — часть заголовка до двоеточия или тире; null — заголовок не делится. */
  place: string | null;
  /** Что — остаток заголовка, иначе описание; не пустая строка. */
  what: string;
  kind: ChangeKind;
  /** Род тревоги словом: «дороги», «паводок». */
  kindLabel: string;
  /**
   * Подпись срока по правилу ленты (lib/safety/alert-dates, #2495):
   * «до 5 октября» — срок из источника; «в ленте до 1 января 2027 г.» — ручная
   * запись, её срок ставит человек; «сообщение от 8 октября» — срок жизни
   * записи задали мы; null — срока нет.
   */
  term: string | null;
  /** Откуда строка. Не узнали — так и сказано, не ближайшая правдоподобная лента. */
  origin: string;
}

const KIND: Record<string, { kind: ChangeKind; label: string }> = {
  road_closure: { kind: 'road', label: 'дороги' },
  volcano: { kind: 'volcano', label: 'вулкан' },
  // Не «извержение»: тем же типом идут запреты подходить к вулкану — разбор
  // МЧС и Минтура («не рекомендуется приближаться», «риск обвалов») и ручная
  // запись сводки (1298). Мутновский по KVERT зелёный, и подпись «извержение»
  // у его записи была бы неправдой. Об извержении скажет сам заголовок.
  volcanic_eruption: { kind: 'volcano', label: 'вулкан' },
  ash_cloud: { kind: 'volcano', label: 'пепел' },
  tsunami_warning: { kind: 'water', label: 'цунами' },
  flood: { kind: 'water', label: 'паводок' },
  avalanche: { kind: 'snow', label: 'лавины' },
  landslide: { kind: 'other', label: 'оползни' },
  weather: { kind: 'weather', label: 'погода' },
  bear: { kind: 'bear', label: 'медведи' },
  park_closure: { kind: 'park', label: 'парк закрыт' },
  warning_test: { kind: 'other', label: 'проверка сирен' },
};

/** «Халактырский пляж: дорога перекрыта» → место и суть; не делится — всё сутью. */
export function splitAlertTitle(title: string, description: string | null): { place: string | null; what: string } {
  const t = title.trim();
  const m = t.match(/^(.{3,60}?)(?::\s+|\s+[—–]\s+)(.{3,})$/);
  if (m) return { place: m[1].trim(), what: m[2].trim() };
  const d = description?.trim();
  // Описание добавляем, только если оно не повторяет заголовок.
  return d && !d.toLowerCase().startsWith(t.toLowerCase().slice(0, 30))
    ? { place: t, what: d.length > 140 ? `${d.slice(0, 139).trimEnd()}…` : d }
    : { place: null, what: t };
}

/**
 * Подпись срока строки «Что меняет план». Правило — общее с лентой сайта и MCP
 * (`alertTerm`): прежняя подпись «до 1 января» у пропусков на Вилючинский
 * перевал выдавала заглушку ручной записи за окончание ограничения, а неделю
 * жизни записи ингеста — за срок дорожного закрытия.
 */
export function planChangeTerm(at: string | null, until: string | null, manual: boolean, nowMs: number = Date.now()): string | null {
  switch (alertTerm({ at, until, manual })) {
    case 'feed_window': {
      const day = alertDayLabel(until, nowMs);
      return day ? `в ленте до ${day}` : null;
    }
    case 'technical': {
      const day = alertDayLabel(at, nowMs);
      return day ? `сообщение от ${day}` : null;
    }
    case 'source': {
      const t = Date.parse(until ?? '');
      // Бессрочные записи ingest кладёт с expires_at на годы вперёд — это не срок.
      if (!Number.isFinite(t) || t - nowMs > 180 * 86_400_000) return null;
      const day = alertDayLabel(until, nowMs);
      return day ? `до ${day}` : null;
    }
    default:
      return null;
  }
}

/** Строки «Что меняет план»; null — ленту прочитать не смогли (это не «ничего»). */
export async function loadPlanChanges(limit = DESK_CHANGES_LIMIT): Promise<PlanChange[] | null> {
  try {
    const r = await query<{
      title: string; description: string | null; alert_type: string | null;
      created_iso: string | null; expires_iso: string | null; external_id: string | null; source_url: string | null;
    }>(`
      SELECT title, description, alert_type, external_id, source_url,
             ${utcWallIsoSql('created_at')} AS created_iso, ${utcWallIsoSql('expires_at')} AS expires_iso FROM (
        SELECT DISTINCT ON (lower(title))
               title, description, alert_type, severity::int AS severity, created_at,
               expires_at, external_id, source_url
          FROM external_alerts
         WHERE expires_at > ${UTC_WALL_NOW_SQL}
           AND alert_type = ANY($1::text[])
         ORDER BY lower(title), severity DESC, created_at DESC
      ) t
      ORDER BY severity DESC, created_at DESC
      LIMIT $2
    `, [[...FEED_ALERT_TYPES], limit]);
    return r.rows.map((row) => {
      const k = KIND[row.alert_type ?? ''] ?? { kind: 'other' as const, label: 'предупреждение' };
      const manual = alertOrigin(row.external_id, row.source_url)?.key === 'manual';
      return {
        ...splitAlertTitle(row.title, row.description),
        kind: k.kind,
        kindLabel: k.label,
        term: planChangeTerm(row.created_iso, row.expires_iso, manual),
        origin: alertOrigin(row.external_id, row.source_url)?.label ?? UNKNOWN_ORIGIN_TEXT,
      };
    });
  } catch (err) {
    console.error('[home] лента «Что меняет план» не прочитана', {
      code: (err as { code?: string })?.code, message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Сводка на пять минут: погода ходит в Open-Meteo, и ждать её на каждый
 * заход на главную незачем. Отказ источника внутри сводки уже назван полем
 * (null / reason), так что в кеш не попадает «спокойно» вместо «не знаем».
 */
const cachedSvodka = unstable_cache(async () => loadSvodka(), ['home-desk-svodka'], { revalidate: 300 });

/** Лента молчит дольше этого — «тревог нет» уже не знание, а тишина крона. */
export const INGEST_STALE_MS = 48 * 3_600_000;

export interface DeskBrief {
  /** «среда, 30 сентября» по Камчатке. */
  weekdayLabel: string;
  svodka: Svodka | null;
  changes: PlanChange[] | null;
  /**
   * Когда ingest последний раз что-то записал (MAX(created_at) по всем
   * записям, включая истёкшие); null — не записывал никогда или не прочитали.
   */
  lastIngestAt: string | null;
  /**
   * Обстановке можно верить: сводка прочитана И лента свежая. Иначе пустая
   * лента — это молчащий крон, а не спокойный день, и «предупреждений нет»
   * не рисуется (тот же порог, что был у прежнего героя).
   */
  safetyTrusted: boolean;
}

async function loadLastIngest(): Promise<string | null> {
  try {
    const r = await query<{ last_ingest: string | null }>(`SELECT MAX(created_at)::text AS last_ingest FROM external_alerts`);
    return r.rows[0]?.last_ingest ?? null;
  } catch (err) {
    console.error('[home] свежесть ленты не прочитана', {
      code: (err as { code?: string })?.code, message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Чистое правило доверия — со сторожем. */
export function isSafetyTrusted(svodka: Svodka | null, lastIngestAt: string | null, nowMs: number): boolean {
  if (!svodka?.safety || !lastIngestAt) return false;
  // Текст из PostgreSQL: «2026-09-30 07:00:00.12+00» — к ISO: T и смещение с минутами.
  const iso = lastIngestAt.trim().replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && nowMs - t <= INGEST_STALE_MS;
}

export async function loadDeskBrief(now: Date = new Date()): Promise<DeskBrief> {
  const [svodka, changes, lastIngestAt] = await Promise.all([
    cachedSvodka().catch((err: unknown) => {
      console.error('[home] сводка дня не собрана:', err instanceof Error ? err.message : err);
      return null;
    }),
    loadPlanChanges(),
    loadLastIngest(),
  ]);
  return {
    weekdayLabel: now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Kamchatka' }),
    svodka,
    changes,
    lastIngestAt,
    safetyTrusted: isSafetyTrusted(svodka, lastIngestAt, now.getTime()),
  };
}
