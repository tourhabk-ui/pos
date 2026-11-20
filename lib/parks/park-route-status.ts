/**
 * Статус «открыт / закрыт» утверждённых маршрутов природных парков (слово
 * владельца 20.11: «Статус открыт/закрыт», цвета — «Шкала как у KVERT»).
 *
 * Источник — колонка «Статус» таблиц на странице парка «Туристические
 * маршруты» (`APPROVED_ROUTES_SOURCE`). Здесь только правила без базы:
 *   — `parseParkRoutesPage` читает таблицы страницы в строки варианта
 *     (парк, название, сезон, статус). Чего правило не узнало — слово статуса,
 *     сезона, имя парка, число ячеек, — уходит в `problems`, а не в догадку;
 *   — `routeParkStatus` сводит варианты одного маршрута в один статус.
 *
 * Запись — GET /api/cron/park-route-status, чтение — collect-signals (оценка
 * дня) и lib/parks/approved-routes (карточка, Кузьмич, MCP).
 */

import { stripTags } from '@/lib/html/text';
import { decodeHtmlEntities } from '@/lib/html/entities';

/** Статус старше этого — «не проверено»: чтение могло перестать работать. */
export const PARK_STATUS_FRESH_HOURS = 72;

export type ParkRouteStatus = 'open' | 'closed';

export interface ParsedStatusRow {
  parkSlug: string;
  title: string;
  season: 'summer' | 'winter' | 'all';
  status: ParkRouteStatus;
}

export interface ParsedPage {
  rows: ParsedStatusRow[];
  problems: string[];
}

/** Таблицы на странице подписаны «Природный парк «…»». */
const PARK_BY_NAME: Record<string, string> = {
  'Налычево': 'nalychevo',
  'Быстринский': 'bystrinskiy',
  'Вилючинский': 'vilyuchinsky',
};

const SEASON_BY_WORD: Record<string, ParsedStatusRow['season']> = {
  'лето': 'summer',
  'зима': 'winter',
  'лето\\зима': 'all',
  'лето/зима': 'all',
};

const STATUS_BY_WORD: Record<string, ParkRouteStatus> = { 'открыт': 'open', 'закрыт': 'closed' };

/** Видимый текст фрагмента: общий разбор тегов и сущностей, пробелы сведены. */
function textOf(html: string): string {
  return decodeHtmlEntities(stripTags(html, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Таблицы страницы → строки варианта. Строка таблицы из семи ячеек начинает
 * маршрут (название с rowspan), из шести — продолжает предыдущий другим
 * сезоном. Строка заголовка («Название») пропускается.
 */
export function parseParkRoutesPage(html: string): ParsedPage {
  const rows: ParsedStatusRow[] = [];
  const problems: string[] = [];
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(html)) !== null) {
    const before = textOf(html.slice(0, m.index));
    const heads = [...before.matchAll(/Природный парк\s*«([^»]+)»/g)];
    const parkName = heads.length ? heads[heads.length - 1]![1]!.trim() : null;
    const tableRows = [...m[0].matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((r) =>
      [...r[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => textOf(c[1] ?? '')));
    if (tableRows.length === 0 || tableRows[0]![0] !== 'Название') continue; // не таблица маршрутов
    const parkSlug = parkName ? PARK_BY_NAME[parkName] : undefined;
    if (!parkSlug) {
      problems.push(`таблица маршрутов без известного парка: «${parkName ?? 'подписи нет'}»`);
      continue;
    }
    let title: string | null = null;
    for (const cells of tableRows.slice(1)) {
      let rest = cells;
      if (cells.length === 7) {
        title = cells[0] || null;
        rest = cells.slice(1);
      } else if (cells.length !== 6) {
        problems.push(`${parkSlug}: строка из ${cells.length} ячеек после «${title ?? '—'}»`);
        continue;
      }
      if (!title) {
        problems.push(`${parkSlug}: строка без названия маршрута`);
        continue;
      }
      const status = STATUS_BY_WORD[rest[0]!.toLowerCase()];
      const season = SEASON_BY_WORD[rest[1]!.toLowerCase()];
      if (!status) problems.push(`${parkSlug}: «${title}» — статус «${rest[0]}» не распознан`);
      if (!season) problems.push(`${parkSlug}: «${title}» — сезон «${rest[1]}» не распознан`);
      if (status && season) rows.push({ parkSlug, title, season, status });
    }
  }
  return { rows, problems };
}

/** Вариант маршрута со статусом из базы; `fresh` — моложе PARK_STATUS_FRESH_HOURS. */
export interface VariantStatus {
  status: ParkRouteStatus | null;
  fresh: boolean;
}

/**
 * Статус маршрута по его вариантам: хоть один открыт по свежему чтению —
 * открыт; все прочитаны свежо и закрыты — закрыт; иначе null, «не проверено»
 * (§4.0): непрочитанный вариант мог быть открыт.
 */
export function routeParkStatus(variants: readonly VariantStatus[]): ParkRouteStatus | null {
  if (variants.length === 0) return null;
  const known = variants.map((v) => (v.fresh ? v.status : null));
  if (known.includes('open')) return 'open';
  return known.every((s) => s === 'closed') ? 'closed' : null;
}
